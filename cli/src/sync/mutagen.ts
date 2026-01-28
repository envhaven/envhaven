import { getDataDir, canonicalPath } from "../utils/paths";
import { ensureMutagenInstalled } from "./download";
import { getAllIgnorePatterns, buildMutagenIgnoreArgs } from "./ignore";
import type { ConnectionConfig } from "../config/store";

export interface SyncStatus {
  status: "watching" | "scanning" | "staging" | "reconciling" | "saving" | "disconnected" | "halted" | "unknown";
  conflicts: string[];
  errors: string[];
}

function getMutagenDataDir(): string {
  return `${getDataDir()}/mutagen`;
}

function getSyncSessionName(localPath: string): string {
  const hash = simpleHash(canonicalPath(localPath));
  return `haven-${hash}`;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

async function runMutagen(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const mutagenPath = await ensureMutagenInstalled();

  const env = {
    ...process.env,
    MUTAGEN_DATA_DIRECTORY: getMutagenDataDir(),
  };

  const proc = Bun.spawn([mutagenPath, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function startSync(
  localPath: string,
  sshAlias: string,
  config: ConnectionConfig,
  useGitignore: boolean = false,
  onProgress?: (message: string) => void
): Promise<string> {
  await ensureMutagenInstalled(onProgress);

  const sessionName = getSyncSessionName(localPath);
  const ignorePatterns = getAllIgnorePatterns(localPath, useGitignore);
  const ignoreArgs = buildMutagenIgnoreArgs(ignorePatterns);

  const existing = await getSyncSession(localPath);
  if (existing) {
    onProgress?.("Resuming existing sync session...");
    await resumeSync(localPath);
    return sessionName;
  }

  onProgress?.("Starting sync...");

  const args = [
    "sync", "create",
    "--name", sessionName,
    "--sync-mode", "two-way-safe",
    ...ignoreArgs,
    canonicalPath(localPath),
    `${sshAlias}:${config.remotePath}`,
  ];

  const result = await runMutagen(args);

  if (result.exitCode !== 0) {
    throw new Error(`Failed to start sync: ${result.stderr}`);
  }

  return sessionName;
}

export async function stopSync(localPath: string): Promise<void> {
  const sessionName = getSyncSessionName(localPath);

  const result = await runMutagen(["sync", "terminate", sessionName]);

  if (result.exitCode !== 0 && !result.stderr.includes("does not exist")) {
    throw new Error(`Failed to stop sync: ${result.stderr}`);
  }
}

export async function pauseSync(localPath: string): Promise<void> {
  const sessionName = getSyncSessionName(localPath);
  await runMutagen(["sync", "pause", sessionName]);
}

export async function resumeSync(localPath: string): Promise<void> {
  const sessionName = getSyncSessionName(localPath);
  await runMutagen(["sync", "resume", sessionName]);
}

export async function flushSync(localPath: string): Promise<void> {
  const sessionName = getSyncSessionName(localPath);
  await runMutagen(["sync", "flush", sessionName]);
}

export async function getSyncSession(localPath: string): Promise<boolean> {
  const sessionName = getSyncSessionName(localPath);
  // Use template to get session names (--json not available in mutagen 0.17.x)
  const result = await runMutagen([
    "sync", "list",
    "--template", '{{range .}}{{.Name}}\n{{end}}'
  ]);

  if (result.exitCode !== 0) {
    return false;
  }

  const sessionNames = result.stdout.split("\n").filter(Boolean);
  return sessionNames.includes(sessionName);
}

export async function getSyncStatus(localPath: string): Promise<SyncStatus> {
  const sessionName = getSyncSessionName(localPath);
  // Template format: Name|Status|ConflictCount|AlphaProblems|BetaProblems
  const template = '{{range .}}{{.Name}}|{{.Status.Description}}|{{len .Conflicts}}|{{range .Alpha.ScanProblems}}{{.}};;{{end}}|{{range .Beta.ScanProblems}}{{.}};;{{end}}\n{{end}}';
  const result = await runMutagen(["sync", "list", "--template", template]);

  if (result.exitCode !== 0) {
    return { status: "disconnected", conflicts: [], errors: [result.stderr] };
  }

  const lines = result.stdout.split("\n").filter(Boolean);
  for (const line of lines) {
    const [name, statusDesc, conflictCount, alphaProblems, betaProblems] = line.split("|");
    if (name === sessionName) {
      const status = parseSessionStatus(statusDesc);
      const conflicts: string[] = [];
      const errors: string[] = [];

      const numConflicts = parseInt(conflictCount || "0", 10);
      if (numConflicts > 0) {
        conflicts.push(`${numConflicts} conflict(s) detected`);
      }
      if (alphaProblems) {
        errors.push(...alphaProblems.split(";;").filter(Boolean));
      }
      if (betaProblems) {
        errors.push(...betaProblems.split(";;").filter(Boolean));
      }

      return { status, conflicts, errors };
    }
  }

  return { status: "disconnected", conflicts: [], errors: [] };
}

function parseSessionStatus(status: string | undefined): SyncStatus["status"] {
  if (!status) return "unknown";

  const statusLower = status.toLowerCase();

  if (statusLower.includes("watching")) return "watching";
  if (statusLower.includes("scanning")) return "scanning";
  if (statusLower.includes("staging")) return "staging";
  if (statusLower.includes("reconciling")) return "reconciling";
  if (statusLower.includes("saving")) return "saving";
  if (statusLower.includes("halted")) return "halted";
  if (statusLower.includes("disconnected")) return "disconnected";

  return "unknown";
}



export function formatSyncStatus(status: SyncStatus["status"]): string {
  switch (status) {
    case "watching": return "✓ In sync";
    case "scanning": return "⟳ Scanning...";
    case "staging": return "⟳ Syncing...";
    case "reconciling": return "⟳ Syncing...";
    case "saving": return "⟳ Saving...";
    case "halted": return "⚠ Halted (conflicts)";
    case "disconnected": return "✗ Disconnected";
    default: return "? Unknown";
  }
}
