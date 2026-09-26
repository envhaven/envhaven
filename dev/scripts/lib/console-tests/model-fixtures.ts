import { readFileSync } from 'fs';
import { join } from 'path';
import { appsWith, rosterDrift } from '../console-apps';
import { REPO_ROOT } from '../config';
import { consoleModel } from '../engine';
import {
  array,
  boolean,
  exact,
  integer,
  object,
  optionalInteger,
  rowIndex,
  string,
} from './fixtures';
import type { TestReporter } from './types';

interface PredictFrameCase {
  name: string;
  protocol: 1 | 4;
  paneSafe: boolean;
  safe: boolean;
  top: number;
  bottom: number;
  left: number;
  right: number;
  geometry: boolean;
  decodedTop: number;
  decodedBottom: number;
  decodedLeft: number;
  decodedRight: number;
  app: string;
  bytes: number[];
}

interface RowCase {
  app: string;
  row: string;
  text: string;
  frame: boolean;
  start?: number;
  end?: number;
}

interface PaneCase {
  app: string;
  cursorRow: number;
  boxTop: number;
  frameEnd: number;
  roomBelow: boolean;
  grows: string;
  why: string;
  grid: string[];
}

interface SplitCase {
  name: string;
  top: number;
  height: number;
  bottom: number;
  left: number;
  right: number;
  insideCol: number;
  outsideCol: number;
  frameEnd: number;
  wrapRow: number;
  canDrop: boolean;
  roomBelow: boolean;
}

interface WordCase {
  app: string;
  draft: string;
  floor: number;
  back: number[];
  fwd: number[];
  kill: number;
  wide?: boolean;
}

const PREDICT_FRAME_CASES = [
  'v1 conservative shell',
  'v4 lower split composer',
  'v4 right split shell',
] as const;
const ROW_CASES = [
  'claude/continuation', 'claude/first', 'claude/hint', 'claude/rule-above', 'claude/rule-below',
  'grok/continuation', 'grok/first', 'grok/frame-bottom-labelled', 'grok/frame-top', 'grok/hint',
  'opencode/bar-only', 'opencode/continuation', 'opencode/frame-bottom', 'opencode/hint',
  'zsh/continuation', 'zsh/full-to-edge',
] as const;
const MEASURED_ROW_CASES = [
  'claude/continuation', 'grok/continuation', 'opencode/continuation',
  'zsh/continuation', 'zsh/full-to-edge',
] as const;
const PANE_CASES = ['claude/up', 'codex/down'] as const;
const SPLIT_CASES = [
  'upper split has room', 'upper split is pinned',
  'lower split has room', 'lower split is pinned',
  'left split column edge', 'right split column start',
] as const;
const WORD_APPS = ['claude', 'codex', 'fx', 'kimi-code', 'muse', 'opencode', 'pi', 'zsh'] as const;
const WORD_DRAFTS = [
  '#aa bb', '$aa bb', 'aa bb', 'aa  bb', 'aa.bb', 'aa..bb', 'aa/bb', 'aa-bb', 'aa_bb',
  "aa'bb", 'aa"bb"', '(aa)', 'aa=bb', 'aa,bb', 'aa:bb', 'aa;bb', 'aa!bb', 'aa?bb',
  'aa@bb', '~/aa bb', 'aa+bb', 'aa*bb', 'aa&bb', 'aa|bb', '<aa> bb', '[aa] bb', '{aa} bb',
  'aa. bb', 'aa .bb', 'aa1 22', '3.14 xx', '1,000 xx', 'café où', '日本語 xx', 'aa--bb',
  'aa//bb', 'aa (bb)',
] as const;

function parsePredictFrameFixture(value: unknown): PredictFrameCase[] {
  const cases = array(value, 'predictive frame fixture').map((value, index): PredictFrameCase => {
    const row = object(value, `predictive frame fixture[${index}]`);
    const protocol = integer(row.protocol, `predictive frame fixture[${index}].protocol`);
    if (protocol !== 1 && protocol !== 4) {
      throw new Error(`predictive frame fixture[${index}].protocol must be 1 or 4`);
    }
    const top = integer(row.top, `predictive frame fixture[${index}].top`);
    const bottom = integer(row.bottom, `predictive frame fixture[${index}].bottom`);
    const left = integer(row.left, `predictive frame fixture[${index}].left`);
    const right = integer(row.right, `predictive frame fixture[${index}].right`);
    const decodedTop = integer(row.decodedTop, `predictive frame fixture[${index}].decodedTop`);
    const decodedBottom = integer(row.decodedBottom, `predictive frame fixture[${index}].decodedBottom`);
    const decodedLeft = integer(row.decodedLeft, `predictive frame fixture[${index}].decodedLeft`);
    const decodedRight = integer(row.decodedRight, `predictive frame fixture[${index}].decodedRight`);
    const geometry = [top, bottom, left, right, decodedTop, decodedBottom, decodedLeft, decodedRight];
    if (geometry.some((part) => part > 65535)) {
      throw new Error(`predictive frame fixture[${index}] geometry is out of range`);
    }
    const bytes = array(row.bytes, `predictive frame fixture[${index}].bytes`)
      .map((byte, byteIndex) => integer(byte, `predictive frame fixture[${index}].bytes[${byteIndex}]`));
    if (bytes.some((byte) => byte > 255)) {
      throw new Error(`predictive frame fixture[${index}].bytes must contain only bytes`);
    }
    const invalidGeometry =
      (protocol === 1 && (decodedTop !== 0 || decodedBottom !== 0 || decodedLeft !== 0 || decodedRight !== 0)) ||
      (protocol === 4 && (decodedTop !== top || decodedBottom !== bottom || decodedLeft !== left || decodedRight !== right));
    if (invalidGeometry) {
      throw new Error(`predictive frame fixture[${index}] has inconsistent geometry semantics`);
    }
    return {
      name: string(row.name, `predictive frame fixture[${index}].name`),
      protocol,
      paneSafe: boolean(row.paneSafe, `predictive frame fixture[${index}].paneSafe`),
      safe: boolean(row.safe, `predictive frame fixture[${index}].safe`),
      top, bottom, left, right,
      geometry: boolean(row.geometry, `predictive frame fixture[${index}].geometry`),
      decodedTop, decodedBottom, decodedLeft, decodedRight,
      app: string(row.app, `predictive frame fixture[${index}].app`),
      bytes,
    };
  });
  exact(cases.map((row) => row.name), PREDICT_FRAME_CASES, 'predictive frame fixture cases');
  return cases;
}

function parseRowFixture(value: unknown): { cols: number; cases: RowCase[] } {
  const root = object(value, 'composer row fixture');
  const cols = integer(root.cols, 'composer row fixture.cols');
  if (cols === 0) throw new Error('composer row fixture.cols must be positive');
  const cases = array(root.cases, 'composer row fixture.cases').map((value, index): RowCase => {
    const row = object(value, `composer row fixture.cases[${index}]`);
    const parsed = {
      app: string(row.app, `composer row fixture.cases[${index}].app`),
      row: string(row.row, `composer row fixture.cases[${index}].row`),
      text: string(row.text, `composer row fixture.cases[${index}].text`),
      frame: boolean(row.frame, `composer row fixture.cases[${index}].frame`),
      start: optionalInteger(row.start, `composer row fixture.cases[${index}].start`),
      end: optionalInteger(row.end, `composer row fixture.cases[${index}].end`),
    };
    if ((parsed.start ?? 0) > cols || (parsed.end ?? 0) > cols) {
      throw new Error(`composer row fixture.cases[${index}] has a column outside width ${cols}`);
    }
    if (parsed.text.length !== cols) {
      throw new Error(`composer row fixture.cases[${index}].text has ${parsed.text.length} characters, expected ${cols}`);
    }
    if (parsed.start !== undefined && parsed.end !== undefined && parsed.start > parsed.end) {
      throw new Error(`composer row fixture.cases[${index}] starts after it ends`);
    }
    return parsed;
  });
  exact(cases.map((row) => `${row.app}/${row.row}`), ROW_CASES, 'composer row fixture cases');
  for (const row of cases) {
    const name = `${row.app}/${row.row}`;
    if ((MEASURED_ROW_CASES as readonly string[]).includes(name) &&
        (row.start === undefined || row.end === undefined)) {
      throw new Error(`composer row fixture ${name} must retain its independently measured start and end`);
    }
  }
  return { cols, cases };
}

function parsePaneFixture(value: unknown): {
  cols: number;
  rows: number;
  panes: PaneCase[];
  splits: SplitCase[];
} {
  const root = object(value, 'composer pane fixture');
  const cols = integer(root.cols, 'composer pane fixture.cols');
  const rows = integer(root.rows, 'composer pane fixture.rows');
  if (cols === 0 || rows === 0) throw new Error('composer pane fixture dimensions must be positive');
  const panes = array(root.panes, 'composer pane fixture.panes').map((value, index): PaneCase => {
    const pane = object(value, `composer pane fixture.panes[${index}]`);
    const grid = array(pane.grid, `composer pane fixture.panes[${index}].grid`).map((row, rowNumber) => {
      if (typeof row !== 'string') {
        throw new Error(`composer pane fixture.panes[${index}].grid[${rowNumber}] must be a string`);
      }
      return row;
    });
    const parsed = {
      app: string(pane.app, `composer pane fixture.panes[${index}].app`),
      cursorRow: integer(pane.cursorRow, `composer pane fixture.panes[${index}].cursorRow`),
      boxTop: rowIndex(pane.boxTop, `composer pane fixture.panes[${index}].boxTop`),
      frameEnd: rowIndex(pane.frameEnd, `composer pane fixture.panes[${index}].frameEnd`),
      roomBelow: boolean(pane.roomBelow, `composer pane fixture.panes[${index}].roomBelow`),
      grows: string(pane.grows, `composer pane fixture.panes[${index}].grows`),
      why: string(pane.why, `composer pane fixture.panes[${index}].why`),
      grid,
    };
    if (grid.length !== rows) {
      throw new Error(`composer pane fixture.panes[${index}].grid has ${grid.length} rows, expected ${rows}`);
    }
    if (parsed.cursorRow >= rows || parsed.boxTop >= rows || parsed.frameEnd >= rows) {
      throw new Error(`composer pane fixture.panes[${index}] has geometry outside height ${rows}`);
    }
    if ((parsed.boxTop === -1) !== (parsed.frameEnd === -1)) {
      throw new Error(`composer pane fixture.panes[${index}] must have both frame bounds or neither`);
    }
    if (parsed.boxTop !== -1 &&
        !(parsed.boxTop <= parsed.cursorRow && parsed.cursorRow <= parsed.frameEnd)) {
      throw new Error(`composer pane fixture.panes[${index}] cursor is outside its frame`);
    }
    const expectedGrowth = parsed.roomBelow ? 'down' : 'up';
    if (parsed.grows !== expectedGrowth) {
      throw new Error(`composer pane fixture.panes[${index}] says roomBelow=${parsed.roomBelow} but grows=${parsed.grows}`);
    }
    return parsed;
  });
  const splits = array(root.splits, 'composer pane fixture.splits').map((value, index): SplitCase => {
    const split = object(value, `composer pane fixture.splits[${index}]`);
    const parsed = {
      name: string(split.name, `composer pane fixture.splits[${index}].name`),
      top: integer(split.top, `composer pane fixture.splits[${index}].top`),
      height: integer(split.height, `composer pane fixture.splits[${index}].height`),
      bottom: integer(split.bottom, `composer pane fixture.splits[${index}].bottom`),
      left: integer(split.left, `composer pane fixture.splits[${index}].left`),
      right: integer(split.right, `composer pane fixture.splits[${index}].right`),
      insideCol: integer(split.insideCol, `composer pane fixture.splits[${index}].insideCol`),
      outsideCol: integer(split.outsideCol, `composer pane fixture.splits[${index}].outsideCol`),
      frameEnd: integer(split.frameEnd, `composer pane fixture.splits[${index}].frameEnd`),
      wrapRow: integer(split.wrapRow, `composer pane fixture.splits[${index}].wrapRow`),
      canDrop: boolean(split.canDrop, `composer pane fixture.splits[${index}].canDrop`),
      roomBelow: boolean(split.roomBelow, `composer pane fixture.splits[${index}].roomBelow`),
    };
    if (parsed.bottom !== parsed.top + parsed.height || parsed.bottom > rows ||
        parsed.frameEnd >= rows || parsed.left >= parsed.right || parsed.right > cols) {
      throw new Error(`composer pane fixture.splits[${index}] has inconsistent geometry`);
    }
    if (parsed.roomBelow !== (parsed.frameEnd + 1 < parsed.bottom)) {
      throw new Error(`composer pane fixture.splits[${index}] has the wrong roomBelow verdict`);
    }
    if (parsed.canDrop !== (parsed.wrapRow + 1 < parsed.bottom)) {
      throw new Error(`composer pane fixture.splits[${index}] has the wrong canDrop verdict`);
    }
    return parsed;
  });
  exact(panes.map((pane) => `${pane.app}/${pane.grows}`), PANE_CASES, 'composer pane fixture cases');
  exact(panes.map((pane) => String(pane.roomBelow)), ['false', 'true'], 'composer pane roomBelow branches');
  exact(splits.map((split) => split.name), SPLIT_CASES, 'composer split fixture cases');
  return { cols, rows, panes, splits };
}

function pair(value: unknown, label: string): number[] {
  const values = array(value, label).map((item, index) => integer(item, `${label}[${index}]`));
  if (values.length !== 2) throw new Error(`${label} must contain exactly two columns`);
  return values;
}

function parseWordFixture(value: unknown): { cases: WordCase[] } {
  const model = consoleModel();
  const root = object(value, 'word rule fixture');
  const cases = array(root.cases, 'word rule fixture.cases').map((value, index): WordCase => {
    const row = object(value, `word rule fixture.cases[${index}]`);
    if (row.wide !== undefined && typeof row.wide !== 'boolean') {
      throw new Error(`word rule fixture.cases[${index}].wide must be a boolean`);
    }
    const parsed = {
      app: string(row.app, `word rule fixture.cases[${index}].app`),
      draft: string(row.draft, `word rule fixture.cases[${index}].draft`),
      floor: integer(row.floor, `word rule fixture.cases[${index}].floor`),
      back: pair(row.back, `word rule fixture.cases[${index}].back`),
      fwd: pair(row.fwd, `word rule fixture.cases[${index}].fwd`),
      kill: integer(row.kill, `word rule fixture.cases[${index}].kill`),
      wide: row.wide as boolean | undefined,
    };
    if (!parsed.wide) {
      const end = parsed.floor + parsed.draft.length;
      if ([...parsed.back, ...parsed.fwd, parsed.kill]
        .some((column) => column < parsed.floor || column > end)) {
        throw new Error(`word rule fixture.cases[${index}] has a movement outside its draft`);
      }
    }
    if (parsed.back[1]! > parsed.back[0]!) {
      throw new Error(`word rule fixture.cases[${index}].back must move left`);
    }
    if (parsed.fwd[1]! < parsed.fwd[0]!) {
      throw new Error(`word rule fixture.cases[${index}].fwd must move right`);
    }
    if (parsed.kill !== parsed.back[0]) {
      throw new Error(`word rule fixture.cases[${index}].kill must match its first word-left movement`);
    }
    return parsed;
  });
  exact([...new Set(cases.map((row) => row.app))], WORD_APPS, 'word rule fixture applications');
  exact(Object.keys(model.wordApps()), WORD_APPS, 'model word rule applications');
  for (const app of WORD_APPS) {
    const appCases = cases.filter((row) => row.app === app);
    const drafts = WORD_DRAFTS.filter((draft) => app !== 'opencode' || draft !== 'aa!bb');
    exact(appCases.map((row) => row.draft), [...drafts, 'aa bb'], `word rule fixture ${app} drafts`);
    exact(
      appCases.filter((row) => row.wide).map((row) => row.draft),
      ['日本語 xx'],
      `word rule fixture ${app} wide cases`,
    );
    if (new Set(appCases.map((row) => row.floor)).size !== 1) {
      throw new Error(`word rule fixture ${app} cases disagree on their empty-composer floor`);
    }
  }
  return { cases };
}

export function runModelFixtureTests(report: TestReporter): void {
  const { pass, fail } = report;
  const model = consoleModel();

  try {
    const fixture = parsePredictFrameFixture(JSON.parse(readFileSync(
      join(REPO_ROOT, 'console/testdata/predict-frames.json'),
      'utf8',
    )));
    const decoder = new TextDecoder();
    const wrong: string[] = [];
    for (const testCase of fixture) {
      const got = model.decodePredictFrame(
        Uint8Array.from(testCase.bytes),
        (bytes) => decoder.decode(bytes),
      );
      if (!got || got.version !== testCase.protocol || got.safe !== testCase.safe ||
          got.top !== testCase.decodedTop || got.bottom !== testCase.decodedBottom ||
          got.left !== testCase.decodedLeft || got.right !== testCase.decodedRight ||
          got.app !== testCase.app) {
        const expected = {
          version: testCase.protocol,
          safe: testCase.safe,
          top: testCase.decodedTop,
          bottom: testCase.decodedBottom,
          left: testCase.decodedLeft,
          right: testCase.decodedRight,
          app: testCase.app,
        };
        wrong.push(`${testCase.name}: ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
      }
    }
    const oldV1 = model.decodePredictFrame(
      Uint8Array.from([2, 1, 122, 115, 104]),
      (bytes) => decoder.decode(bytes),
    );
    if (!oldV1 || oldV1.safe) wrong.push('v1 safe bit from a rolled-back server was not refused');
    const malformedV4 = model.decodePredictFrame(
      Uint8Array.from([5, 1, 0, 10, 0, 5, 0, 8, 0, 8]),
      (bytes) => decoder.decode(bytes),
    );
    if (!malformedV4 || malformedV4.safe) {
      wrong.push('v4 safe bit with empty or reversed bounds was not refused');
    }
    if (wrong.length === 0) {
      pass(`Predictive frame v1/v4 golden fixtures decode (${fixture.length} cases)`);
    } else {
      fail(`Predictive frame decoder disagrees with Go fixtures: ${wrong.join('; ')}`);
    }
  } catch (error) {
    fail(`Could not check predictive frame fixtures: ${(error as Error).message}`);
  }

  try {
    const table = model.tuiTable();
    const wrong = Object.entries(table).filter(([app, row]) => {
      const seed = model.seedStyle(app, 120);
      return !seed || seed.atLen !== 120 - row.pad || seed.indent !== row.indent ||
        seed.pull !== row.pull || seed.down !== row.down || seed.lazy !== row.lazy ||
        seed.spacePull !== row.spacePull || model.seedPrompt(app) !== row.prompt;
    }).map(([app]) => app);
    if (model.seedStyle('__missing__', 120) !== null ||
        model.seedPrompt('__missing__') !== null) wrong.push('__missing__');
    if (model.RIDE_PAD !== Math.max(...Object.values(table).map((row) => row.pad))) {
      wrong.push('RIDE_PAD');
    }
    if (model.learnedWrapDown('claude', 0) !== false ||
        model.learnedWrapDown('claude', 1) !== true) {
      wrong.push('claude learned direction');
    }
    if (model.learnedWrapDown('grok', 1) !== false ||
        model.learnedWrapDown('muse', 0) !== true) {
      wrong.push('fixed learned direction');
    }
    if (wrong.length === 0) pass(`TUI seed API agrees with its model table (${Object.keys(table).length} applications)`);
    else fail(`TUI seed API disagrees with its table for: ${wrong.join(', ')}`);
  } catch (error) {
    fail(`Could not check the TUI seed API: ${(error as Error).message}`);
  }

  try {
    const fixture = parseRowFixture(JSON.parse(readFileSync(
      join(REPO_ROOT, 'dev/fixtures/composer-rows.json'),
      'utf8',
    )));
    const geometry = model.createGeometry({
      cols: () => fixture.cols,
      rows: () => 0,
      baseY: () => 0,
      paneBottom: () => 0,
      row: () => null,
    });
    const wrong: string[] = [];
    for (const testCase of fixture.cases) {
      const at = `${testCase.app}/${testCase.row}`;
      const frame = geometry.isFrameRow(testCase.text);
      if (frame !== testCase.frame) wrong.push(`${at}: isFrameRow said ${frame}`);
      if (testCase.start !== undefined && model.textStart(testCase.text) !== testCase.start) {
        wrong.push(`${at}: textStart ${model.textStart(testCase.text)}, the application starts its text at ${testCase.start}`);
      }
      if (testCase.end !== undefined && model.textEnd(testCase.text) !== testCase.end) {
        wrong.push(`${at}: textEnd ${model.textEnd(testCase.text)}, the application left its caret at ${testCase.end}`);
      }
    }
    if (wrong.length === 0) {
      pass(`Composer rows read correctly at both ends (${fixture.cases.length} rows from ${new Set(fixture.cases.map((row) => row.app)).size} real composers)`);
    } else {
      fail(`Row reading wrong in ${wrong.length} place(s): ${wrong.join('; ')}`);
    }
  } catch (error) {
    fail(`Could not check the row helpers: ${(error as Error).message}`);
  }

  try {
    const fixture = parsePaneFixture(JSON.parse(readFileSync(
      join(REPO_ROOT, 'dev/fixtures/composer-panes.json'),
      'utf8',
    )));
    const wrong: string[] = [];
    for (const testCase of fixture.panes) {
      const geometry = model.createGeometry({
        cols: () => fixture.cols,
        rows: () => fixture.rows,
        baseY: () => 0,
        paneBottom: () => 0,
        row: (row) => testCase.grid[row] ?? null,
      });
      const top = geometry.boxTop(testCase.cursorRow);
      const end = geometry.frameEnd(testCase.cursorRow);
      const room = geometry.roomBelow(end);
      if (top !== testCase.boxTop) wrong.push(`${testCase.app}: boxTop ${top}, the box starts at ${testCase.boxTop}`);
      if (end !== testCase.frameEnd) wrong.push(`${testCase.app}: frameEnd ${end}, the box ends at ${testCase.frameEnd}`);
      if (room !== testCase.roomBelow) {
        wrong.push(`${testCase.app}: roomBelow ${room}, but this pane grows ${testCase.grows} (${testCase.why})`);
      }
    }
    for (const testCase of fixture.splits) {
      const geometry = model.createGeometry({
        cols: () => fixture.cols,
        rows: () => fixture.rows,
        baseY: () => 0,
        paneTop: () => testCase.top,
        paneBottom: () => testCase.bottom,
        paneLeft: () => testCase.left,
        paneRight: () => testCase.right,
        row: () => null,
      });
      const room = geometry.roomBelow(testCase.frameEnd);
      if (room !== testCase.roomBelow) {
        wrong.push(`${testCase.name}: roomBelow ${room}, want ${testCase.roomBelow} at absolute bottom ${testCase.bottom}`);
      }
      const next = testCase.wrapRow + 1;
      if (!geometry.rowWithinPane(testCase.wrapRow) ||
          geometry.rowWithinPane(next) !== testCase.canDrop) {
        wrong.push(`${testCase.name}: wrap ${testCase.wrapRow}->${next} crossed pane bottom ${testCase.bottom}`);
      }
      const rows = geometry.rowsThroughPane(testCase.wrapRow);
      if (rows !== testCase.bottom - testCase.wrapRow) {
        wrong.push(`${testCase.name}: rowsThroughPane ${rows}, want ${testCase.bottom - testCase.wrapRow}`);
      }
      if (!geometry.rowWithinPane(testCase.top) || geometry.rowWithinPane(testCase.top - 1)) {
        wrong.push(`${testCase.name}: row top ${testCase.top} was not an inclusive lower edge`);
      }
      if (!geometry.colWithinPane(testCase.insideCol) || geometry.colWithinPane(testCase.outsideCol)) {
        wrong.push(`${testCase.name}: columns did not stay inside [${testCase.left}, ${testCase.right})`);
      }
    }
    if (wrong.length === 0) {
      pass(`Box growth honors pane geometry (${fixture.panes.length} real panes, ${fixture.splits.length} split positions)`);
    } else {
      fail(`Box top or growth direction wrong in ${wrong.length} place(s): ${wrong.join('; ')}`);
    }
  } catch (error) {
    fail(`Could not check the box-top and growth-direction helpers: ${(error as Error).message}`);
  }

  try {
    const fixture = parseWordFixture(JSON.parse(readFileSync(
      join(REPO_ROOT, 'dev/fixtures/word-rules.json'),
      'utf8',
    )));
    const wrong: string[] = [];
    let checked = 0;
    for (const testCase of fixture.cases) {
      if (testCase.wide) continue;
      const rule = model.wordRule(testCase.app);
      const text = ' '.repeat(testCase.floor) + testCase.draft;
      const end = text.length;
      const left = (from: number) => model.wordLeft(rule, text, from, testCase.floor, model.wordScan());
      const right = (from: number, max: number) => model.wordRight(rule, text, from, max, model.wordScan());
      const back1 = left(end), back2 = left(back1);
      const forward1 = right(testCase.floor, end), forward2 = right(forward1, end);
      const at = `${testCase.app} ${JSON.stringify(testCase.draft)}`;
      if (back1 !== testCase.back[0] || back2 !== testCase.back[1]) {
        wrong.push(`${at}: word-left ${back1},${back2} (pane ${testCase.back.join(',')})`);
      }
      if (forward1 !== testCase.fwd[0] || forward2 !== testCase.fwd[1]) {
        wrong.push(`${at}: word-right ${forward1},${forward2} (pane ${testCase.fwd.join(',')})`);
      }
      if (back1 !== testCase.kill) {
        wrong.push(`${at}: word-delete to ${back1} (pane ${testCase.kill})`);
      }
      checked++;
    }
    if (wrong.length === 0) {
      pass(`Word jumps land where each application's do (${checked} measured cases, ${new Set(fixture.cases.map((row) => row.app)).size} applications)`);
    } else {
      fail(`Word rule wrong in ${wrong.length} place(s): ${wrong.join('; ')}`);
    }
  } catch (error) {
    fail(`Could not check the word rules: ${(error as Error).message}`);
  }

  const drift = rosterDrift();
  if (drift.length === 0) {
    pass(`Harness rosters match the model (${appsWith('seed').length} seeded, ${appsWith('words').length} with a word rule)`);
  } else {
    fail(`console-apps.ts and the model disagree in ${drift.length} place(s): ${drift.join('; ')}`);
  }
}
