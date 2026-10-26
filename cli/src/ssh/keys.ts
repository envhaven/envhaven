import { existsSync, readFileSync, mkdirSync, chmodSync, readdirSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { getSshDir } from "../utils/paths";
import { dumpValue, sshConfigDump } from "./config";

const HAVEN_KEY_NAME = "haven_ed25519";

export interface SshKeyInfo {
  privateKeyPath: string;
  publicKeyPath: string;
  publicKey: string;
}

function isValidSshPublicKeyFile(path: string): boolean {
  const result = spawnSync("ssh-keygen", ["-lf", path], { stdio: "pipe" });
  return result.status === 0;
}

export function findExistingKeys(sshDirOverride?: string): SshKeyInfo[] {
  const sshDir = sshDirOverride ?? getSshDir();
  if (!existsSync(sshDir)) return [];

  const keys: SshKeyInfo[] = [];
  const files = readdirSync(sshDir);

  for (const file of files) {
    if (!file.endsWith(".pub")) continue;
    const publicKeyPath = `${sshDir}/${file}`;
    const privateKeyPath = publicKeyPath.slice(0, -4);

    if (!existsSync(privateKeyPath)) continue;
    if (!isValidSshPublicKeyFile(publicKeyPath)) continue;

    try {
      const publicKey = readFileSync(publicKeyPath, "utf-8").trim();
      if (publicKey) {
        keys.push({ privateKeyPath, publicKeyPath, publicKey });
      }
    } catch {
      continue;
    }
  }

  return keys;
}

export function getAllKeyPaths(sshDirOverride?: string): string[] {
  return findExistingKeys(sshDirOverride).map(k => k.privateKeyPath);
}

export function getPublicKeys(sshDirOverride?: string): string[] {
  return findExistingKeys(sshDirOverride).map(k => k.publicKey);
}

export function hasExistingKeys(sshDirOverride?: string): boolean {
  return findExistingKeys(sshDirOverride).length > 0;
}

export function getHavenKeyPath(sshDirOverride?: string): string {
  const sshDir = sshDirOverride ?? getSshDir();
  return `${sshDir}/${HAVEN_KEY_NAME}`;
}

export function hasHavenKey(sshDirOverride?: string): boolean {
  const keyPath = getHavenKeyPath(sshDirOverride);
  return existsSync(keyPath) && existsSync(`${keyPath}.pub`);
}

export function getHavenPublicKey(sshDirOverride?: string): string | null {
  const pubKeyPath = `${getHavenKeyPath(sshDirOverride)}.pub`;
  if (!existsSync(pubKeyPath)) return null;
  try {
    return readFileSync(pubKeyPath, "utf-8").trim();
  } catch {
    return null;
  }
}

export async function generateHavenKey(sshDirOverride?: string): Promise<SshKeyInfo> {
  const sshDir = sshDirOverride ?? getSshDir();
  if (!existsSync(sshDir)) {
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }

  const privateKeyPath = getHavenKeyPath(sshDirOverride);
  const publicKeyPath = `${privateKeyPath}.pub`;

  const proc = Bun.spawn([
    "ssh-keygen",
    "-t", "ed25519",
    "-f", privateKeyPath,
    "-N", "",
    "-C", "haven-cli",
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`ssh-keygen failed: ${stderr}`);
  }

  chmodSync(privateKeyPath, 0o600);
  chmodSync(publicKeyPath, 0o644);

  const publicKey = readFileSync(publicKeyPath, "utf-8").trim();
  return { privateKeyPath, publicKeyPath, publicKey };
}

export async function ensureKeyExists(sshDirOverride?: string): Promise<{ keys: SshKeyInfo[]; generated: boolean }> {
  const existing = findExistingKeys(sshDirOverride);
  if (existing.length > 0) {
    return { keys: existing, generated: false };
  }

  const generated = await generateHavenKey(sshDirOverride);
  return { keys: [generated], generated: true };
}

export async function isKeyEncrypted(keyPath: string): Promise<boolean> {
  // ssh-keygen -y with empty passphrase fails on encrypted keys
  const proc = Bun.spawn(
    ["ssh-keygen", "-y", "-P", "", "-f", keyPath],
    { stdout: "pipe", stderr: "pipe" }
  );
  return (await proc.exited) !== 0;
}

// The agent ssh actually uses for an alias, or null when there is none. 1Password and Secretive set
// `IdentityAgent` under `Host *` and leave SSH_AUTH_SOCK alone, so asking only the environment's
// agent missed every key they hold. Defaults to the environment's, for callers without an alias.
export type AgentSocket = string | null;

function defaultAgentSocket(): AgentSocket {
  return process.env["SSH_AUTH_SOCK"] || null;
}

// Reads the `identityagent` line of `ssh -G` output, where ssh has already expanded `~` and
// `${VAR}`. Its value can also be `none`, `SSH_AUTH_SOCK`, or `$VAR` naming a variable to read.
export function parseIdentityAgent(dump: string, env: Record<string, string | undefined>): AgentSocket {
  const value = dumpValue(dump, "identityagent");
  if (!value || value === "SSH_AUTH_SOCK") return env["SSH_AUTH_SOCK"] || null;
  if (value === "none") return null;
  if (value.startsWith("$")) return env[value.slice(1)] || null;
  return value;
}

export async function identityAgentSocket(alias: string): Promise<AgentSocket> {
  // A config ssh cannot read leaves the environment's agent; the connect fails on it later with
  // ssh's own message.
  const dump = await sshConfigDump(alias).catch(() => "");
  return parseIdentityAgent(dump, process.env);
}

function agentEnv(agentSocket: string): Record<string, string | undefined> {
  return { ...process.env, SSH_AUTH_SOCK: agentSocket };
}

export async function getAgentFingerprints(agentSocket: AgentSocket = defaultAgentSocket()): Promise<string[]> {
  if (!agentSocket) return [];
  const proc = Bun.spawn(["ssh-add", "-l"], {
    env: agentEnv(agentSocket),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });

  if ((await proc.exited) !== 0) return [];

  const stdout = await new Response(proc.stdout).text();
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(" ")[1])
    .filter((fp): fp is string => fp !== undefined);
}

export async function getKeyFingerprint(keyPath: string): Promise<string | null> {
  const proc = Bun.spawn(["ssh-keygen", "-lf", keyPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if ((await proc.exited) !== 0) return null;

  const stdout = await new Response(proc.stdout).text();
  return stdout.trim().split(" ")[1] ?? null;
}

export interface KeyAnalysis {
  key: SshKeyInfo;
  encrypted: boolean;
  inAgent: boolean;
  usable: boolean;
}

export async function analyzeKeys(
  sshDirOverride?: string,
  agentSocket: AgentSocket = defaultAgentSocket(),
): Promise<KeyAnalysis[]> {
  const keys = findExistingKeys(sshDirOverride);
  const agentFingerprints = await getAgentFingerprints(agentSocket);

  const analyses: KeyAnalysis[] = [];

  for (const key of keys) {
    const encrypted = await isKeyEncrypted(key.privateKeyPath);
    const fingerprint = await getKeyFingerprint(key.privateKeyPath);
    const inAgent = fingerprint ? agentFingerprints.includes(fingerprint) : false;
    const usable = !encrypted || inAgent;

    analyses.push({ key, encrypted, inAgent, usable });
  }

  return analyses;
}

export async function hasUsableKey(sshDirOverride?: string): Promise<boolean> {
  if (hasHavenKey(sshDirOverride)) return true;

  const analyses = await analyzeKeys(sshDirOverride);
  return analyses.some((a) => a.usable);
}

// `type base64` of an OpenSSH public key line, without the comment: what identifies the key.
function keyMaterial(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
}

const PUBLIC_KEY_LINE = /^(ssh-|ecdsa-|sk-)\S+\s+[A-Za-z0-9+/]+={0,3}(\s.*)?$/;

// Public keys the agent holds, one OpenSSH line each. Empty when there is no agent or it holds
// nothing (`ssh-add -L` exits non-zero for both).
export async function getAgentPublicKeys(agentSocket: AgentSocket = defaultAgentSocket()): Promise<string[]> {
  if (!agentSocket) return [];
  const proc = Bun.spawn(["ssh-add", "-L"], {
    env: agentEnv(agentSocket),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) return [];
  return stdout.split("\n").map((line) => line.trim()).filter((line) => PUBLIC_KEY_LINE.test(line));
}

/**
 * Every key worth offering a workspace, in the order `haven connect` tries them: the Haven key,
 * usable key files in ~/.ssh by name, keys that exist only in the agent (1Password, Secretive, a
 * hardware key), and last the passphrase-protected files the agent does not hold, which macOS can
 * still unlock from the Keychain (`UseKeychain`).
 *
 * The SSH config names exactly one of these per workspace, with `IdentitiesOnly yes`, so a
 * workspace is offered the one key it accepts. Workspaces usually authorize the user's GitHub keys
 * rather than a Haven key, which is why the working one is found by trying them in turn. An
 * agent-only key has no file to name, so its public half is saved under ~/.ssh/haven/: given a
 * public key as IdentityFile, ssh signs with the matching agent key.
 */
export async function identityCandidates(
  agentSocket: AgentSocket = defaultAgentSocket(),
  sshDirOverride?: string,
): Promise<string[]> {
  const sshDir = sshDirOverride ?? getSshDir();
  const havenKeyPath = getHavenKeyPath(sshDirOverride);
  const analyses = await analyzeKeys(sshDirOverride, agentSocket);
  const byName = (a: string, b: string) => Number(b === havenKeyPath) - Number(a === havenKeyPath) || a.localeCompare(b);

  const usable = analyses.filter((a) => a.usable).map((a) => a.key.privateKeyPath).sort(byName);
  const locked = analyses.filter((a) => !a.usable).map((a) => a.key.privateKeyPath).sort(byName);

  const onDisk = new Set(analyses.map((a) => keyMaterial(a.key.publicKey)));
  const agentOnly = (await getAgentPublicKeys(agentSocket)).filter((line) => !onDisk.has(keyMaterial(line)));

  const agentDir = `${sshDir}/haven`;
  const agentFiles = agentOnly.map((line) => {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const name = createHash("sha256").update(keyMaterial(line)).digest("hex").slice(0, 16);
    const path = `${agentDir}/agent-${name}.pub`;
    writeFileSync(path, `${line}\n`, { mode: 0o600 });
    return path;
  });

  return [...usable, ...agentFiles, ...locked];
}
