import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runHandledAction } from './action-handler';
import {
  getWorkspaceInfo,
  getTmuxWindows,
} from './environment';
import { snapshot as resourceSnapshot, signalProcess } from './resource-monitor';
import { TmuxControl } from './tmux-control';
import * as consoleClient from './consoleClient';
import {
  TMUX_SESSION,
  type ConsoleToolAction,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage,
} from './shared-types';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'envhaven.sidebarView';

  private _view?: vscode.WebviewView;
  private _pollingInterval?: ReturnType<typeof setInterval>;
  private _tmuxControl = new TmuxControl(TMUX_SESSION);

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
      this._post({ command: 'updateResources', resources });
    } catch {
      /* silent — next tick retries */
    }
  }

  private async _refreshInstalledSkills(): Promise<void> {
    if (!this._view) return;
    try {
      const installedSkills = await consoleClient.listInstalledSkills();
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

        case 'runTool':
          await this.runAiTool(message.toolId, message.action);
          break;

        case 'openToolDocs':
          if (message.url) {
            await vscode.env.openExternal(vscode.Uri.parse(message.url));
          }
          break;

        case 'copySshCommand':
          if (typeof message.text === 'string' && message.text) {
            await vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage('SSH command copied to clipboard');
          } else {
            console.warn('envhaven: copySshCommand received with no text field', message);
          }
          break;

        case 'copyToClipboard':
          await vscode.env.clipboard.writeText(message.text);
          vscode.window.showInformationMessage('Copied to clipboard');
          break;

        case 'setApiKey':
          if (message.toolId && message.envVar && message.apiKey) {
            await this._setApiKey(message.toolId, message.envVar, message.apiKey);
            await this.refresh();
          }
          break;

        case 'signOutTool':
          if (typeof message.toolId === 'string' && message.toolId) {
            await this._signOutTool(message.toolId);
          }
          break;

        case 'setSshKey':
          if (message.sshPublicKey) {
            await this._setSshKey(message.sshPublicKey);
            await this.refresh();
          }
          break;

        case 'importGitHubKeys':
          if (message.username) {
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
          if (message.port) {
            await this._updatePreviewPort(message.port);
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
          const { success, error } = await this._runSkillAction(() =>
            consoleClient.removeSkill(skillPath)
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
          const skillPath = typeof message.skillPath === 'string' ? message.skillPath : '';
          if (!skillPath) break;
          const mdPath = path.join(skillPath, 'SKILL.md');
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
   * Throws on fs errors — callers own the per-command toasts.
   */
  private _appendAuthorizedKeys(keys: string[]): number {
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
    try {
      const added = this._appendAuthorizedKeys([publicKey.trim()]);
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
    const url = `https://github.com/${username}.keys`;

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

      const keys = await response.text();
      const keyLines = keys.trim().split('\n').filter(line => line.startsWith('ssh-'));

      if (keyLines.length === 0) {
        const errMsg = `No SSH keys found for GitHub user "${username}"`;
        vscode.window.showErrorMessage(errMsg);
        this._postSshKeyResult('github', false, errMsg);
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

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; frame-src https://*.envhaven.app;">
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

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
