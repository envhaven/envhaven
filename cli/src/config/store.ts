import { chmodSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { dirname } from "path";
import { getConfigDir, canonicalPath } from "../utils/paths";
import { writeFileAtomic } from "../utils/files";
import { stripTerminalControl } from "../utils/terminal";

export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  remotePath: string;
  sshAlias?: string;
  // Names this connection's mutagen session (`haven-<id>`) and its session file. Connections
  // made before ids came from SHA-256 have none and keep their 32-bit id (see sessionIdFor)
  // until their next `haven connect` moves them over.
  sessionId?: string;
  // The session such a move replaced, paused, until terminating it succeeds. Named here so a
  // terminate that fails is tried again by the next connect, not left to a session nothing finds.
  retiredSessionId?: string;
  // The key that authenticated at the last connect: a private key file, or the saved public half
  // of a key that lives only in ssh-agent. The SSH config offers this key and no other.
  identityFile?: string;
  // The remembered answer to "sync .env and .npmrc files?". Absent means not asked yet.
  syncEnvFiles?: boolean;
  // The .gitignore lines last accepted as sync ignores. Two-way sync lets the workspace edit
  // .gitignore, so a later change is shown and confirmed before it applies.
  gitignorePatterns?: string[];
  // Every ignore pattern of the sync session the last connect started. A later connect compares
  // against these when that session is gone (`haven disconnect` ends it) to tell which files it let
  // sync. Absent for connections last made by a version that did not record them.
  syncIgnores?: string[];
  lastConnected?: number;
}

export interface SessionState {
  connected: boolean;
  startTime: number;
  mutagenSessionId?: string;
  idleTimeout?: number;
}

export type ConnectionStore = Record<string, ConnectionConfig>;

// Every value below ends up in ~/.ssh/config, an ssh argv or a file path, so each is held to the
// characters it can legitimately contain. A newline in a user or host name is how a pasted
// `haven connect` target used to write a ProxyCommand into ~/.ssh/config.
const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
// A hostname or an IPv4 address: starts and ends with a letter or digit, at most 253 characters.
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;
// `haven-` plus a hash: base36 for aliases made before 16-hex-digit SHA-256 ones.
const ALIAS_PATTERN = /^haven-[a-z0-9]{1,32}$/;
const SESSION_ID_PATTERN = /^[a-z0-9]{1,32}$/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

export function isValidUser(user: string): boolean {
  return USER_PATTERN.test(user);
}

export function isValidHost(host: string): boolean {
  return HOST_PATTERN.test(host);
}

export function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function isValidAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias);
}

export function isValidRemotePath(path: string): boolean {
  return path.startsWith("/") && path.length <= 4096 && !CONTROL_CHARACTER.test(path);
}

// Absolute and free of control characters; also free of `"`, which cannot be escaped inside a
// quoted ssh_config argument.
export function isValidIdentityFile(path: string): boolean {
  return path.startsWith("/") && path.length <= 4096 && !CONTROL_CHARACTER.test(path) && !path.includes('"');
}

function getConnectionsPath(): string {
  return `${getConfigDir()}/connections.json`;
}

function getSessionPath(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  return `${getConfigDir()}/sessions/${sessionId}.json`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// The 32-bit hash every alias, session file and mutagen session name used before 16 hex digits of
// SHA-256 replaced it. Two paths (or two host:port pairs) that collided under it were cross-wired:
// one Host block replaced the other and one session's stop killed the other's sync. Kept only to
// find what older versions created.
function legacyHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

export function newSessionId(localPath: string): string {
  return sha256Hex(canonicalPath(localPath)).slice(0, 16);
}

export function sessionIdFor(localPath: string, config: ConnectionConfig): string {
  return config.sessionId ?? legacyHash(canonicalPath(localPath));
}

// Private: it lists every project path and workspace host the user has connected.
function ensureConfigDir(): void {
  const dir = getConfigDir();
  mkdirSync(`${dir}/sessions`, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  chmodSync(`${dir}/sessions`, 0o700);
}

const warned = new Set<string>();

// Once per process per message: the store is read several times in one command.
function warnInvalid(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.error(`⚠ ${stripTerminalControl(message)}`);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && !CONTROL_CHARACTER.test(item));
}

// Builds a ConnectionConfig from untrusted JSON, field by field. Nothing is spread from the parsed
// object, and every field that reaches ssh or mutagen is checked: a hand-edited
// `"sshAlias": "-oProxyCommand=..."` would otherwise land in `ssh <alias>` as an option. A required
// field that fails rejects the entry (null); an optional one is left out and named in `problems`,
// so one bad value does not take a live connection, and its running sync, out of the store.
function toConnectionConfig(value: unknown, problems: string[]): ConnectionConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push("not an object");
    return null;
  }
  const v = value as Record<string, unknown>;

  const required: [string, boolean][] = [
    ["host", typeof v.host === "string" && isValidHost(v.host)],
    ["port", isValidPort(v.port)],
    ["user", typeof v.user === "string" && isValidUser(v.user)],
    ["remotePath", typeof v.remotePath === "string" && isValidRemotePath(v.remotePath)],
  ];
  const missing = required.filter(([, ok]) => !ok).map(([name]) => name);
  if (missing.length > 0) {
    problems.push(...missing);
    return null;
  }

  const config: ConnectionConfig = {
    host: v.host as string,
    port: v.port as number,
    user: v.user as string,
    remotePath: v.remotePath as string,
  };

  const optional: [keyof ConnectionConfig, (x: unknown) => boolean][] = [
    ["sshAlias", (x) => typeof x === "string" && isValidAlias(x)],
    ["sessionId", (x) => typeof x === "string" && SESSION_ID_PATTERN.test(x)],
    ["retiredSessionId", (x) => typeof x === "string" && SESSION_ID_PATTERN.test(x)],
    ["identityFile", (x) => typeof x === "string" && isValidIdentityFile(x)],
    ["syncEnvFiles", (x) => typeof x === "boolean"],
    ["gitignorePatterns", isStringList],
    ["syncIgnores", isStringList],
    ["lastConnected", (x) => typeof x === "number" && Number.isFinite(x)],
  ];
  for (const [name, valid] of optional) {
    if (v[name] === undefined) continue;
    if (valid(v[name])) (config as unknown as Record<string, unknown>)[name] = v[name];
    else problems.push(name);
  }

  return config;
}

// connections.json as this version reads it: the entries it can use, and the ones it rejects, as
// they are on disk.
function readConnections(): { store: ConnectionStore; rejected: Record<string, unknown> } {
  const path = getConnectionsPath();
  // No prototype, so an entry named "__proto__" is kept like any other.
  const rejected: Record<string, unknown> = Object.create(null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      warnInvalid(`Could not read ${path}; continuing without saved connections.`);
    }
    return { store: {}, rejected };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnInvalid(`Ignoring ${path}: it is not a JSON object.`);
    return { store: {}, rejected };
  }

  const store: ConnectionStore = {};
  const trimmed: string[] = [];
  for (const [localPath, entry] of Object.entries(parsed)) {
    const problems: string[] = [];
    const config = localPath.startsWith("/") && !CONTROL_CHARACTER.test(localPath)
      ? toConnectionConfig(entry, problems)
      : null;
    if (!config) {
      rejected[localPath] = entry;
      continue;
    }
    store[localPath] = config;
    if (problems.length > 0) trimmed.push(`${localPath} (${problems.join(", ")})`);
  }

  const names = Object.keys(rejected);
  if (names.length > 0) {
    warnInvalid(`Ignoring ${names.length} invalid entr${names.length === 1 ? "y" : "ies"} in ${path}: ${names.join(", ")}`);
  }
  if (trimmed.length > 0) {
    warnInvalid(`Ignoring invalid settings in ${path}: ${trimmed.join("; ")}`);
  }

  return { store, rejected };
}

export function loadConnections(): ConnectionStore {
  return readConnections().store;
}

// Entries this version rejects are written back as they were, not dropped: an older version may
// have accepted one (a "Remote path" relative to the home directory, say), its sync session can
// still be running, and this file is the only record of the directory it syncs. A valid entry
// saved for the same directory replaces it.
export function saveConnections(store: ConnectionStore): void {
  const { rejected } = readConnections();
  ensureConfigDir();
  writeFileAtomic(getConnectionsPath(), JSON.stringify({ ...rejected, ...store }, null, 2), { mode: 0o600, force: true });
}

export function getConnection(localPath: string): ConnectionConfig | null {
  const store = loadConnections();
  const canonical = canonicalPath(localPath);
  return store[canonical] ?? null;
}

// Held to the same checks as loading, so nothing is written that the next load would refuse.
export function saveConnection(localPath: string, config: ConnectionConfig): void {
  const problems: string[] = [];
  const valid = toConnectionConfig(config, problems);
  if (!valid) {
    throw new Error(`Refusing to save an invalid connection for ${localPath} (${problems.join(", ")})`);
  }
  if (problems.length > 0) {
    warnInvalid(`Not saving invalid ${problems.join(", ")} for ${localPath}`);
  }

  const store = loadConnections();
  const canonical = canonicalPath(localPath);
  store[canonical] = valid;
  saveConnections(store);
}

export function deleteConnection(localPath: string): boolean {
  const store = loadConnections();
  const canonical = canonicalPath(localPath);
  if (canonical in store) {
    delete store[canonical];
    saveConnections(store);
    return true;
  }
  return false;
}

export function findConnection(startPath: string): { localPath: string; config: ConnectionConfig } | null {
  const store = loadConnections();
  let current = canonicalPath(startPath);
  const root = "/";

  while (current !== root) {
    if (current in store) {
      return { localPath: current, config: store[current]! };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (root in store) {
    return { localPath: root, config: store[root]! };
  }

  return null;
}

export function loadSession(sessionId: string): SessionState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getSessionPath(sessionId), "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    const { connected, startTime, mutagenSessionId, idleTimeout } = parsed as Record<string, unknown>;
    if (typeof connected !== "boolean" || typeof startTime !== "number") return null;
    const state: SessionState = { connected, startTime };
    if (typeof mutagenSessionId === "string") state.mutagenSessionId = mutagenSessionId;
    if (typeof idleTimeout === "number") state.idleTimeout = idleTimeout;
    return state;
  } catch {
    return null;
  }
}

export function saveSession(sessionId: string, state: SessionState): void {
  ensureConfigDir();
  writeFileAtomic(getSessionPath(sessionId), JSON.stringify(state, null, 2), { mode: 0o600, force: true });
}

export function deleteSession(sessionId: string): void {
  try {
    unlinkSync(getSessionPath(sessionId));
  } catch {
    // Intentionally ignored: file may not exist
  }
}

export function generateSshAlias(host: string, port: number, user = "abc"): string {
  return `haven-${sha256Hex(`${user}@${host}:${port}`).slice(0, 16)}`;
}

// The alias `haven connect` uses while it checks the host key and looks for a working key, so the
// workspace's own alias changes only once a key has logged in. It can be neither a workspace alias
// (16 hex digits) nor one an older version made (7 characters at most).
export function probeAlias(alias: string): string {
  return alias.replace(/^haven-/, "haven-probe");
}

export function buildSshString(config: ConnectionConfig): string {
  const portPart = config.port !== 22 ? ` -p ${config.port}` : "";
  return `${config.user}@${config.host}${portPart}`;
}

export function parseSshString(input: string): { user: string; host: string; port: number } | null {
  const DEFAULT_USER = "abc";
  const DEFAULT_PORT = 22;

  const fullMatch = input.match(/^([^@]+)@([^:]+)(?::(\d+))?$/);
  if (fullMatch) {
    const [, user, host, portStr] = fullMatch;
    const port = portStr ? parseInt(portStr, 10) : DEFAULT_PORT;

    if (!user || !host || !isValidUser(user) || !isValidHost(host) || !isValidPort(port)) {
      return null;
    }

    return { user, host, port };
  }

  // Shorthand: no @, no :, no dots → managed domain subdomain
  // e.g. "myproject-alice" → "ssh-myproject-alice.envhaven.app"
  if (!input.includes("@") && !input.includes(":") && !input.includes(".")) {
    // Must be a valid subdomain pattern (alphanumeric + hyphens)
    if (/^[a-zA-Z0-9-]+$/.test(input) && input.length > 0) {
      const host = `ssh-${input}.envhaven.app`;
      return isValidHost(host) ? { user: DEFAULT_USER, host, port: DEFAULT_PORT } : null;
    }
  }

  const hostOnlyMatch = input.match(/^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/);
  if (hostOnlyMatch && isValidHost(input)) {
    return { user: DEFAULT_USER, host: input, port: DEFAULT_PORT };
  }

  return null;
}
