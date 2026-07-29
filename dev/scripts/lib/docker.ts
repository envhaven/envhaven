import { $ } from 'bun';

export type ContainerStatus = 'running' | 'stopped' | 'not_found';

export async function getContainerStatus(containerName: string): Promise<ContainerStatus> {
  try {
    const result = await $`docker ps -a --format {{.Names}}:{{.State}}`.quiet();
    for (const line of result.text().split('\n')) {
      const [name, state] = line.split(':');
      if (name === containerName) {
        return state === 'running' ? 'running' : 'stopped';
      }
    }
    return 'not_found';
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

/**
 * Both streams of a failed `$` call. Bun raises `$.ShellError` for a non-zero exit and
 * also for a command it could not run at all, so this covers a missing container, an
 * unreachable daemon and a missing `docker` binary alike. Anything else — a setup failure
 * such as an unreadable cwd — arrives as a plain `Error` with nothing on either stream,
 * which is why this narrows rather than casts: a cast would turn that case into an empty
 * string and print a bare check name with no reason. Note `$.ShellError` and not a
 * `ShellError` import; the class is only reachable through the `$` namespace.
 */
export function shellErrorText(error: unknown): string {
  if (!(error instanceof $.ShellError)) return String(error);
  return [error.stdout.toString(), error.stderr.toString()].filter(Boolean).join('\n').trim();
}

export interface ExecOptions {
  /** Run as this user instead of root. Root is neither the uid nor the HOME any workspace
   *  process gets, and it bypasses DAC on top, so a permission check made as root passes
   *  regardless of the mode bits. Wrong context for asserting either a tool's environment
   *  or a file's permissions. */
  user?: string;
  /** Extra environment for the exec'd process; `abc` needs HOME=/config. */
  env?: Record<string, string>;
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

  try {
    const result = await $`docker exec ${flags} ${containerName} sh -c ${command}`.quiet();
    return { success: true, output: result.text().trim() };
  } catch (error) {
    // Keep the container's own words. This used to return an empty string, so a failed
    // check printed its name and nothing else, and diagnosing one meant reproducing the
    // whole boot by hand somewhere else.
    return { success: false, output: shellErrorText(error) };
  }
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
