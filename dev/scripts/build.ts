#!/usr/bin/env bun
import { spawn } from 'bun';
import { loadConfig, REPO_ROOT, log } from './lib';

const config = loadConfig();
const noCache = process.argv.includes('--no-cache');

const args = ['build', '--force-rm', '-t', config.image];
if (noCache) args.push('--no-cache');
args.push('.');

log.command(`docker ${args.join(' ')}`);
log.dim(`Working directory: ${REPO_ROOT}`);

const proc = spawn(['docker', ...args], {
  cwd: REPO_ROOT,
  stdout: 'inherit',
  stderr: 'inherit',
});

const exitCode = await proc.exited;

if (exitCode === 0) {
  log.success(`Built ${config.image}`);
} else {
  log.error(`Build failed with exit code ${exitCode}`);
}

process.exit(exitCode);
