import type { WebviewApi } from 'vscode-webview';

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
}

export type ProcessCategory = 'pane' | 'user' | 'child';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  starttime: number;
  name: string;
  cmd: string;
  cpuPct: number;
  memMb: number;
  category: ProcessCategory;
}

export interface ResourceSnapshot {
  cpu: { pct: number; nCpus: number };
  ram: { usedMb: number; totalMb: number; pct: number };
  disk: { usedGb: number; totalGb: number; pct: number };
  processes: ProcessInfo[];
  capturedAt: number;
}

// NOTE: these 3 interfaces mirror extension/src/skillsService.ts. The webview
// (Vite) and extension (esbuild) are separate bundles, so the types must be
// re-declared here. If you change a field, update both sites.
export interface InstalledSkill {
  name: string;
  description: string;
  source: string | null;
  path: string;
  agents: string[];
}

export interface SkillsShResult {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  source?: string;
  license?: string;
}

export interface WebviewToExtensionMessage {
  command:
    | 'runTool'
    | 'openToolDocs'
    | 'openTerminal'
    | 'refresh'
    | 'openDocs'
    | 'openPlatform'
    | 'copySshCommand'
    | 'copyToClipboard'
    | 'setApiKey'
    | 'setSshKey'
    | 'importGitHubKeys'
    | 'updatePreviewPort'
    | 'switchTerminal'
    | 'newTerminal'
    | 'killTerminal'
    | 'killProcess'
    | 'searchSkills'
    | 'fetchSkillMarkdown'
    | 'installSkill'
    | 'removeSkill'
    | 'refreshInstalledSkills'
    | 'openSkillInEditor'
    | 'signOutTool'
    | 'ready';
  tool?: string;
  toolName?: string;
  toolCommand?: string;
  text?: string;
  url?: string;
  envVar?: string;
  apiKey?: string;
  sshPublicKey?: string;
  username?: string;
  port?: number;
  windowIndex?: number;
  pid?: number;
  starttime?: number;
  query?: string;
  source?: string;
  skillId?: string;
  skillName?: string;
  skillPath?: string;
  toolId?: string;
}

export interface ExtensionToWebviewMessage {
  command:
    | 'updateWorkspace'
    | 'portUpdateSuccess'
    | 'portUpdateError'
    | 'updateTerminals'
    | 'updateResources'
    | 'updateInstalledSkills'
    | 'skillSearchResult'
    | 'skillMarkdownResult'
    | 'skillInstallComplete'
    | 'skillRemoveComplete'
    | 'sshKeyResult'
    | 'openSheet';
  workspace?: WorkspaceInfo;
  port?: number;
  error?: string;
  tmuxWindows?: TmuxWindow[];
  resources?: ResourceSnapshot;
  installedSkills?: InstalledSkill[];
  query?: string;
  results?: SkillsShResult[];
  source?: string;
  skillId?: string;
  skillName?: string;
  markdown?: string;
  frontmatter?: SkillFrontmatter;
  success?: boolean;
  sheet?: 'ssh' | 'process' | 'skills' | 'tools';
  sshKeyOpSource?: 'github' | 'paste';
}

export interface AITool {
  id: string;
  name: string;
  command: string;
  authCommand: string | null;
  description: string;
  docsUrl: string;
  installed: boolean;
  authStatus: 'ready' | 'needs-auth' | 'unknown';
  connectedVia: string | null;
  envVars?: string[];
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
  exposedPort: number;
  workspaceId: string | null;
  workspaceToken: string | null;
  apiUrl: string | null;
  tmuxWindows: TmuxWindow[];
  version: VersionInfo;
  /** ISO timestamp of workspace first boot, or null when the marker is missing. */
  createdAt: string | null;
  envVarMeta: Record<string, EnvVarMeta>;
}

export interface EnvVarMeta {
  placeholder: string;
  hint: string;
  url: string | null;
}

class VSCodeAPI {
  private readonly vscodeApi: WebviewApi<unknown>;

  constructor() {
    this.vscodeApi = acquireVsCodeApi();
  }

  postMessage(message: WebviewToExtensionMessage): void {
    this.vscodeApi.postMessage(message);
  }

  getState<T>(): T | undefined {
    return this.vscodeApi.getState() as T | undefined;
  }

  setState<T>(state: T): T {
    return this.vscodeApi.setState(state) as T;
  }
}

export const vscode = new VSCodeAPI();
