import { create } from 'zustand';
import { vscode } from '../lib/vscode';
import type {
  WorkspaceInfo,
  AITool,
  TmuxWindow,
  ResourceSnapshot,
  InstalledSkill,
  SkillsShResult,
  SkillFrontmatter,
} from '../lib/vscode';

type PortUpdateStatus = 'idle' | 'updating' | 'success' | 'error';

type SheetKey = 'ssh' | 'process' | 'skills' | 'tools';

export type SshKeyOpSource = 'github' | 'paste';
export type SshKeyOpStatus = 'idle' | 'loading' | 'success' | 'error';

export interface SshKeyOp {
  status: SshKeyOpStatus;
  error?: string;
  lastTs?: number;
}

/** A workspace younger than this with no connected tools shows the onboarding card. */
export const FRESH_WORKSPACE_MAX_AGE_SEC = 30 * 60;
/** After this age, drop first-run chips (Try Managed, Docs). */
export const YOUNG_WORKSPACE_MAX_AGE_SEC = 7 * 86400;

interface WorkspaceStore {
  workspace: WorkspaceInfo | null;
  resources: ResourceSnapshot | null;
  isLoading: boolean;
  portUpdateStatus: PortUpdateStatus;
  portError: string | null;

  openSheet: SheetKey | null;

  installedSkills: InstalledSkill[];
  installedSkillsLoaded: boolean;
  skillsSearchResults: Record<string, SkillsShResult[]>;
  skillsSearchError: string | null;
  skillInstalling: Record<string, boolean>;
  skillRemoving: Record<string, boolean>;
  skillMarkdown: Record<
    string,
    { content?: string; frontmatter?: SkillFrontmatter; error?: string; loading: boolean }
  >;

  sshKeyOps: Record<SshKeyOpSource, SshKeyOp>;

  docsOpened: boolean;
  markDocsOpened: () => void;

  setWorkspace: (workspace: WorkspaceInfo) => void;
  setResources: (resources: ResourceSnapshot) => void;
  setLoading: (loading: boolean) => void;
  setPortUpdateStatus: (status: PortUpdateStatus, error?: string) => void;
  optimisticSetPort: (port: number) => void;
  updateTerminals: (tmuxWindows: TmuxWindow[]) => void;

  setOpenSheet: (key: SheetKey | null) => void;

  setInstalledSkills: (skills: InstalledSkill[]) => void;
  setSkillSearchResults: (query: string, results: SkillsShResult[], error?: string) => void;
  setInstallInFlight: (key: string, inFlight: boolean) => void;
  setRemoveInFlight: (name: string, inFlight: boolean) => void;
  setSkillMarkdownLoading: (key: string) => void;
  setSkillMarkdown: (
    key: string,
    content?: string,
    frontmatter?: SkillFrontmatter,
    error?: string
  ) => void;

  setSshKeyOp: (source: SshKeyOpSource, op: SshKeyOp) => void;

  /**
   * Remove a skill by name. The store owns the name→path lookup so every
   * call site (sidebar panel, sheet browse card, sheet installed card, sheet
   * detail view) calls this directly — no per-component wrappers.
   */
  removeSkill: (name: string) => void;

  getConnectedTools: () => AITool[];
  getDisconnectedTools: () => AITool[];
  /** Age in seconds since `createdAt`; null when the marker is missing. */
  getWorkspaceAgeSec: () => number | null;
  /** True when we know the workspace is < 30 min old and no tool is connected. */
  isFreshWorkspace: () => boolean;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspace: null,
  resources: null,
  isLoading: true,
  portUpdateStatus: 'idle',
  portError: null,
  openSheet: null,
  installedSkills: [],
  installedSkillsLoaded: false,
  skillsSearchResults: {},
  skillsSearchError: null,
  skillInstalling: {},
  skillRemoving: {},
  skillMarkdown: {},
  sshKeyOps: {
    github: { status: 'idle' },
    paste: { status: 'idle' },
  },
  docsOpened: false,

  markDocsOpened: () => set({ docsOpened: true }),

  setOpenSheet: (key) => set({ openSheet: key }),

  setInstalledSkills: (skills) => set({ installedSkills: skills, installedSkillsLoaded: true }),

  setSkillSearchResults: (query, results, error) =>
    set((state) => ({
      skillsSearchResults: { ...state.skillsSearchResults, [query]: results },
      skillsSearchError: error ?? null,
    })),

  setInstallInFlight: (key, inFlight) =>
    set((state) => ({
      skillInstalling: { ...state.skillInstalling, [key]: inFlight },
    })),

  setRemoveInFlight: (name, inFlight) =>
    set((state) => ({
      skillRemoving: { ...state.skillRemoving, [name]: inFlight },
    })),

  setSshKeyOp: (source, op) =>
    set((state) => ({
      sshKeyOps: { ...state.sshKeyOps, [source]: op },
    })),

  removeSkill: (name) => {
    const skill = get().installedSkills.find((s) => s.name === name);
    if (!skill) return;
    set((state) => ({
      skillRemoving: { ...state.skillRemoving, [name]: true },
    }));
    vscode.postMessage({
      command: 'removeSkill',
      skillName: name,
      skillPath: skill.path,
    });
  },

  setSkillMarkdownLoading: (key) =>
    set((state) => ({
      skillMarkdown: { ...state.skillMarkdown, [key]: { loading: true } },
    })),

  setSkillMarkdown: (key, content, frontmatter, error) =>
    set((state) => ({
      skillMarkdown: {
        ...state.skillMarkdown,
        [key]: { loading: false, content, frontmatter, error },
      },
    })),

  setWorkspace: (workspace) =>
    set((state) => ({
      // tmuxWindows is owned by `updateTerminals` (pushed via tmux control mode).
      // Preserve the fresher list on subsequent refreshes to avoid Ctrl+B n flicker.
      workspace: state.workspace
        ? { ...workspace, tmuxWindows: state.workspace.tmuxWindows }
        : workspace,
      isLoading: false,
    })),
  setResources: (resources) => set({ resources }),
  setLoading: (loading) => set({ isLoading: loading }),

  updateTerminals: (tmuxWindows) => {
    const { workspace } = get();
    if (!workspace) return;
    set({ workspace: { ...workspace, tmuxWindows } });
  },

  setPortUpdateStatus: (status, error) => set({ 
    portUpdateStatus: status, 
    portError: error ?? null 
  }),

  optimisticSetPort: (port) => {
    const { workspace } = get();
    if (!workspace) return;
    set({ 
      workspace: { ...workspace, exposedPort: port },
      portUpdateStatus: 'updating',
    });
  },

  getConnectedTools: () => {
    const { workspace } = get();
    if (!workspace) return [];
    return workspace.aiTools.filter((t) => t.installed && t.authStatus === 'ready');
  },

  getDisconnectedTools: () => {
    const { workspace } = get();
    if (!workspace) return [];
    return workspace.aiTools.filter((t) => t.installed && t.authStatus !== 'ready');
  },

  getWorkspaceAgeSec: () => {
    const { workspace } = get();
    if (!workspace?.createdAt) return null;
    const createdMs = new Date(workspace.createdAt).getTime();
    if (!Number.isFinite(createdMs)) return null;
    return (Date.now() - createdMs) / 1000;
  },

  isFreshWorkspace: () => {
    const { workspace } = get();
    if (!workspace?.createdAt) return false;
    const ageSec = get().getWorkspaceAgeSec();
    if (ageSec === null || ageSec >= FRESH_WORKSPACE_MAX_AGE_SEC) return false;
    const connected = workspace.aiTools.filter(
      (t) => t.installed && t.authStatus === 'ready'
    ).length;
    return connected === 0;
  },
}));
