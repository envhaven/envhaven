#!/usr/bin/env bun
import { $ } from 'bun';
import { loadConfig, getTestConfigPath, log, formatTestSummary, dockerExec } from './lib';

const config = loadConfig();
const containerName = `envhaven-test-${Date.now()}`;

const tests = [
  { name: 'code-server health', cmd: 'curl -sf http://localhost:8443/healthz' },
  { name: 'browser terminal', cmd: 'curl -sf -o /dev/null http://localhost:7681/__console/ui' },
  { name: 'SSH daemon', cmd: 'pgrep sshd' },
  { name: 'cloudflared binary', cmd: 'which cloudflared' },
  
  { name: 'Node.js', cmd: 'node --version' },
  { name: 'Python', cmd: 'python --version' },
  { name: 'Go', cmd: 'go version' },
  { name: 'Rust', cmd: 'rustc --version' },
  { name: 'Bun', cmd: 'bun --version' },
  
  { name: 'pnpm', cmd: 'pnpm --version' },
  { name: 'yarn', cmd: 'yarn --version' },
  { name: 'uv', cmd: 'uv --version' },
  
  { name: 'gh', cmd: 'gh --version' },
  { name: 'fd', cmd: 'fd --version' },
  { name: 'ripgrep', cmd: 'rg --version' },
  { name: 'jq', cmd: 'jq --version' },
  
  { name: 'claude', cmd: 'claude --version' },
  { name: 'codex', cmd: 'codex --version' },
  { name: 'gemini', cmd: 'gemini --version' },
  { name: 'qwen', cmd: 'qwen --version' },
  { name: 'amp', cmd: 'amp --version' },
  { name: 'auggie', cmd: 'auggie --version' },
  
  { name: 'aider', cmd: 'aider --version' },
  { name: 'vibe', cmd: 'vibe --version' },
  
  { name: 'opencode', cmd: 'opencode --version' },
  { name: 'goose', cmd: 'goose --version' },
  { name: 'kiro', cmd: 'kiro-cli --version' },
  { name: 'droid', cmd: 'droid --version' },
  
  { name: 'AGENTS.md', cmd: 'test -f /config/workspace/AGENTS.md' },
  { name: 'VS Code settings', cmd: 'test -f /config/data/User/settings.json' },
];

async function cleanup() {
  log.dim('Cleaning up test container...');
  try { await $`docker rm -f ${containerName}`.quiet(); } catch {}
}

let testConfigPath: string;
try {
  testConfigPath = getTestConfigPath(config);
} catch (e: any) {
  log.error(e.message);
  process.exit(1);
}

log.info(`Testing image: ${config.image}`);
log.info('Starting test container...');

try {
  const envArgs = [
    `-e`, `PASSWORD=testpass`,
    `-e`, `SUDO_PASSWORD=testpass`,
  ];
  
  await $`docker run -d --name ${containerName} -p 18443:8443 -p 12222:22 -p 17681:7681 ${envArgs} -v ${testConfigPath}:/config ${config.image}`.quiet();
} catch {
  log.error('Failed to start test container');
  process.exit(1);
}

log.dim('Waiting for container initialization (90s for DOCKER_MODS)...');
await Bun.sleep(90000);

let passed = 0;
let failed = 0;

for (const test of tests) {
  const result = await dockerExec(containerName, test.cmd);
  if (result.success) {
    const version = result.output.split('\n')[0] || '';
    log.success(`${test.name}${version ? `: ${version}` : ''}`);
    passed++;
  } else {
    log.error(test.name);
    failed++;
  }
}

await cleanup();

formatTestSummary(passed, failed);
process.exit(failed === 0 ? 0 : 1);
