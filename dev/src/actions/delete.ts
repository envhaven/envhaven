import type { Config } from '../lib/config';
import { getContainerStatus, removeContainer } from '../lib/docker';

type AddLog = (type: 'info' | 'success' | 'error' | 'warn' | 'command' | 'dim', text: string) => void;

export async function deleteContainer(
  config: Config,
  addLog: AddLog,
  refreshStatus: () => Promise<void>
): Promise<void> {
  const status = await getContainerStatus(config.containerName);

  if (status === 'not_found') {
    addLog('warn', `Container '${config.containerName}' does not exist`);
    return;
  }

  addLog('command', `docker rm -f -v ${config.containerName}`);
  addLog('info', 'Removing container...');

  const success = await removeContainer(config.containerName);

  if (success) {
    addLog('success', `Container '${config.containerName}' deleted`);
  } else {
    addLog('error', `Failed to delete container '${config.containerName}'`);
  }

  await refreshStatus();
}
