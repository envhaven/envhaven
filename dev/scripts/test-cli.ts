#!/usr/bin/env bun
import { $, spawn, spawnSync } from 'bun';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { loadConfig, CLI_DIR, DEV_ROOT, log, formatTestSummary, isContainerRunning } from './lib';

const config = loadConfig();
const ciMode = process.argv.includes('--ci');
const testDir = process.env.ENVHAVEN_TEST_DIR || '/tmp/haven-cli-test';

let passed = 0;
let failed = 0;

function pass(msg: string) {
  log.success(msg);
  passed++;
}

function fail(msg: string) {
  log.error(msg);
  failed++;
}

async function haven(...args: string[]): Promise<{ exitCode: number; output: string }> {
  try {
    const result = await $`bun run ${join(CLI_DIR, 'src/index.ts')} ${args}`.cwd(testDir).quiet();
    return { exitCode: 0, output: result.text() };
  } catch (e: any) {
    return { exitCode: e.exitCode || 1, output: e.stderr?.toString() || '' };
  }
}

async function setupSshKeys(): Promise<boolean> {
  log.header('Setting up SSH keys');
  
  let sshKeyPath = '';
  for (const key of [`${process.env.HOME}/.ssh/id_ed25519`, `${process.env.HOME}/.ssh/id_rsa`]) {
    if (existsSync(key)) {
      try {
        await $`ssh-keygen -y -f ${key} -P ""`.quiet();
        sshKeyPath = key;
        break;
      } catch {}
    }
  }
  
  if (!sshKeyPath) {
    sshKeyPath = `${process.env.HOME}/.ssh/haven_ed25519`;
    if (!existsSync(sshKeyPath)) {
      log.info('No passphrase-less key found. Generating haven_ed25519...');
      await $`ssh-keygen -t ed25519 -f ${sshKeyPath} -N "" -C "haven-cli"`;
    }
  }
  
  const pubKey = await Bun.file(`${sshKeyPath}.pub`).text();
  log.info(`SSH public key: ${pubKey.slice(0, 50)}...`);
  
  log.info("Adding key to container's authorized_keys...");
  try {
    await $`docker exec ${config.containerName} bash -c ${`
      mkdir -p /config/.ssh && 
      echo '${pubKey.trim()}' > /config/.ssh/authorized_keys &&
      chmod 700 /config/.ssh &&
      chmod 600 /config/.ssh/authorized_keys &&
      chown -R abc:abc /config/.ssh
    `}`.quiet();
    pass('SSH key added to container');
  } catch {
    fail('Failed to add SSH key to container');
    return false;
  }
  
  pass('SSH config ready');
  
  // Clear any stale host keys (container rebuilds generate new keys)
  log.info('Clearing stale host keys...');
  try {
    await $`ssh-keygen -f ${process.env.HOME}/.ssh/known_hosts -R "[${config.host}]:${config.sshPort}"`.quiet();
  } catch {
    // Ignore - may not exist
  }

  log.info('Testing SSH connection...');
  try {
    // Use StrictHostKeyChecking=no for test environments (container rebuilds change host keys)
    await $`ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 -i ${sshKeyPath} -p ${config.sshPort} abc@${config.host} "echo ok"`.quiet();
    pass('SSH connection works!');
    return true;
  } catch {
    fail('SSH connection failed');
    log.warn(`Try: ssh -v -i ${sshKeyPath} -p ${config.sshPort} abc@${config.host}`);
    return false;
  }
}

function setupTestDir() {
  log.header('Setting up test directory');
  
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  
  writeFileSync(join(testDir, 'README.md'), '# Haven CLI Test Project\n');
  writeFileSync(join(testDir, 'package.json'), '{"name": "haven-test", "version": "1.0.0"}\n');
  mkdirSync(join(testDir, 'src'), { recursive: true });
  writeFileSync(join(testDir, 'src/index.ts'), 'console.log("Hello from Haven!");\n');
  writeFileSync(join(testDir, '.havenignore'), 'node_modules/\n*.log\n.DS_Store\n');
  
  pass(`Test directory created at ${testDir}`);
}

function cleanupStaleSockets() {
  try { spawnSync(['pkill', '-f', 'ssh.*haven']); } catch {}
  rmSync(`${process.env.HOME}/.ssh/controlmasters`, { recursive: true, force: true });
}

async function runTests() {
  log.header('Haven CLI Integration Tests');
  
  if (!await isContainerRunning(config.containerName)) {
    log.error(`Container '${config.containerName}' not running`);
    log.info('Start it with: bun dev/scripts/start.ts');
    process.exit(1);
  }
  pass('Container is running');
  
  if (!await setupSshKeys()) {
    process.exit(1);
  }
  
  setupTestDir();
  cleanupStaleSockets();
  
  rmSync(`${process.env.HOME}/.config/haven/connections.json`, { force: true });
  
  log.header('Test: haven connect');
  const connectResult = await haven('connect', '.', `abc@${config.host}:${config.sshPort}`);
  if (connectResult.exitCode === 0) {
    pass('haven connect succeeded');
  } else {
    fail(`haven connect failed: ${connectResult.output}`);
  }
  
  log.header('Test: haven status');
  const statusResult = await haven('status');
  if (statusResult.exitCode === 0) {
    pass('haven status succeeded');
  } else {
    fail(`haven status failed: ${statusResult.output}`);
  }
  
  log.header('Test: haven ls');
  const lsResult = await haven('ls', '-la');
  if (lsResult.exitCode === 0) {
    pass('haven ls succeeded');
  } else {
    fail(`haven ls failed: ${lsResult.output}`);
  }
  
  log.header('Test: haven claude (availability)');
  const claudeResult = await haven('claude', '--version');
  if (claudeResult.exitCode === 0) {
    pass('haven claude available');
  } else {
    fail(`haven claude not available: ${claudeResult.output}`);
  }
  
  log.header('Test: haven opencode (availability)');
  const opencodeResult = await haven('opencode', '--version');
  if (opencodeResult.exitCode === 0) {
    pass('haven opencode available');
  } else {
    fail(`haven opencode not available: ${opencodeResult.output}`);
  }
  
  log.header('Test: haven disconnect');
  const disconnectResult = await haven('disconnect');
  if (disconnectResult.exitCode === 0) {
    pass('haven disconnect succeeded');
  } else {
    fail(`haven disconnect failed: ${disconnectResult.output}`);
  }
  
  log.header('Cleanup');
  rmSync(testDir, { recursive: true, force: true });
  pass('Test directory removed');
  
  formatTestSummary(passed, failed);
  process.exit(failed === 0 ? 0 : 1);
}

async function interactiveMode() {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  const prompt = (question: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer));
    });
  };
  
  log.header('Haven CLI Interactive Test');
  
  if (!await isContainerRunning(config.containerName)) {
    log.warn('Test directory not found. Running setup first...');
  }
  
  log.plain(`\nTest directory: ${testDir}`);
  log.plain(`Remote target: abc@${config.host}:${config.sshPort}\n`);
  
  if (!await setupSshKeys()) {
    rl.close();
    process.exit(1);
  }
  
  setupTestDir();
  cleanupStaleSockets();
  
  rmSync(`${process.env.HOME}/.config/haven/connections.json`, { force: true });
  
  log.header('Step 1: Connect');
  const a1 = await prompt('Continue? [Y/n] ');
  if (a1.toLowerCase() !== 'n') {
    const result = await haven('connect', '.', `abc@${config.host}:${config.sshPort}`);
    log.plain(result.output);
    result.exitCode === 0 ? pass('Connect') : fail('Connect');
  }
  
  log.header('Step 2: Status');
  const a2 = await prompt('Continue? [Y/n] ');
  if (a2.toLowerCase() !== 'n') {
    const result = await haven('status');
    log.plain(result.output);
    result.exitCode === 0 ? pass('Status') : fail('Status');
  }
  
  log.header('Step 3: Remote command (ls -la)');
  const a3 = await prompt('Continue? [Y/n] ');
  if (a3.toLowerCase() !== 'n') {
    const result = await haven('ls', '-la');
    log.plain(result.output);
    result.exitCode === 0 ? pass('Remote ls') : fail('Remote ls');
  }
  
  log.header('Step 4: Test AI tools (claude, opencode)');
  const a4 = await prompt('Continue? [Y/n] ');
  if (a4.toLowerCase() !== 'n') {
    const claudeResult = await haven('claude', '--version');
    log.plain(`claude: ${claudeResult.output.trim() || 'not found'}`);
    claudeResult.exitCode === 0 ? pass('claude available') : fail('claude not available');
    
    const opencodeResult = await haven('opencode', '--version');
    log.plain(`opencode: ${opencodeResult.output.trim() || 'not found'}`);
    opencodeResult.exitCode === 0 ? pass('opencode available') : fail('opencode not available');
  }
  
  log.header('Step 5: Disconnect');
  const a5 = await prompt('Continue? [Y/n] ');
  if (a5.toLowerCase() !== 'n') {
    const result = await haven('disconnect');
    log.plain(result.output);
    result.exitCode === 0 ? pass('Disconnect') : fail('Disconnect');
  }
  
  rl.close();
  
  formatTestSummary(passed, failed);
  process.exit(failed === 0 ? 0 : 1);
}

if (ciMode) {
  await runTests();
} else {
  await interactiveMode();
}
