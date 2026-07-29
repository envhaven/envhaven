#!/usr/bin/env bun
import { loadConfig, log, formatTestSummary, dockerExec, isContainerRunning } from './lib';
import toolDefs from '../../tool-definitions.json';

const config = loadConfig();

// Derived from the catalog, like the Dockerfile verification block and
// test-image.ts — the roster has one source of truth.
const AI_TOOLS = toolDefs.tools.map(({ name, command }) => ({ name, cmd: `${command} --version` }));

async function runTests() {
  log.header('AI Coding Tools Verification');

  if (!await isContainerRunning(config.containerName)) {
    log.error(`Container '${config.containerName}' not running`);
    log.info('Start it with: bun dev/scripts/start.ts');
    process.exit(1);
  }

  log.info(`Testing container: ${config.containerName}`);
  log.info(`Total tools to verify: ${AI_TOOLS.length}\n`);

  let passed = 0;
  let failed = 0;

  for (const tool of AI_TOOLS) {
    // As abc with HOME=/config, the uid and home a workspace user actually gets. A tool
    // that only resolves for root resolves for nobody who uses the container.
    const result = await dockerExec(config.containerName, tool.cmd, {
      user: 'abc',
      env: { HOME: '/config' },
    });
    if (result.success) {
      const version = result.output.split('\n')[0]?.trim() || 'OK';
      log.success(`${tool.name}: ${version}`);
      passed++;
    } else {
      log.error(`${tool.name}: MISSING or broken`);
      if (result.output) log.plain(result.output);
      failed++;
    }
  }

  formatTestSummary(passed, failed);
  process.exit(failed === 0 ? 0 : 1);
}

await runTests();
