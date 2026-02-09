import * as vscode from 'vscode';
import * as fs from 'fs';
import { SidebarProvider } from './sidebar-provider';

const TMUX_CLIPBOARD_FILE = '/tmp/.envhaven-clipboard';
const EXTENSION_FLAG_FILE = '/tmp/.envhaven-extension-active';

export function activate(context: vscode.ExtensionContext): void {
  // Signal to tmux that a web client is active (enables copy hint in status bar)
  fs.writeFileSync(EXTENSION_FLAG_FILE, String(process.pid));
  context.subscriptions.push({ dispose: () => fs.rmSync(EXTENSION_FLAG_FILE, { force: true }) });

  // Ctrl+Shift+C: copy last tmux selection to browser clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand('envhaven.copyTerminalSelection', () => {
      try {
        const content = fs.readFileSync(TMUX_CLIPBOARD_FILE, 'utf-8');
        if (content) {
          vscode.env.clipboard.writeText(content);
        }
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('[EnvHaven] Clipboard read failed:', e);
        }
      }
    })
  );

  const sidebarProvider = new SidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('envhaven.sidebarView', sidebarProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envhaven.refreshSidebar', () => {
      sidebarProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envhaven.installOhMyOpenCode', async () => {
      const terminal = vscode.window.createTerminal('Install oh-my-opencode');
      const installCmd = `mkdir -p ~/.config/opencode && \\
        jq '.plugin = ((.plugin // []) + ["oh-my-opencode"] | unique)' \\
        ~/.config/opencode/opencode.json 2>/dev/null > /tmp/oc.json && \\
        mv /tmp/oc.json ~/.config/opencode/opencode.json || \\
        echo '{"plugin":["oh-my-opencode"]}' > ~/.config/opencode/opencode.json`;
      terminal.sendText(installCmd);
      terminal.show();
      vscode.window.showInformationMessage('Installing oh-my-opencode plugin...');
    })
  );

  setTimeout(() => {
    vscode.commands.executeCommand('workbench.view.extension.envhaven-sidebar');
  }, 1000);
}

export function deactivate(): void {}
