import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  getWorkspaceInfo,
  getTmuxWindows,
  invalidateRcEnvVarsCache,
  getToolDefinitionById,
} from './environment';
import { snapshot as resourceSnapshot, signalProcess } from './resource-monitor';
import { TmuxControl } from './tmux-control';
import {
  listInstalledSkills,
  searchSkillsSh,
  fetchSkillMarkdown,
  parseSkillFrontmatter,
  stripSkillFrontmatter,
  installSkill as runInstallSkill,
  removeSkill as runRemoveSkill,
} from './skillsService';

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

  public postToWebview(message: { command: string } & Record<string, unknown>): void {
    this._view?.webview.postMessage(message);
  }

  // Public actions. The webview triggers these via messages; the native command
  // palette calls them directly. Keeping one dispatch surface (the message
  // switch below) routed to these methods avoids a second palette-specific
  // switch that would drift out of sync.
  public openSheet(sheet: 'ssh' | 'process' | 'skills' | 'tools'): void {
    this._view?.webview.postMessage({ command: 'openSheet', sheet });
  }

  public openTerminal(): void {
    this._getOrCreateTerminal('Terminal', false).show(false);
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

  private async _refreshInstalledSkills(): Promise<void> {
    if (!this._view) return;
    try {
      const installedSkills = await listInstalledSkills();
      this._view.webview.postMessage({
        command: 'updateInstalledSkills',
        installedSkills,
      });
    } catch (err) {
      // `npx skills` missing or network-broken — the sidebar will show an
      // empty Skills panel. Log so devs can see why in the webview console.
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

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'ready': {
          this._refreshTerminalsOnly();
          this.refresh();
          this._refreshResources();
          void this._refreshInstalledSkills();
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
          this.runAiTool(message.toolCommand);
          break;

        case 'openToolDocs':
          if (message.url) {
            vscode.env.openExternal(vscode.Uri.parse(message.url));
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

        case 'refresh':
          await this.refresh();
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

        case 'searchSkills': {
          const query = typeof message.query === 'string' ? message.query : '';
          try {
            const results = await searchSkillsSh(query);
            this._view?.webview.postMessage({
              command: 'skillSearchResult',
              query,
              results,
            });
          } catch (err) {
            this._view?.webview.postMessage({
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
          // Scope the install to tools the user has actually authenticated.
          const workspace = await getWorkspaceInfo();
          const connectedIds = workspace.aiTools
            .filter((t) => t.installed && t.authStatus === 'ready')
            .map((t) => t.id);
          const res = await runInstallSkill(source, skillId, connectedIds);
          // Refresh the installed list BEFORE clearing the loading flag so the
          // webview never has a moment where the button is re-enabled but the
          // list hasn't caught up yet.
          await this._refreshInstalledSkills();
          this._view?.webview.postMessage({
            command: 'skillInstallComplete',
            source,
            skillId,
            success: res.ok,
            error: res.error,
          });
          if (res.ok) {
            const agentList = res.agents.join(', ');
            const skippedNote =
              res.unsupportedAgents.length > 0
                ? ` (skipped unsupported: ${res.unsupportedAgents.join(', ')})`
                : '';
            vscode.window.showInformationMessage(
              `Installed ${skillId} for ${agentList}${skippedNote}`
            );
          } else {
            vscode.window.showErrorMessage(
              `Failed to install ${skillId}: ${res.error ?? 'unknown'}`
            );
          }
          break;
        }

        case 'fetchSkillMarkdown': {
          const source = typeof message.source === 'string' ? message.source : '';
          const skillId = typeof message.skillId === 'string' ? message.skillId : '';
          if (!source || !skillId) break;
          try {
            const raw = await fetchSkillMarkdown(source, skillId);
            const frontmatter = parseSkillFrontmatter(raw);
            const markdown = stripSkillFrontmatter(raw);
            this._view?.webview.postMessage({
              command: 'skillMarkdownResult',
              source,
              skillId,
              markdown,
              frontmatter,
            });
          } catch (err) {
            this._view?.webview.postMessage({
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
          const res = await runRemoveSkill(skillPath);
          // Refresh first so the row has disappeared from the list before the
          // webview clears its removing flag — otherwise the row re-enables
          // for a tick and can be clicked again.
          await this._refreshInstalledSkills();
          this._view?.webview.postMessage({
            command: 'skillRemoveComplete',
            skillName,
            success: res.ok,
            error: res.error,
          });
          if (res.ok) {
            vscode.window.showInformationMessage(`Removed ${skillName}`);
          } else {
            vscode.window.showErrorMessage(`Failed to remove ${skillName}: ${res.error ?? 'unknown error'}`);
          }
          break;
        }

        case 'refreshInstalledSkills':
          await this._refreshInstalledSkills();
          break;

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

  public async runAiTool(command: string): Promise<void> {
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

  public async switchTmuxWindow(index: number): Promise<void> {
    await this._runTmuxCommand(`tmux select-window -t envhaven:${index}`);
    await this._refreshTerminalsOnly();
    this._ensureTerminalVisible();
  }

  public async newTmuxWindow(): Promise<void> {
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
      invalidateRcEnvVarsCache();

      const updated = [zshUpdated && '.zshrc', bashUpdated && '.bashrc'].filter(Boolean) as string[];
      const files = updated.join(' and ');
      vscode.window.showInformationMessage(
        `${envVar} saved to ${files}. Reload terminal or run: source ~/${updated[0]}`
      );
    } else {
      vscode.window.showErrorMessage(`Failed to save ${envVar} to rc files`);
    }
  }

  /**
   * Disconnect a tool by:
   *  - removing every `export <envVar>=...` line for that tool from ~/.zshrc and
   *    ~/.bashrc (the reverse of _setApiKey),
   *  - deleting the entries in process.env so checkAuth doesn't see stale values,
   *  - invalidating the rc-env-var cache so the next auth check re-parses fresh,
   *  - deleting every auth file the tool's definition lists (e.g. claude's
   *    ~/.claude/.credentials.json), matching what an explicit CLI logout would
   *    remove.
   * The tool's installed state is left alone — this is auth-only.
   */
  private async _signOutTool(toolId: string): Promise<void> {
    const def = getToolDefinitionById(toolId);
    if (!def) {
      vscode.window.showErrorMessage(`Unknown tool: ${toolId}`);
      return;
    }

    const homeDir = os.homedir();
    const removedEnvVars: string[] = [];
    const removedFiles: string[] = [];

    // 1. Strip `export VAR=...` lines for this tool from both rc files,
    //    track which ones we actually removed so the toast tells the truth.
    for (const envVar of def.envVars) {
      const marker = `export ${envVar}=`;
      let strippedFromRc = false;
      for (const rc of ['.zshrc', '.bashrc']) {
        const rcPath = path.join(homeDir, rc);
        try {
          if (!fs.existsSync(rcPath)) continue;
          const content = fs.readFileSync(rcPath, 'utf-8');
          const lines = content.split('\n');
          const kept = lines.filter((line) => !line.startsWith(marker));
          if (kept.length !== lines.length) {
            fs.writeFileSync(rcPath, kept.join('\n'));
            strippedFromRc = true;
          }
        } catch (err) {
          // Continue so one unreadable/unwritable rc file doesn't prevent
          // cleaning the other. Log so issues are visible during debugging.
          console.warn(`envhaven: failed to strip ${envVar} from ${rcPath}`, err);
        }
      }
      const wasInProcessEnv = process.env[envVar] !== undefined;
      if (wasInProcessEnv) delete process.env[envVar];
      if (strippedFromRc || wasInProcessEnv) removedEnvVars.push(envVar);
    }

    // 2. Delete the auth files the tool definition lists. Resolve each path
    //    and assert it stays under $HOME so a malformed tool-def entry with
    //    `..` segments can't walk out and unlink arbitrary files.
    const homeBoundary = homeDir.endsWith(path.sep) ? homeDir : homeDir + path.sep;
    for (const rel of def.authFiles) {
      const full = path.resolve(homeDir, rel);
      if (full !== homeDir && !full.startsWith(homeBoundary)) {
        console.warn(
          `envhaven: refusing to delete auth file outside $HOME: ${rel} resolved to ${full}`
        );
        continue;
      }
      try {
        if (fs.existsSync(full)) {
          fs.unlinkSync(full);
          removedFiles.push(rel);
        }
      } catch (err) {
        console.warn(`envhaven: failed to delete auth file ${full}`, err);
      }
    }

    // 3. Rebuild the rc-env-var cache so the next checkAuth gets fresh data.
    invalidateRcEnvVarsCache();

    // 4. Push a refresh so the sidebar reflects the new authStatus.
    await this.refresh();

    const summary = [
      removedEnvVars.length > 0 ? `cleared ${removedEnvVars.join(', ')}` : null,
      removedFiles.length > 0 ? `removed ${removedFiles.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(', ');

    vscode.window.showInformationMessage(
      summary ? `Signed out of ${def.name} — ${summary}` : `Signed out of ${def.name}`
    );
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
        this._postSshKeyResult('paste', true);
        return;
      }

      const newContent = content.length > 0 && !content.endsWith('\n')
        ? `${content}\n${keyLine}\n`
        : `${content}${keyLine}\n`;

      fs.writeFileSync(authorizedKeysPath, newContent, { mode: 0o600 });
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
    this._view?.webview.postMessage({
      command: 'sshKeyResult',
      sshKeyOpSource,
      success,
      error,
    });
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
        this._postSshKeyResult('github', true);
        return;
      }

      fs.writeFileSync(authorizedKeysPath, content, { mode: 0o600 });
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
