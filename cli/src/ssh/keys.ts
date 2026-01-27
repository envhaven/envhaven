import { existsSync, readFileSync, mkdirSync, chmodSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { getSshDir } from "../utils/paths";

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

export async function getAgentFingerprints(): Promise<string[]> {
  const proc = Bun.spawn(["ssh-add", "-l"], {
    stdout: "pipe",
    stderr: "pipe",
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

export async function analyzeKeys(sshDirOverride?: string): Promise<KeyAnalysis[]> {
  const keys = findExistingKeys(sshDirOverride);
  const agentFingerprints = await getAgentFingerprints();

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
