import type { WebviewApi } from 'vscode-webview';

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
}

export interface WebviewToExtensionMessage {
  command:
    | 'runTool'
    | 'runSetupCommand'
    | 'openToolDocs'
    | 'installOhMyOpenCode'
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
    | 'ready';
  tool?: string;
  toolName?: string;
  toolCommand?: string;
  setupCommand?: string;
  text?: string;
  url?: string;
  envVar?: string;
  apiKey?: string;
  sshPublicKey?: string;
  username?: string;
  port?: number;
  windowIndex?: number;
}

export interface ExtensionToWebviewMessage {
  command: 'updateWorkspace' | 'portUpdateSuccess' | 'portUpdateError' | 'updateTerminals';
  workspace?: WorkspaceInfo;
  port?: number;
  error?: string;
  tmuxWindows?: TmuxWindow[];
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
