// The single definition of the shapes shared across the extension's TWO bundles:
// the esbuild extension host and the Vite webview. The webview imports these
// `import type` only, so they are erased at build time — no cross-bundle runtime
// coupling, the reason the old mirror in webview/src/lib/vscode.ts existed.
//
// A subset (AITool, InstalledSkill, SkillsShResult, SkillFrontmatter, SetupStep)
// is also the WIRE the Go console emits (console/tools.go + console/skills.go).
// Keep those in lockstep with the Go structs; the golden-JSON conformance tests
// (console/api_golden_test.go + src/__tests__/console-conformance.test.ts) fail
// on drift: tools.golden.json locks AITool + SetupStep, skills.golden.json locks
// InstalledSkill + SkillsShResult. SkillFrontmatter has no golden — keep it
// aligned with skills.go by hand. WorkspaceInfo and friends are host→webview
// only (the host builds them; the console never returns them).

/** A tool-definitions.json setupSteps entry (both fields optional), passed
 *  through by the console verbatim so no client re-derives the catalog. */
export interface SetupStep {
  instruction?: string;
  command?: string;
}

/** One row of GET /__console/tools: the static catalog fields (id/name/command/
 *  authCommand/description/docsUrl/envVars/setupSteps) plus the dynamic result of
 *  reading THIS container (installed via PATH, authStatus + connectedVia via the
 *  console's checkAuth). The console is the sole owner of that auth logic; the
 *  extension and the dashboard both render this shape unchanged. */
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
  setupSteps?: SetupStep[];
  envVars?: string[];
}

/** An installed skill from GET /__console/skills (enriched + sorted server-side). */
export interface InstalledSkill {
  name: string;
  description: string;
  source: string | null;
  path: string;
  agents: string[];
}

/** A merged first-party + skills.sh search result from GET /__console/skills?q=.
 *  `installs` is null for first-party skills (no counter exists) and the
 *  skills.sh count for community ones — the wire value, passed through as-is. */
export interface SkillsShResult {
  id: string;
  skillId: string;
  name: string;
  installs: number | null;
  source: string;
}

/** The scalars the console parses out of a skill's SKILL.md frontmatter. */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  source?: string;
  license?: string;
}

/** The one tmux session every terminal window lives in. A value export consumed
 *  by the HOST only (the webview keeps its imports type-only); the Go console
 *  carries its own `tmuxSession` const (console/gate.go). */
export const TMUX_SESSION = 'envhaven';

/** A tmux window in the shared `envhaven` session. */
export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
}

/** The running image version vs the latest published, for the update prompt. */
export interface VersionInfo {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
}

/** Per-env-var UI metadata (placeholder, hint, signup URL) for the API-key input,
 *  keyed by env var name. Source of truth is tool-definitions.json's envVarMeta. */
export interface EnvVarMeta {
  placeholder: string;
  hint: string;
  url: string | null;
}

/** The full workspace snapshot the extension host builds and posts to the webview. */
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
  tmuxWindows: TmuxWindow[];
  version: VersionInfo;
  /** ISO timestamp of workspace first boot, or null when the marker is missing. */
  createdAt: string | null;
  envVarMeta: Record<string, EnvVarMeta>;
}

/** Where a process sits relative to the tmux panes: the pane shell itself, a
 *  direct child the user launched, or a deeper descendant. */
export type ProcessCategory = 'pane' | 'user' | 'child';

/** One row of the process table in a resource snapshot. */
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

/** The /proc-derived snapshot the host posts to the webview each poll tick. */
export interface ResourceSnapshot {
  cpu: { pct: number; nCpus: number };
  ram: { usedMb: number; totalMb: number; pct: number };
  disk: { usedGb: number; totalGb: number; pct: number };
  processes: ProcessInfo[];
  capturedAt: number;
}

/** Webview → extension-host messages, discriminated on `command`. The variants
 *  mirror the host's onDidReceiveMessage switch (sidebar-provider.ts) one-to-one. */
export type WebviewToExtensionMessage =
  | { command: 'ready' }
  | { command: 'runTool'; toolCommand: string }
  | { command: 'openToolDocs'; url: string }
  | { command: 'copySshCommand'; text: string }
  | { command: 'copyToClipboard'; text: string }
  | { command: 'setApiKey'; envVar: string; apiKey: string }
  | { command: 'signOutTool'; toolId: string }
  | { command: 'setSshKey'; sshPublicKey: string }
  | { command: 'importGitHubKeys'; username: string }
  | { command: 'switchTerminal'; windowIndex: number }
  | { command: 'newTerminal' }
  | { command: 'killTerminal'; windowIndex: number }
  | { command: 'updatePreviewPort'; port: number }
  | { command: 'openDocs' }
  | { command: 'openPlatform' }
  | { command: 'killProcess'; pid: number; starttime: number }
  | { command: 'searchSkills'; query: string }
  | { command: 'installSkill'; source: string; skillId: string }
  | { command: 'fetchSkillMarkdown'; source: string; skillId: string }
  | { command: 'removeSkill'; skillName: string; skillPath: string }
  | { command: 'openSkillInEditor'; skillPath: string };

/** Extension-host → webview messages, discriminated on `command`. The host's one
 *  outbound path (sidebar-provider's `_post`) enforces this union; App.tsx's
 *  message listener consumes it. */
export type ExtensionToWebviewMessage =
  | { command: 'updateWorkspace'; workspace: WorkspaceInfo }
  | { command: 'updateTerminals'; tmuxWindows: TmuxWindow[] }
  | { command: 'updateResources'; resources: ResourceSnapshot }
  | { command: 'portUpdateSuccess'; port: number }
  | { command: 'portUpdateError'; error: string }
  | { command: 'updateInstalledSkills'; installedSkills: InstalledSkill[] }
  | { command: 'skillSearchResult'; query: string; results: SkillsShResult[]; error?: string }
  | {
      command: 'skillMarkdownResult';
      source: string;
      skillId: string;
      markdown?: string;
      frontmatter?: SkillFrontmatter;
      error?: string;
    }
  | {
      command: 'skillInstallComplete';
      source: string;
      skillId: string;
      success: boolean;
      error?: string;
    }
  | { command: 'skillRemoveComplete'; skillName: string; success: boolean; error?: string }
  | {
      command: 'sshKeyResult';
      sshKeyOpSource: 'github' | 'paste';
      success: boolean;
      error?: string;
    }
  | { command: 'openSheet'; sheet: 'ssh' | 'process' | 'skills' | 'tools' };
