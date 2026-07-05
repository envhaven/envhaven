#!/usr/bin/env bun
import { $ } from 'bun';
import { loadConfig, getExtensionMountPath, getTestConfigPath, log, getContainerStatus, removeContainer, waitForContainer } from './lib';

const config = loadConfig();
const fresh = process.argv.includes('--fresh');
const mountExt = process.argv.includes('--mount-ext');

const status = await getContainerStatus(config.containerName);

if (status === 'running' && !fresh) {
  log.success(`Container '${config.containerName}' is already running`);
  log.newline();
  log.info(`Web UI: http://${config.host}:${config.webPort}`);
  log.info(`Terminal: http://${config.host}:${config.consolePort}`);
  log.info(`SSH: ssh abc@${config.host} -p ${config.sshPort}`);
  log.dim(`Password: ${config.password}`);
  process.exit(0);
}

if (status !== 'not_found') {
  log.info('Removing existing container...');
  await removeContainer(config.containerName);
}

const extPath = mountExt ? getExtensionMountPath(config) : null;
if (extPath) {
  log.info(`Mounting extension: ${extPath}`);
}

const testConfigPath = getTestConfigPath(config);

log.command(`docker run -d --name ${config.containerName} ...`);

try {
  const envArgs = [
    `-e`, `PASSWORD=${config.password}`,
    `-e`, `SUDO_PASSWORD=${config.password}`,
    `-e`, `ENVHAVEN_SSH_HOST=${config.host}`,
    `-e`, `ENVHAVEN_SSH_PORT=${config.sshPort}`,
  ];
  
  const volumeArgs = [`-v`, `${testConfigPath}:/config`];
  if (extPath) {
    volumeArgs.push(`-v`, `${extPath}:/extension`);
  }
  
  await $`docker run -d --name ${config.containerName} -p ${config.webPort}:8443 -p ${config.sshPort}:22 -p ${config.consolePort}:7681 ${envArgs} ${volumeArgs} ${config.image}`;
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
  log.dim(`Password: ${config.password}`);
  process.exit(0);
} else {
  log.warn('Container started but health check timed out');
  log.dim(`Check logs: docker logs ${config.containerName}`);
  process.exit(1);
}
