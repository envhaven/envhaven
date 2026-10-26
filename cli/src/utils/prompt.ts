import { createInterface, type Interface } from "readline";

// One line reader for the whole process, shared by every question. A readline interface per
// question lost answers twice over: each one buffers more of piped input than the line it uses,
// so `printf 'y\nn\n' | haven connect` answered the first question and dropped the second, and in
// Bun 1.3 a new interface on a stdin that has already ended never settles and spins a core.
//
// Once input ends (Ctrl-D, a pipe that ran dry, </dev/null), this and every later question takes
// its default, which for every trust question in the CLI is no. The reader is paused between
// questions, so it neither consumes input meant for something else nor keeps the process alive.

interface Reader {
  rl: Interface;
  lines: string[];
  waiting: ((line: string | null) => void) | null;
  ended: boolean;
}

let reader: Reader | null = null;

function input(): Reader {
  if (reader) return reader;

  // terminal: false leaves line editing, echo and Ctrl-C to the terminal itself.
  const rl = createInterface({ input: process.stdin, terminal: false });
  const state: Reader = { rl, lines: [], waiting: null, ended: false };

  rl.on("line", (line) => {
    const waiting = state.waiting;
    state.waiting = null;
    if (waiting) waiting(line);
    else state.lines.push(line);
  });
  rl.on("close", () => {
    state.ended = true;
    const waiting = state.waiting;
    state.waiting = null;
    waiting?.(null);
  });

  reader = state;
  return state;
}

function nextLine(): Promise<string | null> {
  const r = input();
  const queued = r.lines.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (r.ended) return Promise.resolve(null);

  r.rl.resume();
  return new Promise((resolve) => {
    r.waiting = (line) => {
      r.rl.pause();
      resolve(line);
    };
  });
}

// The line typed, or null when input ended before one came.
async function readAnswer(question: string): Promise<string | null> {
  process.stdout.write(`${question}: `);
  const line = await nextLine();
  if (line === null) process.stdout.write("\n");
  return line;
}

export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return ((await readAnswer(`${question}${suffix}`)) ?? "").trim() || defaultValue || "";
}

// confirm, or null when input ended before an answer came. The default still applies then, but
// it is nobody's choice, so a caller that remembers answers does not remember that one.
export async function ask(question: string, defaultAnswer: "y" | "n"): Promise<boolean | null> {
  const line = await readAnswer(`${question} ${defaultAnswer === "y" ? "[Y/n]" : "[y/N]"}`);
  if (line === null) return null;
  const answer = line.trim().toLowerCase();
  if (answer === "") return defaultAnswer === "y";
  if (defaultAnswer === "y") return answer !== "n" && answer !== "no";
  return answer === "y" || answer === "yes";
}

export async function confirm(question: string, defaultAnswer: "y" | "n"): Promise<boolean> {
  return (await ask(question, defaultAnswer)) ?? defaultAnswer === "y";
}
