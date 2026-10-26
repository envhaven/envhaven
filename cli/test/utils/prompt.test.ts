import { describe, it, expect } from "bun:test";
import { join } from "path";

// The questions `haven connect` can ask in one run, with work between them as there is there, fed
// from piped input. Each case runs in its own process: the reader is per process, and a hang
// shows up as the time limit killing it.
const SCRIPT = `
import { prompt, confirm } from ${JSON.stringify(join(import.meta.dir, "../../src/utils/prompt"))};
const trust = await confirm("Trust this host and connect?", "n");
await Bun.sleep(50);
const envFiles = await confirm("Sync .env files?", "n");
await Bun.sleep(50);
const gitignore = await confirm("Found .gitignore. Exclude matching files from sync?", "y");
const enter = await prompt("Press Enter when ready...");
console.log("RESULT " + JSON.stringify({ trust, envFiles, gitignore, enter }));
`;

async function answers(input: string): Promise<Record<string, unknown>> {
  const proc = Bun.spawn([process.execPath, "-e", SCRIPT], {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(proc.signalCode).toBeNull();
  // Piped answers are not echoed, so the result can share a line with the last question.
  const at = stdout.lastIndexOf("RESULT ");
  if (at === -1) throw new Error(`no result; stdout: ${JSON.stringify(stdout)} stderr: ${stderr}`);
  return JSON.parse(stdout.slice(at + "RESULT ".length).split("\n")[0]!);
}

describe("prompt (one reader per process)", () => {
  it("answers the first question and gives every later one its default when input runs out", async () => {
    expect(await answers("y\n")).toEqual({ trust: true, envFiles: false, gitignore: true, enter: "" });
  });

  it("answers each question from piped lines in order, losing none", async () => {
    expect(await answers("y\nyes\nn\nready\n")).toEqual({ trust: true, envFiles: true, gitignore: false, enter: "ready" });
  });

  it("takes every default when there is no input at all", async () => {
    expect(await answers("")).toEqual({ trust: false, envFiles: false, gitignore: true, enter: "" });
  });

  it("treats anything but yes as no on a question that defaults to no", async () => {
    expect(await answers("sure\n\n")).toEqual({ trust: false, envFiles: false, gitignore: true, enter: "" });
  });
});

describe("ask", () => {
  it("tells an answer, Enter for the default included, from input that ended", async () => {
    const script = `
      import { ask } from ${JSON.stringify(join(import.meta.dir, "../../src/utils/prompt"))};
      const first = await ask("Sync .env files?", "n");
      const second = await ask("Found .gitignore. Exclude matching files from sync?", "y");
      console.log("RESULT " + JSON.stringify({ first, second }));
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], { stdin: new Blob(["\n"]), stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const at = stdout.lastIndexOf("RESULT ");
    expect(at).not.toBe(-1);
    expect(JSON.parse(stdout.slice(at + "RESULT ".length).split("\n")[0]!)).toEqual({ first: false, second: null });
  });
});
