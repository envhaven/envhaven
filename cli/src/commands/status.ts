import { findConnection, loadSession, sessionIdFor } from "../config/store";
import { getSyncStatus, formatSyncStatus } from "../sync/mutagen";
import { formatDuration } from "../utils/duration";
import { contractPath, canonicalPath } from "../utils/paths";
import { connected, disconnected, info, warn, blank, bullet } from "../utils/spinner";
import { testConnection } from "../ssh/config";

export interface StatusOptions {
  json?: boolean;
  watch?: boolean;
  diagnose?: boolean;
}

interface StatusData {
  connected: boolean;
  host?: string;
  port?: number;
  localPath?: string;
  remotePath?: string;
  syncStatus?: string;
  sessionDuration?: string;
  conflicts?: string[];
  errors?: string[];
}

async function getStatusData(pathArg?: string): Promise<StatusData> {
  const startPath = pathArg ? canonicalPath(pathArg) : process.cwd();
  const found = findConnection(startPath);

  if (!found) {
    return { connected: false };
  }

  const { localPath, config } = found;
  const sessionId = sessionIdFor(localPath, config);
  const session = loadSession(sessionId);
  const syncStatus = await getSyncStatus(sessionId);

  const data: StatusData = {
    connected: session?.connected ?? false,
    host: config.host,
    port: config.port,
    localPath: localPath,
    remotePath: config.remotePath,
    syncStatus: syncStatus.status,
    conflicts: syncStatus.conflicts,
    errors: syncStatus.errors,
  };

  if (session?.startTime) {
    data.sessionDuration = formatDuration(Date.now() - session.startTime);
  }

  return data;
}

function printStatus(data: StatusData): void {
  if (!data.connected || !data.host) {
    disconnected();
    return;
  }

  connected(`${data.host}:${data.port}`);
  info(`${contractPath(data.localPath!)} ↔ ${data.remotePath}`);
  
  if (data.syncStatus) {
    info(`Sync: ${formatSyncStatus(data.syncStatus as Parameters<typeof formatSyncStatus>[0])}`);
  }
  
  if (data.sessionDuration) {
    info(`Session: ${data.sessionDuration}`);
  }

  if (data.conflicts && data.conflicts.length > 0) {
    blank();
    warn(`${data.conflicts.length} sync conflict(s):`);
    for (const conflict of data.conflicts) {
      bullet(conflict);
    }
  }

  if (data.errors && data.errors.length > 0) {
    blank();
    warn("Errors:");
    for (const err of data.errors) {
      bullet(err);
    }
  }
}

function printJson(data: StatusData): void {
  console.log(JSON.stringify(data, null, 2));
}

async function diagnose(pathArg?: string): Promise<void> {
  const startPath = pathArg ? canonicalPath(pathArg) : process.cwd();
  const found = findConnection(startPath);

  console.log("=== Haven CLI Diagnostics ===");
  blank();

  if (!found) {
    console.log("Status: Not connected");
    console.log("No connection configuration found for this directory.");
    return;
  }

  const { localPath, config } = found;

  console.log(`Local path: ${localPath}`);
  console.log(`Remote: ${config.user}@${config.host}:${config.port}${config.remotePath}`);
  console.log(`SSH alias: ${config.sshAlias}`);
  blank();

  console.log("Testing SSH connection...");
  if (config.sshAlias) {
    const sshResult = await testConnection(config.sshAlias);
    console.log(`SSH: ${sshResult.success ? "OK" : "FAILED"}`);
    if (sshResult.error) {
      console.log(`Error: ${sshResult.error}`);
    }
  } else {
    console.log("SSH: no alias saved; run 'haven connect' to set it up again");
  }
  blank();

  console.log("Checking sync status...");
  const syncStatus = await getSyncStatus(sessionIdFor(localPath, config));
  console.log(`Sync status: ${syncStatus.status}`);
  
  if (syncStatus.conflicts.length > 0) {
    console.log(`Conflicts: ${syncStatus.conflicts.length}`);
    for (const c of syncStatus.conflicts) {
      console.log(`  - ${c}`);
    }
  }
  
  if (syncStatus.errors.length > 0) {
    console.log(`Errors:`);
    for (const e of syncStatus.errors) {
      console.log(`  - ${e}`);
    }
  }
}

export async function status(pathArg: string | undefined, options: StatusOptions): Promise<void> {
  if (options.diagnose) {
    await diagnose(pathArg);
    return;
  }

  if (options.watch) {
    await watchStatus(pathArg, options.json);
    return;
  }

  const data = await getStatusData(pathArg);

  if (options.json) {
    printJson(data);
  } else {
    printStatus(data);
  }
}

async function watchStatus(pathArg?: string, json?: boolean): Promise<void> {
  const clearScreen = () => {
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[2J\x1b[H");
    }
  };

  const refresh = async () => {
    const data = await getStatusData(pathArg);
    clearScreen();
    
    if (json) {
      printJson(data);
    } else {
      printStatus(data);
      blank();
      info("Press Ctrl+C to exit");
    }
  };

  await refresh();
  
  const interval = setInterval(refresh, 2000);

  process.on("SIGINT", () => {
    clearInterval(interval);
    process.exit(0);
  });

  await new Promise(() => {});
}
