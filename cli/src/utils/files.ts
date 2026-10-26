import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomBytes } from "crypto";
import { basename, dirname, resolve } from "path";

/**
 * Replaces `path` with `content` in one step: the new bytes go to a temporary file beside it and
 * are renamed over it, so a crash or a full disk mid-write leaves the old file whole instead of a
 * truncated one. This matters most for `~/.ssh/config`, which ssh refuses to parse at all when it
 * is cut off, taking every host the user has with it.
 *
 * A symlink at `path` is kept: the rename lands on the file it points to. Dotfile managers link
 * `~/.ssh/config` into a repository, and renaming over the link itself would silently detach it.
 * The temporary file is created exclusively (`wx`), so a file or link planted at its name is an
 * error rather than something written through.
 *
 * `mode` applies when the file is created. An existing file keeps its own mode unless `mode` is
 * given explicitly with `force: true`, which is how state files that must be private are
 * tightened on their next write.
 */
export function writeFileAtomic(
  path: string,
  content: string,
  options: { mode: number; force?: boolean },
): void {
  const target = resolveTarget(path);
  let mode = options.mode;
  if (!options.force) {
    try {
      const stat = lstatSync(target);
      // A symlink has no meaningful permission bits to inherit (0777 on Linux).
      if (!stat.isSymbolicLink()) mode = stat.mode & 0o777;
    } catch {
      // New file: the requested mode applies.
    }
  }

  const temp = `${dirname(target)}/.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", mode);
  try {
    // open()'s mode passes through the umask; this one does not.
    fchmodSync(fd, mode);
    // All of it or an error: writeSync returns how much a single write took, and on a full disk
    // that can be part of it, which the rename below would then put in the old file's place.
    writeFileSync(fd, content);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    unlinkSync(temp);
    throw err;
  }
  closeSync(fd);

  try {
    renameSync(temp, target);
  } catch (err) {
    unlinkSync(temp);
    throw err;
  }
}

function resolveTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // realpath fails when a link's target does not exist yet. Resolve that one link ourselves so
    // the link survives and the new target is created with the requested private mode.
    try {
      return resolve(dirname(path), readlinkSync(path));
    } catch {
      return path;
    }
  }
}
