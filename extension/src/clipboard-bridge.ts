// The terminal clipboard bridge between tmux and this extension. A browser cannot read
// tmux's clipboard, so a copy-mode selection reaches the browser in two steps: tmux keeps
// it, and the envhaven.copyTerminalSelection command (Ctrl+Shift+C) copies it out.
//
// The selection used to travel through /tmp/.envhaven-clipboard: written world-readable
// by `cat >`, which followed any symlink planted at that path, and left holding the last
// copied text, secrets included, for the life of the workspace. It now stays inside tmux.
// runtime/templates/tmux.conf sets copy-command to `tmux load-buffer -b envhaven-selection -`,
// so every copy-mode selection lands in one named buffer in the tmux server's memory,
// reachable only through the server's private socket directory, and is read back here
// with save-buffer. An application's OSC 52 write creates an ordinary numbered buffer
// instead, so text a program prints never stands in for the user's selection.

import * as fs from 'fs';
import { execSafe } from './environment';

/** The named tmux buffer tmux.conf's copy-command loads each selection into. */
export const SELECTION_BUFFER = 'envhaven-selection';

/** Present while an extension host runs; runtime/scripts/tmux-copy-hint reads it to pick
 *  the Ctrl+Shift+C hint over the SSH one. It holds a pid, nothing secret. */
export const EXTENSION_FLAG_FILE = '/tmp/.envhaven-extension-active';

/** The last copy-mode selection, or null when there is none to copy. */
export async function readTerminalSelection(): Promise<string | null> {
  try {
    const { stdout } = await execSafe(`tmux save-buffer -b ${SELECTION_BUFFER} -`);
    return stdout;
  } catch (error) {
    // tmux exits 1 when no server runs or nothing has been copied since it started.
    if ((error as Error).message !== 'exit code 1') {
      console.error('[EnvHaven] Could not read the tmux selection:', error);
    }
    return null;
  }
}

/**
 * Write this extension host's pid to `file`, returning whether it did. /tmp is writable by
 * every user, so the open refuses a symlink at the path (O_NOFOLLOW), which would otherwise
 * redirect the write into any file this user can write, and does not wait on a FIFO planted
 * there (O_NONBLOCK). A refusal costs the copy hint its wording only, so it is reported and
 * never thrown into activation.
 */
export function writeExtensionFlag(file: string): boolean {
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  try {
    const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_NONBLOCK, 0o600);
    try {
      fs.writeSync(fd, String(process.pid));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    console.error(`[EnvHaven] Could not write ${file}:`, error);
    return false;
  }
}
