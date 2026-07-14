import type { WebviewApi } from 'vscode-webview';

// The shapes shared with the extension host live in one place (src/shared-types.ts)
// and are imported type-only, so this Vite bundle carries no runtime coupling to the
// esbuild host bundle. Re-exported so webview components keep importing them from
// './vscode'. See src/shared-types.ts for the console-wire vs host-only split.
import type {
  AITool,
  SetupStep,
  InstalledSkill,
  SkillsShResult,
  SkillFrontmatter,
  TmuxWindow,
  VersionInfo,
  EnvVarMeta,
  WorkspaceInfo,
  ProcessCategory,
  ProcessInfo,
  ResourceSnapshot,
  WebviewToExtensionMessage,
  ExtensionToWebviewMessage,
} from '../../../src/shared-types';
export type {
  AITool,
  SetupStep,
  InstalledSkill,
  SkillsShResult,
  SkillFrontmatter,
  TmuxWindow,
  VersionInfo,
  EnvVarMeta,
  WorkspaceInfo,
  ProcessCategory,
  ProcessInfo,
  ResourceSnapshot,
  WebviewToExtensionMessage,
  ExtensionToWebviewMessage,
};

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
