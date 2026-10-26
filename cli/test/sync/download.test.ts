import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { downloadMutagen, ensureMutagenInstalled, getMutagenPath, getMutagenAgentPath } from "../../src/sync/download";

let dataHome: string;
const previousXdg = process.env["XDG_DATA_HOME"];
const realFetch = globalThis.fetch;
let requested: string[] = [];

beforeEach(() => {
  dataHome = mkdtempSync(`${tmpdir()}/haven-download-`);
  process.env["XDG_DATA_HOME"] = dataHome;
  requested = [];
  // A download that is not the pinned release: what a swapped or corrupted asset looks like.
  globalThis.fetch = (async (url: string | URL | Request) => {
    requested.push(String(url));
    return new Response("not the mutagen release", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousXdg === undefined) delete process.env["XDG_DATA_HOME"];
  else process.env["XDG_DATA_HOME"] = previousXdg;
  rmSync(dataHome, { recursive: true, force: true });
});

describe("mutagen download verification (H-3)", () => {
  it("refuses an archive whose SHA-256 is not the pinned one and installs nothing", async () => {
    await expect(downloadMutagen()).rejects.toThrow(/failed verification/);

    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain("/releases/download/v0.17.6/");
    expect(existsSync(getMutagenPath())).toBe(false);
    expect(existsSync(getMutagenAgentPath())).toBe(false);
    // The staging directory is cleaned up too.
    expect(readdirSync(`${dataHome}/haven/mutagen/bin`)).toEqual([]);
  });

  it("does not run a planted binary that fails the pinned hash", async () => {
    mkdirSync(`${dataHome}/haven/mutagen/bin`, { recursive: true });
    writeFileSync(getMutagenPath(), "#!/bin/sh\necho planted\n", { mode: 0o755 });
    writeFileSync(getMutagenAgentPath(), "agents");

    // It is reinstalled from the release instead, and that download is verified in turn.
    await expect(ensureMutagenInstalled()).rejects.toThrow(/failed verification/);
    expect(requested).toHaveLength(1);
  });
});
