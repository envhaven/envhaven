import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Each case runs in a process of its own, since the point is what happens when that process ends.
describe("cleanupOnExit", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(`${tmpdir()}/haven-exit-`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(
    body: string,
    signal?: NodeJS.Signals,
  ): Promise<{ exitCode: number | null; signalCode: string | null; cleaned: boolean }> {
    const marker = join(dir, "cleaned");
    const code = `
      import { writeFileSync } from "fs";
      import { cleanupOnExit } from ${JSON.stringify(join(import.meta.dir, "../../src/utils/exit"))};
      const stop = cleanupOnExit(() => writeFileSync(${JSON.stringify(marker)}, ""));
      console.log("ready");
      ${body}
    `;
    const proc = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    if (signal) {
      const reader = proc.stdout.getReader();
      await reader.read();
      proc.kill(signal);
    }
    await proc.exited;
    return { exitCode: proc.exitCode, signalCode: proc.signalCode, cleaned: existsSync(marker) };
  }

  it("cleans up on Ctrl-C, a closed terminal and a kill, then dies of the signal", async () => {
    // Dying of SIGINT, not exiting with 130, is what makes a shell stop a loop around the command.
    for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"] as const) {
      rmSync(join(dir, "cleaned"), { force: true });
      expect(await run("await Bun.sleep(30_000);", signal)).toEqual({ exitCode: null, signalCode: signal, cleaned: true });
    }
  });

  it("cleans up on process.exit and on a throw", async () => {
    expect(await run("process.exit(1);")).toEqual({ exitCode: 1, signalCode: null, cleaned: true });
    rmSync(join(dir, "cleaned"), { force: true });
    expect(await run("throw new Error('boom');")).toEqual({ exitCode: 1, signalCode: null, cleaned: true });
  });

  it("does nothing once stopped, and the signals go back to ending the process", async () => {
    expect(await run("stop(); process.exit(0);")).toEqual({ exitCode: 0, signalCode: null, cleaned: false });
    expect(await run("stop(); await Bun.sleep(30_000);", "SIGINT")).toEqual({ exitCode: null, signalCode: "SIGINT", cleaned: false });
  });
});
