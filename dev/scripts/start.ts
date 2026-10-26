#!/usr/bin/env bun
import { $ } from 'bun';
import { loadConfig, log, getContainerStatus, removeContainer, waitForContainer, withEnvFile, devContainerEnv } from './lib';

const config = loadConfig();
const fresh = process.argv.includes('--fresh');

// Where the password comes from, never the password itself: terminal output ends up in
// scrollback, tmux logs and screenshots, and ENVHAVEN_PASSWORD may be one a person really uses.
const PASSWORD_HINT = 'Web UI and sudo password: ENVHAVEN_PASSWORD from the environment or dev/.env.dev (default: test)';
const env = devContainerEnv(config.password);
const SSH_HINT = env.PUBLIC_KEY
  ? 'SSH takes keys only; the container has your default public key from ~/.ssh'
  : 'SSH takes keys only, and no ~/.ssh/id_{ed25519,ecdsa,rsa}.pub was found: create one and restart with --fresh';

const status = await getContainerStatus(config.containerName);

if (status === 'running' && !fresh) {
  log.success(`Container '${config.containerName}' is already running`);
  log.newline();
  log.info(`Web UI: http://${config.host}:${config.webPort}`);
  log.info(`Terminal: http://${config.host}:${config.consolePort}`);
  log.info(`SSH: ssh abc@${config.host} -p ${config.sshPort}`);
  log.dim(SSH_HINT);
  log.dim(PASSWORD_HINT);
  process.exit(0);
}

if (status !== 'not_found') {
  log.info('Removing existing container...');
  await removeContainer(config.containerName);
}

log.command(`docker run -d --name ${config.containerName} ...`);

try {
  const runArgs = [
    `-e`, `ENVHAVEN_SSH_HOST=${config.host}`,
    `-e`, `ENVHAVEN_SSH_PORT=${config.sshPort}`,
  ];

  // The password reaches the container through a private env file rather than `-e`, which
  // would put it in this command's argv for anyone on the host to read.
  await withEnvFile(env, (envFile) =>
    $`docker run -d --name ${config.containerName} -p ${config.webPort}:8443 -p ${config.sshPort}:22 -p ${config.consolePort}:7681 --env-file ${envFile} ${runArgs} ${config.image}`
  );
} catch (e: any) {
  const stderr = e.stderr?.toString() || e.message || String(e);
  log.error(`Failed to start container: ${stderr}`);
  process.exit(1);
}

log.success('Container started');

const ready = await waitForContainer(config.containerName, 90, (msg) => {
  log.dim(msg);
});

if (ready) {
  log.success('Services ready');
  log.newline();
  log.info(`Web UI: http://${config.host}:${config.webPort}`);
  log.info(`Terminal: http://${config.host}:${config.consolePort}`);
  log.info(`SSH: ssh abc@${config.host} -p ${config.sshPort}`);
  log.dim(SSH_HINT);
  log.dim(PASSWORD_HINT);
  process.exit(0);
} else {
  log.warn('Container started but health check timed out');
  log.dim(`Check logs: docker logs ${config.containerName}`);
  process.exit(1);
}
