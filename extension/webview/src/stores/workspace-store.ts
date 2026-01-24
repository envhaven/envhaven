import { create } from 'zustand';
import type { WorkspaceInfo, AITool, TmuxWindow } from '../lib/vscode';

type PortUpdateStatus = 'idle' | 'updating' | 'success' | 'error';

interface WorkspaceStore {
  workspace: WorkspaceInfo | null;
  isLoading: boolean;
  portUpdateStatus: PortUpdateStatus;
  portError: string | null;

  setWorkspace: (workspace: WorkspaceInfo) => void;
  setLoading: (loading: boolean) => void;
  setPortUpdateStatus: (status: PortUpdateStatus, error?: string) => void;
  optimisticSetPort: (port: number) => void;
  updateTerminals: (tmuxWindows: TmuxWindow[]) => void;

  getConnectedTools: () => AITool[];
  getDisconnectedTools: () => AITool[];
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspace: null,
  isLoading: true,
  portUpdateStatus: 'idle',
  portError: null,

  setWorkspace: (workspace) => set({ workspace, isLoading: false }),
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
}));
