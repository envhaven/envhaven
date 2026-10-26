import { createHash } from "crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { getSshDir } from "../utils/paths";
import { stripTerminalControl } from "../utils/terminal";
import { dumpValue } from "./config";

// A workspace's SSH host key is what proves `haven connect` reached the workspace and not someone
// in between (hostile Wi-Fi, a hijacked DNS answer). Ssh's own `accept-new` trusted whatever key
// answered first and the reconnect prompt defaulted to replacing a changed one, so a man in the
// middle got the whole project the moment sync started. Here a new key is shown and must be
// confirmed before it is written to known_hosts, and the SSH config is `StrictHostKeyChecking yes`
// so neither ssh nor mutagen ever accepts one on its own.
//
// The key is read through ssh with the workspace's alias rather than ssh-keyscan, which connects
// directly: a ProxyJump or ProxyCommand in the user's config then applies, and the key read is the
// one ssh itself negotiates. Only the "none" authentication method is tried, so no key is offered
// to a server that is not trusted yet.
//
// Trust is decided by comparing that key with the ones known_hosts holds, never by reading what
// ssh prints: a server can put any text it likes into ssh's output, a disconnect message included,
// before it has sent a key at all. A server can also send a key it does not hold, since ssh records
// the key before checking the signature made with it. That is harmless, because every later
// connection is ssh's own, with StrictHostKeyChecking, and fails on the signature.

export interface HostKey {
  type: string;
  // Base64 of the key blob, as known_hosts stores it.
  key: string;
  // The known_hosts line it came from. A presented key's line is written by ssh itself (hashed if
  // the user's config asks for it) and is what gets appended when the user trusts it.
  line: string;
}

export type HostKeyStatus = "trusted" | "untrusted" | "unreachable";

// The key type each plain host key algorithm negotiates, for asking a server for a type the user
// already trusts.
const KEY_TYPE_OF_ALGORITHM: Record<string, string> = {
  "ssh-ed25519": "ssh-ed25519",
  "ecdsa-sha2-nistp256": "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384": "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521": "ecdsa-sha2-nistp521",
  "rsa-sha2-512": "ssh-rsa",
  "rsa-sha2-256": "ssh-rsa",
  "ssh-rsa": "ssh-rsa",
};

// OpenSSH's own order (8.5 and later), for an ssh -G that prints no HostKeyAlgorithms.
const DEFAULT_ALGORITHMS = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256"];

const KEY_TYPES = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"];

const KEY_LABELS: Record<string, { label: string; scanType: string }> = {
  "ssh-ed25519": { label: "ED25519", scanType: "ed25519" },
  "ecdsa-sha2-nistp256": { label: "ECDSA", scanType: "ecdsa" },
  "ecdsa-sha2-nistp384": { label: "ECDSA", scanType: "ecdsa" },
  "ecdsa-sha2-nistp521": { label: "ECDSA", scanType: "ecdsa" },
  "ssh-rsa": { label: "RSA", scanType: "rsa" },
};

// `<hosts> <type> <base64> [comment]`. Marker lines (@cert-authority, @revoked) do not match, so
// they are never mistaken for a trusted key.
const KEY_LINE = /^([^\s@#]\S*)\s+(\S+)\s+([A-Za-z0-9+/]+={0,3})(?:\s.*)?$/;

// Options given on the command line win over the user's config, and three of these are there to
// override it:
// - ControlPath=none: a connection shared through a master has no key exchange of its own, so
//   nothing would be recorded. For a user with ControlMaster set, sync keeps a master open
//   between connects.
// - VerifyHostKeyDNS=no: a key accepted through an SSHFP record is not recorded either.
// - LogLevel=ERROR: why a connection failed is shown even under `LogLevel QUIET`, which some
//   users and some systems set under `Host *`.
const KEY_CAPTURE = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
  "-o", "PreferredAuthentications=none",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "GlobalKnownHostsFile=/dev/null",
  "-o", "CheckHostIP=no",
  "-o", "UpdateHostKeys=no",
  "-o", "ControlPath=none",
  "-o", "VerifyHostKeyDNS=no",
  "-o", "LogLevel=ERROR",
];

export function knownHostsPath(sshDir = getSshDir()): string {
  return `${sshDir}/known_hosts`;
}

// How known_hosts names a host: bare on port 22, bracketed with the port otherwise.
export function hostEntry(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/**
 * The name ssh files this host's keys under in known_hosts, from the alias's `ssh -G` output:
 * HostKeyAlias when the user set one, otherwise the host name, bracketed with the port when it is
 * not 22. ssh uses the host name in lower case, and a hashed line matches only that exact string,
 * so a workspace typed as `Localhost` was looked up as typed, never found, and asked about again on
 * every connect.
 */
export function knownHostsName(dump: string): string {
  const alias = dumpValue(dump, "hostkeyalias");
  if (alias && alias !== "none") return alias;
  const host = dumpValue(dump, "hostname");
  if (!host) throw new Error("ssh -G printed no host name");
  return hostEntry(host.toLowerCase(), Number(dumpValue(dump, "port") ?? 22));
}

/**
 * The host key algorithms to ask the server for: those of the key types known_hosts holds, in the
 * order ssh itself would ask for them (its HostKeyAlgorithms, from `ssh -G`). ssh puts the known
 * types first in that order, so the server presents the key ssh would check. In known_hosts order,
 * a stale RSA line listed before the current ed25519 one was asked for first and read as a change.
 */
export function hostKeyAlgorithms(known: readonly HostKey[], dump: string): string[] {
  const order = dumpValue(dump, "hostkeyalgorithms")?.split(",") ?? DEFAULT_ALGORITHMS;
  const types = new Set(known.map((k) => k.type));
  return order.filter((algorithm) => types.has(KEY_TYPE_OF_ALGORITHM[algorithm] ?? ""));
}

// The SHA256 fingerprint OpenSSH prints: unpadded base64 of the SHA-256 of the key blob.
export function fingerprint(key: Pick<HostKey, "key">): string {
  const digest = createHash("sha256").update(Buffer.from(key.key, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

export function describeHostKey(key: Pick<HostKey, "type" | "key">): string {
  return `${KEY_LABELS[key.type]?.label ?? key.type} ${fingerprint(key)}`;
}

// The `-t` value `ssh-keyscan` takes for this key type, for the command shown to the user.
export function scanTypeOf(key: Pick<HostKey, "type">): string {
  return KEY_LABELS[key.type]?.scanType ?? "ed25519";
}

export function parseKnownHostsLines(text: string): HostKey[] {
  const keys: HostKey[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const match = line.match(KEY_LINE);
    if (!match || !KEY_TYPES.includes(match[2]!)) continue;
    keys.push({ type: match[2]!, key: match[3]!, line });
  }
  return keys;
}

export function sameKey(a: Pick<HostKey, "type" | "key">, b: Pick<HostKey, "type" | "key">): boolean {
  return a.type === b.type && a.key === b.key;
}

/**
 * The key the workspace presents, read the way ssh connects to it: ssh records it into a
 * throwaway known_hosts (accept-new) and gets no further than the "none" method. Nothing is
 * recorded unless the server sent a host key in the key exchange. `algorithms` limits the key
 * types asked for.
 */
export async function presentedHostKey(alias: string, algorithms: string[] = []): Promise<{ key: HostKey | null; error: string }> {
  const dir = mkdtempSync(`${tmpdir()}/haven-hostkey-`);
  const file = `${dir}/known_hosts`;
  try {
    const proc = Bun.spawn([
      "ssh",
      ...KEY_CAPTURE,
      "-o", `UserKnownHostsFile="${file}"`,
      ...(algorithms.length > 0 ? ["-o", `HostKeyAlgorithms=${algorithms.join(",")}`] : []),
      alias,
      "true",
    ], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    const [, , stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const key = parseKnownHostsLines(existsSync(file) ? readFileSync(file, "utf-8") : "")[0] ?? null;
    // Bun's `killed` is true after any exit; a signal is what the timeout leaves behind.
    const error = stripTerminalControl(stderr).trim() || (proc.signalCode !== null ? "Connection timed out" : "");
    return { key, error };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ssh's own lines for a connection that never reached a server, which asking for other key types
// cannot change. Printed at error level, so LogLevel=ERROR keeps them.
const NO_SERVER = /^ssh: (?:connect to host |Could not resolve hostname )/m;

/**
 * Whether the key the workspace presents is one known_hosts already holds for it. `dump` is the
 * alias's `ssh -G` output. The server is first asked for the key types already trusted, so a host
 * known by its RSA key is not reported changed because a fresh connection would have picked
 * ed25519; when that yields no key, it is asked again without the limit. ssh says "no matching
 * host key type" only at info level, which the capture's LogLevel=ERROR hides, so waiting for that
 * line meant never asking again and calling the host unreachable. The second answer is shown and
 * needs a yes like any other. A host trusted only through a @cert-authority line has no plain key
 * to compare, so it is asked about once and then pinned.
 */
export async function checkHostKey(
  alias: string,
  dump: string,
  file = knownHostsPath(),
): Promise<{ status: HostKeyStatus; presented: HostKey | null; known: HostKey[]; error: string }> {
  const known = await knownHostKeys(knownHostsName(dump), file);
  const algorithms = hostKeyAlgorithms(known, dump);

  let capture = await presentedHostKey(alias, algorithms);
  if (!capture.key && algorithms.length > 0 && !NO_SERVER.test(capture.error)) {
    capture = await presentedHostKey(alias);
  }

  const presented = capture.key;
  if (!presented) return { status: "unreachable", presented, known, error: capture.error };
  const status = known.some((k) => sameKey(k, presented)) ? "trusted" : "untrusted";
  return { status, presented, known, error: capture.error };
}

// The keys known_hosts holds under this name (see knownHostsName), hashed entries included.
export async function knownHostKeys(name: string, file = knownHostsPath()): Promise<HostKey[]> {
  if (!existsSync(file)) return [];
  const proc = Bun.spawn(["ssh-keygen", "-F", name, "-f", file], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return exitCode === 0 ? parseKnownHostsLines(stdout) : [];
}

// Removes every key known_hosts holds under this name. ssh-keygen keeps the previous file as
// known_hosts.old, and keeps @cert-authority and @revoked lines.
export async function forgetHostKeys(name: string, file = knownHostsPath()): Promise<void> {
  if (!existsSync(file)) return;
  const proc = Bun.spawn(["ssh-keygen", "-R", name, "-f", file], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Could not remove the old host key from ${file}: ${stderr.trim()}`);
  }
}

// Replaces whatever known_hosts held under this name with the one confirmed key.
export async function trustHostKey(name: string, key: HostKey, file = knownHostsPath()): Promise<void> {
  await forgetHostKeys(name, file);

  const dir = file.slice(0, file.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(file, `${separator}${key.line}\n`, { mode: 0o600 });
}
