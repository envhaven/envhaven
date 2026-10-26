import { chmodSync, existsSync, mkdirSync, readFileSync } from "fs";
import { getSshDir } from "../utils/paths";
import { writeFileAtomic } from "../utils/files";
import { stripTerminalControl } from "../utils/terminal";
import { isValidAlias, isValidHost, isValidIdentityFile, isValidPort, isValidUser } from "../config/store";

export interface HostBlock {
  alias: string;
  host: string;
  port: number;
  user: string;
  // Normally the one key this workspace accepted, with identitiesOnly set (see
  // identityCandidates). The fallback for a workspace none of them reaches alone lists every key
  // file and leaves ssh's own key selection on, as versions before IdentitiesOnly did.
  identityFiles: string[];
  identitiesOnly: boolean;
}

// Haven's Host blocks live in a file of their own, and ~/.ssh/config includes it on its first
// line. Ssh uses the first value it finds for each setting, so blocks appended to the end of the
// user's file, as older versions did, lost to any `Host *` defaults above them: a global
// `ForwardAgent yes` or `StrictHostKeyChecking no` silently applied to workspaces too. The include
// also means the user's file is edited once, for that line, instead of on every connect.
const INCLUDE_LINE = "Include ~/.ssh/haven/config";
const INCLUDE_PRESENT = /^[ \t]*include[ \t]+.*haven\/config\b/im;
const INCLUDE_COMMENT = "# Added by the Haven CLI. Keep it first so workspace settings take precedence.";

const HAVEN_CONFIG_HEADER = `# Managed by the Haven CLI (haven connect). Changes here are overwritten.
# ~/.ssh/config includes this file on its first line.
`;

export function getHavenSshDir(sshDir = getSshDir()): string {
  return `${sshDir}/haven`;
}

function getHavenConfigPath(sshDir: string): string {
  return `${getHavenSshDir(sshDir)}/config`;
}

// Checked again here, immediately before writing, whatever the caller already validated: this is
// the one place a value turns into ssh configuration.
function assertValidBlock(block: HostBlock): void {
  if (!isValidAlias(block.alias)) throw new Error(`Refusing to write SSH config: invalid alias "${block.alias}"`);
  if (!isValidHost(block.host)) throw new Error(`Refusing to write SSH config: invalid host "${block.host}"`);
  if (!isValidPort(block.port)) throw new Error(`Refusing to write SSH config: invalid port "${block.port}"`);
  if (!isValidUser(block.user)) throw new Error(`Refusing to write SSH config: invalid user "${block.user}"`);
  for (const file of block.identityFiles) {
    if (!isValidIdentityFile(file)) throw new Error(`Refusing to write SSH config: invalid identity file "${file}"`);
  }
  // IdentitiesOnly with no IdentityFile silently means ssh's default key files.
  if (block.identitiesOnly && block.identityFiles.length === 0) {
    throw new Error("Refusing to write SSH config: IdentitiesOnly needs an identity file");
  }
}

export function generateHostConfig(block: HostBlock): string {
  assertValidBlock(block);
  // Quoted for paths with spaces; `%` doubled because ssh expands %-tokens in IdentityFile.
  const identities = block.identityFiles.map((file) => `  IdentityFile "${file.replace(/%/g, "%%")}"\n`).join("");

  // CheckHostIP is off because a workspace's address is not part of its identity, and because with
  // it on (the default before OpenSSH 8.5) ssh also files the key under the address: trusting a new
  // key replaced only the host name's line, and the address's stale one failed every later connect.
  return `Host ${block.alias}
  HostName ${block.host}
  Port ${block.port}
  User ${block.user}
${identities}${block.identitiesOnly ? "  IdentitiesOnly yes\n" : ""}  UserKnownHostsFile ~/.ssh/known_hosts
  StrictHostKeyChecking yes
  CheckHostIP no
  ForwardAgent no
  ForwardX11 no
  ServerAliveInterval 5
  ServerAliveCountMax 3
`;
}

// Haven's own file is fully generated, so splitting it on `Host` lines is exact.
function parseHavenBlocks(content: string): { alias: string; text: string }[] {
  const blocks: { alias: string; text: string }[] = [];
  for (const chunk of content.split(/^(?=Host )/m)) {
    const match = chunk.match(/^Host (\S+)\s*\n/);
    if (match) blocks.push({ alias: match[1]!, text: chunk.trimEnd() + "\n" });
  }
  return blocks;
}

// The block the committed version before the include appended to ~/.ssh/config, line for line,
// and the blank lines after it. Only that exact shape is removed, and only when what follows it is
// another Host or Match line or the end of the file: ssh reads every line up to the next Host or
// Match as part of a block, indented or not, so a block with a line of the user's after it is
// theirs. Anything else under a `Host haven-...` line in that file is the user's own as well, since
// Haven writes its blocks only into its own file now; a pattern that took every indented line under
// the alias deleted a user's block with its LocalForward and left the comment above it behind.
function legacyBlockPattern(alias: string): RegExp {
  const nl = "\\r?\\n";
  const end = "(?![\\s\\S])";
  const nextBlock = `[ \\t]*(?:[Hh][Oo][Ss][Tt]|[Mm][Aa][Tt][Cc][Hh])[ \\t=]`;
  return new RegExp(
    `^Host ${alias}${nl}` +
      `  HostName \\S+${nl}  Port \\d+${nl}  User \\S+${nl}` +
      `(?:  IdentityFile .+${nl})*` +
      `  ForwardAgent no${nl}  ForwardX11 no${nl}  StrictHostKeyChecking accept-new${nl}` +
      `  ServerAliveInterval 5${nl}  ServerAliveCountMax 3(?:${nl}|${end})` +
      `(?:[ \\t]*${nl})*` +
      `(?=(?:[ \\t]*#.*(?:${nl}|${end}))*(?:${nextBlock}|${end}))`,
    "gm",
  );
}

/**
 * Writes the Host block for one workspace and makes sure ssh reads it.
 *
 * `drop` names aliases this connect leaves behind (an alias from an older version, or one for a
 * host:port this directory no longer uses); their blocks are removed from haven's file, and from
 * ~/.ssh/config only in the exact shape an older version wrote there. Callers pass only aliases no
 * other connection still uses. ~/.ssh/config is otherwise left as it is, the user's own blocks for
 * a workspace alias included.
 */
export function writeHostConfig(block: HostBlock, drop: readonly string[] = [], sshDir = getSshDir()): void {
  const text = generateHostConfig(block);
  for (const alias of drop) {
    if (!isValidAlias(alias)) throw new Error(`Refusing to edit SSH config: invalid alias "${alias}"`);
  }
  const removed = new Set([block.alias, ...drop]);

  const havenDir = getHavenSshDir(sshDir);
  mkdirSync(havenDir, { recursive: true, mode: 0o700 });
  chmodSync(havenDir, 0o700);
  const havenPath = getHavenConfigPath(sshDir);
  const existing = existsSync(havenPath) ? readFileSync(havenPath, "utf-8") : "";
  const kept = parseHavenBlocks(existing).filter((b) => !removed.has(b.alias));
  const content = [HAVEN_CONFIG_HEADER, ...kept.map((b) => b.text), text].join("\n");
  writeFileAtomic(havenPath, content, { mode: 0o600, force: true });

  ensureUserConfig(drop, sshDir);
}

// Removes the alias's block from haven's file, when it has one.
export function removeHostBlock(alias: string, sshDir = getSshDir()): void {
  if (!isValidAlias(alias)) throw new Error(`Refusing to edit SSH config: invalid alias "${alias}"`);
  const path = getHavenConfigPath(sshDir);
  if (!existsSync(path)) return;
  const blocks = parseHavenBlocks(readFileSync(path, "utf-8"));
  const kept = blocks.filter((b) => b.alias !== alias);
  if (kept.length === blocks.length) return;
  writeFileAtomic(path, [HAVEN_CONFIG_HEADER, ...kept.map((b) => b.text)].join("\n"), { mode: 0o600, force: true });
}

function ensureUserConfig(legacyAliases: readonly string[], sshDir: string): void {
  const path = `${sshDir}/config`;
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";

  let content = existing;
  for (const alias of legacyAliases) {
    content = content.replace(legacyBlockPattern(alias), "");
  }
  if (!INCLUDE_PRESENT.test(content)) {
    content = `${INCLUDE_COMMENT}\n${INCLUDE_LINE}\n${content.length > 0 ? "\n" : ""}${content}`;
  }

  if (content !== existing) {
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(path, content, { mode: 0o600 });
  }
}

// The lines ssh itself prints for refused keys, anchored to the start of a line. A server can still
// send text that matches (a disconnect message keeps its newlines), and the worst that does is
// spend another connection on more keys: ssh offers none of them to a server whose host key it has
// not verified.
const PERMISSION_DENIED = /^\S+@\S+: Permission denied \(/m;
const TOO_MANY_FAILURES = /^Received disconnect from .*: Too many authentication failures/m;

export function isAuthFailure(error: string | undefined): boolean {
  return error !== undefined && (PERMISSION_DENIED.test(error) || TOO_MANY_FAILURES.test(error));
}

// A host key ssh refused at login: a different key, or the trusted one presented by a server that
// cannot sign with it ("incorrect signature"), which is what an impostor that copied the public
// key looks like.
export function isHostKeyFailure(error: string | undefined): boolean {
  return error !== undefined && /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|incorrect signature/i.test(error);
}

/**
 * What `ssh -G` prints for the alias: every option ssh would use for it, the user's config and
 * Haven's block applied, as `keyword value` lines with the keyword in lower case. Values are the
 * ones ssh uses: the host name and HostKeyAlias in lower case, `~` and tokens expanded.
 */
export async function sshConfigDump(alias: string): Promise<string> {
  const proc = Bun.spawn(["ssh", "-G", alias], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`ssh could not read its config for ${alias}: ${stripTerminalControl(stderr).trim() || `exit ${exitCode}`}`);
  }
  return stdout;
}

// One keyword's value in `ssh -G` output, or undefined when ssh printed none.
export function dumpValue(dump: string, keyword: string): string | undefined {
  const line = dump.split("\n").find((l) => l.toLowerCase().startsWith(`${keyword} `));
  return line?.slice(keyword.length + 1).trim();
}

const ACCEPTED_KEY = "Server accepts key: ";

/**
 * Logs in and runs `echo ok`. Given the identity files the alias offers, it also says which of them
 * the server accepted, read from `ssh -v`: `Server accepts key: <path> <type> <fingerprint> ...`,
 * the last such line before success being the key that signed.
 */
export async function testConnection(
  alias: string,
  identityFiles: readonly string[] = [],
): Promise<{ success: boolean; error?: string; acceptedIdentity?: string }> {
  const verbose = identityFiles.length > 0;
  // Either way ssh's own lines are shown whatever LogLevel the user's config sets: -v outranks it,
  // and so does a command-line LogLevel, which keeps QUIET from hiding why a login failed.
  // ControlPath=none makes this a login of its own: through a master connection the user's
  // ControlMaster setting shares (sync keeps one open), no key would be offered at all.
  const proc = Bun.spawn([
    "ssh",
    ...(verbose ? ["-v"] : ["-o", "LogLevel=ERROR"]),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ControlPath=none",
    alias,
    "echo", "ok",
  ], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });

  const [exitCode, , stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  // The server's banner and messages arrive on stderr and are printed in the CLI's own messages.
  const lines = stripTerminalControl(stderr).split("\n");

  if (exitCode === 0) {
    const accepted = lines
      .filter((line) => line.includes(ACCEPTED_KEY))
      .map((line) => line.slice(line.indexOf(ACCEPTED_KEY) + ACCEPTED_KEY.length))
      .pop();
    const acceptedIdentity = accepted ? identityFiles.find((file) => accepted.startsWith(`${file} `)) : undefined;
    return acceptedIdentity ? { success: true, acceptedIdentity } : { success: true };
  }

  // -v adds its version banner and debug lines; the error is what is left.
  const error = lines.filter((line) => !/^(debug\d:|OpenSSH_)/.test(line)).join("\n").trim();
  // Bun's `killed` is true after any exit; a signal is what the timeout leaves behind.
  return { success: false, error: error || (proc.signalCode !== null ? "Connection timed out" : `ssh exited with ${exitCode}`) };
}

export async function getRemoteEnv(alias: string, varName: string): Promise<string | null> {
  const proc = Bun.spawn([
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    alias,
    "printenv", varName,
  ], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });

  const exitCode = await proc.exited;

  if (exitCode === 0) {
    const stdout = await new Response(proc.stdout).text();
    return stdout.trim() || null;
  }

  return null;
}

export function closeControlMaster(alias: string): void {
  Bun.spawn([
    "ssh",
    "-O", "exit",
    alias,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });
}
