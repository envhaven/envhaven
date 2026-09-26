// The applications the console harness can put in a pane: one row per application, with
// the per-check facts each check reads off its row, so "where is this tool tested" has
// one answer. A check derives its roster with appsWith('<fact>'); the seeded set (the
// model's wrap table) and the word-rule set (its WORD_APPS) are read from the model
// and held to these rows by test-console-ui.ts, which CI runs with no container.
//
// Playwright-free on purpose: console-rig.ts imports chromium at runtime, and that CI run
// has no bun install, so the registry the static check loads cannot live beside the rig.

import { tuiTable, wordApps } from './engine';

/** Replaced with this run's validated fixture directory immediately before launch. */
const FIXTURE_DIR = '__ENVHAVEN_CONSOLE_FIXTURES__';

// A well-formed but invalid key: the composer draws before the key is checked, and no
// check submits a message.
const FAKE_ANTHROPIC_KEY = 'sk-ant-api03-fake0000000000';

export interface AppSpec {
  /** Shell command that takes the pane. */
  command: string;
  /** What `probe.app` reads once it has the pane. */
  paneApp: string;
  /** Budget for a cold start to draw its composer. */
  bootMs: number;
  /**
   * How long after taking the pane before the first frame can be trusted.
   *
   * A column in the table rather than a branch in launchApp. This started life as a
   * ternary on one application's name, which is exactly the kind of fact that belongs
   * beside the others it describes and cannot be found by anyone reading the table.
   */
  settleMs: number;
  /** The key that makes it leave the pane when two interrupts do not (pi: ^D). */
  leave?: string;
  /**
   * It has a row in the model's wrap table, so seedwrap and wrapkeep drive it. The
   * numbers come from the model; this only says the app is on their roster, and
   * test-console-ui.ts fails when the two disagree.
   */
  seed?: true;
  /**
   * keys-editing-composer drives it, holding Home and the kill to the column its EMPTY
   * composer keeps the cursor at; the number here only sanity-checks that its chrome
   * still puts the cursor there. 'moves' for a composer whose chrome shifts with the
   * width (opencode centres its splash box).
   */
  floor?: number | 'moves';
  /** draftink drives it: the comment on the row says what its draft colour tests. */
  ink?: true;
  /** keys-words drives it: it has a rule in the model's WORD_APPS. */
  words?: true;
  /** keys-ghost drives it: its empty composer shows a placeholder. */
  ghost?: true;
  /** keys-trailing drives it. */
  trailing?: true;
}

/**
 * The rows, in the order the sweeps drive them. The shell is on no row: the checks that
 * include it (draftink, keys-trailing, seedwrap) put a `null` first, since there is nothing
 * to launch and its composer is the pane's own prompt.
 *
 * Most composer apps are launched with a FAKE key for the same reason claude is: the
 * composer is a local line editor and draws before any credential is checked. Muse uses
 * its local echo provider instead. The checks never submit. What these launch settings
 * do NOT replace is each app's first-run state, which lives in the container's home
 * and has to exist once: measured on a fresh envhaven:dev container, claude asks to trust
 * the folder and then to confirm the key, codex shows its sign-in menu until
 * ~/.codex/auth.json exists and then asks to trust the directory, agy runs a
 * theme-and-terms wizard, grok opens its device-code sign-in, Kimi asks to trust the
 * folder before using its documented ephemeral KIMI_MODEL_* provider below. Muse's
 * built-in echo provider opens a local composer without credentials. fx opens straight
 * on the composer.
 * A check that finds no composer reports the app as skipped.
 *
 * The four mimics are here because the real CLIs cannot be held in the states some checks
 * need: a controlled background, a self-drawn caret, a parked cursor that never moves.
 * They report as `python3`, since that is the process holding the pane, and the engine has
 * no row for them, so they also exercise the unlearned path.
 */
const rows = {
  // Drafts in the default foreground. The `Try "…"` placeholder it used to open with
  // is gone in the current build (v2.1 redraws the empty composer bare, at least in
  // bypass mode), so it is off the ghost roster, and ghostcover and staletail drive the
  // ghostmimic row below instead.
  claude: {
    command: `ANTHROPIC_API_KEY=${FAKE_ANTHROPIC_KEY} claude`, paneApp: 'claude', bootMs: 60000, settleMs: 3000,
    seed: true, floor: 2, ink: true, words: true, trailing: true,
  },
  // No key: codex reads only CODEX_API_KEY and its gate is ~/.codex/auth.json, which the
  // first-run note above covers. A PANELLED composer (bg-237 edge to edge) whose
  // placeholder is also dim: the fill blanks carry the draft's white, and counting only
  // inked runs picked the placeholder's translucent grey for the first keystroke.
  codex: {
    command: 'codex', paneApp: 'codex', bootMs: 60000, settleMs: 2500,
    seed: true, floor: 2, ink: true, words: true, ghost: true, trailing: true,
  },
  // Drafts in the default foreground per its seed row; on the ink roster so the sweep's
  // own `draft:` line is not the only place that claim is ever checked.
  agy: {
    command: 'GEMINI_API_KEY=AIza-fake agy', paneApp: 'agy', bootMs: 60000, settleMs: 2500,
    seed: true, floor: 2, ink: true,
  },
  // Fills its box interior in fg-254, which is its draft colour, one palette step off its
  // prompt's fg-251: the fill, not the prompt, has to answer. Its draft opens at column 6,
  // behind the box side, a gutter and the prompt.
  grok: {
    command: 'XAI_API_KEY=xai-fake grok', paneApp: 'grok', bootMs: 60000, settleMs: 2500,
    seed: true, floor: 6, ink: true,
  },
  // Kimi does not read ordinary provider keys from the process environment. Its documented
  // KIMI_MODEL_* override creates an in-memory provider without writing config or contacting
  // the API before the composer draws; the harness never submits the fake key.
  kimi: {
    command: 'KIMI_MODEL_NAME=kimi-for-coding KIMI_MODEL_API_KEY=sk-fake KIMI_CODE_NO_AUTO_UPDATE=1 kimi',
    paneApp: 'kimi-code', bootMs: 60000, settleMs: 2500,
    seed: true, floor: 5, ink: true, words: true, trailing: true,
  },
  // The built-in echo provider is local and needs no credential. --trust-workspace avoids
  // first-run policy chrome; no check submits the draft, so the provider never answers.
  // Drafts use fixed ANSI 252, and the empty composer starts after `❯ `.
  muse: {
    command: 'MUSE_NO_AUTO_UPDATE=1 muse --provider echo --trust-workspace',
    paneApp: 'muse', bootMs: 60000, settleMs: 2500,
    seed: true, floor: 2, ink: true, words: true, trailing: true,
  },
  // No prompt at all: the draft opens at column 0. Measured on 0.84.3: two ^C leave pi on
  // its composer; ^D exits it. Default-foreground draft per its seed row.
  pi: {
    command: 'ANTHROPIC_API_KEY=sk-fake pi', paneApp: 'pi', bootMs: 60000, settleMs: 2500, leave: 'Control+d',
    seed: true, floor: 0, ink: true, words: true, trailing: true,
  },
  // Measured on 0.0.6: with a key in the environment fx opens straight on its composer;
  // with none it adds a sign-in panel above it, which the first keystroke dismisses. The
  // key keeps the frame the checks read identical on every run. A left-bordered composer
  // that drafts in the default foreground: the only ink on an empty row is its border
  // glyph, so the first keystroke has nothing but chrome to read a colour from, and the
  // theme's colour has to win over the bar's. Its draft opens behind the border alone.
  fx: {
    command: 'AI_GATEWAY_API_KEY=vck_fake fx', paneApp: 'fx', bootMs: 60000, settleMs: 2500,
    seed: true, floor: 2, ink: true, words: true, trailing: true,
  },
  // A plain line editor behind `> `; default-foreground draft per its seed row.
  // Unconfigured goose EXITS at launch ("No provider configured"), so the row
  // carries a stub provider: the composer draws before the key is checked, same
  // bargain as the rest of the roster.
  goose: {
    command: 'GOOSE_PROVIDER=anthropic GOOSE_MODEL=claude-sonnet-4-5 ANTHROPIC_API_KEY=sk-fake goose',
    paneApp: 'goose', bootMs: 60000, settleMs: 2500,
    seed: true, floor: 2, ink: true,
  },
  // Unseeded on purpose (see NO_ROW in measure-tui.ts): here so the checks can still drive
  // its intro box, which opens with no provider configured at all. Its splash box draws
  // several seconds before it takes input (measured: a draft typed 4s after the process
  // took the pane never landed, one typed 12s after did), and that box is centred, so its
  // floor moves with the terminal's width.
  opencode: {
    command: 'opencode', paneApp: 'opencode', bootMs: 60000, settleMs: 9000,
    floor: 'moves', words: true, ghost: true, trailing: true,
  },
  composer: { command: `python3 ${FIXTURE_DIR}/composer.py`, paneApp: 'python3', bootMs: 20000, settleMs: 2500 },
  // The same mimic with its placeholder drawn (GHOST=1): the live driver for the
  // ghost checks, now that no logged-in app on the roster shows one (claude's
  // `Try "…"` is gone in the current build, at least in bypass mode). It keeps the styling
  // measured on claude, the first placeholder dim and every later one palette grey, so
  // ghostcover photographs both.
  ghostmimic: { command: `GHOST=1 python3 ${FIXTURE_DIR}/composer.py`, paneApp: 'python3', bootMs: 20000, settleMs: 2500 },
  // Its own background (236) under its own foreground (80): a predictor that paints the
  // theme's colour is visibly wrong there, and the row's ink has to answer instead.
  boxcomposer: {
    command: `python3 ${FIXTURE_DIR}/boxcomposer.py`, paneApp: 'python3', bootMs: 20000, settleMs: 2500,
    ink: true,
  },
  // Draws its own caret, so the cell UNDER the cursor is inverse and its foreground is a
  // background. The learner reads the cell behind the cursor precisely to miss it.
  invcomposer: {
    command: `python3 ${FIXTURE_DIR}/invcomposer.py`, paneApp: 'python3', bootMs: 20000, settleMs: 2500,
    ink: true,
  },
  blinkmimic: { command: `python3 ${FIXTURE_DIR}/blinkmimic.py`, paneApp: 'python3', bootMs: 20000, settleMs: 2500 },
} satisfies Record<string, AppSpec>;

export type AppName = keyof typeof rows;

/** The rows under their contract: one type for every reader, so no use site casts. */
export const APPS: Record<AppName, AppSpec> = rows;

/** Resolve a mimic's fixture path; ordinary application commands pass through unchanged. */
export function appCommand(spec: AppSpec, fixtureDir?: string): string {
  if (!spec.command.includes(FIXTURE_DIR)) return spec.command;
  if (!fixtureDir || !/^\/tmp\/eh-fixtures-[0-9a-z-]+$/.test(fixtureDir)) {
    throw new Error(`mimic command has no valid run-scoped fixture directory: ${JSON.stringify(fixtureDir)}`);
  }
  return spec.command.replaceAll(FIXTURE_DIR, fixtureDir);
}

/** The applications whose row carries `fact`, in roster order. */
export function appsWith(fact: keyof AppSpec): AppName[] {
  return (Object.keys(APPS) as AppName[]).filter((a) => APPS[a][fact] !== undefined);
}

/**
 * Where the harness rows and model disagree: a wrap row or word rule no row drives (a row
 * that rots), or a row claiming one the model lacks (a check that skips forever). Empty
 * when they agree. Asked by test-console-ui.ts in CI with no container, and by the echo
 * harness before it opens a browser.
 */
export function rosterDrift(): string[] {
  // Model tables are keyed by the process tmux reports, which can differ from the
  // command users launch (Kimi's `kimi` executable reports `kimi-code`).
  const paneApps = (fact: keyof AppSpec) => appsWith(fact).map((a) => APPS[a].paneApp);
  const seeded = new Set<string>(paneApps('seed'));
  const ruled = new Set<string>(paneApps('words'));
  const table = tuiTable();
  const rules = wordApps();
  return [
    ...Object.keys(table).filter((a) => a !== 'zsh' && !seeded.has(a))
      .map((a) => `${a} has a model wrap row and no app row marked seed`),
    ...[...seeded].filter((a) => !table[a]).map((a) => `${a} is marked seed and the model has no wrap row for it`),
    ...Object.keys(rules).filter((a) => a !== 'zsh' && !ruled.has(a))
      .map((a) => `${a} has a model word rule and no app row marked words`),
    ...[...ruled].filter((a) => !rules[a]).map((a) => `${a} is marked words and the model has no rule for it`),
  ];
}
