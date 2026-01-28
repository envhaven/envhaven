import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import {
  getDefaultIgnorePatterns,
  buildMutagenIgnoreArgs,
  hasGitignore,
  loadGitignorePatterns,
  getAllIgnorePatterns,
} from "../../src/sync/ignore";

const TEST_DIR = "/tmp/haven-ignore-test";

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

describe("getDefaultIgnorePatterns", () => {
  it("includes common patterns", () => {
    const patterns = getDefaultIgnorePatterns();
    
    expect(patterns).toContain("node_modules/");
    expect(patterns).toContain(".git/");
    expect(patterns).toContain("__pycache__/");
    expect(patterns).toContain(".DS_Store");
    expect(patterns).toContain("*.swp");
  });
});

describe("buildMutagenIgnoreArgs", () => {
  it("builds ignore args", () => {
    const args = buildMutagenIgnoreArgs(["node_modules/", ".git/"]);
    
    expect(args).toContain("--ignore-vcs");
    expect(args).toContain("--ignore");
    expect(args).toContain("node_modules/");
    expect(args).toContain(".git/");
  });

  it("includes --ignore-vcs first", () => {
    const args = buildMutagenIgnoreArgs([]);
    expect(args[0]).toBe("--ignore-vcs");
  });
});

describe("hasGitignore", () => {
  it("returns false when no .gitignore exists", () => {
    expect(hasGitignore(TEST_DIR)).toBe(false);
  });

  it("returns true when .gitignore exists", () => {
    writeFileSync(`${TEST_DIR}/.gitignore`, "node_modules/\n");
    expect(hasGitignore(TEST_DIR)).toBe(true);
  });

  it("returns true for empty .gitignore", () => {
    writeFileSync(`${TEST_DIR}/.gitignore`, "");
    expect(hasGitignore(TEST_DIR)).toBe(true);
  });
});

describe("loadGitignorePatterns", () => {
  it("returns empty array when no .gitignore exists", () => {
    const patterns = loadGitignorePatterns(TEST_DIR);
    expect(patterns).toEqual([]);
  });

  it("parses .gitignore file", () => {
    writeFileSync(`${TEST_DIR}/.gitignore`, "*.log\n.env\nsecrets/\n");
    
    const patterns = loadGitignorePatterns(TEST_DIR);
    
    expect(patterns).toContain("*.log");
    expect(patterns).toContain(".env");
    expect(patterns).toContain("secrets/");
  });

  it("ignores comments and empty lines", () => {
    writeFileSync(`${TEST_DIR}/.gitignore`, "# Comment\n\n*.log\n  \n# Another comment\n.env\n");
    
    const patterns = loadGitignorePatterns(TEST_DIR);
    
    expect(patterns).toEqual(["*.log", ".env"]);
  });
});

describe("getAllIgnorePatterns", () => {
  it("returns default patterns when useGitignore is false", () => {
    writeFileSync(`${TEST_DIR}/.gitignore`, "custom-pattern\n");
    
    const patterns = getAllIgnorePatterns(TEST_DIR, false);
    
    expect(patterns).toContain("node_modules/");
    expect(patterns).not.toContain("custom-pattern");
  });

  it("includes gitignore patterns when useGitignore is true", () => {
    writeFileSync(`${TEST_DIR}/.gitignore`, "custom-pattern\n.secrets\n");
    
    const patterns = getAllIgnorePatterns(TEST_DIR, true);
    
    expect(patterns).toContain("node_modules/");
    expect(patterns).toContain("custom-pattern");
    expect(patterns).toContain(".secrets");
  });

  it("deduplicates patterns", () => {
    writeFileSync(`${TEST_DIR}/.gitignore`, "node_modules/\n*.log\n");
    
    const patterns = getAllIgnorePatterns(TEST_DIR, true);
    const nodeModulesCount = patterns.filter(p => p === "node_modules/").length;
    
    expect(nodeModulesCount).toBe(1);
  });
});
