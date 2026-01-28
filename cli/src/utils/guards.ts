import { homedir } from "os";
import { basename } from "path";

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

export function isSuspiciousPath(path: string): boolean {
  if (SUSPICIOUS_PATHS.has(path)) return true;
  if (SUSPICIOUS_NAMES.has(basename(path))) return true;
  return false;
}

export function getSuspiciousPaths(): ReadonlySet<string> {
  return SUSPICIOUS_PATHS;
}

export function getSuspiciousNames(): ReadonlySet<string> {
  return SUSPICIOUS_NAMES;
}
