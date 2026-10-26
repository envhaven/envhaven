import { $ } from 'bun';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

export type ContainerStatus = 'running' | 'stopped' | 'not_found';

/**
 * Hands `run` the path of a private file holding `vars`, for `docker run --env-file`, and deletes
 * it afterwards. A secret passed as `-e NAME=value` sits in the docker client's argv, where any
 * local user can read it from `ps` or /proc for as long as the command runs. The client reads
 * --env-file itself and sends the values in the create request, so the file only has to outlive
 * `docker run`.
 */
export async function withEnvFile<T>(
  vars: Record<string, string>,
  run: (envFile: string) => Promise<T>
): Promise<T> {
  // One NAME=value per line, taken verbatim: a line break would end the value early and turn
  // the rest of it into a variable of its own.
  for (const [name, value] of Object.entries(vars)) {
    if (/[\r\n]/.test(value)) {
      throw new Error(`${name} contains a line break, which an env file cannot carry`);
    }
  }
  // mkdtemp creates the directory 0700, so no other user can open or even list the file.
  const dir = mkdtempSync(join(tmpdir(), 'envhaven-env-'));
  try {
    const envFile = join(dir, 'env');
    const content = Object.entries(vars).map(([name, value]) => `${name}=${value}\n`).join('');
    writeFileSync(envFile, content, { mode: 0o600 });
    return await run(envFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What a dev container starts with: the web and sudo password, and, because the image's SSH
 * accepts keys only, the developer's own public key (the first of id_ed25519, id_ecdsa and
 * id_rsa found; ssh offers each default identity, so any of them logs in), so `ssh` and `eh shell`
 * can log in. Without one, SSH stays closed and the caller says so.
 */
export function devContainerEnv(password: string): Record<string, string> {
  const env: Record<string, string> = { PASSWORD: password, SUDO_PASSWORD: password };
  for (const name of ['id_ed25519.pub', 'id_ecdsa.pub', 'id_rsa.pub']) {
    const path = join(homedir(), '.ssh', name);
    if (existsSync(path)) {
      env.PUBLIC_KEY = readFileSync(path, 'utf8').trim();
      break;
    }
  }
  return env;
}

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
