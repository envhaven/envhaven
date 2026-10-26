import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carryOverChoices, retireSession } from "../../src/commands/connect";
import { disconnect } from "../../src/commands/disconnect";
import { getConnection, loadSession, saveConnection, saveSession, type ConnectionConfig } from "../../src/config/store";

let dir: string;
const previousXdg = process.env["XDG_CONFIG_HOME"];

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/haven-connect-`);
  process.env["XDG_CONFIG_HOME"] = join(dir, "config");
});

afterEach(() => {
  if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = previousXdg;
  rmSync(dir, { recursive: true, force: true });
});

// The questions run in a process of their own, fed from piped input, as the reader is per process.
async function run(body: string, input: string): Promise<{ result: unknown; stdout: string }> {
  const code = `
    import { resolveEnvFilesChoice, resolveGitignorePatterns } from ${JSON.stringify(join(import.meta.dir, "../../src/commands/connect"))};
    const config = { host: "h.example.com", port: 22, user: "abc", remotePath: "/w" };
    ${body}
  `;
  const proc = Bun.spawn([process.execPath, "-e", code], { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const at = stdout.lastIndexOf("RESULT ");
  if (at === -1) throw new Error(`no result; stdout: ${JSON.stringify(stdout)} stderr: ${stderr}`);
  return { result: JSON.parse(stdout.slice(at + "RESULT ".length).split("\n")[0]!), stdout };
}

describe("the .env question", () => {
  const choose = (option: string) => `
    const sync = await resolveEnvFilesChoice(config, ${option});
    console.log("RESULT " + JSON.stringify({ sync, remembered: config.syncEnvFiles ?? null }));
  `;

  it("does not remember the default taken because input ended", async () => {
    // Remembered, it was a "no" nobody gave, and no later connect asked again.
    expect((await run(choose("undefined"), "")).result).toEqual({ sync: false, remembered: null });
  });

  it("remembers an answer, Enter for the default included, and the flags", async () => {
    expect((await run(choose("undefined"), "y\n")).result).toEqual({ sync: true, remembered: true });
    expect((await run(choose("undefined"), "\n")).result).toEqual({ sync: false, remembered: false });
    expect((await run(choose("true"), "")).result).toEqual({ sync: true, remembered: true });
    expect((await run(choose("false"), "")).result).toEqual({ sync: false, remembered: false });
  });
});

describe("a .gitignore with no accepted version yet (M-27)", () => {
  const resolve = (option = "undefined") => `
    const patterns = await resolveGitignorePatterns(${JSON.stringify(join(dir, "project"))}, config, ${option});
    console.log("RESULT " + JSON.stringify({ patterns, accepted: config.gitignorePatterns ?? null }));
  `;
  const gitignore = (content: string) => {
    mkdirSync(join(dir, "project"), { recursive: true });
    writeFileSync(join(dir, "project", ".gitignore"), content);
  };

  it("lists the lines that re-include files and then defaults to not using it", async () => {
    // The workspace can write .gitignore through sync, and this file would otherwise apply unseen.
    gitignore("dist/\n!keep.log\n!.vscode/\n");
    const { result, stdout } = await run(resolve(), "");
    expect(result).toEqual({ patterns: [], accepted: null });
    expect(stdout).toContain("!keep.log");
    expect(stdout).toContain("!.vscode/");
    expect(stdout).toContain("Exclude matching files from sync? [y/N]");
  });

  it("applies and accepts those lines on a yes", async () => {
    gitignore("dist/\n!keep.log\n");
    expect((await run(resolve(), "y\n")).result).toEqual({ patterns: ["dist/", "!keep.log"], accepted: ["dist/", "!keep.log"] });
  });

  it("asks even with --use-gitignore, which was given without seeing them", async () => {
    gitignore("dist/\n!keep.log\n");
    expect((await run(resolve("true"), "")).result).toEqual({ patterns: [], accepted: null });
  });

  it("keeps the yes default for a file without such lines, and records only a real answer", async () => {
    gitignore("dist/\n*.log\n");
    expect((await run(resolve(), "")).result).toEqual({ patterns: ["dist/", "*.log"], accepted: null });
    expect((await run(resolve(), "\n")).result).toEqual({ patterns: ["dist/", "*.log"], accepted: ["dist/", "*.log"] });
    expect((await run(resolve("true"), "")).result).toEqual({ patterns: ["dist/", "*.log"], accepted: ["dist/", "*.log"] });
  });
});

describe("a .gitignore deleted after its lines were accepted (M-27)", () => {
  const resolve = (option: string, accepted: string[] = ["secrets/", "*.tfstate"]) => `
    config.gitignorePatterns = ${JSON.stringify(accepted)};
    const patterns = await resolveGitignorePatterns(${JSON.stringify(join(dir, "project"))}, config, ${option});
    console.log("RESULT " + JSON.stringify({ patterns, accepted: config.gitignorePatterns ?? null }));
  `;
  const kept = { patterns: ["secrets/", "*.tfstate"], accepted: ["secrets/", "*.tfstate"] };

  beforeEach(() => {
    mkdirSync(join(dir, "project"), { recursive: true });
  });

  it("lists the lines it took away and keeps them unless confirmed, with or without --use-gitignore", async () => {
    // The workspace can delete .gitignore through sync, and what its lines kept here would sync.
    for (const option of ["undefined", "true"]) {
      const { result, stdout } = await run(resolve(option), "");
      expect(result).toEqual(kept);
      expect(stdout).toContain(".gitignore was deleted");
      expect(stdout).toContain("- secrets/");
      expect(stdout).toContain("Apply these changes to what syncs? [y/N]");
      expect((await run(resolve(option), "n\n")).result).toEqual(kept);
    }
  });

  it("drops them on a yes", async () => {
    for (const option of ["undefined", "true"]) {
      expect((await run(resolve(option), "y\n")).result).toEqual({ patterns: [], accepted: [] });
    }
  });

  it("asks nothing when no lines were accepted", async () => {
    const { result, stdout } = await run(resolve("undefined", []), "");
    expect(result).toEqual({ patterns: [], accepted: [] });
    expect(stdout).not.toContain("Apply these changes");
  });
});

describe("the broad-directory guard", () => {
  it("exits non-zero when the answer is no, so a script does not carry on as if connected", async () => {
    mkdirSync(join(dir, "build"));
    // HOME is the test's own, and the guard comes before anything reads ~/.ssh or connects.
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/index.ts"), "connect", join(dir, "build"), "abc@h.example.com"], {
      stdin: new Blob([""]),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir },
    });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(stdout).toContain("unusually broad");
    expect(proc.exitCode).toBe(1);
    expect(existsSync(join(dir, ".config", "haven", "connections.json"))).toBe(false);
  });
});

describe("retiring the session an older version named", () => {
  const base: ConnectionConfig = { host: "h.example.com", port: 22, user: "abc", remotePath: "/w", sessionId: "0123456789abcdef" };

  it("keeps naming a session it could not terminate, and lets go once it is gone", async () => {
    // Left paused with nothing naming it, the session outlived every disconnect.
    saveConnection("/projects/app", { ...base, retiredSessionId: "abc12" });
    saveSession("abc12", { connected: true, startTime: 1 });

    await retireSession("/projects/app", getConnection("/projects/app")!, async () => {
      throw new Error("daemon did not answer");
    });
    expect(getConnection("/projects/app")?.retiredSessionId).toBe("abc12");
    expect(loadSession("abc12")).not.toBeNull();

    const stopped: string[] = [];
    await retireSession("/projects/app", getConnection("/projects/app")!, async (id) => {
      stopped.push(id);
    });
    expect(stopped).toEqual(["abc12"]);
    expect(getConnection("/projects/app")?.retiredSessionId).toBeUndefined();
    expect(loadSession("abc12")).toBeNull();
  });

  it("never terminates the directory's current session", async () => {
    const stopped: string[] = [];
    await retireSession("/projects/app", { ...base, retiredSessionId: base.sessionId! }, async (id) => {
      stopped.push(id);
    });
    expect(stopped).toEqual([]);
  });

  it("is terminated by disconnect too, so the daemon can stop", async () => {
    // Paused, it counted as a session, and the daemon kept running until the next connect.
    saveConnection("/projects/app", { ...base, retiredSessionId: "abc12" });
    saveSession("abc12", { connected: true, startTime: 1 });

    const calls: string[] = [];
    await disconnect("/projects/app", {
      flushSync: async (id) => {
        calls.push(`flush ${id}`);
      },
      stopSync: async (id) => {
        calls.push(`stop ${id}`);
      },
      stopDaemonIfIdle: async () => {
        calls.push("stop daemon");
      },
    });
    expect(calls).toEqual([`flush ${base.sessionId}`, `stop ${base.sessionId}`, "stop abc12", "stop daemon"]);
    expect(getConnection("/projects/app")?.retiredSessionId).toBeUndefined();
    expect(loadSession("abc12")).toBeNull();
  });

  it("carries the name to a new target with the directory's other choices", () => {
    const config: ConnectionConfig = { host: "other.example.com", port: 22, user: "abc", remotePath: "/w" };
    carryOverChoices(config, { ...base, retiredSessionId: "abc12", syncEnvFiles: true, identityFile: "/k" });
    expect(config).toEqual({ host: "other.example.com", port: 22, user: "abc", remotePath: "/w", retiredSessionId: "abc12", syncEnvFiles: true });
  });
});
