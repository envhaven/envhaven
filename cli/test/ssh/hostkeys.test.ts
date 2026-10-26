import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, mkdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  fingerprint,
  hostEntry,
  knownHostsName,
  hostKeyAlgorithms,
  parseKnownHostsLines,
  sameKey,
  describeHostKey,
  scanTypeOf,
  knownHostKeys,
  trustHostKey,
  forgetHostKeys,
  type HostKey,
} from "../../src/ssh/hostkeys";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/haven-hostkeys-`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`);
  return stdout;
}

// A fresh key pair, as `<type> <base64>` and the fingerprint OpenSSH itself prints for it.
async function generateKey(type: "ed25519" | "rsa", name: string): Promise<{ type: string; key: string; expected: string }> {
  await run(["ssh-keygen", "-q", "-t", type, "-N", "", "-C", "", "-f", `${dir}/${name}`]);
  const [keyType, key] = readFileSync(`${dir}/${name}.pub`, "utf-8").trim().split(/\s+/) as [string, string];
  const expected = (await run(["ssh-keygen", "-lf", `${dir}/${name}.pub`])).split(/\s+/)[1]!;
  return { type: keyType, key, expected };
}

function hostKey(type: string, key: string, host: string): HostKey {
  return { type, key, line: `${host} ${type} ${key}` };
}

describe("fingerprint", () => {
  it("matches ssh-keygen for ed25519 and rsa keys", async () => {
    for (const type of ["ed25519", "rsa"] as const) {
      const generated = await generateKey(type, `k-${type}`);
      expect(fingerprint(generated)).toBe(generated.expected);
    }
  });

  it("describes a key with its type", async () => {
    const generated = await generateKey("ed25519", "k");
    expect(describeHostKey(generated)).toBe(`ED25519 ${generated.expected}`);
    expect(scanTypeOf(generated)).toBe("ed25519");
  });
});

describe("hostEntry", () => {
  it("brackets non-default ports the way known_hosts does", () => {
    expect(hostEntry("h.example.com", 22)).toBe("h.example.com");
    expect(hostEntry("h.example.com", 2222)).toBe("[h.example.com]:2222");
  });
});

describe("parseKnownHostsLines", () => {
  it("reads plain and hashed lines and skips comments and markers", () => {
    const text = [
      "# Host h found: line 1",
      "h.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF0dTzi/cVJtCzVHDBvisgvbu7owwV8LwwuBDwUkEbxA",
      "|1|n6Zz5qJeGVZfQbB+e1a9FnF3bhw=|VLQl+xWCqHFeSZopiLeOgxXxVyU= ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC",
      "@revoked h.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther",
      "@cert-authority *.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICa",
      "h.example.com unknown-type AAAA",
      "",
    ].join("\n");

    const keys = parseKnownHostsLines(text);
    expect(keys.map((k) => k.type)).toEqual(["ssh-ed25519", "ssh-rsa"]);
    expect(keys[1]!.line.startsWith("|1|")).toBe(true);
  });
});

describe("sameKey", () => {
  it("compares type and key material", () => {
    expect(sameKey(hostKey("ssh-rsa", "AAAA", "a"), hostKey("ssh-rsa", "AAAA", "b"))).toBe(true);
    expect(sameKey(hostKey("ssh-rsa", "AAAA", "a"), hostKey("ssh-ed25519", "AAAA", "a"))).toBe(false);
  });
});

describe("known_hosts round trip", () => {
  it("trusts a key, finds it again, and replaces it when another is confirmed", async () => {
    const file = `${dir}/known_hosts`;
    const first = await generateKey("ed25519", "first");
    const second = await generateKey("ed25519", "second");
    writeFileSync(file, "other.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF0dTzi/cVJtCzVHDBvisgvbu7owwV8LwwuBDwUkEbxA");

    expect(await knownHostKeys("[h.example.com]:2222", file)).toEqual([]);

    await trustHostKey("[h.example.com]:2222", hostKey(first.type, first.key, "[h.example.com]:2222"), file);
    const afterFirst = await knownHostKeys("[h.example.com]:2222", file);
    expect(afterFirst.map((k) => k.key)).toEqual([first.key]);
    // Appended on its own line even though the file had no trailing newline.
    expect(readFileSync(file, "utf-8").split("\n")).toHaveLength(3);

    await trustHostKey("[h.example.com]:2222", hostKey(second.type, second.key, "[h.example.com]:2222"), file);
    const afterSecond = await knownHostKeys("[h.example.com]:2222", file);
    expect(afterSecond.map((k) => k.key)).toEqual([second.key]);
    // Other hosts are left alone.
    expect(readFileSync(file, "utf-8")).toContain("other.example.com");
    // A port is part of the identity: the same host on 22 knows nothing.
    expect(await knownHostKeys("h.example.com", file)).toEqual([]);
  });

  it("finds hashed entries and forgets them", async () => {
    const file = `${dir}/known_hosts`;
    const key = await generateKey("ed25519", "hashed");
    writeFileSync(file, `[h.example.com]:2222 ${key.type} ${key.key}\n`);
    await run(["ssh-keygen", "-H", "-f", file]);
    expect(readFileSync(file, "utf-8").startsWith("|1|")).toBe(true);

    expect((await knownHostKeys("[h.example.com]:2222", file)).map((k) => k.key)).toEqual([key.key]);
    await forgetHostKeys("[h.example.com]:2222", file);
    expect(await knownHostKeys("[h.example.com]:2222", file)).toEqual([]);
  });

  it("finds a hashed entry for a host name typed in capitals, under the name ssh uses", async () => {
    // ssh files keys under the host name in lower case, and a hashed line matches only that exact
    // string, so the name as typed found nothing and every connect asked again.
    const file = `${dir}/known_hosts`;
    const key = await generateKey("ed25519", "upper");
    writeFileSync(file, `localhost ${key.type} ${key.key}\n`);
    await run(["ssh-keygen", "-H", "-f", file]);
    expect(await knownHostKeys("Localhost", file)).toEqual([]);
    const name = knownHostsName("hostname Localhost\nport 22\n");
    expect((await knownHostKeys(name, file)).map((k) => k.key)).toEqual([key.key]);
  });

  it("creates known_hosts privately when there is none", async () => {
    const file = `${dir}/sub/known_hosts`;
    const key = await generateKey("ed25519", "fresh");
    await trustHostKey("h.example.com", hostKey(key.type, key.key, "h.example.com"), file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect((await knownHostKeys("h.example.com", file)).map((k) => k.key)).toEqual([key.key]);
  });
});

describe("knownHostsName", () => {
  it("is the host name ssh uses, bracketed with a port other than 22", () => {
    expect(knownHostsName("user abc\nhostname localhost\nport 22\n")).toBe("localhost");
    expect(knownHostsName("hostname Ws.Example.COM\nport 2222\n")).toBe("[ws.example.com]:2222");
  });

  it("is the HostKeyAlias when the user set one, port or not", () => {
    expect(knownHostsName("hostname h.example.com\nport 2222\nhostkeyalias workspace\n")).toBe("workspace");
  });

  it("refuses a dump without a host name", () => {
    expect(() => knownHostsName("port 22\n")).toThrow();
  });
});

describe("hostKeyAlgorithms", () => {
  const ed25519 = hostKey("ssh-ed25519", "AAAA", "h");
  const rsa = hostKey("ssh-rsa", "BBBB", "h");
  const ecdsa = hostKey("ecdsa-sha2-nistp256", "CCCC", "h");
  // What `ssh -G` prints on OpenSSH 9.6 (ed25519 first) and 8.2 (ECDSA first).
  const modern = "hostkeyalgorithms ssh-ed25519-cert-v01@openssh.com,rsa-sha2-512-cert-v01@openssh.com,ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,sk-ssh-ed25519@openssh.com,rsa-sha2-512,rsa-sha2-256\n";
  const old = "hostkeyalgorithms ecdsa-sha2-nistp256-cert-v01@openssh.com,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,ssh-ed25519,rsa-sha2-512,rsa-sha2-256,ssh-rsa\n";

  it("asks for the known types in ssh's order, not known_hosts order", () => {
    // A stale RSA line listed first used to be asked for first, and read as a changed key.
    expect(hostKeyAlgorithms([rsa, ed25519], modern)).toEqual(["ssh-ed25519", "rsa-sha2-512", "rsa-sha2-256"]);
    expect(hostKeyAlgorithms([ed25519, ecdsa], old)).toEqual(["ecdsa-sha2-nistp256", "ssh-ed25519"]);
    expect(hostKeyAlgorithms([rsa], old)).toEqual(["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"]);
  });

  it("keeps OpenSSH's own order when ssh -G prints none, and asks for nothing unknown", () => {
    expect(hostKeyAlgorithms([rsa, ecdsa, ed25519], "")).toEqual(["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512", "rsa-sha2-256"]);
    expect(hostKeyAlgorithms([], modern)).toEqual([]);
  });
});

// checkHostKey drives the real ssh binary; here a stand-in on PATH answers the way a server in
// each state does, in a subprocess because Bun resolves PATH at startup. ssh-keygen is the real one.
describe("checkHostKey through ssh (M-5, proxies honoured)", () => {
  const ALIAS = "haven-0123456789abcdef";
  // What ssh -G prints for the alias, cut to the lines checkHostKey reads.
  const DUMP = "hostname h.example.com\nport 2222\nhostkeyalgorithms ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512,rsa-sha2-256\n";
  const PRESENTED = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF0dTzi/cVJtCzVHDBvisgvbu7owwV8LwwuBDwUkEbxA";
  const FAKE_SSH = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    UserKnownHostsFile=*) file=\${arg#UserKnownHostsFile=}; file=\${file#\\"}; file=\${file%\\"} ;;
    HostKeyAlgorithms=*) algorithms=\${arg#HostKeyAlgorithms=} ;;
  esac
done
echo "$*" >> "$FAKE_SSH_LOG"
record() { echo "|1|c2FsdA==|aGFzaA== $FAKE_SSH_KEY" > "$file"; }
case "$FAKE_SSH" in
  answer) record; echo "abc@h: Permission denied (publickey)." >&2 ;;
  disconnect) printf 'Received disconnect from 10.0.0.1 port 2222:2: \\nabc@h: Permission denied (publickey).\\nDisconnected from 10.0.0.1 port 2222\\n' >&2 ;;
  refused) printf 'ssh: connect to host h port 2222: \\033[31mConnection refused\\n' >&2 ;;
  other-types)
    if [ -n "\${algorithms:-}" ]; then
      # ssh logs this at info level, so under the capture's LogLevel=ERROR it prints nothing at all
      # (OpenSSH 9.6 against a server without the type asked for).
      case " $* " in
        *" LogLevel=ERROR "*) ;;
        *) echo "Unable to negotiate with 10.0.0.1 port 2222: no matching host key type found. Their offer: rsa-sha2-512" >&2 ;;
      esac
    else
      record; echo "abc@h: Permission denied (publickey)." >&2
    fi ;;
esac
exit 255
`;

  interface Check {
    status: string;
    presented: HostKey | null;
    known: HostKey[];
    error: string;
  }

  async function check(mode: string, known: string | string[] | null, presented = PRESENTED): Promise<Check & { calls: string[] }> {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ssh"), FAKE_SSH);
    chmodSync(join(bin, "ssh"), 0o755);
    const knownHosts = join(dir, "known_hosts");
    if (known !== null) writeFileSync(knownHosts, [known].flat().map((k) => `[h.example.com]:2222 ${k}\n`).join(""));
    const log = join(dir, "ssh.log");
    const code = `
      import { checkHostKey } from ${JSON.stringify(join(import.meta.dir, "../../src/ssh/hostkeys"))};
      console.log(JSON.stringify(await checkHostKey(${JSON.stringify(ALIAS)}, ${JSON.stringify(DUMP)}, ${JSON.stringify(knownHosts)})));
    `;
    const proc = Bun.spawn([process.execPath, "-e", code], {
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, FAKE_SSH: mode, FAKE_SSH_KEY: presented, FAKE_SSH_LOG: log },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    return { ...JSON.parse(stdout), calls: readFileSync(log, "utf-8").trim().split("\n") };
  }

  it("trusts the key the server presents only when known_hosts holds it, without offering a key", async () => {
    const result = await check("answer", PRESENTED);
    expect(result.status).toBe("trusted");
    expect(result.calls).toHaveLength(1);
    const call = result.calls[0]!;
    expect(call).toContain(ALIAS);
    expect(call).toContain("PreferredAuthentications=none");
    expect(call).toContain("StrictHostKeyChecking=accept-new");
    // A config with LogLevel QUIET would otherwise hide why a connection failed.
    expect(call).toContain("LogLevel=ERROR");
    // Through a shared master connection there is no key exchange, so no key to read.
    expect(call).toContain("ControlPath=none");
    // Asked for the type already trusted, so a server that also has others is not "changed".
    expect(call).toContain("HostKeyAlgorithms=ssh-ed25519");
    expect(call).not.toContain("ssh-keyscan");
  });

  it("reports a key known_hosts does not hold as untrusted, with the line ssh recorded", async () => {
    const other = await generateKey("ed25519", "other");
    const result = await check("answer", `${other.type} ${other.key}`);
    expect(result.status).toBe("untrusted");
    expect(result.presented?.type).toBe("ssh-ed25519");
    expect(result.presented?.line.startsWith("|1|")).toBe(true);
    expect(result.known.map((k) => k.key)).toEqual([other.key]);
  });

  it("asks for the trusted types in ssh's order, so a stale line listed first is not read as a change", async () => {
    const stale = await generateKey("rsa", "stale");
    const result = await check("answer", [`${stale.type} ${stale.key}`, PRESENTED]);
    expect(result.status).toBe("trusted");
    expect(result.calls[0]).toContain("HostKeyAlgorithms=ssh-ed25519,rsa-sha2-512,rsa-sha2-256");
  });

  it("asks a host it has never seen for any key type", async () => {
    const result = await check("answer", null);
    expect(result.status).toBe("untrusted");
    expect(result.known).toEqual([]);
    expect(result.calls[0]).not.toContain("HostKeyAlgorithms");
  });

  it("does not take a disconnect that imitates ssh's refusal for a host key that passed", async () => {
    // Before any key exchange a server can send a disconnect whose text, newlines kept, reads like
    // ssh's own refusal line. No key was sent, so none is trusted, even with one in known_hosts.
    const result = await check("disconnect", PRESENTED);
    expect(result.status).toBe("unreachable");
    expect(result.presented).toBeNull();
    expect(result.error).toContain("Received disconnect");
  });

  it("asks again for any key type when the server has none of the trusted ones", async () => {
    // ssh says nothing about why under LogLevel=ERROR; waiting for its words called the host
    // unreachable, and the connect failed with no reason instead of showing the new key.
    const rsa = await generateKey("rsa", "rsa");
    const result = await check("other-types", PRESENTED, `${rsa.type} ${rsa.key}`);
    expect(result.status).toBe("untrusted");
    expect(result.presented?.type).toBe("ssh-rsa");
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]).toContain("HostKeyAlgorithms=ssh-ed25519");
    expect(result.calls[1]).not.toContain("HostKeyAlgorithms");
  });

  it("reports an unreachable host with ssh's message, sanitised", async () => {
    const result = await check("refused", PRESENTED);
    expect(result.status).toBe("unreachable");
    expect(result.error).toContain("Connection refused");
    expect(result.error).not.toContain("\x1b");
    // It never reached a server, so asking for other key types would only wait twice as long.
    expect(result.calls).toHaveLength(1);
  });
});
