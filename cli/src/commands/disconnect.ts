import { findConnection, loadSession, deleteSession, sessionIdFor } from "../config/store";
import { closeControlMaster } from "../ssh/config";
import { stopSync, flushSync, stopDaemonIfIdle } from "../sync/mutagen";
import { formatDuration } from "../utils/duration";
import { createSpinner, success, info, error, warn, blank } from "../utils/spinner";
import { canonicalPath } from "../utils/paths";
import { retireSession } from "./connect";

// `sync` is replaceable for tests.
export async function disconnect(pathArg?: string, sync = { flushSync, stopSync, stopDaemonIfIdle }): Promise<void> {
  let localPath: string;

  if (pathArg) {
    localPath = canonicalPath(pathArg);
  } else {
    const found = findConnection(process.cwd());
    if (!found) {
      error("Not connected to any workspace.");
      info("Run 'haven connect <path>' to connect first.");
      process.exit(1);
    }
    localPath = found.localPath;
  }

  const found = findConnection(localPath);
  if (!found) {
    error("No connection found for this directory.");
    process.exit(1);
  }

  const { config } = found;
  const sessionId = sessionIdFor(found.localPath, config);
  const session = loadSession(sessionId);

  const flushSpinner = createSpinner("Flushing pending changes...");
  flushSpinner.start();

  try {
    await sync.flushSync(sessionId);
    flushSpinner.succeed("Changes flushed");
  } catch (err) {
    // Stopping sync still matters more than the last cycle; nothing is deleted on either side.
    flushSpinner.fail("Flush failed; the latest changes may not have reached the other side");
    warn(err instanceof Error ? err.message : String(err));
  }

  const stopSpinner = createSpinner("Stopping sync...");
  stopSpinner.start();

  try {
    await sync.stopSync(sessionId);
    stopSpinner.succeed("Sync stopped");
  } catch (err) {
    // The session may still be live in the daemon and resume syncing when the network returns,
    // so this is a failure: the session file stays, and `haven status` keeps showing it.
    stopSpinner.fail("Stop sync failed");
    error(err instanceof Error ? err.message : String(err));
    info("Sync may still be running. Run 'haven disconnect' again.");
    process.exit(1);
  }

  // A session a connect paused and could not terminate counts as one, and would keep the daemon
  // below running until the next connect.
  await retireSession(found.localPath, config, sync.stopSync);

  if (config.sshAlias) {
    closeControlMaster(config.sshAlias);
  }

  deleteSession(sessionId);

  try {
    await sync.stopDaemonIfIdle();
  } catch (err) {
    // The session is already gone; a daemon left running holds no sync.
    warn(err instanceof Error ? err.message : String(err));
  }

  blank();
  success("Disconnected");

  if (session?.startTime) {
    const duration = Date.now() - session.startTime;
    info(`Session: ${formatDuration(duration)}`);
  }
}
