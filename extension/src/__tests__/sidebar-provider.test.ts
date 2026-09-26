import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'fs';
import type * as vscode from 'vscode';
import * as consoleClient from '../consoleClient';
import type { SidebarProvider as Provider } from '../sidebar-provider';
import { TmuxControl } from '../tmux-control';

// bun cannot load the real vscode module; this is the surface the tested paths touch.
const vscodeWindow = {
  terminals: [] as unknown[],
  visibleTextEditors: [] as unknown[],
  createTerminal: mock((_options: unknown) => ({ show: (_preserveFocus?: boolean) => {} })),
  showErrorMessage: mock(async (_message: string) => undefined),
  showInformationMessage: mock(async (_message: string) => undefined),
};
mock.module('vscode', () => ({
  window: vscodeWindow,
  ViewColumn: { Active: -1 },
  Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
}));

let SidebarProvider: typeof Provider;
beforeAll(async () => {
  ({ SidebarProvider } = await import('../sidebar-provider'));
});

const READS = ['_refreshTerminalsOnly', 'refresh', '_refreshResources', '_refreshInstalledSkills'] as const;
let provider: Provider;
let spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  // The reads are stubbed, but a new unstubbed one must still never find this
  // machine's real web password.
  consoleClient.__setContainerEnvDirForTests('/nonexistent/envhaven-container-environment');
  vscodeWindow.terminals = [];
  vscodeWindow.visibleTextEditors = [];
  vscodeWindow.createTerminal.mockClear();
  vscodeWindow.showErrorMessage.mockClear();
  vscodeWindow.showInformationMessage.mockClear();
  spies = [
    // The welcome branch unlinks a real marker under /config, and start() would
    // attach to this machine's tmux server; no test may do either.
    spyOn(fs, 'unlinkSync').mockImplementation(() => {}),
    spyOn(TmuxControl.prototype, 'start').mockResolvedValue(undefined),
  ];
  provider = new SidebarProvider({} as vscode.Uri);
});

afterEach(() => {
  provider.dispose();
  for (const spy of spies) spy.mockRestore();
});

/** Replace the four sidebar reads, which otherwise run tmux, /proc and the console. */
function stubReads(read: () => Promise<void>): void {
  const target = provider as unknown as Record<(typeof READS)[number], () => Promise<void>>;
  for (const name of READS) target[name] = read;
}

/** Resolve a fake view and return its message sender. */
function resolveView(visible: boolean): (message: unknown) => Promise<void> {
  let receive: (message: unknown) => Promise<void> = async () => {};
  const view = {
    visible,
    webview: {
      options: {},
      html: '',
      cspSource: '',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: async () => true,
      onDidReceiveMessage: (listener: typeof receive) => {
        receive = listener;
      },
    },
    onDidChangeVisibility: () => {},
  };
  provider.resolveWebviewView(
    view as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    {} as vscode.CancellationToken
  );
  return (message) => receive(message);
}

function pollingStarted(): boolean {
  return (provider as unknown as { _pollingInterval?: unknown })._pollingInterval !== undefined;
}

describe('ready', () => {
  test('opens the welcome terminal and starts polling before the reads settle', async () => {
    let settle!: () => void;
    const reads = new Promise<void>((resolve) => {
      settle = resolve;
    });
    stubReads(() => reads);

    const handled = resolveView(true)({ command: 'ready' });

    expect(fs.unlinkSync).toHaveBeenCalledWith('/config/.envhaven-welcome-shown');
    expect(vscodeWindow.createTerminal).toHaveBeenCalledTimes(1);
    expect(pollingStarted()).toBe(true);
    settle();
    await handled;
  });

  test('does not poll while the view is hidden', async () => {
    stubReads(async () => {});
    await resolveView(false)({ command: 'ready' });
    expect(pollingStarted()).toBe(false);
  });

  test('reports a failed read without skipping the terminal or polling', async () => {
    spies.push(spyOn(console, 'error').mockImplementation(() => {}));
    stubReads(async () => {
      throw new Error('tmux gone');
    });
    await resolveView(true)({ command: 'ready' });
    expect(vscodeWindow.createTerminal).toHaveBeenCalledTimes(1);
    expect(pollingStarted()).toBe(true);
    expect(vscodeWindow.showErrorMessage).toHaveBeenCalledWith('Action failed: tmux gone');
  });
});

describe('signOutTool', () => {
  function signOutRejects(status: number, instruction: string): void {
    spies.push(
      spyOn(consoleClient, 'signOutTool').mockRejectedValue(
        new consoleClient.ConsoleRequestError(instruction, status, instruction)
      )
    );
  }

  test('opens the terminal for a sign-out that stopped partway, then refreshes', async () => {
    const instruction =
      'The logout session opened, but managed credential cleanup did not finish. Finish the vendor logout, then retry sign-out.';
    const refresh = mock(async () => {});
    stubReads(refresh);
    signOutRejects(500, instruction);

    await resolveView(true)({ command: 'signOutTool', toolId: 'factory' });

    expect(vscodeWindow.createTerminal).toHaveBeenCalledTimes(1);
    expect(vscodeWindow.showErrorMessage).toHaveBeenCalledWith(`Failed to sign out: ${instruction}`);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('leaves the terminal closed for a conflict, then refreshes', async () => {
    const instruction = 'OPENAI_API_KEY is shared. Remove it from Environment.';
    const refresh = mock(async () => {});
    stubReads(refresh);
    signOutRejects(409, instruction);

    await resolveView(true)({ command: 'signOutTool', toolId: 'qwen' });

    expect(vscodeWindow.createTerminal).not.toHaveBeenCalled();
    expect(vscodeWindow.showErrorMessage).toHaveBeenCalledWith(`Failed to sign out: ${instruction}`);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
