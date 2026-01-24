import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';

/** Default timeout for all process spawns (ms) */
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Execute a command with a hard timeout that actually kills the process.
 * Node's exec timeout only rejects the promise but doesn't kill the spawned process.
 * This is the ONLY way to spawn processes in this module - prevents zombie accumulation.
 */
function execSafe(command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
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

interface StaticCache {
  tools: Map<string, { installed: boolean }>;
  versions: {
    node: string | null;
    python: string | null;
    go: string | null;
    rust: string | null;
  } | null;
  rcEnvVars: Map<string, string> | null;
}

const staticCache: StaticCache = {
  tools: new Map(),
  versions: null,
  rcEnvVars: null,
};

async function getCachedVersions(): Promise<NonNullable<StaticCache['versions']>> {
  if (staticCache.versions) return staticCache.versions;

  const [node, python, go, rust] = await Promise.all([
    getVersion('node'),
    getVersion('python3'),
    getVersion('go', 'version'),
    getVersion('rustc'),
  ]);

  staticCache.versions = { node, python, go, rust };
  return staticCache.versions;
}

export interface SetupStep {
  instruction?: string;
  command?: string;
}

export interface AITool {
  id: string;
  name: string;
  command: string;
  description: string;
  docsUrl: string;
  installed: boolean;
  authStatus: 'ready' | 'needs-auth' | 'unknown';
  connectedVia: string | null;
  authHint?: string;
  setupSteps?: SetupStep[];
  envVars?: string[];
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
}

export interface VersionInfo {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
}

export interface WorkspaceInfo {
  isManaged: boolean;
  workspacePath: string;
  hostname: string;
  nodeVersion: string | null;
  pythonVersion: string | null;
  goVersion: string | null;
  rustVersion: string | null;
  aiTools: AITool[];
  sshEnabled: boolean;
  sshPort: number;
  sshCommand: string | null;
  sshConfigured: boolean;
  sshKeyConfigured: boolean;
  publicUrl: string | null;
  previewUrl: string | null;
  previewPortOpen: boolean;
  hasOhMyOpenCode: boolean;
  exposedPort: number;
  workspaceId: string | null;
  workspaceToken: string | null;
  apiUrl: string | null;
  tmuxWindows: TmuxWindow[];
  version: VersionInfo;
}

export interface ToolDefinition {
  id: string;
  name: string;
  command: string;
  description: string;
  docsUrl: string;
  envVars?: string[];
  authCommand?: string;
  authHint?: string;
  setupSteps?: SetupStep[];
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    description: 'AI coding agent from SST',
    docsUrl: 'https://opencode.ai/docs',
    envVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'],
    setupSteps: [
      { instruction: 'Run OpenCode and configure your provider:' },
      { command: 'opencode' },
      { instruction: 'Then type /connect to set up authentication.' },
    ],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    description: "Anthropic's official CLI",
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    authCommand: 'claude auth status',
    setupSteps: [
      { instruction: 'Sign in with your Claude account:' },
      { command: 'claude' },
      { instruction: 'Then type /login to authenticate via browser.' },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    description: "Google's AI in your terminal",
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    setupSteps: [
      { instruction: 'Run Gemini and select your auth method:' },
      { command: 'gemini' },
      { instruction: 'Or set: export GEMINI_API_KEY="your-key"' },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    description: "OpenAI's coding agent",
    docsUrl: 'https://github.com/openai/codex',
    envVars: ['OPENAI_API_KEY'],
    setupSteps: [
      { instruction: 'Sign in with ChatGPT (Plus/Pro/Team):' },
      { command: 'codex' },
      { instruction: 'Or set: export OPENAI_API_KEY="your-key"' },
    ],
  },
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    description: 'AI pair programming',
    docsUrl: 'https://aider.chat',
    envVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'],
    setupSteps: [
      { instruction: 'Set your API key for any supported provider:' },
      { command: 'export ANTHROPIC_API_KEY="your-key"' },
      { instruction: 'Or: OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY' },
    ],
  },
  {
    id: 'goose',
    name: 'Goose',
    command: 'goose',
    description: "Block's AI developer agent",
    docsUrl: 'https://block.github.io/goose',
    envVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    setupSteps: [
      { instruction: 'Configure your LLM provider:' },
      { command: 'goose configure' },
      { instruction: 'Select "Configure Providers" and enter your API key.' },
    ],
  },
  {
    id: 'vibe',
    name: 'Mistral Vibe',
    command: 'vibe',
    description: 'Powered by Devstral',
    docsUrl: 'https://github.com/mistralai/mistral-vibe',
    envVars: ['MISTRAL_API_KEY'],
    setupSteps: [
      { instruction: 'Set your Mistral API key:' },
      { command: 'export MISTRAL_API_KEY="your-key"' },
      { instruction: 'Get key at console.mistral.ai' },
    ],
  },
  {
    id: 'amp',
    name: 'Amp',
    command: 'amp',
    description: 'Frontier coding agent',
    docsUrl: 'https://ampcode.com/manual',
    envVars: ['AMP_API_KEY'],
    setupSteps: [
      { instruction: 'Sign in via browser:' },
      { command: 'amp login' },
      { instruction: 'Or set: export AMP_API_KEY="your-key"' },
    ],
  },
  {
    id: 'auggie',
    name: 'Augment',
    command: 'auggie',
    description: 'Context-aware coding agent',
    docsUrl: 'https://docs.augmentcode.com/cli/overview',
    authCommand: 'auggie tokens print',
    setupSteps: [
      { instruction: 'Sign in via browser:' },
      { command: 'auggie login' },
    ],
  },
  {
    id: 'factory',
    name: 'Factory',
    command: 'droid',
    description: 'AI for CI/CD automation',
    docsUrl: 'https://docs.factory.ai',
    envVars: ['FACTORY_API_KEY'],
    setupSteps: [
      { instruction: 'Run droid - browser auth opens automatically:' },
      { command: 'droid' },
    ],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    command: 'kiro-cli',
    description: 'AWS-powered AI CLI',
    docsUrl: 'https://kiro.dev/docs/cli',
    setupSteps: [
      { instruction: 'Run Kiro - browser auth opens automatically:' },
      { command: 'kiro-cli' },
      { instruction: 'Sign in with GitHub, Google, or AWS Builder ID.' },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    command: 'qwen',
    description: "Alibaba's coding assistant",
    docsUrl: 'https://qwenlm.github.io/qwen-code-docs',
    envVars: ['QWEN_API_KEY'],
    setupSteps: [
      { instruction: 'Run Qwen and sign in (free tier available):' },
      { command: 'qwen' },
      { instruction: 'Or use OpenAI-compatible API with OPENAI_API_KEY' },
    ],
  },
];

async function commandExists(cmd: string): Promise<boolean> {
  const cached = staticCache.tools.get(cmd);
  if (cached !== undefined) return cached.installed;

  try {
    await execSafe(`which ${cmd}`);
    staticCache.tools.set(cmd, { installed: true });
    return true;
  } catch {
    staticCache.tools.set(cmd, { installed: false });
    return false;
  }
}

async function getVersion(cmd: string, versionArg = '--version'): Promise<string | null> {
  try {
    const { stdout } = await execSafe(`${cmd} ${versionArg} 2>/dev/null`);
    const match = stdout.match(/(\d+\.\d+(\.\d+)?)/);
    return match ? match[1] : stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}

function parseRcEnvVars(): Map<string, string> {
  const envVars = new Map<string, string>();
  const rcPaths = [
    path.join(os.homedir(), '.zshrc'),
    path.join(os.homedir(), '.bashrc'),
  ];

  for (const rcPath of rcPaths) {
    try {
      const content = fs.readFileSync(rcPath, 'utf-8');
      const regex = /^export\s+(\w+)=["']?([^"'\n]+)["']?/gm;
      let match;
      while ((match = regex.exec(content)) !== null) {
        if (!envVars.has(match[1])) {
          envVars.set(match[1], match[2]);
        }
      }
    } catch {
      continue;
    }
  }
  return envVars;
}

function getCachedRcEnvVars(): Map<string, string> {
  if (!staticCache.rcEnvVars) {
    staticCache.rcEnvVars = parseRcEnvVars();
  }
  return staticCache.rcEnvVars;
}

function getSetEnvVar(varNames: string[]): string | null {
  const rcVars = getCachedRcEnvVars();
  for (const varName of varNames) {
    if (process.env[varName]) return varName;
    if (rcVars.has(varName)) return varName;
  }
  return null;
}

export interface AuthResult {
  status: 'ready' | 'needs-auth' | 'unknown';
  connectedVia: string | null;
}

const FILE_AUTH_PATHS: Record<string, { path: string; label: string }[]> = {
  opencode: [
    { path: '.local/share/opencode/auth.json', label: 'opencode auth' },
  ],
  claude: [
    { path: '.claude/.credentials.json', label: 'credentials file' },
  ],
  codex: [
    { path: '.codex/auth.json', label: 'codex auth' },
    { path: '.codex/config.toml', label: 'codex config' },
  ],
  gemini: [
    { path: '.gemini/oauth_creds.json', label: 'google oauth' },
    { path: '.gemini/settings.json', label: 'gemini settings' },
  ],
  kiro: [
    { path: '.kiro/settings/cli.json', label: 'kiro settings' },
  ],
  amp: [
    { path: '.config/amp/auth.json', label: 'amp auth' },
    { path: '.amp/credentials', label: 'amp credentials' },
  ],
  qwen: [
    { path: '.qwen/config.json', label: 'qwen config' },
    { path: '.config/qwen/config.json', label: 'qwen config' },
  ],
};

function checkGooseAuth(): AuthResult {
  const configPath = path.join(os.homedir(), '.config/goose/config.yaml');
  try {
    if (!fs.existsSync(configPath)) {
      return { status: 'needs-auth', connectedVia: null };
    }
    const content = fs.readFileSync(configPath, 'utf-8');
    if (content.includes('GOOSE_PROVIDER:')) {
      const match = content.match(/GOOSE_PROVIDER:\s*["']?(\w+)["']?/);
      const provider = match ? match[1] : 'configured';
      return { status: 'ready', connectedVia: `goose (${provider})` };
    }
    return { status: 'needs-auth', connectedVia: null };
  } catch {
    return { status: 'needs-auth', connectedVia: null };
  }
}

function checkAuggieAuth(): AuthResult {
  if (process.env.AUGMENT_SESSION_AUTH) {
    return { status: 'ready', connectedVia: 'AUGMENT_SESSION_AUTH' };
  }
  const rcVars = getCachedRcEnvVars();
  if (rcVars.has('AUGMENT_SESSION_AUTH')) {
    return { status: 'ready', connectedVia: 'AUGMENT_SESSION_AUTH' };
  }
  return { status: 'unknown', connectedVia: null };
}

export async function checkAuth(def: ToolDefinition): Promise<AuthResult> {
  if (def.envVars) {
    const setVar = getSetEnvVar(def.envVars);
    if (setVar) return { status: 'ready', connectedVia: setVar };
  }

  if (def.id === 'goose') return checkGooseAuth();
  if (def.id === 'auggie') return checkAuggieAuth();

  const filePaths = FILE_AUTH_PATHS[def.id];
  if (filePaths) {
    for (const { path: relPath, label } of filePaths) {
      const fullPath = path.join(os.homedir(), relPath);
      try {
        if (fs.existsSync(fullPath)) {
          if (fullPath.endsWith('.json')) {
            const content = fs.readFileSync(fullPath, 'utf-8').trim();
            if (content && content !== '{}' && content !== '[]') {
              return { status: 'ready', connectedVia: label };
            }
          } else {
            return { status: 'ready', connectedVia: label };
          }
        }
      } catch {
        continue;
      }
    }
    return { status: 'needs-auth', connectedVia: null };
  }

  if (def.envVars && def.envVars.length > 0) {
    return { status: 'needs-auth', connectedVia: null };
  }

  return { status: 'unknown', connectedVia: null };
}

function hasOhMyOpenCode(): boolean {
  const configPath = path.join(os.homedir(), '.config/opencode/opencode.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config.plugin?.includes('oh-my-opencode') ?? false;
  } catch {
    return false;
  }
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
  } catch { }
  
  const updateAvailable = !!(current && latest && current !== latest);
  
  return { current, latest, updateAvailable };
}

export async function getTmuxWindows(): Promise<TmuxWindow[]> {
  try {
    const { stdout } = await execSafe('tmux list-windows -t envhaven -F "#{window_index}|#{window_name}|#{window_active}"');
    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.map((line) => {
      const [index, name, active] = line.split('|');
      return {
        index: parseInt(index, 10),
        name: name || `Window ${index}`,
        active: active === '1',
      };
    });
  } catch {
    return [];
  }
}

export async function getWorkspaceInfo(): Promise<WorkspaceInfo> {
  const isManaged = process.env.ENVHAVEN_MANAGED === 'true';
  const workspacePath = process.env.DEFAULT_WORKSPACE || '/config/workspace';
  const ssh = getSshConfig();
  const publicUrl = process.env.ENVHAVEN_PUBLIC_URL || null;
  const exposedPort = parseInt(process.env.ENVHAVEN_EXPOSED_PORT || '3000', 10);
  const workspaceId = process.env.ENVHAVEN_WORKSPACE_ID || null;
  const workspaceToken = process.env.ENVHAVEN_WORKSPACE_TOKEN || null;
  const apiUrl = process.env.ENVHAVEN_API_URL || null;

  const [toolResults, versions, sshEnabled, previewPortOpen, tmuxWindows, versionInfo] = await Promise.all([
    Promise.all(
      TOOL_DEFINITIONS.map(async (def) => {
        const installed = await commandExists(def.command);
        const auth = installed
          ? await checkAuth(def)
          : { status: 'needs-auth' as const, connectedVia: null };
        return {
          id: def.id,
          name: def.name,
          command: def.command,
          description: def.description,
          docsUrl: def.docsUrl,
          installed,
          authStatus: auth.status,
          connectedVia: auth.connectedVia,
          authHint: def.authHint,
          setupSteps: def.setupSteps,
          envVars: def.envVars,
        };
      })
    ),
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
    aiTools: toolResults,
    sshEnabled,
    sshPort: ssh.port,
    sshCommand: sshEnabled ? ssh.command : null,
    sshConfigured: ssh.configured,
    sshKeyConfigured: isSshKeyConfigured(),
    publicUrl,
    previewUrl: getPreviewUrl(publicUrl),
    previewPortOpen,
    hasOhMyOpenCode: hasOhMyOpenCode(),
    exposedPort,
    workspaceId,
    workspaceToken,
    apiUrl,
    tmuxWindows,
    version: versionInfo,
  };
}
