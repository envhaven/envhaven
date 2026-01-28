import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

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

export function getDefaultIgnorePatterns(): readonly string[] {
  return DEFAULT_IGNORE_PATTERNS;
}

function parseIgnoreFile(content: string): string[] {
  return content
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"));
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

export function getAllIgnorePatterns(projectRoot: string, useGitignore: boolean = false): string[] {
  const defaultPatterns = [...DEFAULT_IGNORE_PATTERNS];
  const gitignorePatterns = useGitignore ? loadGitignorePatterns(projectRoot) : [];
  
  const combined = new Set([...defaultPatterns, ...gitignorePatterns]);
  return Array.from(combined);
}

export function buildMutagenIgnoreArgs(patterns: readonly string[]): string[] {
  const args: string[] = [];
  
  args.push("--ignore-vcs");
  
  for (const pattern of patterns) {
    args.push("--ignore", pattern);
  }
  
  return args;
}
