import { atom } from 'jotai';
import { selectAtom } from 'jotai/utils';
import type { ContainerStatus } from '../lib/docker';
import type { Config } from '../lib/config';
import type { Theme } from '../lib/theme';

let _theme: Theme | undefined;

export function setTheme(theme: Theme) {
  _theme = theme;
}

export const THEME = new Proxy({} as Theme, {
  get(_, prop: keyof Theme) {
    if (!_theme) throw new Error('Theme not initialized. Call setTheme() first.');
    return _theme[prop];
  },
});

export interface LogLine {
  id: string;
  type: 'info' | 'success' | 'error' | 'warn' | 'command' | 'dim';
  text: string;
}

let logIdCounter = 0;
export function createLogLine(type: LogLine['type'], text: string): LogLine {
  return { id: `log-${++logIdCounter}`, type, text };
}

export interface MenuItem {
  key: string;
  label: string;
  shortcut: string;
  hint: string;
  group: 'primary' | 'inspect' | 'config';
}

export const MENU_ITEMS: MenuItem[] = [
  { key: 'start', label: 'Start Container', shortcut: 's', hint: 'Run or restart dev container', group: 'primary' },
  { key: 'build', label: 'Build Image', shortcut: 'b', hint: 'Rebuild Docker image', group: 'primary' },
  { key: 'watch', label: 'Watch Extension', shortcut: 'w', hint: 'Live extension dev', group: 'primary' },
  { key: 'release', label: 'Release', shortcut: 'r', hint: 'Tag → Image + CLI', group: 'primary' },
  { key: 'test', label: 'Test', shortcut: 't', hint: 'Run validation tests', group: 'inspect' },
  { key: 'logs', label: 'Logs', shortcut: 'l', hint: 'Stream container logs', group: 'inspect' },
  { key: 'shell', label: 'Shell', shortcut: 'x', hint: 'SSH into container', group: 'inspect' },
  { key: 'settings', label: 'Settings', shortcut: ',', hint: 'Configure environment', group: 'config' },
];

export const TEST_SUBMENU: MenuItem[] = [
  { key: 'test-image', label: 'Validate Image', shortcut: 'i', hint: 'Check runtimes & services', group: 'inspect' },
  { key: 'test-ai', label: 'AI Tools', shortcut: 'a', hint: 'Verify all AI CLI tools', group: 'inspect' },
  { key: 'test-cli', label: 'Test Haven CLI', shortcut: 'c', hint: 'CLI integration tests', group: 'inspect' },
  { key: 'test-ext', label: 'Test Extension', shortcut: 'e', hint: 'Extension build check', group: 'inspect' },
];

export const START_SUBMENU: MenuItem[] = [
  { key: 'start-normal', label: 'Start Container', shortcut: 's', hint: 'Run or restart container', group: 'primary' },
  { key: 'start-recreate', label: 'Recreate Container', shortcut: 'r', hint: 'Delete and start fresh', group: 'primary' },
  { key: 'start-delete', label: 'Delete Container', shortcut: 'd', hint: 'Remove only', group: 'primary' },
];

export interface SettingsField {
  key: keyof Config;
  label: string;
  mask?: boolean;
}

export const SETTINGS_FIELDS: SettingsField[] = [
  { key: 'containerName', label: 'Container' },
  { key: 'image', label: 'Image' },
  { key: 'host', label: 'Host' },
  { key: 'webPort', label: 'Web Port' },
  { key: 'sshPort', label: 'SSH Port' },
  { key: 'consolePort', label: 'Console Port' },
  { key: 'password', label: 'Password', mask: true },
];

export type UIMode =
  | { type: 'idle' }
  | { type: 'running'; operation: string }
  | { type: 'submenu'; menu: 'test' | 'start' }
  | { type: 'settings' }
  | { type: 'release' }
  | { type: 'help' };

export const uiModeAtom = atom<UIMode>({ type: 'idle' });

export const uiModeTypeAtom = selectAtom(uiModeAtom, (mode) => mode.type);
export const isRunningAtom = selectAtom(uiModeAtom, (mode) => mode.type === 'running');
export const operationAtom = selectAtom(uiModeAtom, (mode) => 
  mode.type === 'running' ? mode.operation : null
);
export const isSubmenuAtom = selectAtom(uiModeAtom, (mode) => 
  mode.type === 'submenu' ? mode.menu : null
);
export const isSettingsAtom = selectAtom(uiModeAtom, (mode) => mode.type === 'settings');
export const isReleaseAtom = selectAtom(uiModeAtom, (mode) => mode.type === 'release');
export const isHelpAtom = selectAtom(uiModeAtom, (mode) => mode.type === 'help');

export const configAtom = atom<Config | null>(null);
export const containerStatusAtom = atom<ContainerStatus>('not_found');
export const containerStaleAtom = atom<boolean>(false);
export const selectedIndexAtom = atom(0);
export const submenuIndexAtom = atom(0);
export const settingsIndexAtom = atom(0);
export const abortControllerAtom = atom<AbortController | null>(null);

interface TerminalSize {
  width: number;
  height: number;
}

const _terminalSizeAtom = atom<TerminalSize>({ width: 80, height: 24 });

export const terminalSizeAtom = atom(
  (get) => get(_terminalSizeAtom),
  (get, set, newSize: TerminalSize) => {
    const current = get(_terminalSizeAtom);
    if (current.width !== newSize.width || current.height !== newSize.height) {
      set(_terminalSizeAtom, newSize);
    }
  }
);

export const terminalWidthAtom = selectAtom(_terminalSizeAtom, (size) => size.width);
export const terminalHeightAtom = selectAtom(_terminalSizeAtom, (size) => size.height);

export interface ProgressState {
  step: number;
  total: number;
  percent: number;
}
export const progressAtom = atom<ProgressState | null>(null);

export const outputLinesAtom = atom<LogLine[]>([]);

const MAX_VISIBLE_LINES = 100;

let cachedVisibleLines: LogLine[] = [];
let cachedLastLineId: string | null = null;
let cachedLineCount = 0;
let cachedMaxLines = 0;

export const visibleLinesAtom = atom((get) => {
  const lines = get(outputLinesAtom);
  const terminalHeight = get(terminalHeightAtom);
  const progress = get(progressAtom);
  const isRunning = get(isRunningAtom);
  
  const hasProgress = progress !== null && isRunning;
  const progressHeight = hasProgress ? 2 : 0;
  const maxLines = Math.max(3, Math.min(MAX_VISIBLE_LINES, terminalHeight - 6 - progressHeight));
  
  const lineCount = lines.length;
  const lastLineId = lineCount > 0 ? lines[lineCount - 1].id : null;
  
  if (
    lastLineId === cachedLastLineId &&
    lineCount === cachedLineCount &&
    maxLines === cachedMaxLines
  ) {
    return cachedVisibleLines;
  }
  
  cachedLastLineId = lastLineId;
  cachedLineCount = lineCount;
  cachedMaxLines = maxLines;
  cachedVisibleLines = lineCount <= maxLines ? lines : lines.slice(-maxLines);
  
  return cachedVisibleLines;
});

export const hasOutputAtom = selectAtom(outputLinesAtom, (lines) => lines.length > 0);

export const isContainerRunningAtom = selectAtom(
  containerStatusAtom, 
  (status) => status === 'running'
);
