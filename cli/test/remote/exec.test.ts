import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// remotePathsThatExist sends one shell script over ssh. A stand-in ssh runs that script here, so
// the quoting is tested against a real shell; in a subprocess because Bun resolves PATH at startup.
const FAKE_SSH = `#!/bin/sh
for last; do :; done
exec sh -c "$last"
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/haven-exec-`);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "ssh"), FAKE_SSH);
  chmodSync(join(dir, "bin", "ssh"), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// abc's login shell on workspaces is zsh, which expands a word starting with `=`.
const FAKE_SSH_ZSH = `#!/bin/sh
for last; do :; done
exec zsh -c "$last"
`;

async function existing(remoteRoot: string, paths: string[]): Promise<string[]> {
  const code = `
    import { remotePathsThatExist } from ${JSON.stringify(join(import.meta.dir, "../../src/remote/exec"))};
    console.log(JSON.stringify(await remotePathsThatExist("haven-0123456789abcdef", ${JSON.stringify(remoteRoot)}, ${JSON.stringify(paths)})));
  `;
  const proc = Bun.spawn([process.execPath, "-e", code], {
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env["PATH"]}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return JSON.parse(stdout);
}

describe("remotePathsThatExist", () => {
  it("names the paths that exist under the remote root, spaces and all, and changes nothing", async () => {
    const root = join(dir, "workspace project");
    mkdirSync(join(root, "certs"), { recursive: true });
    mkdirSync(join(root, "dir with space"), { recursive: true });
    mkdirSync(join(root, ".aws"), { recursive: true });
    writeFileSync(join(root, "certs", "ca.pem"), "x");
    writeFileSync(join(root, ".env"), "x");
    writeFileSync(join(root, "dir with space", "key"), "x");

    const asked = ["certs/ca.pem", ".env", "missing", "dir with space/key", ".aws", "it's"];
    expect(await existing(root, asked)).toEqual(["certs/ca.pem", ".env", "dir with space/key", ".aws"]);
    expect(existsSync(join(root, "certs", "ca.pem"))).toBe(true);
  });

  it.skipIf(!Bun.which("zsh"))("works under zsh, where one name starting with = once blanked the answer", async () => {
    writeFileSync(join(dir, "bin", "ssh"), FAKE_SSH_ZSH);
    const root = join(dir, "workspace");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "=key.pem"), "x");
    writeFileSync(join(root, "server.pem"), "x");

    expect(await existing(root, ["=key.pem", "server.pem", "~notes"])).toEqual(["=key.pem", "server.pem"]);
  });

  it("answers nothing when the remote root does not exist", async () => {
    expect(await existing(join(dir, "nowhere"), [".env"])).toEqual([]);
  });
});
