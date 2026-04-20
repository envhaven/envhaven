import * as vscode from 'vscode';
import * as path from 'path';
import type { SidebarProvider } from './sidebar-provider';
import { getWorkspaceInfo, type WorkspaceInfo } from './environment';
import { listInstalledSkills, type InstalledSkill } from './skillsService';

type Action = {
  run: () => Promise<void> | void;
};

type Item = vscode.QuickPickItem & Partial<Action>;

function sep(label: string): Item {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

function commandItem(
  label: string,
  detail: string | undefined,
  iconId: string,
  run: () => Promise<void> | void
): Item {
  return {
    label,
    detail,
    iconPath: new vscode.ThemeIcon(iconId),
    run,
  };
}

function havenCommandFor(workspace: WorkspaceInfo): string {
  const subdomain = workspace.hostname.replace(/^ssh-/, '').replace(/\.envhaven\.app$/, '');
  return workspace.isManaged
    ? `haven connect . ${subdomain}`
    : `haven connect . abc@${workspace.hostname}:${workspace.sshPort}`;
}

function buildItems(workspace: WorkspaceInfo, skills: InstalledSkill[], sidebar: SidebarProvider): Item[] {
  const items: Item[] = [];
  const connectedTools = workspace.aiTools.filter((t) => t.installed && t.authStatus === 'ready');
  const disconnectedTools = workspace.aiTools.filter(
    (t) => t.installed && t.authStatus !== 'ready'
  );
  const windows = workspace.tmuxWindows;

  items.push(sep('Workspace'));
  items.push(
    commandItem('Show terminal', undefined, 'terminal', () => {
      sidebar.openTerminal();
    })
  );
  items.push(
    commandItem('New terminal', undefined, 'add', () => {
      void sidebar.newTmuxWindow();
    })
  );
  if (workspace.previewUrl) {
    const url = workspace.previewUrl;
    items.push(
      commandItem('Copy preview URL', url.replace('https://', ''), 'clippy', async () => {
        await vscode.env.clipboard.writeText(url);
        vscode.window.showInformationMessage('Preview URL copied');
      })
    );
  }

  if (windows.length > 0) {
    items.push(sep('Terminals'));
    for (const w of windows) {
      items.push(
        commandItem(
          `Switch to: ${w.name}`,
          w.active ? 'active' : undefined,
          'terminal',
          () => {
            void sidebar.switchTmuxWindow(w.index);
          }
        )
      );
    }
  }

  if (connectedTools.length > 0) {
    items.push(sep('Launch AI tool'));
    for (const t of connectedTools) {
      items.push(
        commandItem(`Launch ${t.name}`, t.description, 'rocket', () => {
          void sidebar.runAiTool(t.command);
        })
      );
    }
  }

  if (disconnectedTools.length > 0) {
    items.push(sep('Connect AI tool'));
    for (const t of disconnectedTools) {
      const iconId = 'plug';
      if (t.authCommand) {
        items.push(
          commandItem(`Connect ${t.name}`, 'run auth flow', iconId, () => {
            void sidebar.runAiTool(t.authCommand!);
          })
        );
      } else if (t.docsUrl) {
        items.push(
          commandItem(`Connect ${t.name}`, 'open docs', iconId, () => {
            void vscode.env.openExternal(vscode.Uri.parse(t.docsUrl));
          })
        );
      }
    }
  }

  items.push(sep('Skills'));
  items.push(
    commandItem('Browse skills…', 'open the skills.sh browser', 'sparkle', () => {
      sidebar.openSheet('skills');
    })
  );
  for (const s of skills.slice(0, 25)) {
    items.push(
      commandItem(
        `View ${s.name}`,
        s.description ? s.description.slice(0, 80) : undefined,
        'file-text',
        async () => {
          try {
            const doc = await vscode.workspace.openTextDocument(path.join(s.path, 'SKILL.md'));
            await vscode.window.showTextDocument(doc);
          } catch (err) {
            vscode.window.showErrorMessage(`Cannot open ${s.name}: ${err}`);
          }
        }
      )
    );
  }

  if (workspace.sshEnabled) {
    items.push(sep('Remote Access'));
    items.push(
      commandItem('Open SSH settings', undefined, 'key', () => {
        sidebar.openSheet('ssh');
      })
    );
    if (workspace.sshCommand) {
      items.push(
        commandItem('Copy Haven command', havenCommandFor(workspace), 'clippy', async () => {
          await vscode.env.clipboard.writeText(havenCommandFor(workspace));
          vscode.window.showInformationMessage('Haven command copied');
        })
      );
    }
  }

  items.push(sep('Monitor'));
  items.push(
    commandItem('Show processes', undefined, 'pulse', () => {
      sidebar.openSheet('process');
    })
  );

  items.push(sep('Help'));
  items.push(
    commandItem('Open docs', undefined, 'book', () => {
      void vscode.env.openExternal(
        vscode.Uri.parse('https://github.com/envhaven/envhaven/tree/master/docs')
      );
    })
  );
  if (!workspace.isManaged) {
    items.push(
      commandItem('Try EnvHaven Managed', 'envhaven.com', 'cloud', () => {
        void vscode.env.openExternal(vscode.Uri.parse('https://envhaven.com'));
      })
    );
  }

  return items;
}

export async function showCommandPalette(sidebar: SidebarProvider): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.envhaven-sidebar');

  const [workspace, skills] = await Promise.all([
    getWorkspaceInfo(),
    listInstalledSkills(),
  ]);

  const qp = vscode.window.createQuickPick<Item>();
  qp.title = 'EnvHaven';
  qp.placeholder = 'Type to search terminals, tools, skills, commands…';
  qp.matchOnDetail = true;
  qp.items = buildItems(workspace, skills, sidebar);

  qp.onDidAccept(async () => {
    const picked = qp.selectedItems[0];
    if (picked?.run) {
      qp.hide();
      try {
        await picked.run();
      } catch (err) {
        vscode.window.showErrorMessage(`Action failed: ${err}`);
      }
    } else {
      qp.hide();
    }
  });

  qp.onDidHide(() => qp.dispose());
  qp.show();
}
