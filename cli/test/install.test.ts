import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, symlinkSync, lstatSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { join } from "path";

// End-to-end runs of cli/install.sh against a local stand-in for github.com/<repo>/releases:
// the real script and real curl/sha256sum, only the base URL swapped.

const TAG = "v9.9.9";
const PLATFORM = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const BINARY = `haven-${PLATFORM}`;
const PAYLOAD = "#!/bin/sh\necho haven-fixture\n";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

let sums: string | null;
// When set, the binary download waits for `released`, and says when it started.
let hold: { started: () => void; released: Promise<void> } | null;
let server: ReturnType<typeof Bun.serve>;
let script: string;
let dir: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/envhaven/envhaven/releases/latest") {
        return new Response(null, { status: 302, headers: { Location: `/envhaven/envhaven/releases/tag/${TAG}` } });
      }
      if (path === `/envhaven/envhaven/releases/tag/${TAG}`) return new Response("release page");
      if (path === `/envhaven/envhaven/releases/download/${TAG}/${BINARY}`) {
        if (!hold) return new Response(PAYLOAD);
        hold.started();
        return hold.released.then(() => new Response(PAYLOAD));
      }
      if (path === `/envhaven/envhaven/releases/download/${TAG}/SHA256SUMS` && sums !== null) return new Response(sums);
      return new Response("not found", { status: 404 });
    },
  });
  const original = readFileSync(join(import.meta.dir, "../install.sh"), "utf-8");
  const base = 'RELEASES="https://github.com/${REPO}/releases"';
  if (!original.includes(base)) throw new Error("install.sh no longer defines RELEASES as expected");
  script = original.replace(base, `RELEASES="http://127.0.0.1:${server.port}/\${REPO}/releases"`);
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/haven-install-`);
  writeFileSync(`${dir}/install.sh`, script);
  sums = `${sha256("something else")}  haven-other-platform\n${sha256(PAYLOAD)}  ${BINARY}\n`;
  hold = null;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function startInstall() {
  return Bun.spawn(["sh", `${dir}/install.sh`], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir, INSTALL_DIR: `${dir}/bin` },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function install(): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = startInstall();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("cli/install.sh (H-3)", () => {
  it("installs when the binary matches SHA256SUMS", async () => {
    const result = await install();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Latest version: ${TAG}`);
    expect(readFileSync(`${dir}/bin/haven`, "utf-8")).toBe(PAYLOAD);
    expect(statSync(`${dir}/bin/haven`).mode & 0o777).toBe(0o755);
    // No staging directory is left behind.
    expect(readdirSync(`${dir}/bin`)).toEqual(["haven"]);
  });

  it("accepts the binary-mode `*name` form of sha256sum", async () => {
    sums = `${sha256(PAYLOAD)} *${BINARY}\n`;
    expect((await install()).code).toBe(0);
  });

  it("refuses a binary whose hash does not match", async () => {
    sums = `${sha256("tampered")}  ${BINARY}\n`;
    const result = await install();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch");
    expect(existsSync(`${dir}/bin/haven`)).toBe(false);
  });

  it("refuses when SHA256SUMS has no entry for the platform", async () => {
    sums = `${sha256(PAYLOAD)}  haven-other-platform\n`;
    const result = await install();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no entry");
    expect(existsSync(`${dir}/bin/haven`)).toBe(false);
  });

  it("refuses when the release has no SHA256SUMS", async () => {
    sums = null;
    const result = await install();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("refusing to install an unverified binary");
    expect(existsSync(`${dir}/bin/haven`)).toBe(false);
  });

  it("replaces a symlink at the destination instead of writing through it (L-57)", async () => {
    writeFileSync(`${dir}/victim`, "do not overwrite\n");
    Bun.spawnSync(["mkdir", "-p", `${dir}/bin`]);
    symlinkSync(`${dir}/victim`, `${dir}/bin/haven`);

    expect((await install()).code).toBe(0);
    expect(readFileSync(`${dir}/victim`, "utf-8")).toBe("do not overwrite\n");
    expect(lstatSync(`${dir}/bin/haven`).isSymbolicLink()).toBe(false);
    expect(readFileSync(`${dir}/bin/haven`, "utf-8")).toBe(PAYLOAD);
  });

  it("refuses a destination symlink that points to a directory", async () => {
    Bun.spawnSync(["mkdir", "-p", `${dir}/bin`, `${dir}/target`]);
    symlinkSync(`${dir}/target`, `${dir}/bin/haven`);

    const result = await install();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("is a directory");
    expect(readdirSync(`${dir}/target`)).toEqual([]);
    expect(lstatSync(`${dir}/bin/haven`).isSymbolicLink()).toBe(true);
  });

  it("removes its staging directory when Ctrl-C, a kill or a closed terminal stops it", async () => {
    // dash, sh on Debian and Ubuntu, runs no EXIT trap when a signal ends it, and a partial
    // download stayed behind in the install directory.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        hold = { started: resolve, released: new Promise<void>((done) => (release = done)) };
      });
      const proc = startInstall();
      await started;
      proc.kill(signal);
      // A shell acts on a signal once the command it waits for ends, as curl does on a real Ctrl-C.
      release();
      await proc.exited;
      expect(readdirSync(`${dir}/bin`)).toEqual([]);
    }
  });
});
