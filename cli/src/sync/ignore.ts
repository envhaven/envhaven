import { existsSync, readFileSync, readdirSync, openSync, readSync, closeSync, lstatSync } from "fs";
import { join, resolve } from "path";

const GITIGNORE_FILE = ".gitignore";
const DEFAULT_IGNORE_PATTERNS = [
  ".git/",
  "node_modules/",
  ".pnpm-store/",
  "__pycache__/",
  "*.pyc",
  ".pytest_cache/",
  ".mypy_cache/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  ".output/",
  "target/",
  ".gradle/",
  ".idea/",
  "*.log",
  "*.tmp",
  "*.swp",
  "*.swo",
  ".DS_Store",
  ".haven/",
];

// Private keys and credential stores. The workspace runs AI agents with every permission prompt
// off, so anything synced there is readable by them; none of these is ever synced, in either
// direction. Patterns without a slash match at any depth, and in any letter case (see anyCase).
const CREDENTIAL_NAMES = [
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_ecdsa_sk",
  "id_ed25519_sk",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".netrc",
  ".pgpass",
  ".git-credentials",
  ".pypirc",
  "*.ppk",
];

// Every letter as a class of both cases, `*.pem` as `*.[pP][eE][mM]`, which mutagen and Bun.Glob
// both read that way: server.KEY and client.PEM used to sync without a word.
function anyCase(pattern: string): string {
  return pattern.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

const CREDENTIAL_PATTERNS = CREDENTIAL_NAMES.map(anyCase);

// Files that often hold tokens and that a project often needs on the workspace too. These sync
// only when the user said so for this directory (`syncEnvFiles`). Templates stay synced.
const ENV_FILE_PATTERNS = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  ".npmrc",
];

// After a yes, the same files are re-included past the .gitignore lines: nearly every .gitignore
// lists .env, and a yes it then overrode would change nothing. A `!` line also matches folders,
// and `.env/` is a common name for a Python virtualenv, so folders are excluded again after it.
const ENV_FILE_INCLUDES = ["!.env", "!.env.*", "!.npmrc", ".env/", ".env.*/"];

// The folders `--ignore-vcs` leaves out (mutagen 0.17.6's DefaultVCSIgnores). Mutagen puts those
// before every session pattern, so a `!.git/` line in .gitignore, which the workspace can edit
// through sync, synced .git both ways, and with it hooks and a core.fsmonitor that git (or an
// editor running git status) runs here without asking. Repeated after the .gitignore lines, they
// always win. `.git` matches files as well: a submodule's or a worktree's .git is a file naming
// the git directory, and the workspace could point it at a folder it syncs, config included. The
// workspace's copy of that file names a .git folder that never syncs, so it loses nothing.
const VCS_PATTERNS = [".git", ".svn/", ".hg/", ".bzr/", "_darcs/"];

export function getDefaultIgnorePatterns(): readonly string[] {
  return DEFAULT_IGNORE_PATTERNS;
}

// The credential rules as written, before anyCase.
export function getCredentialNames(): readonly string[] {
  return CREDENTIAL_NAMES;
}

export function getCredentialPatterns(): readonly string[] {
  return CREDENTIAL_PATTERNS;
}

export function getEnvFilePatterns(): readonly string[] {
  return ENV_FILE_PATTERNS;
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

// A line with a control character in it is skipped: no pattern needs one, the workspace can write
// this file through sync, and the line would otherwise be saved with the connection and fail its
// validation on the next load.
function parseIgnoreFile(content: string): string[] {
  return content
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#") && !CONTROL_CHARACTER.test(line));
}

export function hasGitignore(projectRoot: string): boolean {
  return existsSync(resolve(projectRoot, GITIGNORE_FILE));
}

export function loadGitignorePatterns(projectRoot: string): string[] {
  const gitignorePath = resolve(projectRoot, GITIGNORE_FILE);
  
  if (!existsSync(gitignorePath)) {
    return [];
  }

  const content = readFileSync(gitignorePath, "utf-8");
  return parseIgnoreFile(content);
}

export function diffPatterns(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  const was = new Set(before);
  const now = new Set(after);
  return {
    added: after.filter((p) => !was.has(p)),
    removed: before.filter((p) => !now.has(p)),
  };
}

// Last-match-wins rules are equal only when their order and multiplicities match too.
export function patternsEqual(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && before.every((pattern, index) => pattern === after[index]);
}

// Mutagen applies the last pattern that matches a path, so the env-file, VCS and credential rules
// go after the .gitignore lines, credentials last: a `!.env`, `!.git` or `!*.pem` written into
// .gitignore (by the workspace, through sync) cannot re-include what they exclude.
export function getAllIgnorePatterns(
  gitignorePatterns: readonly string[],
  syncEnvFiles: boolean,
  privateKeyFiles: readonly string[] = [],
): string[] {
  return [
    ...DEFAULT_IGNORE_PATTERNS,
    ...gitignorePatterns,
    ...(syncEnvFiles ? ENV_FILE_INCLUDES : ENV_FILE_PATTERNS),
    ...VCS_PATTERNS,
    ...CREDENTIAL_PATTERNS,
    ...privateKeyFiles.map(rootPattern),
  ];
}

// A pattern for exactly one path under the sync root: a leading slash anchors it, and glob
// characters in the name are escaped.
function rootPattern(path: string): string {
  return `/${path.replace(/[\\*?[\]{}]/g, "\\$&")}`;
}

interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  leaf: boolean;
  glob: InstanceType<typeof Bun.Glob>;
}

// One ignore pattern as mutagen 0.17 reads it: `!` negates it, a leading `/` anchors it to the sync
// root, a trailing `/` limits it to folders, and one with no slash left also matches the last
// component of a path.
function ignoreRule(pattern: string): IgnoreRule {
  const negated = pattern.startsWith("!");
  let body = negated ? pattern.slice(1) : pattern;
  const absolute = body.startsWith("/");
  if (absolute) body = body.slice(1);
  const dirOnly = body.endsWith("/");
  if (dirOnly) body = body.slice(0, -1);
  return { negated, dirOnly, leaf: !absolute && !body.includes("/"), glob: new Bun.Glob(body) };
}

// Whether the rules leave out `path` itself, its last component `name`, the folders above it aside.
function ignoredOwn(rules: readonly IgnoreRule[], path: string, name: string, directory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !directory) continue;
    if (rule.glob.match(path) || (rule.leaf && rule.glob.match(name))) ignored = !rule.negated;
  }
  return ignored;
}

/**
 * Whether a session with these ignore patterns leaves `path` (relative to the sync root, a folder
 * ending in "/") out of sync. As in mutagen's scan, the last pattern that matches a path decides,
 * and nothing inside an ignored folder is looked at.
 */
export function isIgnored(patterns: readonly string[], path: string): boolean {
  return ignoreMatcher(patterns)(path);
}

// isIgnored with the patterns compiled once, for asking about many paths.
export function ignoreMatcher(patterns: readonly string[]): (path: string) => boolean {
  const rules = patterns.map(ignoreRule);
  return (path) => {
    const parts = path.replace(/\/$/, "").split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const directory = depth < parts.length || path.endsWith("/");
      if (ignoredOwn(rules, parts.slice(0, depth).join("/"), parts[depth - 1]!, directory)) return true;
    }
    return false;
  };
}

export interface CredentialScan {
  // Paths the credential name rules exclude; directories end in "/".
  byName: string[];
  // Other files whose content is a private key (a renamed id_ed25519, a deploy_key).
  privateKeys: string[];
  // .env, .env.* (templates aside) and .npmrc files, which sync only after a yes.
  envFiles: string[];
  // False when the walk stopped at SCAN_LIMIT entries.
  complete: boolean;
}

export const SCAN_LIMIT = 100_000;
const KEY_FILE_MAX_BYTES = 16 * 1024;
// How the private key formats of ssh-keygen, OpenSSL, PuTTY and OpenPGP armour begin, after a
// UTF-8 byte order mark (as latin1, which the header is read as) or blank lines an editor left.
const PRIVATE_KEY_START = /^(?:\xef\xbb\xbf)?[\t\n\r ]*(?:-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File-)/;
const ENV_FILE = /^(?:\.env(?:\..+)?|\.npmrc)$/;
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template)$/;

function globs(patterns: readonly string[]): { dirOnly: boolean; glob: InstanceType<typeof Bun.Glob> }[] {
  return patterns.map((p) => ({ dirOnly: p.endsWith("/"), glob: new Bun.Glob(p.replace(/\/$/, "")) }));
}

// Keys are small. Read only the header, whatever extension a renamed key carries.
function mayHoldPrivateKey(path: string): boolean {
  try {
    if (lstatSync(path).size > KEY_FILE_MAX_BYTES) return false;
    const fd = openSync(path, "r");
    try {
      const head = Buffer.alloc(64);
      const length = readSync(fd, head, 0, head.length, 0);
      return PRIVATE_KEY_START.test(head.subarray(0, length).toString("latin1"));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * What the credential rules keep off the workspace, for the notice `haven connect` prints, plus
 * any file that holds a private key under a name those rules miss, and the env files.
 *
 * Folders the complete ordered default-plus-.gitignore rules (VCS folders last, as they sync)
 * exclude are not entered. Evaluating the rules, rather than pruning every positive plain-name
 * line, matters when a later negation re-includes a folder. The rules are compiled once and a
 * folder is judged on its own path: the walk only reaches folders whose parents sync, which is the
 * rest of isIgnored's answer. Compiling them again for every folder took 12 seconds for 20,000
 * folders and a 300-line .gitignore. The walk is breadth-first, so a budget that does run out is
 * spent near the root, where a stray key is likeliest; it follows no symlinks and stops after
 * `limit` entries, which `complete` reports.
 */
export function scanForCredentials(
  root: string,
  gitignorePatterns: readonly string[] = [],
  limit = SCAN_LIMIT,
): CredentialScan {
  const syncRules = [...DEFAULT_IGNORE_PATTERNS, ...gitignorePatterns, ...VCS_PATTERNS].map(ignoreRule);
  const rules = globs(CREDENTIAL_PATTERNS);
  const scan: CredentialScan = { byName: [], privateKeys: [], envFiles: [], complete: true };
  const pending = [""];
  let visited = 0;

  walk: for (let next = 0; next < pending.length; next++) {
    const dir = pending[next]!;
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > limit) {
        scan.complete = false;
        break walk;
      }
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      if (rules.some((r) => (!r.dirOnly || isDir) && r.glob.match(entry.name))) {
        scan.byName.push(isDir ? `${path}/` : path);
      } else if (isDir) {
        if (!ignoredOwn(syncRules, path, entry.name, true)) pending.push(path);
      } else if (entry.isFile()) {
        if (ENV_FILE.test(entry.name) && !ENV_TEMPLATE.test(entry.name)) scan.envFiles.push(path);
        else if (mayHoldPrivateKey(join(root, path))) scan.privateKeys.push(path);
      }
    }
  }

  scan.byName.sort();
  scan.privateKeys.sort();
  scan.envFiles.sort();
  return scan;
}

export function buildMutagenIgnoreArgs(patterns: readonly string[]): string[] {
  const args: string[] = [];
  
  args.push("--ignore-vcs");
  
  for (const pattern of patterns) {
    args.push("--ignore", pattern);
  }
  
  return args;
}
