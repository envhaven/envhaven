import { $ } from 'bun';

export type ContainerStatus = 'running' | 'stopped' | 'not_found';

export async function getContainerStatus(containerName: string): Promise<ContainerStatus> {
  try {
    const result = await $`docker inspect --type container --format {{.State.Running}} ${containerName}`.quiet();
    return result.text().trim() === 'true' ? 'running' : 'stopped';
  } catch {
    return 'not_found';
  }
}

export async function isContainerRunning(containerName: string): Promise<boolean> {
  return (await getContainerStatus(containerName)) === 'running';
}

export async function removeContainer(containerName: string): Promise<boolean> {
  try {
    // -v drops the anonymous volume the image's `VOLUME /config` creates on
    // every run. Named volumes are untouched, so a hand-mounted /config lives on.
    await $`docker rm -f -v ${containerName}`.quiet();
    await Bun.sleep(500);
    return true;
  } catch {
    return false;
  }
}

export async function waitForContainer(
  containerName: string,
  timeoutSeconds: number = 90,
  onProgress?: (message: string) => void
): Promise<boolean> {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;

  while (Date.now() - startTime < timeoutMs) {
    try {
      await $`docker exec ${containerName} curl -sf http://localhost:8443/healthz`.quiet();
      return true;
    } catch {}

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    onProgress?.(`Waiting for container... (${elapsed}s)`);
    await Bun.sleep(2000);
  }

  return false;
}

export interface ExecOptions {
  /** Run as this user instead of root. Root is neither the uid nor the HOME any workspace
   *  process gets, and it bypasses DAC on top, so a permission check made as root passes
   *  regardless of the mode bits. Wrong context for asserting either a tool's environment
   *  or a file's permissions. */
  user?: string;
  /** Extra environment for the exec'd process; `abc` needs HOME=/config. */
  env?: Record<string, string>;
  /** Maximum wall-clock time for the Docker client process. */
  timeoutMs?: number;
}

export interface ProcessResult {
  success: boolean;
  output: string;
}

export async function runBoundedProcess(
  command: string[],
  timeoutMs: number
): Promise<ProcessResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Process timeout must be a positive number');
  }

  try {
    const process = Bun.spawn(command, {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill('SIGKILL');
    }, timeoutMs);

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (timedOut) {
        return {
          success: false,
          output: [`Process timed out after ${timeoutMs}ms`, output].filter(Boolean).join('\n'),
        };
      }
      return { success: exitCode === 0, output };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { success: false, output: String(error) };
  }
}

export async function dockerExec(
  containerName: string,
  command: string,
  options: ExecOptions = {}
): Promise<{ success: boolean; output: string }> {
  const flags: string[] = [];
  if (options.user) flags.push('-u', options.user);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    flags.push('-e', `${key}=${value}`);
  }

  return runBoundedProcess(
    ['docker', 'exec', ...flags, containerName, 'sh', '-c', command],
    options.timeoutMs ?? 30_000
  );
}

export async function dockerExecStream(
  containerName: string,
  command: string,
  onOutput?: (line: string) => void
): Promise<number> {
  const proc = Bun.spawn(['docker', 'exec', containerName, 'sh', '-c', command], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const decoder = new TextDecoder();
  
  if (proc.stdout) {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        for (const line of text.split('\n')) {
          if (line) onOutput?.(line);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  return await proc.exited;
}

export async function getContainerImageId(containerName: string): Promise<string | null> {
  try {
    const result = await $`docker inspect ${containerName} --format {{.Image}}`.quiet();
    return result.text().trim() || null;
  } catch {
    return null;
  }
}

export async function getImageId(imageName: string): Promise<string | null> {
  try {
    const result = await $`docker inspect ${imageName} --format {{.Id}}`.quiet();
    return result.text().trim() || null;
  } catch {
    return null;
  }
}

export async function isContainerImageStale(containerName: string, imageName: string): Promise<boolean> {
  const [containerImageId, currentImageId] = await Promise.all([
    getContainerImageId(containerName),
    getImageId(imageName),
  ]);
  
  if (!containerImageId || !currentImageId) return false;
  return containerImageId !== currentImageId;
}
