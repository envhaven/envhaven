import { createInterface } from "readline";
import {
  getConnection,
  saveConnection,
  findConnection,
  saveSession,
  generateSshAlias,
  parseSshString,
  type ConnectionConfig,
} from "../config/store";
import { canonicalPath, contractPath, isDirectory, baseName } from "../utils/paths";
import { isSuspiciousPath } from "../utils/guards";
import { hasGitignore } from "../sync/ignore";
import {
  findExistingKeys,
  hasHavenKey,
  getHavenPublicKey,
  generateHavenKey,
  analyzeKeys,
  type KeyAnalysis,
  type SshKeyInfo,
} from "../ssh/keys";
import { writeHostConfig, testConnection, getRemoteEnv, removeHostKey } from "../ssh/config";
import { startSync } from "../sync/mutagen";
import { parseDuration, formatDuration } from "../utils/duration";
import { createSpinner, success, error, info, warn, blank, bullet } from "../utils/spinner";

function getWorkspaceUrl(target: string | undefined): string | undefined {
  if (!target) return undefined;
  
  if (!target.includes('@') && !target.includes('.')) {
    return `https://${target}.envhaven.app`;
  }
  
  if (target.endsWith('.envhaven.app') && target.startsWith('ssh-')) {
    const subdomain = target.replace('ssh-', '').replace('.envhaven.app', '');
    return `https://${subdomain}.envhaven.app`;
  }
  
  return undefined;
}

function formatKeyInstructions(workspaceUrl?: string): string {
  if (workspaceUrl) {
    return `Add key: ${workspaceUrl} → Remote Access`;
  }
  return `Add key in your workspace (open in browser) → Remote Access`;
}

export interface ConnectOptions {
  idleTimeout?: string | undefined;
  resetHostKey?: boolean | undefined;
  target?: string | undefined;
  useGitignore?: boolean | undefined;
}

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const suffix = defaultValue ? ` [${defaultValue}]` : "";

  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

async function showGeneratedKey(key: SshKeyInfo, workspaceUrl?: string): Promise<void> {
  blank();
  console.log("━".repeat(60));
  console.log("");
  console.log("  Copy this public key:");
  console.log("");
  console.log(`  ${key.publicKey}`);
  console.log("");
  console.log("━".repeat(60));
  blank();
  info(formatKeyInstructions(workspaceUrl));
  blank();
  await prompt("Press Enter when ready...");
}

async function ensureUsableKey(workspaceUrl?: string): Promise<void> {
  const keys = findExistingKeys();

  if (keys.length === 0) {
    blank();
    console.log("🔑 No SSH keys found. Generating a Haven key...");
    const key = await generateHavenKey();
    success(`Created ${contractPath(key.privateKeyPath)}`);
    await showGeneratedKey(key, workspaceUrl);
    return;
  }

  if (hasHavenKey()) {
    return;
  }

  const analyses = await analyzeKeys();
  const hasUsable = analyses.some((a) => a.usable);

  if (hasUsable) {
    return;
  }

  await promptForEncryptedKeyResolution(analyses, workspaceUrl);
}

async function promptForEncryptedKeyResolution(
  analyses: KeyAnalysis[],
  workspaceUrl?: string
): Promise<void> {
  blank();
  warn("Your SSH keys are encrypted (passphrase-protected)");
  blank();
  console.log("  Found keys:");
  for (const a of analyses) {
    const status = a.inAgent ? "in agent ✓" : "not in agent";
    console.log(`    ${contractPath(a.key.privateKeyPath)} (encrypted, ${status})`);
  }
  blank();
  console.log("  Haven uses non-interactive SSH which can't prompt for passphrases.");
  blank();

  console.log("What would you like to do?");
  blank();
  console.log("  [1] Generate a Haven key (recommended)");
  console.log("      One-time setup, no passphrase, works everywhere");
  blank();
  console.log("  [2] Load your key into ssh-agent first");
  console.log("      Run: eval \"$(ssh-agent -s)\" && ssh-add");
  blank();

  const choice = await prompt("Choice", "1");

  if (choice === "1") {
    const spinner = createSpinner("Generating Haven key...");
    spinner.start();
    const key = await generateHavenKey();
    spinner.succeed(`Created ${contractPath(key.privateKeyPath)}`);
    await showGeneratedKey(key, workspaceUrl);
    return;
  }

  blank();
  info("Load your key into ssh-agent:");
  blank();
  console.log("   eval \"$(ssh-agent -s)\"");
  console.log("   ssh-add");
  blank();
  info("Then run 'haven connect' again.");
  process.exit(1);
}

function showSshKeyHelp(workspaceUrl?: string): void {
  const havenKey = getHavenPublicKey();

  if (havenKey) {
    console.log("━".repeat(60));
    console.log("");
    console.log("  Your Haven public key (copy this):");
    console.log("");
    console.log(`  ${havenKey}`);
    console.log("");
    console.log("━".repeat(60));
    blank();
    info(formatKeyInstructions(workspaceUrl));
    blank();
  } else {
    info("Run 'haven connect' again to generate a Haven key.");
    blank();
  }
}

function parseConnectionFromTarget(target: string, localPath: string): ConnectionConfig | null {
  const parsed = parseSshString(target);
  if (!parsed) {
    return null;
  }

  const remotePath = `/config/workspace/${baseName(localPath)}`;
  const sshAlias = generateSshAlias(parsed.host, parsed.port);

  return {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    remotePath,
    sshAlias,
  };
}

async function promptForConnection(localPath: string): Promise<ConnectionConfig> {
  blank();
  console.log("No remote target configured for this directory.");
  blank();

  const sshInput = await prompt("SSH connection (host or user@host[:port])");
  const parsed = parseSshString(sshInput);
  
  if (!parsed) {
    throw new Error("Invalid connection format. Expected: host, user@host, or user@host:port");
  }

  const defaultRemotePath = `/config/workspace/${baseName(localPath)}`;
  const remotePath = await prompt("Remote path", defaultRemotePath);

  const sshAlias = generateSshAlias(parsed.host, parsed.port);

  return {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    remotePath,
    sshAlias,
  };
}

export async function connect(pathArg: string | undefined, options: ConnectOptions): Promise<void> {
  let localPath: string;
  let config: ConnectionConfig | null = null;

  if (pathArg) {
    localPath = canonicalPath(pathArg);
    
    if (!isDirectory(localPath)) {
      error(`Path does not exist or is not a directory: ${pathArg}`);
      process.exit(1);
    }
    
    if (isSuspiciousPath(localPath)) {
      blank();
      warn(`"${contractPath(localPath)}" is unusually broad for a project directory.`);
      blank();
      const answer = await prompt("Are you sure you want to sync this path? [y/N]", "N");
      if (answer.toLowerCase() !== "y") {
        process.exit(0);
      }
    }
    
    config = getConnection(localPath);
  } else {
    const found = findConnection(process.cwd());
    
    if (found) {
      localPath = found.localPath;
      config = found.config;
    } else {
    error("No path specified and no parent directory is connected.");
    info("Usage: haven connect <path>");
    info("       haven connect . <host>");
      process.exit(1);
    }
  }

  const workspaceUrl = getWorkspaceUrl(options.target);
  
  await ensureUsableKey(workspaceUrl);

  if (options.target) {
    const parsed = parseConnectionFromTarget(options.target, localPath);
  if (!parsed) {
    error("Invalid connection format. Expected: host, user@host, or user@host:port");
    process.exit(1);
  }
    config = parsed;
  }

  if (!config) {
    config = await promptForConnection(localPath);
  }

  const sshAlias = config.sshAlias ?? generateSshAlias(config.host, config.port);
  config.sshAlias = sshAlias;

  if (options.resetHostKey) {
    const spinner = createSpinner("Removing old host key...");
    spinner.start();
    await removeHostKey(config.host, config.port);
    spinner.succeed("Host key removed");
  }

  writeHostConfig(sshAlias, config.host, config.port, config.user);

  const connSpinner = createSpinner("Testing connection...");
  connSpinner.start();

  const connResult = await testConnection(sshAlias);

  if (!connResult.success) {
    if (connResult.error?.includes("Host key verification failed")) {
      connSpinner.stop();
      blank();
      const answer = await prompt("Connection fingerprint changed. If you recently updated your workspace, this is expected. Reconnect? [Y/n]", "Y");
      
      if (answer.toLowerCase() === "n") {
        blank();
        info("Run 'haven connect --reset-host-key' when ready to reconnect.");
        process.exit(1);
      }
      
      await removeHostKey(config.host, config.port);
      
      const retrySpinner = createSpinner("Reconnecting...");
      retrySpinner.start();
      
      const retryResult = await testConnection(sshAlias);
      
      if (!retryResult.success) {
        retrySpinner.fail("Connection failed");
        blank();
        error(`Cannot connect to ${config.host}:${config.port}`);
        if (retryResult.error) {
          blank();
          console.log(`  ${retryResult.error.split('\n')[0]}`);
        }
        process.exit(1);
      }
      
      connSpinner.succeed("SSH connection successful");
    } else {
      connSpinner.fail("Connection failed");
      blank();
      error(`Cannot connect to ${config.host}:${config.port}`);
      
      if (connResult.error) {
        blank();
        console.log(`  ${connResult.error.split('\n')[0]}`);
      }
      
      blank();
      bullet("Workspace may be stopped");
      bullet("Network/firewall blocking port");
      bullet("SSH key not added to workspace");
      blank();

      showSshKeyHelp(workspaceUrl);

      process.exit(1);
    }
  }

  connSpinner.succeed("SSH connection successful");

  let idleTimeout: number | undefined;
  
  if (options.idleTimeout) {
    idleTimeout = parseDuration(options.idleTimeout) ?? undefined;
  } else {
    const remoteTimeout = await getRemoteEnv(sshAlias, "HAVEN_IDLE_TIMEOUT");
    if (remoteTimeout) {
      idleTimeout = parseDuration(remoteTimeout) ?? undefined;
    }
  }

  let useGitignore = options.useGitignore ?? false;
  
  if (!useGitignore && hasGitignore(localPath)) {
    blank();
    const answer = await prompt("Found .gitignore. Exclude matching files from sync? [Y/n]", "Y");
    useGitignore = answer.toLowerCase() !== "n";
  }

  const syncSpinner = createSpinner("Starting sync...");
  syncSpinner.start();

  try {
    await startSync(localPath, sshAlias, config, useGitignore, (msg) => syncSpinner.update(msg));
    syncSpinner.succeed("Sync started");
  } catch (err) {
    syncSpinner.fail("Sync failed");
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  config.lastConnected = Date.now();
  saveConnection(localPath, config);

  const sessionState: import("../config/store").SessionState = {
    connected: true,
    startTime: Date.now(),
  };
  if (idleTimeout !== undefined) {
    sessionState.idleTimeout = idleTimeout;
  }
  saveSession(localPath, sessionState);

  blank();
  success(`Connected to ${config.host}:${config.port}`);
  info(`Local:  ${contractPath(localPath)}`);
  info(`Remote: ${config.remotePath}`);
  
  if (idleTimeout !== undefined && idleTimeout > 0) {
    info(`Idle timeout: ${formatDuration(idleTimeout)}`);
  }
  
  blank();
  info("Try: haven opencode");
}
