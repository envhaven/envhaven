import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import toolDefinitionsJson from '../../tool-definitions.json';
import { getTools } from './consoleClient';
import {
  TMUX_SESSION,
  type AITool,
  type SetupStep,
  type TmuxWindow,
  type VersionInfo,
  type EnvVarMeta,
  type WorkspaceInfo,
} from './shared-types';

/** Default timeout for all process spawns (ms) */
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Execute a command with a hard timeout that actually kills the process.
 * Node's exec timeout only rejects the promise but doesn't kill the spawned process.
 * This is the ONLY way to spawn processes in this module - prevents zombie accumulation.
 */
export function execSafe(command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error('timeout'));
    }, timeoutMs);

    child.stdout?.on('data', (data) => { stdout += data; });
    child.stderr?.on('data', (data) => { stderr += data; });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!killed) reject(err);
    });
  });
}

interface Versions {
  node: string | null;
  python: string | null;
  go: string | null;
  rust: string | null;
}

let cachedVersions: Versions | null = null;

async function getCachedVersions(): Promise<Versions> {
  if (cachedVersions) return cachedVersions;

  const [node, python, go, rust] = await Promise.all([
    getVersion('node'),
    getVersion('python3'),
    getVersion('go', 'version'),
    getVersion('rustc'),
  ]);

  cachedVersions = { node, python, go, rust };
  return cachedVersions;
}

export interface ToolDefinition {
  id: string;
  name: string;
  command: string;
  authCommand: string | null;
  description: string;
  docsUrl: string;
  envVars: string[];
  authFiles: string[];
  // Consumed by the Go console's auth ladder (tools.go checkAuth), not the extension;
  // it still types the shared tool-definitions.json the console reads.
  authCheck?: 'goose';
  /**
   * The kebab-case agent id `npx skills add -a <agent>` accepts. Absent when
   * skills.sh doesn't support this tool (e.g. aider) — the console's
   * connectedAgents silently skips agent-less tools when installing skills.
   */
  skillsAgent?: string;
  setupSteps: SetupStep[];
}

export const TOOL_DEFINITIONS: ToolDefinition[] = toolDefinitionsJson.tools as ToolDefinition[];

// Per-env-var UI metadata (placeholder/hint/signup URL) for the API-key input,
// keyed by env var name and shared across tools (e.g. ANTHROPIC_API_KEY is used by
// both opencode and claude). Source of truth is tool-definitions.json's envVarMeta.
export const ENV_VAR_META: Record<string, EnvVarMeta> =
  (toolDefinitionsJson as { envVarMeta?: Record<string, EnvVarMeta> }).envVarMeta ?? {};

async function getVersion(cmd: string, versionArg = '--version'): Promise<string | null> {
  try {
    const { stdout } = await execSafe(`${cmd} ${versionArg} 2>/dev/null`);
    const match = stdout.match(/(\d+\.\d+(\.\d+)?)/);
    return match ? match[1] : stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}

export function getToolDefinitionById(id: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((t) => t.id === id);
}

async function isSshEnabled(): Promise<boolean> {
  try {
    await execSafe('pgrep -x sshd');
    return true;
  } catch {
    return false;
  }
}

function isSshKeyConfigured(): boolean {
  if (process.env.PUBLIC_KEY) return true;

  const authorizedKeysPath = path.join(os.homedir(), '.ssh', 'authorized_keys');
  try {
    const content = fs.readFileSync(authorizedKeysPath, 'utf-8').trim();
    return content.length > 0;
  } catch {
    return false;
  }
}

function getSshConfig() {
  const isManaged = process.env.ENVHAVEN_MANAGED === 'true';
  const host = process.env.ENVHAVEN_SSH_HOST || null;
  const port = parseInt(process.env.ENVHAVEN_SSH_PORT || (isManaged ? '22' : '2222'), 10);
  const displayHost = host || '<host>';
  const command = port === 22
    ? `ssh abc@${displayHost}`
    : `ssh abc@${displayHost} -p ${port}`;
  const configured = !!host;
  return { host: displayHost, port, command, configured };
}

function getPreviewUrl(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    if (!url.hostname.startsWith('preview-')) {
      url.hostname = `preview-${url.hostname}`;
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

async function getVersionInfo(isManaged: boolean, apiUrl: string | null): Promise<VersionInfo> {
  const current = process.env.ENVHAVEN_VERSION || null;
  
  let latest: string | null = null;
  
  try {
    if (isManaged && apiUrl) {
      const response = await fetch(`${apiUrl}/v1/version`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const data = await response.json() as { latest?: string };
        latest = data.latest || null;
      }
    } else {
      const tokenRes = await fetch(
        'https://ghcr.io/token?service=ghcr.io&scope=repository:envhaven/envhaven:pull',
        { signal: AbortSignal.timeout(3000) }
      );
      if (tokenRes.ok) {
        const { token } = await tokenRes.json() as { token: string };
        
        const manifestRes = await fetch(
          'https://ghcr.io/v2/envhaven/envhaven/manifests/latest',
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.docker.distribution.manifest.v2+json',
            },
            signal: AbortSignal.timeout(3000),
          }
        );
        
        if (manifestRes.ok) {
          const manifest = await manifestRes.json() as { config?: { digest?: string } };
          const configDigest = manifest.config?.digest;
          
          if (configDigest) {
            const configRes = await fetch(
              `https://ghcr.io/v2/envhaven/envhaven/blobs/${configDigest}`,
              { 
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(3000),
              }
            );
            
            if (configRes.ok) {
              const config = await configRes.json() as { config?: { Labels?: Record<string, string> } };
              latest = config.config?.Labels?.['org.opencontainers.image.version'] || null;
            }
          }
        }
      }
    }
  } catch {
    /* network/registry failure — leave `latest` null, the UI just won't show
       an update prompt this poll cycle and we'll retry on the next refresh */
  }

  const updateAvailable = !!(current && latest && current !== latest);
  
  return { current, latest, updateAvailable };
}

// parseTmuxWindows turns `index|active|name` lines into windows. The free-text name
// is LAST so a "|" inside a renamed window stays whole (same field order as the
// console's parseWindows); a nameless window falls back to `Window <index>`.
export function parseTmuxWindows(stdout: string): TmuxWindow[] {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [index, active, ...name] = line.split('|');
      return {
        index: parseInt(index, 10),
        name: name.join('|') || `Window ${index}`,
        active: active === '1',
      };
    });
}

export async function getTmuxWindows(): Promise<TmuxWindow[]> {
  try {
    const { stdout } = await execSafe(`tmux list-windows -t ${TMUX_SESSION} -F "#{window_index}|#{window_active}|#{window_name}"`);
    return parseTmuxWindows(stdout);
  } catch {
    return [];
  }
}

async function getExposedPort(isManaged: boolean, workspaceId: string | null, workspaceToken: string | null, apiUrl: string | null): Promise<number> {
  const fallback = parseInt(process.env.ENVHAVEN_EXPOSED_PORT || '3000', 10);
  if (!isManaged || !workspaceId || !workspaceToken || !apiUrl) return fallback;

  try {
    const response = await fetch(`${apiUrl}/v1/internal/workspace/${workspaceId}/status`, {
      headers: { Authorization: `Bearer ${workspaceToken}` },
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const data = await response.json() as { exposedPort?: number };
      if (data.exposedPort) return data.exposedPort;
    }
  } catch {
    /* managed API unreachable — fall back to ENVHAVEN_EXPOSED_PORT/default */
  }

  return fallback;
}

// The `init-user-config-run` s6 script touches this marker on first boot and
// leaves it alone afterwards, so its mtime is the workspace's true creation
// time — persisted across container restarts on the /config volume.
// Deliberately no fallback to /proc/uptime or Date.now(): both reset on restart
// and would mis-flag a long-running workspace as brand new.
const WORKSPACE_CREATED_MARKER = '/config/.workspace-created';

function getWorkspaceCreatedAt(): string | null {
  try {
    const stat = fs.statSync(WORKSPACE_CREATED_MARKER);
    return new Date(stat.mtimeMs).toISOString();
  } catch {
    return null;
  }
}

export async function getWorkspaceInfo(): Promise<WorkspaceInfo> {
  const isManaged = process.env.ENVHAVEN_MANAGED === 'true';
  const workspacePath = process.env.DEFAULT_WORKSPACE || '/config/workspace';
  const ssh = getSshConfig();
  const publicUrl = process.env._ENVHAVEN_PUBLIC_URL || null;
  const workspaceId = process.env._ENVHAVEN_WORKSPACE_ID || null;
  const workspaceToken = process.env._ENVHAVEN_WORKSPACE_TOKEN || null;
  const apiUrl = process.env._ENVHAVEN_API_URL || null;
  const exposedPort = await getExposedPort(isManaged, workspaceId, workspaceToken, apiUrl);
  const createdAt = getWorkspaceCreatedAt();

  const [aiTools, versions, sshEnabled, previewPortOpen, tmuxWindows, versionInfo] = await Promise.all([
    // The console (console/api.go) is the single source of truth for the tool grid:
    // installed via PATH + per-tool auth status, computed by reading THIS container's
    // env, rc files, and auth files. Unreachable (e.g. a self-host box with no web
    // password) → an empty grid, the same graceful degradation the other
    // console-backed panels have.
    getTools().catch(() => [] as AITool[]),
    getCachedVersions(),
    isSshEnabled(),
    isPortOpen(exposedPort),
    getTmuxWindows(),
    getVersionInfo(isManaged, apiUrl),
  ]);

  return {
    isManaged,
    workspacePath,
    hostname: ssh.host,
    nodeVersion: versions.node,
    pythonVersion: versions.python,
    goVersion: versions.go,
    rustVersion: versions.rust,
    aiTools,
    sshEnabled,
    sshPort: ssh.port,
    sshCommand: sshEnabled ? ssh.command : null,
    sshConfigured: ssh.configured,
    sshKeyConfigured: isSshKeyConfigured(),
    publicUrl,
    previewUrl: getPreviewUrl(publicUrl),
    previewPortOpen,
    exposedPort,
    tmuxWindows,
    version: versionInfo,
    createdAt,
    envVarMeta: ENV_VAR_META,
  };
}
