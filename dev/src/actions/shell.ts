import { spawnSync } from 'bun';
import type { Config } from '../lib/config';
import { isContainerRunning } from '../lib/docker';
import { exitFullscreen } from '../lib/terminal';

type ExitApp = () => void;

export async function runShell(
  config: Config,
  exitApp: ExitApp
): Promise<void> {
  const running = await isContainerRunning(config.containerName);
  
  if (!running) {
    return;
  }

  exitFullscreen();
  exitApp();

  await Bun.sleep(100);

  spawnSync([
    'ssh',
    // The dev container is recreated all the time and each one presents a new host key, so
    // there is nothing worth pinning: a saved entry would only turn the next container into a
    // "REMOTE HOST IDENTIFICATION HAS CHANGED" refusal. /dev/null as the known_hosts file keeps
    // this throwaway target out of the user's own known_hosts, and LogLevel=ERROR drops the
    // "Permanently added" notice that /dev/null would otherwise print on every connect.
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'LogLevel=ERROR',
    '-p', String(config.sshPort),
    `abc@${config.host}`,
  ], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
}
