import { homedir } from "os";
import { basename } from "path";
import { realpathSync } from "fs";

const SUSPICIOUS_PATHS = new Set([
  "/",
  homedir(),
  `${homedir()}/Documents`,
  `${homedir()}/Downloads`,
  `${homedir()}/Desktop`,
  `${homedir()}/Library`,
  "/etc", "/var", "/usr", "/bin", "/sbin", "/lib", "/opt",
  "/System", "/Applications", "/tmp",
]);

const SUSPICIOUS_NAMES = new Set([
  "node_modules", ".git", "venv", ".venv", "vendor", "__pycache__", "dist", "build",
]);

function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

// macOS volumes are case-insensitive by default, so `~/documents` is `~/Documents` there.
const fold = process.platform === "darwin" ? (path: string) => path.toLowerCase() : (path: string) => path;

// The guarded paths as the filesystem resolves them: on macOS /tmp, /var and /etc are links into
// /private, and a home directory can itself be a link.
const SUSPICIOUS_REAL_PATHS = new Set([...SUSPICIOUS_PATHS].map((p) => fold(realPath(p))));
const SUSPICIOUS_LEXICAL_PATHS = new Set([...SUSPICIOUS_PATHS].map(fold));

/**
 * Whether `path` is too broad to be a project directory. Checked on the path as given and on the
 * path every symlink in it resolves to: a link to the home directory named like a project used
 * to pass, and then synced the whole home directory both ways.
 */
export function isSuspiciousPath(path: string): boolean {
  const real = realPath(path);
  if (SUSPICIOUS_LEXICAL_PATHS.has(fold(path)) || SUSPICIOUS_REAL_PATHS.has(fold(real))) return true;
  if (SUSPICIOUS_NAMES.has(basename(path)) || SUSPICIOUS_NAMES.has(basename(real))) return true;
  return false;
}

export function getSuspiciousPaths(): ReadonlySet<string> {
  return SUSPICIOUS_PATHS;
}

export function getSuspiciousNames(): ReadonlySet<string> {
  return SUSPICIOUS_NAMES;
}
