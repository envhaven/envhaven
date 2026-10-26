import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { dirname } from "path";
import {
  getDefaultIgnorePatterns,
  getCredentialNames,
  getCredentialPatterns,
  getEnvFilePatterns,
  buildMutagenIgnoreArgs,
  hasGitignore,
  loadGitignorePatterns,
  getAllIgnorePatterns,
  diffPatterns,
  patternsEqual,
  scanForCredentials,
  isIgnored,
} from "../../src/sync/ignore";

const TEST_DIR = "/tmp/haven-ignore-test";

// The case-folded form the credential rules take (`*.pem` as `*.[pP][eE][mM]`).
const anyCase = (pattern: string) => pattern.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

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

  it("skips lines with control characters, which the workspace could plant (L-13)", () => {
    writeFileSync(`${TEST_DIR}/.gitignore`, "dist/\nbad\tline\n*.log\r\nok\u0007bell\n");

    expect(loadGitignorePatterns(TEST_DIR)).toEqual(["dist/", "*.log"]);
  });

  it("ignores comments and empty lines", () => {
    writeFileSync(`${TEST_DIR}/.gitignore`, "# Comment\n\n*.log\n  \n# Another comment\n.env\n");
    
    const patterns = loadGitignorePatterns(TEST_DIR);
    
    expect(patterns).toEqual(["*.log", ".env"]);
  });
});

describe("getAllIgnorePatterns", () => {
  it("returns default patterns when no gitignore patterns are given", () => {
    const patterns = getAllIgnorePatterns([], true);
    
    expect(patterns).toContain("node_modules/");
    expect(patterns).not.toContain("custom-pattern");
  });

  it("includes gitignore patterns", () => {
    const patterns = getAllIgnorePatterns(["custom-pattern", ".secrets"], true);
    
    expect(patterns).toContain("node_modules/");
    expect(patterns).toContain("custom-pattern");
    expect(patterns).toContain(".secrets");
  });

  it("preserves repeated patterns because the last match wins", () => {
    const ordered = ["secrets/", "!secrets/", "secrets/"];
    const patterns = getAllIgnorePatterns(ordered, true);
    const start = patterns.indexOf("secrets/");
    expect(patterns.slice(start, start + 3)).toEqual(ordered);
    expect(isIgnored(patterns, "secrets/deploy_key")).toBe(true);
  });

  it("never syncs private keys or credential stores (M-6)", () => {
    for (const syncEnvFiles of [true, false]) {
      const patterns = getAllIgnorePatterns([], syncEnvFiles);
      for (const credential of ["id_ed25519", "id_rsa", "*.pem", "*.key", ".ssh/", ".aws/", ".netrc", ".pgpass"]) {
        expect(getCredentialNames()).toContain(credential);
        expect(patterns).toContain(anyCase(credential));
      }
    }
  });

  it("excludes .env and .npmrc unless the user chose to sync them", () => {
    expect(getAllIgnorePatterns([], false)).toEqual(expect.arrayContaining([".env", ".env.*", ".npmrc"]));
    const synced = getAllIgnorePatterns([], true);
    expect(synced).not.toContain(".env");
    expect(synced).not.toContain(".npmrc");
  });

  it("keeps env templates syncing", () => {
    const patterns = getAllIgnorePatterns([], false);
    expect(patterns.indexOf("!.env.example")).toBeGreaterThan(patterns.indexOf(".env.*"));
  });

  it("puts secret rules after .gitignore lines, which cannot re-include them (M-27)", () => {
    const patterns = getAllIgnorePatterns(["!.env", "!*.pem", "!id_ed25519"], false);
    expect(patterns.lastIndexOf(".env")).toBeGreaterThan(patterns.indexOf("!.env"));
    expect(patterns.lastIndexOf(anyCase("*.pem"))).toBeGreaterThan(patterns.indexOf("!*.pem"));
    expect(patterns.lastIndexOf(anyCase("id_ed25519"))).toBeGreaterThan(patterns.indexOf("!id_ed25519"));
  });

  it("does not match ordinary source files", () => {
    for (const pattern of [...getCredentialPatterns(), ...getEnvFilePatterns()]) {
      expect(pattern).not.toBe("id_*");
    }
  });
});

describe("diffPatterns", () => {
  it("lists added and removed lines", () => {
    expect(diffPatterns(["*.log", "dist/"], ["*.log", "src/", "!.env"])).toEqual({
      added: ["src/", "!.env"],
      removed: ["dist/"],
    });
  });

  it("reports no change for the same lines", () => {
    expect(diffPatterns(["a", "b"], ["a", "b"])).toEqual({ added: [], removed: [] });
  });

  it("detects reordered and repeated rules even when the set of lines is unchanged", () => {
    expect(patternsEqual(["a", "b"], ["b", "a"])).toBe(false);
    expect(patternsEqual(["a", "b"], ["a", "b", "b"])).toBe(false);
    expect(patternsEqual(["a", "b"], ["a", "b"])).toBe(true);
  });
});

describe("env files after a yes (M-6)", () => {
  it("re-includes .env, .env.* and .npmrc after the .gitignore lines and before the credential rules", () => {
    const patterns = getAllIgnorePatterns([".env", ".env.local", "*.log"], true);
    const gitignoreEnd = patterns.indexOf("*.log");
    for (const include of ["!.env", "!.env.*", "!.npmrc"]) {
      expect(patterns.indexOf(include)).toBeGreaterThan(gitignoreEnd);
      expect(patterns.indexOf(include)).toBeLessThan(patterns.indexOf(anyCase("*.pem")));
    }
  });

  it("does not re-include them after a no", () => {
    expect(getAllIgnorePatterns([".env"], false)).not.toContain("!.env");
  });
});

describe("scanForCredentials (M-6)", () => {
  const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n";
  const file = (path: string, content = "x") => {
    mkdirSync(dirname(`${TEST_DIR}/${path}`), { recursive: true });
    writeFileSync(`${TEST_DIR}/${path}`, content);
  };

  it("lists what the name rules exclude and finds private keys under other names", () => {
    file("certs/ca.pem", "-----BEGIN CERTIFICATE-----\n");
    file("id_rsa", KEY);
    file("id_rsa.pub", "ssh-rsa AAAA user");
    file(".ssh/config", "Host x");
    file("deploy/github_key", KEY);
    file("keys/id_ed25519_work", "-----BEGIN RSA PRIVATE KEY-----\n");
    file("node_modules/pkg/id_rsa", KEY);
    file("data/old_key", KEY);
    file("big_key", KEY + "x".repeat(20_000));
    file("Makefile", "all:\n\ttrue\n");
    file("src/app.ts", "console.log(1)");

    const scan = scanForCredentials(TEST_DIR, ["data/"]);

    expect(scan.complete).toBe(true);
    expect(scan.byName).toEqual([".ssh/", "certs/ca.pem", "id_rsa"]);
    expect(scan.privateKeys).toEqual(["deploy/github_key", "keys/id_ed25519_work"]);
  });

  it("excludes the private keys it found by exact path, escaped", () => {
    const patterns = getAllIgnorePatterns([], false, ["deploy/github_key", "odd/key[1]*"]);
    expect(patterns.slice(-2)).toEqual(["/deploy/github_key", "/odd/key\\[1\\]\\*"]);
  });

  it("detects renamed private keys with ordinary extensions", () => {
    file("deploy/key.txt", KEY);
    file("deploy/key.json", KEY);
    expect(scanForCredentials(TEST_DIR).privateKeys).toEqual(["deploy/key.json", "deploy/key.txt"]);
  });

  it("scans a directory that a later rule re-includes", () => {
    file("secrets/deploy_key", KEY);
    const gitignore = ["secrets/", "!secrets/"];
    const scan = scanForCredentials(TEST_DIR, gitignore);
    expect(scan.privateKeys).toEqual(["secrets/deploy_key"]);
    expect(getAllIgnorePatterns(gitignore, false, scan.privateKeys)).toContain("/secrets/deploy_key");
  });

  it("enters exactly the folders isIgnored says sync, nested and re-included ones too", () => {
    const gitignore = ["out/", "!out/", "/gen/", "a/b/", "*.cache/", "!keep.cache/", "deep/**/skip/"];
    const folders = ["out/x", "gen/x", "src/gen/x", "a/b/x", "a/b/c/x", "z/a/b/x", "t.cache/x", "keep.cache/x", "deep/1/2/skip/x", "deep/1/2/ok/x"];
    for (const folder of folders) file(`${folder}/deploy_key`, KEY);

    const syncPatterns = [...getDefaultIgnorePatterns(), ...gitignore];
    const expected = folders.filter((folder) => !isIgnored(syncPatterns, `${folder}/`)).map((folder) => `${folder}/deploy_key`);
    expect(scanForCredentials(TEST_DIR, gitignore).privateKeys).toEqual(expected.sort());
    expect(expected).toContain("z/a/b/x/deploy_key");
    expect(expected).not.toContain("a/b/c/x/deploy_key");
  });

  it("detects OpenPGP private keys and keys behind a byte order mark or blank lines", () => {
    file("keys/signing.asc", "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBGVx\n");
    file("keys/bom.txt", "﻿-----BEGIN RSA PRIVATE KEY-----\nMIIE\n");
    file("keys/blank.txt", "\n\r\n  -----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n");
    file("keys/public.asc", "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQIN\n");
    file("keys/notes.txt", "see -----BEGIN RSA PRIVATE KEY----- in the docs\n");
    expect(scanForCredentials(TEST_DIR).privateKeys).toEqual(["keys/blank.txt", "keys/bom.txt", "keys/signing.asc"]);
  });
});

describe("VCS folders (M-27)", () => {
  const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n";

  it("stay out of sync whatever .gitignore says, since the workspace can edit it", () => {
    // A synced .git lets the workspace set hooks or core.fsmonitor, which git runs on this machine.
    for (const syncEnvFiles of [true, false]) {
      const patterns = getAllIgnorePatterns(["!.git/", "!.git", "!.hg/", "!_darcs/"], syncEnvFiles);
      expect(isIgnored(patterns, ".git/config")).toBe(true);
      expect(isIgnored(patterns, "vendor/lib/.git/hooks/pre-commit")).toBe(true);
      expect(isIgnored(patterns, ".hg/hgrc")).toBe(true);
      expect(isIgnored(patterns, "_darcs/prefs")).toBe(true);
      expect(patterns.lastIndexOf(".git")).toBeGreaterThan(patterns.indexOf("!.git"));
      expect(patterns.lastIndexOf(".git")).toBeLessThan(patterns.indexOf(anyCase("*.pem")));
    }
  });

  it("include .git files, which name the folder git uses (P5-31)", () => {
    // A submodule's .git and a worktree's are files naming the git directory. Synced, they let the
    // workspace point git at a folder it also syncs, with a core.fsmonitor that git runs here.
    for (const syncEnvFiles of [true, false]) {
      const patterns = getAllIgnorePatterns(["!.git"], syncEnvFiles);
      expect(isIgnored(patterns, ".git")).toBe(true);
      expect(isIgnored(patterns, "vendor/lib/.git")).toBe(true);
      expect(isIgnored(patterns, ".git/")).toBe(true);
      expect(isIgnored(patterns, "vendor/lib/.git/config")).toBe(true);
    }
  });

  it("reach mutagen as isIgnored reads them", () => {
    const patterns = getAllIgnorePatterns(["!.git", "!.hg/"], false);
    expect(buildMutagenIgnoreArgs(patterns)).toEqual(["--ignore-vcs", ...patterns.flatMap((pattern) => ["--ignore", pattern])]);
    // --ignore-vcs puts mutagen 0.17.6's DefaultVCSIgnores before them, which changes no answer.
    const withVcsDefaults = [".git/", ".svn/", ".hg/", ".bzr/", "_darcs/", ...patterns];
    for (const path of [".git", ".git/", "sub/.git", "sub/.git/HEAD", ".hg", ".hg/", "src/main.ts", ".env"]) {
      expect(isIgnored(withVcsDefaults, path)).toBe(isIgnored(patterns, path));
    }
  });

  it("are not scanned when .gitignore re-includes them, as they do not sync", () => {
    mkdirSync(`${TEST_DIR}/.git/hooks`, { recursive: true });
    writeFileSync(`${TEST_DIR}/.git/hooks/deploy_key`, KEY);
    expect(scanForCredentials(TEST_DIR, ["!.git/"]).privateKeys).toEqual([]);
  });
});

describe("scanForCredentials cost", () => {
  it("compiles the ignore rules once per scan, not once per folder", () => {
    // Compiling every rule again for every folder took 12 seconds for 20,000 folders and a
    // 300-line .gitignore, before sync had even started.
    for (let i = 0; i < 40; i++) mkdirSync(`${TEST_DIR}/pkg${i}/src/lib`, { recursive: true });
    const gitignore = Array.from({ length: 50 }, (_, i) => `generated-${i}/`);
    const bun = Bun as unknown as { Glob: typeof Bun.Glob };
    const Glob = bun.Glob;
    let compiled = 0;
    bun.Glob = class extends Glob {
      constructor(pattern: string) {
        super(pattern);
        compiled++;
      }
    };
    try {
      expect(scanForCredentials(TEST_DIR, gitignore).complete).toBe(true);
    } finally {
      bun.Glob = Glob;
    }
    // Defaults, .gitignore lines and the five VCS rules once, and the credential names once.
    const rules = getDefaultIgnorePatterns().length + gitignore.length + 5 + getCredentialPatterns().length;
    expect(compiled).toBeLessThanOrEqual(rules);
  });
});

describe("credential rules in any letter case (M-6)", () => {
  it("match upper- and mixed-case names in mutagen's patterns and in the scan", () => {
    for (const name of ["server.KEY", "client.PEM", "Bundle.Pfx", "ID_RSA"]) {
      writeFileSync(`${TEST_DIR}/${name}`, "x");
    }
    writeFileSync(`${TEST_DIR}/notes.Md`, "x");

    expect(scanForCredentials(TEST_DIR).byName).toEqual(["Bundle.Pfx", "ID_RSA", "client.PEM", "server.KEY"]);
    expect(getAllIgnorePatterns([], false)).toContain("*.[pP][eE][mM]");
  });
});

describe("env folders after a yes (M-6)", () => {
  it("re-includes .env files but keeps .env folders, usually virtualenvs, excluded", () => {
    const patterns = getAllIgnorePatterns([".env"], true);
    const tail = patterns.slice(patterns.indexOf("!.env"), patterns.indexOf("!.env") + 5);
    expect(tail).toEqual(["!.env", "!.env.*", "!.npmrc", ".env/", ".env.*/"]);
  });
});

describe("scanForCredentials limits (M-6)", () => {
  const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n";

  it("does not enter folders a plain .gitignore line names, with or without a slash", () => {
    mkdirSync(`${TEST_DIR}/.venv/lib`, { recursive: true });
    writeFileSync(`${TEST_DIR}/.venv/lib/stray_key`, KEY);
    mkdirSync(`${TEST_DIR}/scripts`, { recursive: true });
    writeFileSync(`${TEST_DIR}/scripts/deploy_key`, KEY);

    const scan = scanForCredentials(TEST_DIR, [".venv"]);
    expect(scan.privateKeys).toEqual(["scripts/deploy_key"]);
    expect(scan.complete).toBe(true);
  });

  it("walks breadth-first and says when it stopped early", () => {
    mkdirSync(`${TEST_DIR}/deep/x`, { recursive: true });
    for (let i = 0; i < 30; i++) writeFileSync(`${TEST_DIR}/deep/x/file${i}.txt`, "x");
    mkdirSync(`${TEST_DIR}/shallow`, { recursive: true });
    writeFileSync(`${TEST_DIR}/shallow/deploy_key`, KEY);

    const scan = scanForCredentials(TEST_DIR, [], 12);
    expect(scan.privateKeys).toEqual(["shallow/deploy_key"]);
    expect(scan.complete).toBe(false);
  });

  it("collects env files apart, templates aside", () => {
    for (const name of [".env", ".env.local", ".env.example", ".npmrc"]) writeFileSync(`${TEST_DIR}/${name}`, "x");
    expect(scanForCredentials(TEST_DIR).envFiles).toEqual([".env", ".env.local", ".npmrc"]);
  });
});

// The expectations below are what mutagen 0.17.6 itself synced for these paths and patterns (a
// local session, one-way-replica, checked file by file), so isIgnored answers as mutagen does.
describe("isIgnored, as mutagen reads ignore patterns", () => {
  const gitignore = ["docs/*.md", "/build", "*.local", "!keep.local", "secret/", "!*.pem", "[x].txt", ".env", "dist"];
  const keys = ["keys/id_ed25519_work", "notes/deploy*key"];
  const rules = (syncEnvFiles: boolean) => getAllIgnorePatterns(gitignore, syncEnvFiles, keys);

  it("lets the last matching pattern decide, credentials last", () => {
    expect(isIgnored(rules(false), ".env")).toBe(true);
    expect(isIgnored(rules(true), ".env")).toBe(false);
    expect(isIgnored(rules(true), ".env.example")).toBe(false);
    expect(isIgnored(rules(false), "keep.local")).toBe(false);
    expect(isIgnored(rules(false), "other.local")).toBe(true);
    // `!*.pem` in .gitignore cannot re-include what the credential rules exclude.
    expect(isIgnored(rules(true), "data/server.pem")).toBe(true);
    expect(isIgnored(rules(true), "Client.PEM")).toBe(true);
  });

  it("anchors patterns with a slash to the root and matches the rest at any depth", () => {
    expect(isIgnored(rules(true), "docs/a.md")).toBe(true);
    expect(isIgnored(rules(true), "x/docs/a.md")).toBe(false);
    expect(isIgnored(rules(true), "keys/id_ed25519_work")).toBe(true);
    expect(isIgnored(rules(true), "other/keys/id_ed25519_work")).toBe(false);
    // An escaped glob character in a private key's own name matches only that name.
    expect(isIgnored(rules(true), "notes/deploy*key")).toBe(true);
    expect(isIgnored(rules(true), "notes/deployXkey")).toBe(false);
    expect(isIgnored(rules(true), "[x].txt")).toBe(false);
    expect(isIgnored(rules(true), "sub/x.txt")).toBe(true);
  });

  it("ignores everything inside an ignored folder, and folder-only patterns only folders", () => {
    expect(isIgnored(rules(true), "sub/build/out.txt")).toBe(true);
    expect(isIgnored(rules(true), "logs/dist/app.txt")).toBe(true);
    expect(isIgnored(rules(true), "secret/data.txt")).toBe(true);
    expect(isIgnored(rules(true), "py/.env/lib.py")).toBe(true);
    expect(isIgnored(rules(true), ".ssh/config")).toBe(true);
    expect(isIgnored(rules(true), "src/.AWS/credentials")).toBe(true);
    expect(isIgnored(rules(true), "normal.txt")).toBe(false);
    expect(isIgnored(rules(true), ".envrc")).toBe(false);
  });

  it("ignores nothing with no patterns", () => {
    expect(isIgnored([], ".env")).toBe(false);
    expect(isIgnored([], "certs/dev.key")).toBe(false);
  });
});
