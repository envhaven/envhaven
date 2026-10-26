import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { runHandledAction } from './action-handler';
import {
  getWorkspaceInfo,
  getTmuxWindows,
  getPreviewUrl,
} from './environment';
import { snapshot as resourceSnapshot, signalProcess } from './resource-monitor';
import { TmuxControl } from './tmux-control';
import * as consoleClient from './consoleClient';
import {
  TMUX_SESSION,
  type AITool,
  type ConsoleToolAction,
  type ExtensionToWebviewMessage,
  type InstalledSkill,
  type ResourceSnapshot,
  type WebviewToExtensionMessage,
  type WorkspaceInfo,
} from './shared-types';

const DOCKER_PULL_COMMAND = 'docker pull ghcr.io/envhaven/envhaven:latest';

// OpenSSH's SHA256 fingerprint format, computed locally from a key already validated below.
function authorizedKeyFingerprint(line: string): string {
  const blob = line.trim().split(/\s+/)[1]!;
  return `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'envhaven.sidebarView';

  private _view?: vscode.WebviewView;
  private _pollingInterval?: ReturnType<typeof setInterval>;
  private _tmuxControl = new TmuxControl(TMUX_SESSION);

  // What this host last showed the webview. A webview message is a request, never a
  // source of truth: one that names a tool, a skill, a process or text to copy is acted on
  // only when the host itself offered that thing, so script that gets into the webview
  // cannot widen what the host does on its behalf.
  private _workspace?: WorkspaceInfo;
  private _installedSkills: InstalledSkill[] = [];
  private _resources?: ResourceSnapshot;
  private _offeredSkills = new Set<string>();

  constructor(private readonly _extensionUri: vscode.Uri) {
    this._tmuxControl.on((e) => {
      if (e === 'change') this._refreshTerminalsOnly();
    });
    void this._tmuxControl.start();
  }

  // Terminal location helper - uses editor area instead of panel
  private _terminalLocation(preserveFocus: boolean): vscode.TerminalEditorLocationOptions {
    return {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus,
    };
  }

  private _getOrCreateTerminal(name: string, preserveFocus: boolean, skipWelcome = false): vscode.Terminal {
    const existing = vscode.window.terminals.find((t) => t.name === name);
    if (existing) return existing;

    return vscode.window.createTerminal({
      name,
      location: this._terminalLocation(preserveFocus),
      env: skipWelcome ? { ENVHAVEN_SKIP_WELCOME: '1' } : undefined,
    });
  }

  public async refresh(): Promise<void> {
    if (this._view) {
      const workspaceInfo = await getWorkspaceInfo();
      this._workspace = workspaceInfo;
      this._post({ command: 'updateWorkspace', workspace: workspaceInfo });
    }
  }

  /** The ONE outbound path to the webview; the union keeps payloads honest. */
  private _post(message: ExtensionToWebviewMessage): void {
    this._view?.webview.postMessage(message);
  }

  // Public actions. The webview triggers these via messages; the native command
  // palette calls them directly. Keeping one dispatch surface (the message
  // switch below) routed to these methods avoids a second palette-specific
  // switch that would drift out of sync.
  public openSheet(sheet: 'ssh' | 'process' | 'skills' | 'tools'): void {
    this._post({ command: 'openSheet', sheet });
  }

  public openTerminal(): void {
    this._getOrCreateTerminal('Terminal', false).show(false);
  }

  public async reportActionError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    console.error('envhaven: action failed', error);
    try {
      await vscode.window.showErrorMessage(`Action failed: ${message}`);
    } catch (reportError) {
      console.error('envhaven: could not show action failure', reportError);
    }
  }

  private async _refreshTerminalsOnly(): Promise<void> {
    if (this._view) {
      const tmuxWindows = await getTmuxWindows();
      this._post({ command: 'updateTerminals', tmuxWindows });
    }
  }

  private async _refreshResources(): Promise<void> {
    if (!this._view) return;
    try {
      const resources = await resourceSnapshot();
      this._resources = resources;
      this._post({ command: 'updateResources', resources });
    } catch {
      /* silent — next tick retries */
    }
  }

  private async _refreshInstalledSkills(): Promise<void> {
    if (!this._view) return;
    try {
      const installedSkills = await consoleClient.listInstalledSkills();
      this._installedSkills = installedSkills;
      this._post({ command: 'updateInstalledSkills', installedSkills });
    } catch (err) {
      // Console unreachable or errored: keep the panel empty and retry next tick.
      console.warn('envhaven: listInstalledSkills failed', err);
    }
  }

  public dispose(): void {
    this._stopPolling();
    this._tmuxControl.dispose();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'webview', 'build')],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._startPolling();
      } else {
        this._stopPolling();
      }
    });

    webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) =>
      runHandledAction(async () => {
      switch (message.command) {
        case 'ready': {
          // A freshly loaded webview has no search results, so it can name none.
          this._offeredSkills.clear();
          // Terminal and polling first: neither may wait on the slowest read
          // below, and a failed read must not skip them.
          const hasOpenEditors = vscode.window.visibleTextEditors.length > 0;
          const hasOpenTerminals = vscode.window.terminals.length > 0;
          if (!hasOpenEditors && !hasOpenTerminals) {
            try { fs.unlinkSync('/config/.envhaven-welcome-shown'); } catch {}
            const terminal = this._getOrCreateTerminal('Terminal', true);
            terminal.show(true);
          }
          this._startPolling();
          await Promise.all([
            this._refreshTerminalsOnly(),
            this.refresh(),
            this._refreshResources(),
            this._refreshInstalledSkills(),
          ]);
          break;
        }

        case 'runTool': {
          // The console checks the id against its catalog too, but when its HTTP API is
          // down the request falls back to the local binary, so the host checks first.
          const tool = this._catalogTool(message.toolId);
          if (!tool) throw new Error('Refused to run a tool this workspace did not list');
          await this.runAiTool(tool.id, message.action);
          break;
        }

        case 'openToolDocs': {
          if (typeof message.url !== 'string' || !message.url) break;
          // Docs and skill links are all https. openExternal would hand a file:,
          // command: or vscode: URI to its own handler, so nothing else leaves here.
          const uri = vscode.Uri.parse(message.url);
          if (uri.scheme !== 'https') throw new Error('Refused to open a link that is not https');
          await vscode.env.openExternal(uri);
          break;
        }

        case 'copyToClipboard': {
          // The webview names what to copy and the host supplies the text, so a webview
          // message cannot put arbitrary text on the clipboard behind a routine toast.
          const copy = this._clipboardText(message.key);
          if (!copy) throw new Error('Refused to copy text the sidebar does not show');
          await vscode.env.clipboard.writeText(copy.text);
          vscode.window.showInformationMessage(`${copy.label} copied to clipboard`);
          break;
        }

        case 'setApiKey': {
          if (typeof message.apiKey !== 'string' || !message.apiKey) break;
          const tool = this._catalogTool(message.toolId);
          if (!tool || !tool.envVars?.includes(message.envVar)) {
            throw new Error('Refused to save a key the tool does not declare');
          }
          await this._setApiKey(tool.id, message.envVar, message.apiKey);
          await this.refresh();
          break;
        }

        case 'signOutTool': {
          const tool = this._catalogTool(message.toolId);
          if (!tool) throw new Error('Refused to sign out of a tool this workspace did not list');
          await this._signOutTool(tool.id);
          break;
        }

        case 'setSshKey':
          if (typeof message.sshPublicKey === 'string' && message.sshPublicKey) {
            await this._setSshKey(message.sshPublicKey);
            await this.refresh();
          }
          break;

        case 'importGitHubKeys':
          if (typeof message.username === 'string' && message.username) {
            await this._importGitHubKeys(message.username);
            await this.refresh();
          }
          break;

        case 'switchTerminal':
          if (typeof message.windowIndex === 'number') {
            await this.switchTmuxWindow(message.windowIndex);
          }
          break;

        case 'newTerminal':
          await this.newTmuxWindow();
          break;

        case 'killTerminal':
          if (typeof message.windowIndex === 'number') {
            await this._killTmuxWindow(message.windowIndex);
          }
          break;

        case 'updatePreviewPort':
          // The webview's editor clamps to this range as well, but the message is what
          // reaches the platform with the workspace token, so the host checks it.
          if (isExposedPort(message.port)) {
            await this._updatePreviewPort(message.port);
          } else {
            this._post({ command: 'portUpdateError', error: 'Port must be between 1024 and 65535' });
          }
          break;

        case 'openDocs':
          await vscode.env.openExternal(vscode.Uri.parse('https://github.com/envhaven/envhaven/tree/master/docs'));
          break;

        case 'openPlatform':
          await vscode.env.openExternal(vscode.Uri.parse('https://envhaven.com'));
          break;

        case 'killProcess': {
          if (typeof message.pid !== 'number' || typeof message.starttime !== 'number') break;
          const { pid, starttime } = message;
          // signalProcess only reaches processes the last snapshot listed, but those are
          // the user's own shells, agents and servers, and the webview's terminate button
          // asks nothing. So the host asks, naming the process from its own snapshot: a
          // webview message alone never ends someone's work.
          const target = this._resources?.processes.find(
            (p) => p.pid === pid && p.starttime === starttime
          );
          if (!target) {
            vscode.window.showWarningMessage(`Cannot terminate PID ${pid}: not in current view`);
            break;
          }
          const choice = await vscode.window.showWarningMessage(
            `Terminate ${target.name} (PID ${pid})?`,
            { modal: true, detail: target.cmd },
            'Terminate'
          );
          if (choice !== 'Terminate') break;
          const term = signalProcess(pid, starttime, 'SIGTERM');
          if (!term.ok) {
            vscode.window.showWarningMessage(
              `Cannot terminate PID ${pid}: ${term.reason ?? 'unknown'}`
            );
            break;
          }
          await this._refreshResources();
          setTimeout(async () => {
            const kill = signalProcess(pid, starttime, 'SIGKILL');
            if (kill.ok) await this._refreshResources();
          }, 2000);
          break;
        }

        case 'searchSkills': {
          const query = typeof message.query === 'string' ? message.query : '';
          try {
            const results = await consoleClient.searchSkills(query);
            for (const result of results) {
              this._offeredSkills.add(skillKey(result.source, result.skillId));
            }
            this._post({ command: 'skillSearchResult', query, results });
          } catch (err) {
            this._post({
              command: 'skillSearchResult',
              query,
              results: [],
              error: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }

        case 'installSkill': {
          const source = typeof message.source === 'string' ? message.source : '';
          const skillId = typeof message.skillId === 'string' ? message.skillId : '';
          if (!source || !skillId) break;
          // An install runs `skills add` for every connected agent, so only a skill
          // the console returned to this sidebar's search is installed. The completion
          // still goes out, so the button the webview disabled comes back.
          if (!this._offeredSkills.has(skillKey(source, skillId))) {
            this._post({
              command: 'skillInstallComplete',
              source,
              skillId,
              success: false,
              error: SKILL_NOT_OFFERED,
            });
            throw new Error(`Refused to install: ${SKILL_NOT_OFFERED}`);
          }
          // The console scopes the install to every authenticated skills-capable
          // tool (it runs the same auth checks server-side), so the host no
          // longer collects and forwards connected tool ids.
          const { success, error } = await this._runSkillAction(() =>
            consoleClient.installSkill(source, skillId)
          );
          // Refresh the installed list BEFORE clearing the loading flag so the
          // webview never has a moment where the button is re-enabled but the
          // list hasn't caught up yet.
          await this._refreshInstalledSkills();
          this._post({ command: 'skillInstallComplete', source, skillId, success, error });
          if (success) {
            vscode.window.showInformationMessage(`Installed ${skillId}`);
          } else {
            vscode.window.showErrorMessage(
              `Failed to install ${skillId}: ${error ?? 'unknown'}`
            );
          }
          break;
        }

        case 'fetchSkillMarkdown': {
          const source = typeof message.source === 'string' ? message.source : '';
          const skillId = typeof message.skillId === 'string' ? message.skillId : '';
          if (!source || !skillId) break;
          if (!this._offeredSkills.has(skillKey(source, skillId))) {
            this._post({ command: 'skillMarkdownResult', source, skillId, error: SKILL_NOT_OFFERED });
            break;
          }
          try {
            const { markdown, frontmatter } = await consoleClient.fetchSkillMarkdown(
              source,
              skillId
            );
            this._post({ command: 'skillMarkdownResult', source, skillId, markdown, frontmatter });
          } catch (err) {
            this._post({
              command: 'skillMarkdownResult',
              source,
              skillId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }

        case 'removeSkill': {
          const skillName = typeof message.skillName === 'string' ? message.skillName : '';
          const skillPath = typeof message.skillPath === 'string' ? message.skillPath : '';
          if (!skillName || !skillPath) break;
          const skill = this._installedSkill(skillPath);
          if (!skill) {
            this._post({ command: 'skillRemoveComplete', skillName, success: false, error: NOT_INSTALLED });
            throw new Error(`Refused to remove: ${NOT_INSTALLED}`);
          }
          const { success, error } = await this._runSkillAction(() =>
            consoleClient.removeSkill(skill.path)
          );
          // Refresh first so the row has disappeared from the list before the
          // webview clears its removing flag — otherwise the row re-enables
          // for a tick and can be clicked again.
          await this._refreshInstalledSkills();
          this._post({ command: 'skillRemoveComplete', skillName, success, error });
          if (success) {
            vscode.window.showInformationMessage(`Removed ${skillName}`);
          } else {
            vscode.window.showErrorMessage(`Failed to remove ${skillName}: ${error ?? 'unknown error'}`);
          }
          break;
        }

        case 'openSkillInEditor': {
          // Only an installed skill the host listed: opening whatever path the webview
          // names would put any file in the container in front of the user, the web
          // password and authorized_keys included.
          const skill = this._installedSkill(message.skillPath);
          if (!skill) throw new Error(`Refused to open: ${NOT_INSTALLED}`);
          const mdPath = path.join(skill.path, 'SKILL.md');
          try {
            const doc = await vscode.workspace.openTextDocument(mdPath);
            await vscode.window.showTextDocument(doc);
          } catch (err) {
            vscode.window.showErrorMessage(`Cannot open ${mdPath}: ${err}`);
          }
          break;
        }
      }
      }, (error) => this.reportActionError(error))
    );
  }

  private _startPolling(): void {
    if (this._pollingInterval || !this._view?.visible) return;
    // Terminal state is pushed via tmux control mode; this poll is only a
    // safety net + the cadence for workspace info and /proc snapshots.
    this._pollingInterval = setInterval(() => {
      this._refreshTerminalsOnly();
      this.refresh();
      this._refreshResources();
    }, 5000);
  }

  private _stopPolling(): void {
    if (this._pollingInterval) {
      clearInterval(this._pollingInterval);
      this._pollingInterval = undefined;
    }
  }

  /** Run a console skill action, folding a thrown error into the `{ success,
   *  error }` pair the completion messages carry. */
  private async _runSkillAction(
    action: () => Promise<void>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await action();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The tool a webview message names, from the catalog this host last posted. */
  private _catalogTool(toolId: unknown): AITool | undefined {
    return this._workspace?.aiTools.find((tool) => tool.id === toolId);
  }

  /** The installed skill at `skillPath`, compared after resolving, from the list this
   *  host last posted. Its own `path` is what the caller then uses. */
  private _installedSkill(skillPath: unknown): InstalledSkill | undefined {
    if (typeof skillPath !== 'string' || !skillPath) return undefined;
    const resolved = path.resolve(skillPath);
    return this._installedSkills.find((skill) => path.resolve(skill.path) === resolved);
  }

  /** The text behind a ClipboardKey: the commands the webview shows, as this host built
   *  them, or the fixed docker pull for the update chip. */
  private _clipboardText(key: unknown): { text: string; label: string } | undefined {
    switch (key) {
      case 'sshCommand':
        return this._workspace && { text: this._workspace.sshCommand, label: 'SSH command' };
      case 'havenCommand':
        return this._workspace && { text: this._workspace.havenCommand, label: 'Haven command' };
      case 'dockerPullCommand':
        return { text: DOCKER_PULL_COMMAND, label: 'Docker pull command' };
      default:
        return undefined;
    }
  }

  public async runAiTool(toolId: string, action: ConsoleToolAction): Promise<void> {
    if (action === 'launch') {
      await consoleClient.launchTool(toolId);
    } else if (action === 'connect') {
      await consoleClient.connectTool(toolId);
    } else {
      throw new Error(`Unknown tool action: ${String(action)}`);
    }
    await this._refreshTerminalsOnly();
    this.openTerminal();
  }

  public async switchTmuxWindow(index: number): Promise<void> {
    await consoleClient.selectWindow(index);
    await this._refreshTerminalsOnly();
    this.openTerminal();
  }

  public async newTmuxWindow(): Promise<void> {
    await consoleClient.newWindow();
    await this._refreshTerminalsOnly();
    this.openTerminal();
  }

  private async _killTmuxWindow(index: number): Promise<void> {
    await consoleClient.killWindow(index);
    await this._refreshTerminalsOnly();
  }

  private async _setApiKey(toolId: string, envVar: string, apiKey: string): Promise<void> {
    try {
      await consoleClient.setToolApiKey(toolId, envVar, apiKey);
      vscode.window.showInformationMessage(`${envVar} saved. New terminals will use it.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to save ${envVar}: ${message}`);
    }
  }

  private async _signOutTool(toolId: string): Promise<void> {
    try {
      const result = await consoleClient.signOutTool(toolId);
      if (result.instruction) {
        this.openTerminal();
        vscode.window.showInformationMessage(result.instruction);
      } else {
        vscode.window.showInformationMessage('Signed out of tool');
      }
    } catch (err) {
      // A 500 with an instruction is a sign-out that stopped partway, possibly
      // after opening the vendor's logout window; a 409 conflict changed nothing.
      if (err instanceof consoleClient.ConsoleRequestError && err.status === 500 && err.instruction) {
        this.openTerminal();
      }
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to sign out: ${message}`);
    } finally {
      await this.refresh();
    }
  }

  /**
   * Append public keys to ~/.ssh/authorized_keys, creating the directory
   * (0700) and file (0600) as needed and skipping keys already present.
   * Returns how many keys were actually added; 0 leaves the file untouched.
   * Throws on fs errors, and before writing anything when a line is not exactly
   * one public key; callers own the per-command toasts.
   */
  private _appendAuthorizedKeys(keys: string[]): number {
    if (!keys.every(isAuthorizedKeyLine)) {
      throw new Error('Refused a line that is not exactly one SSH public key');
    }
    const sshDir = path.join(os.homedir(), '.ssh');
    const authorizedKeysPath = path.join(sshDir, 'authorized_keys');

    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { mode: 0o700 });
    }

    let content = '';
    if (fs.existsSync(authorizedKeysPath)) {
      content = fs.readFileSync(authorizedKeysPath, 'utf-8');
    }

    let added = 0;
    for (const key of keys) {
      if (content.includes(key)) continue;
      content = content.endsWith('\n') || content.length === 0
        ? `${content}${key}\n`
        : `${content}\n${key}\n`;
      added++;
    }

    if (added > 0) {
      fs.writeFileSync(authorizedKeysPath, content, { mode: 0o600 });
    }
    return added;
  }

  private async _setSshKey(publicKey: string): Promise<void> {
    const key = publicKey.trim();
    if (!isAuthorizedKeyLine(key)) {
      const message = 'Not an SSH public key. Paste the one line of your .pub file, such as "ssh-ed25519 AAAA... you@laptop".';
      vscode.window.showErrorMessage(message);
      this._postSshKeyResult('paste', false, message);
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      'Authorize this SSH key to log in to the workspace?',
      { modal: true, detail: authorizedKeyFingerprint(key) },
      'Authorize Key'
    );
    if (choice !== 'Authorize Key') {
      this._postSshKeyResult('paste', false, 'Cancelled');
      return;
    }

    try {
      const added = this._appendAuthorizedKeys([key]);
      if (added === 0) {
        vscode.window.showInformationMessage('SSH key already configured');
        this._postSshKeyResult('paste', true);
        return;
      }

      vscode.window.showInformationMessage('SSH public key added to authorized_keys');
      this._postSshKeyResult('paste', true);
      await this.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to save SSH key: ${message}`);
      this._postSshKeyResult('paste', false, message);
    }
  }

  private _postSshKeyResult(
    sshKeyOpSource: 'github' | 'paste',
    success: boolean,
    error?: string
  ): void {
    this._post({ command: 'sshKeyResult', sshKeyOpSource, success, error });
  }

  private async _updatePreviewPort(port: number): Promise<void> {
    const workspaceId = process.env._ENVHAVEN_WORKSPACE_ID;
    const workspaceToken = process.env._ENVHAVEN_WORKSPACE_TOKEN;
    const apiUrl = process.env._ENVHAVEN_API_URL;

    if (!workspaceId || !workspaceToken || !apiUrl) {
      this._post({ command: 'portUpdateError', error: 'Missing workspace credentials' });
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Expose the service on port ${port} as the workspace's public preview?`,
      { modal: true, detail: 'Anyone with the preview URL will be able to reach this service.' },
      'Expose Port'
    );
    if (choice !== 'Expose Port') {
      this._post({ command: 'portUpdateError', error: 'Cancelled' });
      return;
    }

    try {
      const response = await fetch(`${apiUrl}/v1/internal/workspace/${workspaceId}/port`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${workspaceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error || 'Failed to update port');
      }

      process.env.ENVHAVEN_EXPOSED_PORT = String(port);

      this._post({ command: 'portUpdateSuccess', port });

      await this.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to update preview port: ${message}`);
      this._post({ command: 'portUpdateError', error: message });
      await this.refresh();
    }
  }

  private async _importGitHubKeys(username: string): Promise<void> {
    if (!isGitHubUsername(username)) {
      const errMsg = 'Not a GitHub username';
      vscode.window.showErrorMessage(errMsg);
      this._postSshKeyResult('github', false, errMsg);
      return;
    }
    const url = `https://github.com/${encodeURIComponent(username)}.keys`;

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) {
        const errMsg = response.status === 404
          ? `GitHub user "${username}" not found or has no public keys`
          : `Failed to fetch keys: HTTP ${response.status}`;
        vscode.window.showErrorMessage(errMsg);
        this._postSshKeyResult('github', false, errMsg);
        return;
      }

      // GitHub serves one bare `type blob` line per key. Each line passes the same check a
      // pasted key does, so whatever else the response holds is dropped, not appended.
      const keys = await response.text();
      const keyLines = keys.split('\n').map((line) => line.trim()).filter(isAuthorizedKeyLine);

      if (keyLines.length === 0) {
        const errMsg = `No SSH keys found for GitHub user "${username}"`;
        vscode.window.showErrorMessage(errMsg);
        this._postSshKeyResult('github', false, errMsg);
        return;
      }

      const fingerprints = keyLines.slice(0, 5).map(authorizedKeyFingerprint)
      if (keyLines.length > 5) fingerprints.push(`… and ${keyLines.length - 5} more`)
      const choice = await vscode.window.showWarningMessage(
        `Authorize ${keyLines.length} SSH key${keyLines.length === 1 ? '' : 's'} from GitHub user @${username}?`,
        { modal: true, detail: fingerprints.join('\n') },
        'Authorize Keys'
      );
      if (choice !== 'Authorize Keys') {
        this._postSshKeyResult('github', false, 'Cancelled');
        return;
      }

      const added = this._appendAuthorizedKeys(keyLines);

      if (added === 0) {
        vscode.window.showInformationMessage(`All ${keyLines.length} keys from @${username} already configured`);
        this._postSshKeyResult('github', true);
        return;
      }

      vscode.window.showInformationMessage(
        `Imported ${added} SSH key${added > 1 ? 's' : ''} from github.com/${username}`
      );
      this._postSshKeyResult('github', true);
      await this.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to import GitHub keys: ${message}`);
      this._postSshKeyResult('github', false, message);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const webviewBuildPath = vscode.Uri.joinPath(this._extensionUri, 'webview', 'build');

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(webviewBuildPath, 'assets', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(webviewBuildPath, 'assets', 'index.css')
    );

    const nonce = getNonce();

    // The one frame this page holds is the live preview, and it may load that exact origin
    // and nothing else. code-server serves webviews from its own origin, and on a managed
    // workspace that is <subdomain>.envhaven.app, so a wildcard would let the previewed app
    // navigate its frame to a code-server page: same origin as this webview, with its DOM
    // and its bridge to the extension host in reach.
    const previewUrl = getPreviewUrl(process.env._ENVHAVEN_PUBLIC_URL || null);
    const previewOrigin = previewUrl ? new URL(previewUrl).origin : null;
    const frameSrc = previewOrigin?.startsWith('https://') ? previewOrigin : "'none'";

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; frame-src ${frameSrc};">
    <link rel="stylesheet" href="${styleUri}">
    <title>EnvHaven</title>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** A CSP nonce is only worth something if it cannot be predicted, which rules out
 *  Math.random: V8's generator can be recovered from a few of its outputs. */
function getNonce(): string {
  return randomBytes(16).toString('hex');
}

const SKILL_NOT_OFFERED = 'not a skill from this sidebar\'s search results';
const NOT_INSTALLED = 'not an installed skill';

/** One key per (source, skillId) pair; a plain `${source}/${skillId}` would let
 *  `a/b` + `c` and `a` + `b/c` collide. */
function skillKey(source: string, skillId: string): string {
  return JSON.stringify([source, skillId]);
}

/** The platform's isValidExposedPort range (packages/shared): the internal port route
 *  refuses anything else. */
function isExposedPort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= 1024 && (port as number) <= 65535;
}

// Key types sshd accepts in authorized_keys today. DSA is left out: OpenSSH has disabled
// it by default since 7.0 and GitHub no longer serves it.
const AUTHORIZED_KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

/**
 * Whether `line` is exactly one public key in authorized_keys form: a known key type, its
 * base64 blob, and an optional comment. An authorized_keys line may also open with options
 * (`command="..."`, `environment=...`, `from=...`), which is how a pasted "key" becomes a
 * forced command or a standing backdoor, and a newline would start a second line; neither
 * passes, because the first field must be a bare key type and the comment holds no control
 * characters. The blob must also name the same type inside it, the check ssh-keygen makes,
 * so a line that only looks like a key is refused too.
 */
export function isAuthorizedKeyLine(line: string): boolean {
  if (line.length > 8192) return false;
  const match = /^(\S+)[ \t]+([A-Za-z0-9+/]+={0,2})(?:[ \t]+[^\x00-\x1f\x7f]*)?$/.exec(line);
  if (!match || !AUTHORIZED_KEY_TYPES.has(match[1])) return false;
  const blob = Buffer.from(match[2], 'base64');
  if (blob.length < 4) return false;
  const typeLength = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + typeLength).toString('latin1') === match[1];
}

/** A GitHub login: letters, digits and hyphens, starting with a letter or digit, at most
 *  39 characters. Checked before it becomes part of the github.com URL, so no name can
 *  point the fetch at another path. */
export function isGitHubUsername(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(name);
}
