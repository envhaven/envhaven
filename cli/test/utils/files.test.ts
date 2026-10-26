import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, symlinkSync, lstatSync, readdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileAtomic } from "../../src/utils/files";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/haven-files-`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic (L-11)", () => {
  it("creates a file with the requested mode and leaves no temporary file", () => {
    writeFileAtomic(`${dir}/state.json`, "{}", { mode: 0o600 });
    expect(readFileSync(`${dir}/state.json`, "utf-8")).toBe("{}");
    expect(statSync(`${dir}/state.json`).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("keeps an existing file's mode unless forced", () => {
    writeFileSync(`${dir}/config`, "old", { mode: 0o644 });
    chmodSync(`${dir}/config`, 0o644);
    writeFileAtomic(`${dir}/config`, "new", { mode: 0o600 });
    expect(statSync(`${dir}/config`).mode & 0o777).toBe(0o644);

    writeFileAtomic(`${dir}/config`, "newer", { mode: 0o600, force: true });
    expect(statSync(`${dir}/config`).mode & 0o777).toBe(0o600);
    expect(readFileSync(`${dir}/config`, "utf-8")).toBe("newer");
  });

  it("writes through a symlink and keeps the link", () => {
    writeFileSync(`${dir}/target`, "old", { mode: 0o600 });
    symlinkSync(`${dir}/target`, `${dir}/link`);
    writeFileAtomic(`${dir}/link`, "new", { mode: 0o600 });
    expect(lstatSync(`${dir}/link`).isSymbolicLink()).toBe(true);
    expect(readFileSync(`${dir}/target`, "utf-8")).toBe("new");
  });

  it("creates a dangling symlink's target privately and keeps the link", () => {
    symlinkSync(`${dir}/new-target`, `${dir}/link`);
    writeFileAtomic(`${dir}/link`, "new", { mode: 0o600 });
    expect(lstatSync(`${dir}/link`).isSymbolicLink()).toBe(true);
    expect(readFileSync(`${dir}/new-target`, "utf-8")).toBe("new");
    expect(statSync(`${dir}/new-target`).mode & 0o777).toBe(0o600);
  });

  it("leaves the old file whole when the disk takes only part of the new one", async () => {
    // A short write renamed over connections.json truncated it, and the next save then kept only
    // its own entry. A file size limit makes the kernel accept part of a write, as a full disk can.
    writeFileSync(`${dir}/state.json`, "old");
    const code = `
      import { writeFileAtomic } from ${JSON.stringify(join(import.meta.dir, "../../src/utils/files"))};
      try {
        writeFileAtomic(${JSON.stringify(`${dir}/state.json`)}, "x".repeat(1 << 20), { mode: 0o600 });
        console.log("RESULT written");
      } catch (err) {
        console.log("RESULT " + err.code);
      }
    `;
    // SIGXFSZ ignored, so a write past the limit fails with EFBIG instead of ending the process.
    const proc = Bun.spawn(["sh", "-c", 'trap "" XFSZ; ulimit -f 64; exec "$0" -e "$1"', process.execPath, code], {
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ stdout, stderr }).toEqual({ stdout: "RESULT EFBIG\n", stderr: "" });
    expect(readFileSync(`${dir}/state.json`, "utf-8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });
});
