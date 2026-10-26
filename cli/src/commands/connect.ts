import { existsSync } from "fs";
import {
  getConnection,
  saveConnection,
  findConnection,
  loadConnections,
  saveSession,
  deleteSession,
  generateSshAlias,
  probeAlias,
  newSessionId,
  sessionIdFor,
  parseSshString,
  isValidRemotePath,
  isValidIdentityFile,
  type ConnectionConfig,
  type SessionState,
} from "../config/store";
import { canonicalPath, contractPath, isDirectory, baseName } from "../utils/paths";
import { isSuspiciousPath } from "../utils/guards";
import { stripTerminalControl } from "../utils/terminal";
import { prompt, confirm, ask } from "../utils/prompt";
import {
  hasGitignore,
  loadGitignorePatterns,
  diffPatterns,
  patternsEqual,
  getAllIgnorePatterns,
  scanForCredentials,
  ignoreMatcher,
  SCAN_LIMIT,
  type CredentialScan,
} from "../sync/ignore";
import {
  findExistingKeys,
  hasHavenKey,
  getHavenPublicKey,
  generateHavenKey,
  analyzeKeys,
  identityCandidates,
  identityAgentSocket,
  getAllKeyPaths,
  type AgentSocket,
  type KeyAnalysis,
  type SshKeyInfo,
} from "../ssh/keys";
import {
  writeHostConfig,
  removeHostBlock,
  testConnection,
  getRemoteEnv,
  isAuthFailure,
  isHostKeyFailure,
  sshConfigDump,
  dumpValue,
  type HostBlock,
} from "../ssh/config";
import {
  checkHostKey,
  knownHostsName,
  trustHostKey,
  forgetHostKeys,
  describeHostKey,
  scanTypeOf,
} from "../ssh/hostkeys";
import { startSync, stopSync, pauseSync, resumeSync, sessionIgnores } from "../sync/mutagen";
import { remotePathsThatExist } from "../remote/exec";
import { ensureMutagenInstalled } from "../sync/download";
import { parseDuration, formatDuration } from "../utils/duration";
import { cleanupOnExit } from "../utils/exit";
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
  syncEnvFiles?: boolean | undefined;
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

async function ensureUsableKey(agentSocket: AgentSocket, workspaceUrl?: string): Promise<void> {
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

  const analyses = await analyzeKeys(undefined, agentSocket);
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

async function showSshKeyHelp(agentSocket: AgentSocket, workspaceUrl?: string): Promise<void> {
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
    info("Already added? Check that workspace is running.");
    blank();
  } else {
    const analyses = await analyzeKeys(undefined, agentSocket);
    const usableKeys = analyses.filter((a) => a.usable);

    if (usableKeys.length > 0) {
      console.log("━".repeat(60));
      console.log("");
      console.log(`  Your public key${usableKeys.length > 1 ? "s" : ""} (add one to workspace):`);
      console.log("");
      for (const { key } of usableKeys) {
        console.log(`  ${key.publicKey}`);
        console.log("");
      }
      console.log("━".repeat(60));
      blank();
      info(formatKeyInstructions(workspaceUrl));
      blank();
      info("Already added? Check that workspace is running.");
    } else {
      blank();
      console.log("🔑 No usable SSH keys. Generating a Haven key...");
      const key = await generateHavenKey();
      success(`Created ${contractPath(key.privateKeyPath)}`);
      console.log("━".repeat(60));
      console.log("");
      console.log("  Copy this public key:");
      console.log("");
      console.log(`  ${key.publicKey}`);
      console.log("");
      console.log("━".repeat(60));
      blank();
      info(formatKeyInstructions(workspaceUrl));
    }
    blank();
  }
}

function parseConnectionFromTarget(target: string, localPath: string): ConnectionConfig | null {
  const parsed = parseSshString(target);
  if (!parsed) {
    return null;
  }

  const remotePath = `/config/workspace/${baseName(localPath)}`;

  return {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    remotePath,
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

  return {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    remotePath,
  };
}

// The choices that belong to the local directory rather than to the target, so a reconnect to a
// new target keeps them, and so does a session still to be retired, which the directory names. The
// working key only carries over to the same host and port.
export function carryOverChoices(config: ConnectionConfig, stored: ConnectionConfig | null): void {
  if (!stored) return;
  if (stored.syncEnvFiles !== undefined) config.syncEnvFiles = stored.syncEnvFiles;
  if (stored.gitignorePatterns !== undefined) config.gitignorePatterns = stored.gitignorePatterns;
  if (stored.retiredSessionId !== undefined) config.retiredSessionId = stored.retiredSessionId;
  if (stored.identityFile !== undefined && stored.host === config.host && stored.port === config.port && stored.user === config.user) {
    config.identityFile = stored.identityFile;
  }
}

// An alias this directory used before (one from an older version, or for a target it no longer
// uses) is removed once no other connected directory still uses it.
function aliasesToDrop(localPath: string, previousAlias: string | undefined, alias: string): string[] {
  if (!previousAlias || previousAlias === alias) return [];
  const stillUsed = Object.entries(loadConnections()).some(
    ([path, config]) => path !== localPath && config.sshAlias === previousAlias,
  );
  return stillUsed ? [] : [previousAlias];
}

// Why the host key check got no key, in ssh's words, except where ssh's line carries the server's
// own text (a disconnect message, an answer that is not an SSH greeting): a stranger's words are
// never printed as the reason.
function unreachableReason(sshError: string): string {
  if (/^Received disconnect from /m.test(sshError)) {
    return "The server closed the connection before it sent a host key.";
  }
  if (/protocol version identification/i.test(sshError)) {
    return "The server did not answer the way an SSH server does.";
  }
  return sshError.split("\n")[0] ?? "";
}

// The ProxyJump or ProxyCommand an `ssh -G` dump shows, if any.
function proxyIn(dump: string): string | undefined {
  const value = dumpValue(dump, "proxyjump") ?? dumpValue(dump, "proxycommand");
  return value && value !== "none" ? value : undefined;
}

/**
 * Makes sure the host key the workspace presents is one the user has trusted, before anything
 * authenticates or syncs. A key seen for the first time, or one that differs from the key
 * known_hosts holds, is shown with its fingerprint and needs an explicit yes; the default is no.
 * The key is read through ssh with the probe alias, so a ProxyJump or ProxyCommand the user set
 * under `Host haven-*` or `Match host` applies as it does to every other connection; one set under
 * the workspace's own alias does not, and a check that fails for that reason says so.
 */
async function ensureHostKeyTrusted(
  alias: string,
  workspaceAlias: string,
  host: string,
  port: number,
  resetHostKey: boolean,
): Promise<void> {
  const dump = await sshConfigDump(alias);
  const name = knownHostsName(dump);

  if (resetHostKey) {
    const resetSpinner = createSpinner("Removing old host key...");
    resetSpinner.start();
    await forgetHostKeys(name);
    resetSpinner.succeed("Host key removed");
  }

  const spinner = createSpinner("Checking host key...");
  spinner.start();
  const { status, presented, known, error: sshError } = await checkHostKey(alias, dump);
  spinner.stop();

  if (status === "trusted") {
    return;
  }

  if (!presented) {
    error(`Cannot connect to ${host}:${port}`);
    blank();
    const reason = unreachableReason(sshError);
    if (reason) console.log(`  ${reason}`);
    blank();
    const proxy = proxyIn(await sshConfigDump(workspaceAlias));
    if (proxy && !proxyIn(dump)) {
      info(`Your ssh config reaches ${workspaceAlias} through a proxy (${stripTerminalControl(proxy)}), set for`);
      info("that alias alone. Haven checks the host key under an alias of its own, so the check went");
      info(`direct. Move the setting under \`Host haven-*\` or \`Match host ${host}\` in ~/.ssh/config.`);
      process.exit(1);
    }
    bullet("Workspace may be stopped");
    bullet("Network/firewall blocking port");
    process.exit(1);
  }

  const target = port === 22 ? host : `${host} (port ${port})`;
  const check = `ssh-keyscan -t ${scanTypeOf(presented)} localhost 2>/dev/null | ssh-keygen -lf -`;

  blank();
  if (known.length === 0) {
    warn(`First connection to ${target}`);
    info(`Host key: ${describeHostKey(presented)}`);
    blank();
    info("To check that this is your workspace, open its terminal in the browser, run the");
    info("command below and compare the fingerprint it prints:");
    info(`  ${check}`);
  } else {
    const previous = known.filter((k) => k.type === presented.type);
    warn(`The host key for ${target} has changed`);
    for (const key of previous.length > 0 ? previous : known) {
      info(`Trusted until now: ${describeHostKey(key)}`);
    }
    info(`Presented now:     ${describeHostKey(presented)}`);
    blank();
    info("EnvHaven workspaces now generate a host key of their own, so one change after you");
    info("update or rebuild your workspace is expected. If you did neither, the connection may");
    info("be intercepted. Before answering, open the workspace terminal in the browser, run the");
    info("command below and compare the fingerprint it prints:");
    info(`  ${check}`);
  }
  blank();

  const trusted = await confirm(
    known.length === 0 ? "Trust this host and connect?" : "Trust the new key and connect?",
    "n",
  );
  if (!trusted) {
    blank();
    info("Not connected. Nothing was synced.");
    process.exit(1);
  }

  await trustHostKey(name, presented);
  success("Host key saved to ~/.ssh/known_hosts");
}

function blockFor(base: Omit<HostBlock, "identityFiles" | "identitiesOnly">, identityFile: string | undefined): HostBlock {
  return identityFile
    ? { ...base, identityFiles: [identityFile], identitiesOnly: true }
    : { ...base, identityFiles: [], identitiesOnly: false };
}

// Keys offered per connection while looking for the one that works. One connection per key piled
// up refused logins, and OpenSSH 9.8+ answers three in quick succession by refusing the address
// for a while (PerSourcePenalties), so a user with a few keys was locked out halfway through.
// Five stays under sshd's default MaxAuthTries of 6 with room for a key the user's own config adds
// for every host.
const KEYS_PER_CONNECTION = 5;

interface WorkingKey {
  block: HostBlock;
  // The key the server accepted, when ssh says which one it was.
  identityFile: string | undefined;
  // True when no key was accepted on its own and the block leaves key selection to ssh.
  fallback: boolean;
}

/**
 * Finds the key that authenticates to this workspace and leaves the SSH config offering only it.
 * Candidates go in groups, each one connection that offers its keys in turn; `ssh -v` then names
 * the key the server accepted. The key recorded at the last connect comes first, so a reconnect
 * is one connection. When every key is refused, one last try lists them all with ssh's own key
 * selection left on, as before IdentitiesOnly: whatever ssh would have found (an agent behind an
 * IdentityAgent the scan missed, a key file outside ~/.ssh) still gets the user in.
 */
async function connectWithWorkingKey(
  base: Omit<HostBlock, "identityFiles" | "identitiesOnly">,
  candidates: string[],
  onTry: (label: string) => void,
): Promise<WorkingKey | { error: string }> {
  let lastError = "No SSH key to offer";
  for (let i = 0; i < candidates.length; i += KEYS_PER_CONNECTION) {
    const group = candidates.slice(i, i + KEYS_PER_CONNECTION);
    if (i > 0) onTry("Testing more keys...");
    const block: HostBlock = { ...base, identityFiles: group, identitiesOnly: true };
    writeHostConfig(block);
    const result = await testConnection(base.alias, group);
    if (result.success) {
      if (!result.acceptedIdentity) return { block, identityFile: undefined, fallback: false };
      const single = blockFor(base, result.acceptedIdentity);
      writeHostConfig(single);
      return { block: single, identityFile: result.acceptedIdentity, fallback: false };
    }
    lastError = result.error ?? lastError;
    // Only refused keys are worth more keys. Anything else (unreachable, a host key that
    // changed since the check above) fails the same way for every key.
    if (!isAuthFailure(result.error)) return { error: lastError };
  }

  onTry("Testing connection with ssh's own key selection...");
  const fallback: HostBlock = {
    ...base,
    identityFiles: getAllKeyPaths().filter(isValidIdentityFile),
    identitiesOnly: false,
  };
  writeHostConfig(fallback);
  const result = await testConnection(base.alias);
  if (result.success) return { block: fallback, identityFile: undefined, fallback: true };
  return { error: result.error ?? lastError };
}

// Records the choice on `config` when it is one: the flag, or an answer. The default taken because
// input ended (a pipe, CI) applies to this connect only, so the question comes back next time
// instead of a "no" nobody gave being remembered.
export async function resolveEnvFilesChoice(config: ConnectionConfig, option: boolean | undefined): Promise<boolean> {
  if (option !== undefined) {
    config.syncEnvFiles = option;
    return option;
  }
  if (config.syncEnvFiles !== undefined) return config.syncEnvFiles;

  blank();
  info(".env, .env.* (.env.local, .env.development, ...) and .npmrc files often hold API keys");
  info("and tokens, and the AI agents on the workspace can read everything synced to it. Your");
  info("answer is remembered for this directory; change it later with --sync-env-files or");
  info("--no-sync-env-files.");
  const answer = await ask("Sync .env, .env.* and .npmrc files to the workspace?", "n");
  if (answer === null) {
    info("No answer, so they stay on this machine for now; the next connect asks again.");
    return false;
  }
  config.syncEnvFiles = answer;
  return answer;
}

// Says which files the credential rules keep on this machine, so a missing CA bundle or test
// certificate on the workspace has an explanation.
function reportCredentialFiles(scan: CredentialScan): void {
  const files = [
    ...scan.byName,
    ...scan.privateKeys.map((path) => `${path} (holds a private key)`),
  ].sort();

  const shown = 8;
  if (files.length > 0) {
    blank();
    warn(`Not syncing ${files.length} file${files.length === 1 ? "" : "s"} that look${files.length === 1 ? "s" : ""} like keys or credentials:`);
    for (const file of files.slice(0, shown)) info(`  ${stripTerminalControl(file)}`);
    if (files.length > shown) info(`  and ${files.length - shown} more`);
    info("Haven does not sync them. If the workspace needs one, copy it there yourself (scp).");
  }
  // Said even when nothing was found: a silent stop would read as a clean result.
  if (!scan.complete) {
    blank();
    warn(`Stopped looking for private keys after ${SCAN_LIMIT.toLocaleString("en-US")} files and folders.`);
    info("A key file with an unusual name further in would sync; the name rules (*.pem, id_rsa and");
    info("the rest) still apply everywhere. Listing big folders in .gitignore keeps the look short.");
  }
}

/**
 * Names the files this connect stops syncing that the workspace still has, when the session before
 * it synced the same workspace folder under rules that let them sync: an upgrade from a version
 * that synced everything, a .env answer turned to no, a private key created since the last connect
 * under a name the rules miss. `previousIgnores` are that session's rules, as mutagen holds them
 * or, once `haven disconnect` has ended it, as the last connect recorded them (`syncIgnores`). A
 * file they kept out is not named, and a first connect names nothing: the workspace may have made
 * the file itself, or another folder may sync it there. Nothing is deleted and no command is
 * offered, since deleting a file on the workspace deletes it everywhere that syncs it.
 */
async function reportStaleCopies(
  sshAlias: string,
  config: ConnectionConfig,
  scan: CredentialScan,
  syncEnvFiles: boolean,
  previousIgnores: readonly string[],
): Promise<void> {
  const ignoredBefore = ignoreMatcher(previousIgnores);
  const newlyExcluded = [...scan.byName, ...scan.privateKeys, ...(syncEnvFiles ? [] : scan.envFiles)]
    .filter((path) => !ignoredBefore(path))
    .map((path) => path.replace(/\/$/, ""))
    .slice(0, 200);
  if (newlyExcluded.length === 0) return;
  const onWorkspace = await remotePathsThatExist(sshAlias, config.remotePath, newlyExcluded);
  if (onWorkspace.length === 0) return;

  blank();
  warn("These files are on the workspace and are not synced from now on:");
  for (const path of onWorkspace.slice(0, 8)) info(`  ${stripTerminalControl(path)}`);
  if (onWorkspace.length > 8) info(`  and ${onWorkspace.length - 8} more`);
  info("If Haven copied them there earlier, you may want to delete them on the workspace. Deleting");
  info("them there also deletes them from any other folder or machine that syncs the same workspace");
  info("folder.");
}

// The .gitignore lines that become sync ignores. Sync is two-way, so the workspace can rewrite
// .gitignore and so decide what syncs; a change since the last accepted version is shown and
// applies only when confirmed, and so does deleting the file, which would otherwise let what its
// lines kept here sync without a word. With no accepted version (a first connect, a no last time,
// a connection an older version made) a file the workspace wrote would apply unseen, so its `!`
// lines, the ones that re-include files, are listed first and the question defaults to no. A
// default taken because input ended applies to this connect but is not recorded as accepted.
export async function resolveGitignorePatterns(
  localPath: string,
  config: ConnectionConfig,
  useGitignoreOption: boolean | undefined,
): Promise<string[]> {
  // Read once, so the lines shown are the lines applied.
  const current = loadGitignorePatterns(localPath);
  const exists = hasGitignore(localPath);
  const accepted = config.gitignorePatterns;
  const negations = accepted === undefined ? current.filter((pattern) => pattern.startsWith("!")) : [];
  const deleted = !exists && accepted !== undefined && accepted.length > 0;
  let useGitignore = ((useGitignoreOption ?? false) || deleted) && negations.length === 0;
  let answered = useGitignore;

  if (!useGitignore && exists) {
    blank();
    if (negations.length > 0) {
      warn(".gitignore re-includes files with these lines, and the workspace can edit it through sync:");
      for (const pattern of negations) info(`  ${stripTerminalControl(pattern)}`);
    }
    const answer = await ask("Found .gitignore. Exclude matching files from sync?", negations.length > 0 ? "n" : "y");
    useGitignore = answer ?? negations.length === 0;
    answered = answer !== null;
  }
  if (!useGitignore) return [];

  if (accepted === undefined) {
    if (answered) config.gitignorePatterns = current;
    return current;
  }

  if (patternsEqual(accepted, current)) return current;

  const { added, removed } = diffPatterns(accepted, current);
  blank();
  warn(deleted
    ? ".gitignore was deleted since the last connect, and the workspace can delete it through sync:"
    : ".gitignore changed since the last connect, and the workspace can edit it through sync:");
  for (const pattern of added) info(`+ ${stripTerminalControl(pattern)}`);
  for (const pattern of removed) info(`- ${stripTerminalControl(pattern)}`);
  if (added.length === 0 && removed.length === 0) {
    info("Rules were reordered or repeated; Mutagen applies the last matching rule.");
  }
  blank();
  if (await confirm("Apply these changes to what syncs?", "n")) {
    config.gitignorePatterns = current;
    return current;
  }
  info("Keeping the previous rules.");
  return accepted;
}

/**
 * Terminates the session that the move to SHA-256 ids replaced, which the connection names until
 * it is gone (`retiredSessionId`): the one this connect paused, or one an earlier connect could not
 * end. Left paused with nothing naming it, it outlived every disconnect and kept the daemon
 * running. `haven connect` and `haven disconnect` both call this. `stop` is replaceable for tests.
 */
export async function retireSession(localPath: string, config: ConnectionConfig, stop = stopSync): Promise<void> {
  const retired = config.retiredSessionId;
  if (retired === undefined || retired === config.sessionId) return;
  try {
    await stop(retired);
  } catch (err) {
    // Paused before its replacement started, so it cannot race the new one meanwhile.
    warn(`The previous sync session is paused but could not be removed; the next connect or disconnect tries again: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  deleteSession(retired);
  delete config.retiredSessionId;
  try {
    saveConnection(localPath, config);
  } catch {
    // The name stays on disk, and the next connect finds that session already gone.
  }
}

export async function connect(pathArg: string | undefined, options: ConnectOptions): Promise<void> {
  let localPath: string;
  let stored: ConnectionConfig | null;

  if (pathArg) {
    localPath = canonicalPath(pathArg);
    
    if (!isDirectory(localPath)) {
      error(`Path does not exist or is not a directory: ${pathArg}`);
      process.exit(1);
    }
    
    stored = getConnection(localPath);
  } else {
    const found = findConnection(process.cwd());
    
    if (found) {
      localPath = found.localPath;
      stored = found.config;
    } else {
    error("No path specified and no parent directory is connected.");
    info("Usage: haven connect <path>");
    info("       haven connect . <host>");
      process.exit(1);
    }
  }

  // On every connect, the saved one included: a reconnect re-syncs whatever directory is saved. A
  // no is not a success: a script that runs `haven connect && haven npm test` must not go on.
  if (isSuspiciousPath(localPath)) {
    blank();
    warn(`"${contractPath(localPath)}" is unusually broad for a project directory.`);
    blank();
    if (!(await confirm("Are you sure you want to sync this path?", "n"))) {
      process.exit(1);
    }
  }

  let config: ConnectionConfig | null = null;
  if (options.target) {
    config = parseConnectionFromTarget(options.target, localPath);
    if (!config) {
      error("Invalid connection format. Expected: host, user@host, or user@host:port");
      process.exit(1);
    }
  }

  const workspaceUrl = getWorkspaceUrl(options.target);

  if (!config) {
    config = stored ? { ...stored } : await promptForConnection(localPath);
  }
  carryOverChoices(config, stored);

  if (!isValidRemotePath(config.remotePath)) {
    error(`Invalid remote path: ${JSON.stringify(config.remotePath)}. It must be absolute, without control characters.`);
    process.exit(1);
  }

  const sshAlias = generateSshAlias(config.host, config.port, config.user);
  const drop = aliasesToDrop(localPath, stored?.sshAlias, sshAlias);
  config.sshAlias = sshAlias;

  const sessionId = newSessionId(localPath);
  const previousSessionId = stored ? sessionIdFor(localPath, stored) : undefined;
  config.sessionId = sessionId;

  // The agent ssh will use for this alias, which 1Password and Secretive set with IdentityAgent.
  const agentSocket = await identityAgentSocket(sshAlias);
  await ensureUsableKey(agentSocket, workspaceUrl);

  const recorded = config.identityFile && existsSync(config.identityFile) ? config.identityFile : undefined;
  const candidates = (await identityCandidates(agentSocket)).filter((c) => c !== recorded && isValidIdentityFile(c));
  const ordered = recorded ? [recorded, ...candidates] : candidates;
  const base = { alias: sshAlias, host: config.host, port: config.port, user: config.user };

  // Everything up to a working login goes through a probe alias with the same HostName, Port and
  // User (so ssh reads the same known_hosts entries), and the workspace's own entry is written only
  // once a key has logged in: mutagen and `haven <cmd>` use that entry, so a reconnect that is
  // refused, declined or interrupted must leave it as it was. The probe entry is removed however
  // the process ends.
  const probe = { ...base, alias: probeAlias(sshAlias) };
  writeHostConfig(blockFor(probe, ordered[0]));
  const stopProbeCleanup = cleanupOnExit(() => {
    try {
      removeHostBlock(probe.alias);
    } catch {
      // Exiting anyway; the next connect to this workspace rewrites and removes it.
    }
  });

  await ensureHostKeyTrusted(probe.alias, sshAlias, config.host, config.port, options.resetHostKey === true);

  const connSpinner = createSpinner("Testing connection...");
  connSpinner.start();

  const connResult = await connectWithWorkingKey(probe, ordered, (label) => connSpinner.update(label));

  if ("error" in connResult) {
    connSpinner.fail("Connection failed");
    blank();
    error(`Cannot connect to ${config.host}:${config.port}`);
    blank();
    console.log(`  ${connResult.error.split('\n')[0]}`);

    if (isHostKeyFailure(connResult.error)) {
      blank();
      info("At login the server did not prove it holds the host key you trust: it presented another");
      info("key, or the trusted one without being able to sign with it. The connection may be");
      info("intercepted, and no key of yours was offered to it. Run 'haven connect' again; if this");
      info("repeats, check the network you are on.");
      process.exit(1);
    }

    blank();
    bullet("Workspace may be stopped");
    bullet("Network/firewall blocking port");
    bullet("SSH key not added to workspace");
    blank();

    await showSshKeyHelp(agentSocket, workspaceUrl);

    process.exit(1);
  }

  const block: HostBlock = { ...connResult.block, alias: sshAlias };
  writeHostConfig(block, [probe.alias]);
  stopProbeCleanup();

  if (connResult.identityFile) {
    config.identityFile = connResult.identityFile;
  } else {
    delete config.identityFile;
  }
  connSpinner.succeed("SSH connection successful");
  if (connResult.fallback) {
    warn("No single key was accepted on its own, so this workspace is offered every key ssh");
    info("would offer. Add one key to the workspace (Remote Access) and connect again to go back");
    info("to offering only that one.");
  }

  let idleTimeout: number | undefined;
  
  if (options.idleTimeout) {
    idleTimeout = parseDuration(options.idleTimeout) ?? undefined;
  } else {
    const remoteTimeout = await getRemoteEnv(sshAlias, "HAVEN_IDLE_TIMEOUT");
    if (remoteTimeout) {
      idleTimeout = parseDuration(remoteTimeout) ?? undefined;
    }
  }

  const syncEnvFiles = await resolveEnvFilesChoice(config, options.syncEnvFiles);
  const gitignorePatterns = await resolveGitignorePatterns(localPath, config, options.useGitignore);

  // The scan reads the header of every small file, which takes a moment in a big project, so the
  // spinner is up first; what it found is reported once sync has started.
  const syncSpinner = createSpinner("Starting sync...");
  syncSpinner.start();
  const credentials = scanForCredentials(localPath, gitignorePatterns);
  const ignorePatterns = getAllIgnorePatterns(gitignorePatterns, syncEnvFiles, credentials.privateKeys);

  // A session an older version named with the 32-bit id stays paused until the replacement and its
  // new connection state are both durable. A failure before that commit must not leave two active
  // sessions, or a new session that `haven disconnect` cannot find.
  const migrating = previousSessionId !== undefined && previousSessionId !== sessionId;
  // The rules of the session this directory synced the same workspace folder with until now: they
  // say which files Haven may have copied there (reportStaleCopies). The session's own, read before
  // it is replaced, or when `haven disconnect` has ended it, the ones the last connect recorded.
  const sameFolder = stored !== null
    && stored.host === config.host && stored.port === config.port && stored.user === config.user
    && stored.remotePath === config.remotePath;
  let previousIgnores: string[] | null = null;
  try {
    await ensureMutagenInstalled((msg) => syncSpinner.update(msg));
    if (sameFolder) {
      previousIgnores = (await sessionIgnores(migrating ? previousSessionId : sessionId)) ?? stored?.syncIgnores ?? null;
    }
    if (migrating) await pauseSync(previousSessionId);
    try {
      await startSync(localPath, sshAlias, config, sessionId, ignorePatterns, (msg) => syncSpinner.update(msg));
      config.syncIgnores = ignorePatterns;
    } catch (err) {
      if (migrating) await resumeSync(previousSessionId).catch(() => {});
      throw err;
    }
  } catch (err) {
    syncSpinner.fail("Sync failed");
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  config.lastConnected = Date.now();
  const sessionState: SessionState = {
    connected: true,
    startTime: Date.now(),
  };
  if (idleTimeout !== undefined) sessionState.idleTimeout = idleTimeout;
  // Committed with the connection, so a terminate that fails below is tried again next time.
  if (migrating) config.retiredSessionId = previousSessionId;

  let sessionSaved = false;
  try {
    // Session first: if this write fails, the old connection still points at the old session. If
    // the connection write then fails, the rollback below removes this new state again.
    saveSession(sessionId, sessionState);
    sessionSaved = true;
    saveConnection(localPath, config);
  } catch (err) {
    if (migrating || stored === null) {
      if (sessionSaved) deleteSession(sessionId);
      try {
        await stopSync(sessionId);
      } catch (rollbackError) {
        warn(`Could not stop the untracked new sync session: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      if (migrating) {
        try {
          await resumeSync(previousSessionId);
        } catch (rollbackError) {
          warn(`Could not resume the previous sync session: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
    }
    syncSpinner.fail("Sync failed");
    error(`Could not save the connection: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  syncSpinner.succeed("Sync started");
  await retireSession(localPath, config);

  reportCredentialFiles(credentials);
  if (previousIgnores) await reportStaleCopies(sshAlias, config, credentials, syncEnvFiles, previousIgnores);

  // Only now is the alias this directory used before (if any) safe to remove. The workspace's own
  // entry was written above, so a failure here leaves a stale entry and nothing broken.
  if (drop.length > 0) {
    try {
      writeHostConfig(block, drop);
    } catch (err) {
      warn(`Could not remove the old SSH entry ${drop.join(", ")}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
