import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { getWorkspaceInfo, getTmuxWindows } from './environment';
import { snapshot as resourceSnapshot, signalProcess } from './resource-monitor';
import { TmuxControl } from './tmux-control';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'envhaven.sidebarView';

  private _view?: vscode.WebviewView;
  private _pollingInterval?: ReturnType<typeof setInterval>;
  private _tmuxControl = new TmuxControl('envhaven');

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
      this._view.webview.postMessage({
        command: 'updateWorkspace',
        workspace: workspaceInfo,
      });
    }
  }

  private async _refreshTerminalsOnly(): Promise<void> {
    if (this._view) {
      const tmuxWindows = await getTmuxWindows();
      this._view.webview.postMessage({
        command: 'updateTerminals',
        tmuxWindows,
      });
    }
  }

  private async _refreshResources(): Promise<void> {
    if (!this._view) return;
    try {
      const resources = await resourceSnapshot();
      this._view.webview.postMessage({ command: 'updateResources', resources });
    } catch {
      /* silent — next tick retries */
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

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'ready': {
          this._refreshTerminalsOnly();
          this.refresh();
          this._refreshResources();
          const hasOpenEditors = vscode.window.visibleTextEditors.length > 0;
          const hasOpenTerminals = vscode.window.terminals.length > 0;
          if (!hasOpenEditors && !hasOpenTerminals) {
            try { fs.unlinkSync('/config/.envhaven-welcome-shown'); } catch {}
            const terminal = this._getOrCreateTerminal('Terminal', true);
            terminal.show(true);
          }
          this._startPolling();
          break;
        }

        case 'runTool':
          this._runAiTool(message.toolName, message.toolCommand);
          break;

        case 'openToolDocs':
          if (message.url) {
            vscode.env.openExternal(vscode.Uri.parse(message.url));
          }
          break;

        case 'copySshCommand':
          await vscode.env.clipboard.writeText(message.command);
          vscode.window.showInformationMessage('SSH command copied to clipboard');
          break;

        case 'copyToClipboard':
          await vscode.env.clipboard.writeText(message.text);
          vscode.window.showInformationMessage('Copied to clipboard');
          break;

        case 'openTerminal': {
          // Open in editor tab group instead of panel
          const terminal = this._getOrCreateTerminal('Terminal', false);
          terminal.show(false); // false = focus terminal
          break;
        }

        case 'setApiKey':
          if (message.envVar && message.apiKey) {
            await this._setApiKey(message.envVar, message.apiKey);
            await this.refresh();
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

        case 'refresh':
          await this.refresh();
          break;

        case 'switchTerminal':
          if (typeof message.windowIndex === 'number') {
            await this._switchTmuxWindow(message.windowIndex);
          }
          break;

        case 'newTerminal':
          await this._newTmuxWindow();
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
          vscode.env.openExternal(vscode.Uri.parse('https://github.com/envhaven/envhaven/tree/master/docs'));
          break;

        case 'openPlatform':
          vscode.env.openExternal(vscode.Uri.parse('https://envhaven.com'));
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
      }
    });
  }

  private _startPolling(): void {
    if (this._pollingInterval) return;
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

  private async _runAiTool(toolName: string, command: string): Promise<void> {
    const hasSession = await this._runTmuxCommand('tmux has-session -t envhaven');
    
    if (hasSession) {
      await this._runTmuxCommand('tmux new-window -t envhaven -c /config/workspace');
    } else {
      await this._runTmuxCommand('tmux new-session -d -s envhaven -c /config/workspace');
    }
    
    await this._runTmuxCommand(`tmux send-keys -t envhaven '${command.replace(/'/g, "'\\''")}' Enter`);
    await this._refreshTerminalsOnly();
    
    this._ensureTerminalVisible();
  }

  private _ensureTerminalVisible(): void {
    const existing = vscode.window.terminals.find((t) => t.name === 'Terminal');
    if (existing) {
      existing.show(false);
    } else {
      const terminal = vscode.window.createTerminal({
        name: 'Terminal',
        location: this._terminalLocation(false),
      });
      terminal.show(false);
    }
  }

  private async _runTmuxCommand(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', command], { stdio: 'pipe' });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  }

  private async _switchTmuxWindow(index: number): Promise<void> {
    await this._runTmuxCommand(`tmux select-window -t envhaven:${index}`);
    await this._refreshTerminalsOnly();
    this._ensureTerminalVisible();
  }

  private async _newTmuxWindow(): Promise<void> {
    const hasSession = await this._runTmuxCommand('tmux has-session -t envhaven');
    if (hasSession) {
      await this._runTmuxCommand('tmux new-window -t envhaven -c /config/workspace');
    } else {
      await this._runTmuxCommand('tmux new-session -d -s envhaven -c /config/workspace');
    }
    await this._refreshTerminalsOnly();
    
    this._ensureTerminalVisible();
  }

  private async _killTmuxWindow(index: number): Promise<void> {
    await this._runTmuxCommand(`tmux kill-window -t envhaven:${index}`);
    await this._refreshTerminalsOnly();
  }

  private async _setApiKey(envVar: string, apiKey: string): Promise<void> {
    const homeDir = os.homedir();
    const zshrcPath = path.join(homeDir, '.zshrc');
    const bashrcPath = path.join(homeDir, '.bashrc');

    const exportLine = `export ${envVar}="${apiKey}"`;
    const marker = `export ${envVar}=`;

    const updateRcFile = async (rcPath: string): Promise<boolean> => {
      try {
        let content = '';
        if (fs.existsSync(rcPath)) {
          content = fs.readFileSync(rcPath, 'utf-8');
        }

        const lines = content.split('\n');
        const existingIdx = lines.findIndex((line) => line.startsWith(marker));

        if (existingIdx >= 0) {
          lines[existingIdx] = exportLine;
        } else {
          if (content.length > 0 && !content.endsWith('\n')) {
            lines.push('');
          }
          lines.push(exportLine);
        }

        fs.writeFileSync(rcPath, lines.join('\n'));
        return true;
      } catch {
        return false;
      }
    };

    const zshUpdated = await updateRcFile(zshrcPath);
    const bashUpdated = await updateRcFile(bashrcPath);

    if (zshUpdated || bashUpdated) {
      process.env[envVar] = apiKey;

      const files = [zshUpdated && '.zshrc', bashUpdated && '.bashrc'].filter(Boolean).join(' and ');
      vscode.window.showInformationMessage(
        `${envVar} saved to ${files}. Reload terminal or run: source ~/.zshrc`
      );
    } else {
      vscode.window.showErrorMessage(`Failed to save ${envVar} to rc files`);
    }
  }

  private async _setSshKey(publicKey: string): Promise<void> {
    const sshDir = path.join(os.homedir(), '.ssh');
    const authorizedKeysPath = path.join(sshDir, 'authorized_keys');

    try {
      if (!fs.existsSync(sshDir)) {
        fs.mkdirSync(sshDir, { mode: 0o700 });
      }

      let content = '';
      if (fs.existsSync(authorizedKeysPath)) {
        content = fs.readFileSync(authorizedKeysPath, 'utf-8');
      }

      const keyLine = publicKey.trim();
      if (content.includes(keyLine)) {
        vscode.window.showInformationMessage('SSH key already configured');
        return;
      }

      const newContent = content.length > 0 && !content.endsWith('\n') 
        ? `${content}\n${keyLine}\n` 
        : `${content}${keyLine}\n`;

      fs.writeFileSync(authorizedKeysPath, newContent, { mode: 0o600 });
      vscode.window.showInformationMessage('SSH public key added to authorized_keys');
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to save SSH key: ${err}`);
    }
  }

  private async _updatePreviewPort(port: number): Promise<void> {
    const workspaceId = process.env._ENVHAVEN_WORKSPACE_ID;
    const workspaceToken = process.env._ENVHAVEN_WORKSPACE_TOKEN;
    const apiUrl = process.env._ENVHAVEN_API_URL;

    if (!workspaceId || !workspaceToken || !apiUrl) {
      this._view?.webview.postMessage({
        command: 'portUpdateError',
        error: 'Missing workspace credentials',
      });
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
      });

      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error || 'Failed to update port');
      }

      process.env.ENVHAVEN_EXPOSED_PORT = String(port);

      this._view?.webview.postMessage({
        command: 'portUpdateSuccess',
        port,
      });

      await this.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to update preview port: ${message}`);
      this._view?.webview.postMessage({
        command: 'portUpdateError',
        error: message,
      });
      await this.refresh();
    }
  }

  private async _importGitHubKeys(username: string): Promise<void> {
    const url = `https://github.com/${username}.keys`;
    
    try {
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 404) {
          vscode.window.showErrorMessage(`GitHub user "${username}" not found or has no public keys`);
        } else {
          vscode.window.showErrorMessage(`Failed to fetch keys: HTTP ${response.status}`);
        }
        return;
      }

      const keys = await response.text();
      const keyLines = keys.trim().split('\n').filter(line => line.startsWith('ssh-'));
      
      if (keyLines.length === 0) {
        vscode.window.showErrorMessage(`No SSH keys found for GitHub user "${username}"`);
        return;
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
      for (const key of keyLines) {
        if (!content.includes(key)) {
          content = content.endsWith('\n') || content.length === 0 
            ? `${content}${key}\n` 
            : `${content}\n${key}\n`;
          added++;
        }
      }

      if (added === 0) {
        vscode.window.showInformationMessage(`All ${keyLines.length} keys from @${username} already configured`);
        return;
      }

      fs.writeFileSync(authorizedKeysPath, content, { mode: 0o600 });
      vscode.window.showInformationMessage(
        `Imported ${added} SSH key${added > 1 ? 's' : ''} from github.com/${username}`
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to import GitHub keys: ${err}`);
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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
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
