import * as vscode from 'vscode';
import * as fs from 'fs';
import { SidebarProvider } from './sidebar-provider';
import { showCommandPalette } from './command-palette';
import { EXTENSION_FLAG_FILE, readTerminalSelection, writeExtensionFlag } from './clipboard-bridge';

export function activate(context: vscode.ExtensionContext): void {
  // Signal to tmux that a web client is active (enables copy hint in status bar)
  if (writeExtensionFlag(EXTENSION_FLAG_FILE)) {
    context.subscriptions.push({ dispose: () => fs.rmSync(EXTENSION_FLAG_FILE, { force: true }) });
  }

  // Ctrl+Shift+C: copy last tmux selection to browser clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand('envhaven.copyTerminalSelection', async () => {
      const content = await readTerminalSelection();
      if (content) {
        await vscode.env.clipboard.writeText(content);
      }
    })
  );

  const sidebarProvider = new SidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('envhaven.sidebarView', sidebarProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envhaven.refreshSidebar', () => sidebarProvider.refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('envhaven.openCommandPalette', () =>
      showCommandPalette(sidebarProvider)
    )
  );

  setTimeout(() => {
    vscode.commands.executeCommand('workbench.view.extension.envhaven-sidebar');
  }, 1000);
}

export function deactivate(): void {}
