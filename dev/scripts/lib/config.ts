import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { loadEnvFile } from './env';

export interface Config {
  containerName: string;
  image: string;
  webPort: number;
  sshPort: number;
  consolePort: number;
  password: string;
  host: string;
  hostRepoPath: string;
}

function isRunningInContainer(): boolean {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
}

const DEFAULTS: Config = {
  containerName: 'envhaven-test',
  image: 'envhaven:dev',
  webPort: 8443,
  sshPort: 2222,
  consolePort: 7681,
  password: 'test',
  host: 'localhost',
  hostRepoPath: '',
};

function findDevRoot(): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(import.meta.dir, '..', '..');
}

function findRepoRoot(): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'Dockerfile'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(import.meta.dir, '..', '..', '..');
}

export const DEV_ROOT = findDevRoot();
export const REPO_ROOT = findRepoRoot();
export const EXTENSION_DIR = join(REPO_ROOT, 'extension');
export const WEBVIEW_DIR = join(EXTENSION_DIR, 'webview');
export const CLI_DIR = join(REPO_ROOT, 'cli');

export function loadConfig(): Config {
  const envDevPath = join(DEV_ROOT, '.env.dev');
  const envVars = loadEnvFile(envDevPath);

  // An exported variable wins over dev/.env.dev, which wins over the default. Someone
  // typing ENVHAVEN_IMAGE=... in front of a script means it, and a file that silently
  // outranks them is the surprising reading. CI has no .env.dev at all, so this is also
  // what points the harness at the image the build step just loaded.
  const get = (key: string) => process.env[key] || envVars[key];

  return {
    containerName: get('ENVHAVEN_CONTAINER_NAME') || DEFAULTS.containerName,
    image: get('ENVHAVEN_IMAGE') || DEFAULTS.image,
    webPort: parseInt(get('ENVHAVEN_WEB_PORT') || String(DEFAULTS.webPort), 10),
    sshPort: parseInt(get('ENVHAVEN_SSH_PORT') || String(DEFAULTS.sshPort), 10),
    consolePort: parseInt(get('ENVHAVEN_CONSOLE_PORT') || String(DEFAULTS.consolePort), 10),
    password: get('ENVHAVEN_PASSWORD') || DEFAULTS.password,
    host: get('ENVHAVEN_HOST') || DEFAULTS.host,
    hostRepoPath: get('ENVHAVEN_HOST_REPO_PATH') || DEFAULTS.hostRepoPath,
  };
}

export function getExtensionMountPath(config: Config): string {
  if (config.hostRepoPath) {
    return join(config.hostRepoPath, 'extension');
  }

  if (isRunningInContainer()) {
    throw new Error(
      'ENVHAVEN_HOST_REPO_PATH is required when running inside a container.\n' +
      'The Docker daemon runs on the host and cannot see container paths.\n\n' +
      'Fix: Copy dev/.env.example to dev/.env.dev and set ENVHAVEN_HOST_REPO_PATH\n' +
      'to the HOST path where this repo is mounted (check your container\'s volume mounts).'
    );
  }

  return EXTENSION_DIR;
}
