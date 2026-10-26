import { createHash } from "crypto";
import { getDataDir, canonicalPath } from "../utils/paths";
import { stripTerminalControl } from "../utils/terminal";
import { ensureMutagenInstalled } from "./download";
import { buildMutagenIgnoreArgs } from "./ignore";
import type { ConnectionConfig } from "../config/store";

export interface SyncStatus {
  status: "watching" | "scanning" | "staging" | "reconciling" | "saving" | "disconnected" | "halted" | "unknown";
  conflicts: string[];
  errors: string[];
}

// Every mutagen call is bounded. With none, a stalled workspace hung `haven disconnect` at the
// flush step indefinitely. Creating or resuming a session connects to the workspace and installs
// the agent there first when it is missing (a new or rebuilt workspace), so those get longer than
// the calls that only talk to the local daemon.
const TIMEOUT_MS = {
  daemon: 30_000,
  connect: 180_000,
  flush: 60_000,
} as const;

// What mutagen 0.17 prints when a name matches no session: the outcome terminate wants.
const NO_SUCH_SESSION = "did not match any sessions";

// The label holding a hash of what a session was created with (target and ignore rules). Mutagen
// fixes both at creation, so a session whose label differs is recreated rather than resumed.
const SPEC_LABEL = "haven-spec";

function getMutagenDataDir(): string {
  return `${getDataDir()}/mutagen`;
}

export function getSyncSessionName(sessionId: string): string {
  return `haven-${sessionId}`;
}

export function syncSpec(sshAlias: string, remotePath: string, ignorePatterns: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([sshAlias, remotePath, ignorePatterns]))
    .digest("hex")
    .slice(0, 16);
}

async function runMutagen(
  args: string[],
  timeoutMs: number = TIMEOUT_MS.daemon,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const mutagenPath = await ensureMutagenInstalled();

  const env = {
    ...process.env,
    MUTAGEN_DATA_DIRECTORY: getMutagenDataDir(),
  };

  const proc = Bun.spawn([mutagenPath, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  // Errors and scan problems carry workspace file names, which reach the terminal in the CLI's
  // own messages.
  const clean = (text: string) => stripTerminalControl(text).trim();
  // Bun's `killed` is true after any exit; a signal is what the timeout leaves behind.
  if (proc.signalCode !== null) {
    return {
      exitCode: exitCode || 1,
      stdout: clean(stdout),
      stderr: `mutagen ${args.slice(0, 2).join(" ")} did not finish (stopped by ${proc.signalCode}; the limit is ${timeoutMs / 1000}s)`,
    };
  }
  return { exitCode, stdout: clean(stdout), stderr: clean(stderr) };
}

interface SessionInfo {
  // The haven-spec label: empty for a session an older version created.
  spec: string;
  // The ignore patterns the session was created with, as mutagen holds them.
  ignores: string[];
}

// The `sync list` templates. Mutagen 0.17.6 keeps a session's conflicts and last error in a struct
// it embeds by pointer and leaves nil while the session is paused, and an endpoint's scan problems
// in one that is nil while the endpoint is disconnected; a template that reads either fails the
// whole listing ("indirection through nil pointer to embedded struct field"). So those fields are
// read only under `{{if .SessionState}}` and `{{if .Alpha.EndpointState}}` (or Beta): one stopped
// workspace or a paused session used to make `haven status` call every directory disconnected.
export const LIST_TEMPLATE = `{{range .}}{{.Name}}|{{index .Labels "${SPEC_LABEL}"}}|{{json .Ignore.Paths}}{{"\\n"}}{{end}}`;
// Name|Status|ConflictCount|AlphaProblems|BetaProblems
export const STATUS_TEMPLATE = '{{range .}}{{.Name}}|{{.Status.Description}}|{{if .SessionState}}{{len .Conflicts}}{{else}}0{{end}}|{{if .Alpha.EndpointState}}{{range .Alpha.ScanProblems}}{{.}};;{{end}}{{end}}|{{if .Beta.EndpointState}}{{range .Beta.ScanProblems}}{{.}};;{{end}}{{end}}\n{{end}}';

// The sessions the daemon holds, all of which are Haven's (the data directory is Haven's own), by
// name. The ignore list comes last on each line, as JSON, so a `|` inside a pattern is harmless.
async function listSessions(): Promise<Map<string, SessionInfo>> {
  const result = await runMutagen(["sync", "list", "--template", LIST_TEMPLATE]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to list sync sessions: ${result.stderr}`);
  }
  const sessions = new Map<string, SessionInfo>();
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const [name = "", spec = "", ...rest] = line.split("|");
    const ignores: unknown = JSON.parse(rest.join("|") || "null");
    sessions.set(name, { spec, ignores: Array.isArray(ignores) ? ignores.map(String) : [] });
  }
  return sessions;
}

// The ignore patterns of this directory's session, or null when the daemon holds none.
export async function sessionIgnores(sessionId: string): Promise<string[] | null> {
  return (await listSessions()).get(getSyncSessionName(sessionId))?.ignores ?? null;
}

/**
 * Starts this directory's sync session, or resumes it when one with the same alias, remote path
 * and ignore rules exists.
 */
export async function startSync(
  localPath: string,
  sshAlias: string,
  config: ConnectionConfig,
  sessionId: string,
  ignorePatterns: readonly string[],
  onProgress?: (message: string) => void
): Promise<void> {
  await ensureMutagenInstalled(onProgress);

  const sessionName = getSyncSessionName(sessionId);
  const spec = syncSpec(sshAlias, config.remotePath, ignorePatterns);

  const existing = (await listSessions()).get(sessionName)?.spec;
  if (existing === spec) {
    onProgress?.("Resuming existing sync session...");
    await resumeSync(sessionId);
    return;
  }
  if (existing !== undefined) {
    // Created for another target or with other ignore rules, or by an older version that set
    // neither the label nor the credential ignores. Resuming would keep syncing under those.
    onProgress?.("Sync settings changed, restarting sync...");
    await stopSync(sessionId);
  }

  onProgress?.("Starting sync...");

  const args = [
    "sync", "create",
    "--name", sessionName,
    "--label", `${SPEC_LABEL}=${spec}`,
    "--sync-mode", "two-way-safe",
    ...buildMutagenIgnoreArgs(ignorePatterns),
    canonicalPath(localPath),
    `${sshAlias}:${config.remotePath}`,
  ];

  const result = await runMutagen(args, TIMEOUT_MS.connect);

  if (result.exitCode !== 0) {
    throw new Error(`Failed to start sync: ${result.stderr}`);
  }
}

// Ends the session in the daemon. A session that does not exist is already stopped.
export async function stopSync(sessionId: string): Promise<void> {
  const sessionName = getSyncSessionName(sessionId);

  const result = await runMutagen(["sync", "terminate", sessionName]);

  if (result.exitCode !== 0 && !result.stderr.includes(NO_SUCH_SESSION)) {
    throw new Error(`Failed to stop sync: ${result.stderr}`);
  }
}

export async function pauseSync(sessionId: string): Promise<void> {
  const result = await runMutagen(["sync", "pause", getSyncSessionName(sessionId)]);
  if (result.exitCode !== 0 && !result.stderr.includes(NO_SUCH_SESSION)) {
    throw new Error(`Failed to pause sync: ${result.stderr}`);
  }
}

export async function resumeSync(sessionId: string): Promise<void> {
  const result = await runMutagen(["sync", "resume", getSyncSessionName(sessionId)], TIMEOUT_MS.connect);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to resume sync: ${result.stderr}`);
  }
}

// Waits for one full sync cycle, so changes made just before disconnecting reach the other side.
export async function flushSync(sessionId: string): Promise<void> {
  const result = await runMutagen(["sync", "flush", getSyncSessionName(sessionId)], TIMEOUT_MS.flush);
  if (result.exitCode !== 0 && !result.stderr.includes(NO_SUCH_SESSION)) {
    throw new Error(`Failed to flush sync: ${result.stderr}`);
  }
}

// The daemon starts itself on first use and would otherwise run until the machine shuts down.
// Once no session is left there is nothing for it to do.
export async function stopDaemonIfIdle(): Promise<void> {
  if ((await listSessions()).size > 0) return;
  const result = await runMutagen(["daemon", "stop"]);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to stop the sync daemon: ${result.stderr}`);
  }
}

export async function getSyncStatus(sessionId: string): Promise<SyncStatus> {
  const sessionName = getSyncSessionName(sessionId);
  const result = await runMutagen(["sync", "list", "--template", STATUS_TEMPLATE]);

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
