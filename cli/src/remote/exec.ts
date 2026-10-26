import { buildRemoteCommand, posixQuote } from "./quote";
import type { ConnectionConfig } from "../config/store";
import { mapLocalToRemote, canonicalPath } from "../utils/paths";
import { stripTerminalControl } from "../utils/terminal";

export interface ExecOptions {
  cwd?: string;
  inheritStdio?: boolean;
}

export async function runRemote(
  sshAlias: string,
  config: ConnectionConfig,
  localProjectRoot: string,
  args: readonly string[],
  options: ExecOptions = {}
): Promise<number> {
  const localCwd = options.cwd ? canonicalPath(options.cwd) : process.cwd();
  const remoteCwd = mapLocalToRemote(localProjectRoot, config.remotePath, localCwd);

  const remoteCommand = buildRemoteCommand(remoteCwd, args);

  // Allocate a pseudo-terminal if we're in an interactive session
  // This is required for interactive programs like opencode, vim, htop, etc.
  const isInteractive =
    options.inheritStdio !== false &&
    process.stdin.isTTY &&
    process.stdout.isTTY;

  const sshArgs = isInteractive
    ? ["-t", sshAlias, remoteCommand]
    : [sshAlias, remoteCommand];

  const proc = Bun.spawn(["ssh", ...sshArgs], {
    stdin: options.inheritStdio !== false ? "inherit" : "pipe",
    stdout: options.inheritStdio !== false ? "inherit" : "pipe",
    stderr: options.inheritStdio !== false ? "inherit" : "pipe",
  });

  return await proc.exited;
}

/**
 * Which of `paths` (relative to `remoteRoot`) exist on the workspace, asked in one ssh call and
 * without changing anything there. Empty when the question could not be asked: callers use it to
 * inform, never to decide.
 */
export async function remotePathsThatExist(
  sshAlias: string,
  remoteRoot: string,
  paths: readonly string[],
): Promise<string[]> {
  if (paths.length === 0) return [];
  const list = paths.map(posixQuote).join(" ");
  const script = `cd ${posixQuote(remoteRoot)} 2>/dev/null || exit 0; for p in ${list}; do if [ -e "$p" ] || [ -L "$p" ]; then printf '%s\\n' "$p"; fi; done`;
  const proc = Bun.spawn(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "LogLevel=ERROR", sshAlias, script],
    { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) return [];
  const asked = new Set(paths);
  return stripTerminalControl(stdout).split("\n").filter((line) => asked.has(line));
}
