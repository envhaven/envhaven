import { BROWSER_RUNTIME_ASSETS, consoleModel } from '../engine';
import type { TestReporter } from './types';

const modules = new Function(BROWSER_RUNTIME_ASSETS
  .filter(({ name }) => ['eh-predict-input.js', 'eh-predict-layout.js', 'eh-predict-navigation.js',
    'eh-predict-actions.js', 'eh-predict-reconcile.js', 'eh-predict-session.js'].includes(name))
  .map((asset) => asset.source()).join('\n') + `\nreturn {
    input: EnvHavenConsoleInput, layout: EnvHavenConsoleLayout,
    navigation: EnvHavenConsoleNavigation, actions: EnvHavenConsoleActions,
    reconcile: EnvHavenConsoleReconcile, session: EnvHavenConsoleSession
  };`)();

function exact(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

function rig(contents: string[], cursor: [number, number], down = false, left = 0) {
  const width = 20 + left, height = 20, top = down ? 6 : 12 - contents.length;
  let now = 2000;
  const rows = Array.from({ length: height }, () => ' '.repeat(width));
  const frame = ' '.repeat(left) + '─'.repeat(20);
  rows[top - 1] = frame;
  contents.forEach((text, index) => { rows[top + index] = (' '.repeat(left) + text).padEnd(width); });
  rows[top + contents.length] = frame;
  rows[top + contents.length + 1] = (' '.repeat(left) + '  ⏵ status').padEnd(width);
  const buffer = {
    baseY: 0, cursorY: top + cursor[0], cursorX: left + cursor[1],
    getLine: (r: number) => ({
      translateToString: (_trim: boolean, start = 0, end = width) => (rows[r] || '').slice(start, end),
      getCell: (x: number) => ({ getChars: () => rows[r]?.[x] || '', isDim: () => false, isFgDefault: () => true }),
    }),
  };
  const probe: { __ehPredict?: { hold: { nav: boolean } | null } } = {};
  const session = modules.session.create({
    ...modules, model: consoleModel(), term: { rows: height, cols: width, buffer: { active: buffer } },
    clock: { now: () => now }, timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    window: probe, params: { get: (key: string) => key === 'echo' || key === 'probe' ? '1' : null },
    display: { cursorGrace: 250 }, publish: () => undefined,
  });
  session.dispatch({ type: 'gate', gate: { safe: true, app: 'claude', top: 0,
    bottom: down ? height : 14, left, right: width } });
  now += 1000;
  return {
    session, rows, buffer, top, left,
    hold: () => probe.__ehPredict!.hold,
    send: (data: string) => session.dispatch({ type: 'input', command: modules.input.decode(data) }),
    reconcile: (elapsed = 0) => { now += elapsed; return session.dispatch({ type: 'reconcile' }); },
  };
}

export function runReflowTests(report: TestReporter): void {
  for (const down of [false, true]) for (const left of [0, 7]) {
    const name = `${down ? 'top' : 'bottom'}-anchored draft${left ? ' in a split pane' : ''}`;
    try {
      const r = rig(['❯ look at this', '  very nice', '  example'], [1, 7], down, left);
      const oldRows = r.rows.slice();
      r.send('\x1b\x7f');
      let burst = r.session.view().predicted;
      if (!burst?.reflow) throw new Error('word deletion produced no multi-row prediction');
      const expectedTop = r.top + (down ? 0 : 1);
      exact(burst.reflow.rows.map((row: { text: string }) => row.text.trim()),
        ['❯ look at this', 'nice example'], 'reflowed draft');
      exact([burst.absRow, burst.line.length], [expectedTop + 1, left + 2], 'reflowed cursor');
      exact(r.rows, oldRows, 'authoritative grid after local prediction');

      // A partial echo agrees at the cursor, but still has the old continuation.
      r.buffer.cursorY = burst.absRow;
      r.buffer.cursorX = burst.line.length;
      r.rows[burst.absRow] = (burst.line + burst.tail).slice(0, 20 + left);
      r.reconcile(50);
      if (!r.session.view().predicted?.reflow) throw new Error('partial echo retired the draft');
      if (!r.session.view().predicted.mismatched) throw new Error('partial echo matched without the remaining rows');

      // Navigate over the NEW rows, then edit again before the first edit echoes.
      r.send('\x05');
      r.send(' again');
      burst = r.session.view().predicted;
      exact(burst.reflow.rows.map((row: { text: string }) => row.text.trim()),
        ['❯ look at this', 'nice example', 'again'], 're-expanded draft');
      r.send('\x1b\x7f');
      r.send('\x7f');
      burst = r.session.view().predicted;
      exact(burst.reflow.rows.map((row: { text: string }) => row.text.trim()),
        ['❯ look at this', 'nice example'], 'repeated shrink');

      // Echo the entire predicted block, then release it without leaving paint.
      burst.reflow.paint.forEach(({ row, text, clear }: { row: number; text: string; clear: boolean }) => {
        r.rows[row] = clear ? (' '.repeat(left) + 'Updated status').padEnd(20 + left) : text;
      });
      r.buffer.cursorY = burst.absRow;
      r.buffer.cursorX = burst.line.length;
      r.reconcile();
      r.reconcile(3000);
      if (r.session.view().predicted !== null) throw new Error('complete echo did not release the draft');
      report.pass(`Wrapped deletion cascades, shrinks, navigates and expands a ${name}`);
    } catch (error) {
      report.fail(`Reflow of ${name}: ${(error as Error).message}`);
    }
  }
  try {
    const r = rig(['❯ alpha bet', '  gamma delta', '  epsilon'], [0, 8]);
    r.send('\x1b\x7f');
    const draft = r.session.view().predicted?.reflow;
    if (!draft) throw new Error('no draft');
    exact(draft.rows.map((row: { text: string }) => row.text.trim()),
      ['❯ bet', 'gamma delta', 'epsilon'], 'explicit newline retained');
    report.pass('Reflow preserves line breaks that cannot be soft wraps');
  } catch (error) {
    report.fail(`Explicit newline during reflow: ${(error as Error).message}`);
  }
  try {
    // A draft that opens with an empty line, as Shift+Enter on an empty composer makes.
    const r = rig(['❯ ', '  alpha beta', '  gamma delta'], [1, 12]);
    r.send('x');
    r.send('\x1b[A');
    r.send('\x01');
    const burst = r.session.view().predicted;
    exact([burst?.absRow, burst?.line.length], [r.top, 2], 'Home on the empty first line');
    report.pass('Home at the start of an empty first line stays on it');
  } catch (error) {
    report.fail(`Home on an empty first draft line: ${(error as Error).message}`);
  }
  try {
    // Up past the first row recalls history, which repaints the whole draft.
    const r = rig(['❯ ', '  alpha beta', '  gamma delta'], [1, 12]);
    r.send('x');
    r.send('\x1b[A');
    r.send('\x1b[A');
    exact(r.hold()?.nav, false, 'navigation hold after Up past the first row');
    report.pass('Up past the first draft row waits out the recalled line like any history recall');
  } catch (error) {
    report.fail(`Up past the first draft row: ${(error as Error).message}`);
  }
  for (const example of [
    { name: 'four-row cascade', rows: ['❯ one two three', '  four five six', '  seven eight', '  eleven twelve'],
      cursor: [1, 12] as [number, number], keys: ['\x1b\x7f', '\x1b\x7f'],
      want: ['❯ one two three', 'six seven eight', 'eleven twelve'] },
    { name: 'deletion at a soft seam', rows: ['❯ look at this', '  very nice', '  example'],
      cursor: [1, 2] as [number, number], keys: ['\x7f'],
      want: ['❯ look at', 'thisvery nice', 'example'] },
    { name: 'exact-edge word with a following separator', rows: ['❯ look at', '  thisvery nice', '  example'],
      cursor: [1, 2] as [number, number], keys: ['\x7f'], want: ['❯ look atthisvery', 'nice example'] },
    { name: 'blank logical lines', rows: ['❯ alpha beta', '  ', '  gamma delta'],
      cursor: [0, 8] as [number, number], keys: ['\x1b\x7f'], want: ['❯ beta', '', 'gamma delta'] },
    { name: 'accented text', rows: ['❯ café pequeño', '  très agréable', '  ejemplo'],
      cursor: [1, 7] as [number, number], keys: ['\x1b\x7f'], want: ['❯ café pequeño', 'agréable ejemplo'] },
  ]) {
    try {
      const r = rig(example.rows, example.cursor);
      example.keys.forEach(r.send);
      const draft = r.session.view().predicted?.reflow;
      if (!draft) throw new Error('no multi-row prediction');
      exact(draft.rows.map((row: { text: string }) => row.text.trim()), example.want, example.name);
      report.pass(`Reflow handles ${example.name}`);
    } catch (error) {
      report.fail(`${example.name}: ${(error as Error).message}`);
    }
  }
}
