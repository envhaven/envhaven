// Runtime readers for the console's first-party browser assets. The model is
// executed whole, exactly as the classic script is loaded in terminal.html; tests never
// tokenize or detach private declarations from the predictor modules.
import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT } from './config';

function runtimeAsset<Name extends string, Factory extends string | null>(name: Name, factory: Factory) {
  let content: string | undefined;
  return {
    name,
    factory,
    source: () => (content ??= readFileSync(join(REPO_ROOT, 'console/ui/assets', name), 'utf8')),
  };
}

const modelAsset = runtimeAsset('eh-model.js', 'EnvHavenConsoleModel');
let runtime: ConsoleModel | undefined;

export const BROWSER_RUNTIME_ASSETS = [
  modelAsset,
  runtimeAsset('eh-predict-input.js', 'EnvHavenConsoleInput'),
  runtimeAsset('eh-predict-layout.js', 'EnvHavenConsoleLayout'),
  runtimeAsset('eh-predict-navigation.js', 'EnvHavenConsoleNavigation'),
  runtimeAsset('eh-predict-actions.js', 'EnvHavenConsoleActions'),
  runtimeAsset('eh-predict-style.js', 'EnvHavenConsoleStyle'),
  runtimeAsset('eh-predict-renderer.js', 'EnvHavenConsoleRenderer'),
  runtimeAsset('eh-predict-reconcile.js', 'EnvHavenConsoleReconcile'),
  runtimeAsset('eh-predict-session.js', 'EnvHavenConsoleSession'),
  runtimeAsset('eh-status.js', 'EnvHavenConsoleStatus'),
  runtimeAsset('eh-auth.js', 'EnvHavenConsoleAuth'),
  runtimeAsset('eh-clipboard.js', 'EnvHavenConsoleClipboard'),
  runtimeAsset('eh-transport.js', 'EnvHavenConsoleTransport'),
  runtimeAsset('eh-predictor.js', 'EnvHavenConsolePredictor'),
  runtimeAsset('eh-engine.js', null),
] as const;

export interface SeedRow {
  pad: number;
  indent: number;
  pull: boolean;
  down: boolean | null;
  prompt: string | null;
  lazy?: boolean;
  spacePull?: boolean;
  coldFg?: string;
}

export interface Seed extends SeedRow {
  lazy: boolean;
  spacePull: boolean;
}

export interface WordRule {
  word?: RegExp;
  punct?: boolean;
  join?: boolean;
  fwd?: 'next' | 'end';
  delim?: RegExp;
}

export interface WordScan {
  cls: number;
  one: boolean;
  phase: number;
  landed: boolean;
}

export interface GeometryView {
  cols(): number;
  rows(): number;
  baseY(): number;
  paneTop?(): number;
  paneBottom(): number;
  paneLeft?(): number;
  paneRight?(): number;
  row(index: number): string | null;
}

export interface Geometry {
  rowIsFull(row: string): boolean;
  isFrameRow(row: string | null): boolean;
  boxTop(row: number): number;
  frameEnd(row: number): number;
  paneTop(): number;
  paneBottom(): number;
  paneLeft(): number;
  paneRight(): number;
  paneWidth(): number;
  rowWithinPane(row: number): boolean;
  colWithinPane(col: number): boolean;
  rowsThroughPane(row: number): number;
  roomBelow(end: number): boolean;
}

export interface PredictFrame {
  version: 1 | 4;
  safe: boolean;
  top: number;
  bottom: number;
  left: number;
  right: number;
  app: string;
}

export interface PredictorState {
  safe: boolean;
  localDisarm: boolean;
  app: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type PredictorEvent =
  | { type: 'gate'; safe: boolean; app: string; top: number; bottom: number; left: number; right: number }
  | { type: 'submit' | 'disconnect' | 'resize' }
  | { type: 'reset'; reason: string };

export type PredictorEffect =
  | { type: 'geometry'; top: number; bottom: number; left: number; right: number }
  | { type: 'reset'; reason: string }
  | { type: 'app'; previous: string; app: string }
  | { type: 'disconnect' | 'resize' };

export interface PredictorTransition {
  state: PredictorState;
  effects: PredictorEffect[];
}

export type TransportPhase = 'disconnected' | 'connecting' | 'awaiting-frame' | 'ready';

export interface TransportState { phase: TransportPhase; gateRequired: boolean; canPredict: boolean }

export type TransportEvent =
  | { type: 'connect' | 'data' | 'gate' | 'socket-close' }
  | { type: 'socket-open'; gateRequired?: boolean }
  | { type: 'input'; data: string };

export type TransportEffect =
  | { type: 'send-input' | 'predict-input'; data: string }
  | { type: 'refuse-input'; phase: Exclude<TransportPhase, 'ready'> };

export interface TransportTransition {
  state: TransportState;
  effects: TransportEffect[];
}

export interface ProbeTraceEntry {
  sequence: number;
  at: number;
  text: string;
}

export interface ProbeTrace {
  sequence: number;
  deaths: number;
  entries: ProbeTraceEntry[];
}

export interface ProbeTraceMark {
  sequence: number;
  deaths: number;
}

const BURST_DEATH = /\breset (content-deadline|wrap-deadline|move-mismatch)\b/;
const traceLine = (entry: ProbeTraceEntry) => `${entry.text} @${entry.at}`;

/** Burst deaths after a mark, including a synthetic failure when the bounded ring lost details. */
export function burstDeathLinesSince(trace: ProbeTrace, mark: ProbeTraceMark): string[] {
  const deathDelta = trace.deaths - mark.deaths;
  if (trace.sequence < mark.sequence || deathDelta < 0) {
    return ['reset trace-counter-regressed (the page trace restarted after its watermark)'];
  }

  const retained = trace.entries
    .filter((entry) => entry.sequence > mark.sequence && BURST_DEATH.test(entry.text))
    .map(traceLine);
  if (retained.length > deathDelta) {
    return [`reset trace-counter-mismatch (${retained.length} retained, counter advanced ${deathDelta})`, ...retained];
  }

  const missing = deathDelta - retained.length;
  if (missing > 0) {
    retained.unshift(...Array.from(
      { length: missing },
      (_, index) => `reset trace-truncated (burst death ${index + 1} of ${missing} was evicted from the ring)`,
    ));
  }
  return retained;
}

export interface ConsoleModel {
  FRAME: { data: number; resize: number; predictV1: number; predictV4: number };
  predictQuery: '&echo=1&echoProtocol=4';
  decodePredictFrame(bytes: Uint8Array, decode: (bytes: Uint8Array) => string): PredictFrame | null;
  reducePredictorLifecycle(state: PredictorState, event: PredictorEvent): PredictorTransition;
  transportState(phase?: TransportPhase): TransportState;
  reduceTransport(state: TransportState, event: TransportEvent): TransportTransition;
  isLetter(char: string): boolean;
  wordRuleName(app: string): string;
  wordRule(app: string): WordRule;
  wordApps(): Record<string, string>;
  wordClass(rule: WordRule, text: string, index: number): number;
  wordScan(): WordScan;
  wordLeft(rule: WordRule, text: string, index: number, floor: number, scan: WordScan): number;
  seamJoins(rule: WordRule, separator: string, scan: WordScan): boolean;
  wordRight(rule: WordRule, text: string, index: number, max: number, scan: WordScan): number;
  RIDE_PAD: number;
  tuiRow(app: string): SeedRow | null;
  seedStyle(app: string, cols: number): {
    atLen: number;
    indent: number;
    pull: boolean;
    down: boolean | null;
    lazy: boolean;
    spacePull: boolean;
    flipped: boolean;
  } | null;
  seedPrompt(app: string): string | null;
  learnedWrapDown(app: string, delta: number): boolean;
  tuiTable(): Record<string, Seed>;
  promptShaped(prompt: string): boolean;
  borderSkip(row: string): number;
  textStart(row: string): number;
  textEnd(row: string): number;
  createGeometry(view: GeometryView): Geometry;
}

/** Execute the complete shipped model asset and return its public API. */
export function consoleModel(): ConsoleModel {
  if (runtime) return runtime;
  runtime = new Function(`${modelAsset.source()}\nreturn EnvHavenConsoleModel;`)() as ConsoleModel;
  if (!runtime || typeof runtime.createGeometry !== 'function') {
    throw new Error('console/ui/assets/eh-model.js did not expose EnvHavenConsoleModel');
  }
  return runtime;
}

export function tuiTable(): Record<string, Seed> {
  return consoleModel().tuiTable();
}

export function wordApps(): Record<string, string> {
  return consoleModel().wordApps();
}
