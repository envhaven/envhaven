#!/usr/bin/env bun
import { $ } from 'bun';
import { loadConfig, log, formatTestSummary, dockerExec } from './lib';
import toolDefs from '../../tool-definitions.json';

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
  
  // AI tools derive from tool-definitions.json — the roster's single source of truth.
  ...toolDefs.tools.map(({ command }) => ({ name: command, cmd: `${command} --version` })),

  // Every tool must resolve to a real binary outside /config, because users mount a
  // volume there and it hides whatever the build left behind. A `--version` gate can't
  // catch this: /config/.local/bin leads PATH, so a misplaced tool passes at build time
  // and goes missing in production. See docs/architecture.md § The Volume Mount Problem.
  {
    name: 'tools resolve outside /config',
    cmd: `for t in ${toolDefs.tools.map(({ command }) => command).join(' ')}; do ` +
      `case "$(readlink -f "$(command -v "$t")")" in /config/*) exit 1;; esac; done`,
  },

  { name: 'AGENTS.md', cmd: 'test -f /config/workspace/AGENTS.md' },
  { name: 'VS Code settings', cmd: 'test -f /config/data/User/settings.json' },
  { name: 'artifacts drop folder', cmd: 'test -d /config/artifacts' },
  { name: 'claude seed symlink', cmd: 'test -L /config/.local/bin/claude && test -e /config/.local/bin/claude' },
];

async function cleanup() {
  log.dim('Cleaning up test container...');
  try { await $`docker rm -f -v ${containerName}`.quiet(); } catch {}
}

log.info(`Testing image: ${config.image}`);
log.info('Starting test container...');

try {
  const envArgs = [
    `-e`, `PASSWORD=testpass`,
    `-e`, `SUDO_PASSWORD=testpass`,
  ];
  
  await $`docker run -d --name ${containerName} -p 18443:8443 -p 12222:22 -p 17681:7681 ${envArgs} ${config.image}`.quiet();
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
