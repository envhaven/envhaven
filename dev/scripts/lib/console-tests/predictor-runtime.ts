import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT } from '../config';
import {
  BROWSER_RUNTIME_ASSETS,
  burstDeathLinesSince,
  consoleModel,
  type PredictorEvent,
  type PredictorTransition,
} from '../engine';
import { array, exact, object, string } from './fixtures';
import type { TestReporter } from './types';

interface PredictorTransitionCase {
  name: string;
  events: PredictorEvent[];
  steps: PredictorTransition[];
}

const PREDICTOR_TRANSITION_CASES = [
  'safe gate seats app and geometry',
  'submit waits for unsafe before rearming',
  'every unsafe frame clears pending paint',
  'app and split geometry move together',
  'disconnect forgets session state',
] as const;

function runtimeSource(name: string): string {
  const asset = BROWSER_RUNTIME_ASSETS.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`unknown browser runtime asset: ${name}`);
  return asset.source();
}

function predictionModules() {
  return new Function([
    'eh-predict-input.js', 'eh-predict-layout.js', 'eh-predict-navigation.js',
    'eh-predict-actions.js', 'eh-predict-reconcile.js', 'eh-predict-session.js',
  ].map(runtimeSource).join('\n') + `\nreturn {
    input: EnvHavenConsoleInput, layout: EnvHavenConsoleLayout,
    navigation: EnvHavenConsoleNavigation, actions: EnvHavenConsoleActions,
    reconcile: EnvHavenConsoleReconcile, session: EnvHavenConsoleSession
  };`)();
}

interface PaneView {
  predicted: { absRow: number; line: string; tail: string; proven: boolean } | null;
}

interface PaneProbe {
  hold: { nav: boolean } | null;
  wrap: { atLen: number } | null;
}

// One prediction session over a pane the test draws. The rows are what the application
// has echoed so far, and every call reads the same clock the session does.
function pane(app: string, width: number, height: number, styled = (_row: number, _col: number) => false) {
  const modules = predictionModules();
  const rows = Array.from({ length: height }, () => ' '.repeat(width));
  const probe: { __ehPredict?: PaneProbe } = {};
  let now = 1000;
  const buffer = {
    baseY: 0, cursorY: 0, cursorX: 0,
    getLine: (row: number) => rows[row] === undefined ? undefined : {
      translateToString: (_trim: boolean, start = 0, end = width) => rows[row]!.slice(start, end),
      getCell: (x: number) => ({
        getChars: () => rows[row]![x] || '', isDim: () => false, isFgDefault: () => !styled(row, x),
      }),
    },
  };
  const session = modules.session.create({
    ...modules, model: consoleModel(), term: { rows: height, cols: width, buffer: { active: buffer } },
    clock: { now: () => now }, timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    window: probe, params: { get: (key: string) => key === 'echo' || key === 'probe' ? '1' : null },
    display: { cursorGrace: 250, inputForeground: () => '', cellForeground: () => '' },
    publish: () => undefined,
  }) as { dispatch(event: unknown): { view: PaneView } };
  session.dispatch({ type: 'gate', gate: { safe: true, app, top: 0, bottom: height, left: 0, right: width } });
  now += 1000; // The app-switch hold has expired.
  const rig = {
    draw(row: number, text: string) { rows[row] = text.padEnd(width); },
    cursor(row: number, col: number) { buffer.cursorY = row; buffer.cursorX = col; },
    wait(ms: number) { now += ms; },
    send: (data: string) => session.dispatch({ type: 'input', command: modules.input.decode(data) }).view,
    reconcile() { session.dispatch({ type: 'reconcile' }); },
    // One server frame: its data event, then the reconcile its write callback runs.
    frame() {
      session.dispatch({ type: 'data', at: now });
      rig.reconcile();
    },
    // Each key echoes before the next is typed, as on a fast link.
    echo(row: number, keys: string) {
      for (const key of keys) {
        rig.send(key);
        const line = rows[row]!.slice(0, buffer.cursorX) + key;
        rig.draw(row, line);
        rig.cursor(row, line.length);
        rig.wait(30);
        rig.frame();
      }
    },
    probe: () => probe.__ehPredict!,
  };
  return rig;
}

function parsePredictorTransitions(value: unknown): PredictorTransitionCase[] {
  const root = object(value, 'predictor transition fixture');
  const cases = array(root.cases, 'predictor transition fixture.cases').map((value, index) => {
    const row = object(value, `predictor transition fixture.cases[${index}]`);
    const events = array(row.events, `predictor transition fixture.cases[${index}].events`) as PredictorEvent[];
    const steps = array(row.steps, `predictor transition fixture.cases[${index}].steps`) as PredictorTransition[];
    if (events.length !== steps.length) {
      throw new Error(`predictor transition fixture.cases[${index}] needs one expected step per event`);
    }
    return {
      name: string(row.name, `predictor transition fixture.cases[${index}].name`),
      events,
      steps,
    };
  });
  exact(cases.map((row) => row.name), PREDICTOR_TRANSITION_CASES, 'predictor transition fixture cases');
  return cases;
}

export function runPredictorRuntimeTests(report: TestReporter): void {
  const { pass, fail } = report;
  const modelAsset = runtimeSource('eh-model.js');
  const transportSource = runtimeSource('eh-transport.js');
  const predictorSource = runtimeSource('eh-predictor.js');
  const model = consoleModel();

  try {
    new Function(modelAsset);
    exact(Object.keys(model.FRAME), ['data', 'resize', 'predictV1', 'predictV4'], 'predictive frame types');
    if (model.predictQuery !== '&echo=1&echoProtocol=4') {
      throw new Error(`predict query is ${model.predictQuery}`);
    }
    pass(`Model exposes v1 compatibility and protocol v4 negotiation (${modelAsset.split('\n').length} lines)`);
  } catch (error) {
    fail(`Browser model contract failed: ${(error as Error).message}`);
  }

  if (transportSource.includes('if (deps.echoEnabled) url += MODEL.predictQuery;') &&
      transportSource.includes("transition({ type: 'socket-open', gateRequired: deps.echoEnabled });") &&
      transportSource.includes("transition({ type: 'data' });")) {
    pass('Transport negotiates prediction and arms default sockets from server data');
  } else {
    fail('Transport readiness is not wired to prediction mode and authoritative server data');
  }

  try {
    let state = model.transportState('ready');
    const secret = 'new-pane-secret';
    const refused: string[] = [];
    const delivered: string[] = [];
    const step = (event: Parameters<typeof model.reduceTransport>[1]) => {
      const result = model.reduceTransport(state, event);
      state = result.state;
      for (const effect of result.effects) {
        if (effect.type === 'refuse-input') refused.push(effect.phase);
        else delivered.push(`${effect.type}:${effect.data}`);
      }
    };
    step({ type: 'socket-close' });
    step({ type: 'input', data: secret });
    step({ type: 'connect' });
    step({ type: 'input', data: secret });
    step({ type: 'socket-open', gateRequired: true });
    step({ type: 'input', data: secret });
    step({ type: 'data' });
    step({ type: 'input', data: secret });
    step({ type: 'gate' });
    if (delivered.length !== 0) {
      throw new Error(`pre-gate input escaped or replayed: ${JSON.stringify(delivered)}`);
    }
    step({ type: 'input', data: 'after-authority' });
    if (JSON.stringify(refused) !== JSON.stringify([
      'disconnected', 'connecting', 'awaiting-frame', 'awaiting-frame',
    ])) {
      throw new Error(`input refusals did not cover every detached phase: ${JSON.stringify(refused)}`);
    }
    if (JSON.stringify(delivered) !== JSON.stringify([
      'send-input:after-authority', 'predict-input:after-authority',
    ])) {
      throw new Error(`post-gate input was not sent and predicted exactly once: ${JSON.stringify(delivered)}`);
    }
    if (/pendingInput|InputQueue|enqueue|\.drain\(/.test(transportSource + modelAsset + predictorSource)) {
      throw new Error('a pending-input/replay mechanism remains in the browser runtime');
    }
    let plain = model.reduceTransport(
      model.transportState('connecting'),
      { type: 'socket-open' },
    ).state;
    plain = model.reduceTransport(plain, { type: 'data' }).state;
    const plainEffects = model.reduceTransport(plain, { type: 'input', data: 'plain' }).effects;
    if (plainEffects.length !== 1 || plainEffects[0]?.type !== 'send-input') {
      throw new Error(`non-predictive input did not arm send-only after server data: ${JSON.stringify(plainEffects)}`);
    }
    pass('Reconnect refuses and forgets input until a fresh data frame or predictive gate');
  } catch (error) {
    fail(`Reconnect secret-input contract failed: ${(error as Error).message}`);
  }

  try {
    const fixture = parsePredictorTransitions(JSON.parse(readFileSync(
      join(REPO_ROOT, 'console/testdata/predictor-transitions.json'),
      'utf8',
    )));
    const wrong: string[] = [];
    let transitions = 0;
    for (const testCase of fixture) {
      let state = {
        safe: false, localDisarm: false, app: '',
        top: 0, bottom: 0, left: 0, right: 0,
      };
      testCase.events.forEach((event, index) => {
        const result = model.reducePredictorLifecycle(state, event);
        state = result.state;
        const expected = testCase.steps[index]!;
        if (JSON.stringify(result) !== JSON.stringify(expected)) {
          wrong.push(`${testCase.name} step ${index + 1}: ${JSON.stringify(result)}, want ${JSON.stringify(expected)}`);
        }
        transitions++;
      });
    }
    if (wrong.length === 0) pass(`Predictor controller transitions execute (${transitions} steps)`);
    else fail(`Predictor controller disagrees with fixtures: ${wrong.join('; ')}`);
  } catch (error) {
    fail(`Could not check predictor controller fixtures: ${(error as Error).message}`);
  }

  try {
    const mark = { sequence: 10, deaths: 4 };
    const sameMillisecond = burstDeathLinesSince({
      sequence: 11,
      deaths: 5,
      entries: [{ sequence: 11, at: 100, text: 'reset move-mismatch' }],
    }, mark);
    const truncated = burstDeathLinesSince({ sequence: 200, deaths: 6, entries: [] }, mark);
    if (sameMillisecond.length !== 1 || !sameMillisecond[0]!.includes('move-mismatch')) {
      throw new Error('a later sequence sharing the watermark timestamp was lost');
    }
    if (truncated.length !== 2 || truncated.some((line) => !line.includes('trace-truncated'))) {
      throw new Error(`ring truncation reported ${JSON.stringify(truncated)}`);
    }
    pass('Trace death accounting survives timestamp collisions and ring truncation');
  } catch (error) {
    fail(`Could not check trace death accounting: ${(error as Error).message}`);
  }

  try {
    const factory = new Function(
      `${runtimeSource('eh-predict-reconcile.js')}\nreturn EnvHavenConsoleReconcile;`,
    )() as {
      create(deps: unknown): {
        learnWrap(): void;
      };
    };
    const width = 128;
    const rows: Record<number, string> = {
      7: 'x'.repeat(122) + 'bien  ',
      8: '  y' + ' '.repeat(width - 3),
    };
    const state = {
      app: 'claude', lastDataAt: 0, rideQueue: null, predicted: null,
      wrapStyle: model.seedStyle('claude', width),
      wrapPend: {
        row: 7, col: 126, at: 900, word: 'bien', line: rows[7], trigger: ' ',
        moved: '', prevSeen: null, seenAt: 0,
      },
    };
    const layout = {
      rowWithinPane: (row: number) => row >= 0 && row < 36,
      rowIsFull: (row: string) => row.replace(/ +$/, '').length === width,
      textEnd: model.textEnd,
      textStart: model.textStart,
      rowAboveHoldsLine: () => false,
    };
    const traces: string[] = [];
    const core = {
      fullRow: (row: number) => rows[row] ?? null,
      paneLeft: () => 0,
      paneRight: () => width,
      lastToken: (text: string) => text.slice(text.lastIndexOf(' ') + 1),
      trace: (...parts: unknown[]) => traces.push(parts.join(' ')),
      reset: () => undefined,
      effect: () => undefined,
    };
    const reconcile = factory.create({
      model, term: { buffer: { active: { baseY: 0, cursorY: 8, cursorX: 3 } } },
      clock: { now: () => 1000 }, display: {}, layout, state, core,
    });
    reconcile.learnWrap();
    if (!state.wrapStyle || state.wrapStyle.atLen !== 126 || state.wrapStyle.down !== true ||
        state.wrapPend !== null || !traces.some((line) => line.startsWith('learned claude '))) {
      throw new Error(`empty continuation learned ${JSON.stringify(state.wrapStyle)} with ${JSON.stringify(traces)}`);
    }
    pass('A ridden empty continuation learns its wrap column and observed direction');
  } catch (error) {
    fail(`Could not learn a ridden empty continuation: ${(error as Error).message}`);
  }

  // The continuation shows the queued keys' echo so far, or none of it yet.
  for (const shown of ['mo', '']) {
    try {
      const factory = new Function(
        `${runtimeSource('eh-predict-session.js')}\nreturn EnvHavenConsoleSession;`,
      )() as {
        create(deps: unknown): {
          dispatch(event: unknown): { view: { predicted: { line: string } | null } };
        };
      };
      const width = 16;
      const row = ('  ' + shown).padEnd(width);
      let queue = true;
      const actions = {
        create: ({ state, core }: {
          state: { rideQueue: { text: string; at: number; moved: string | null } | null };
          core: { startBurst(): boolean };
        }) => ({
          predict() {
            if (queue) {
              queue = false;
              state.rideQueue = { text: 'mode', at: 1000, moved: '' };
            } else {
              core.startBurst();
            }
          },
        }),
      };
      const line = { translateToString: (_trim: boolean, start = 0, end = width) => row.slice(start, end) };
      const session = factory.create({
        model,
        term: { rows: 1, cols: width, buffer: { active: { baseY: 0, cursorY: 0, cursorX: 2 + shown.length, getLine: () => line } } },
        clock: { now: () => 1000 },
        timers: { setTimeout: () => 0, clearTimeout: () => undefined },
        window: {}, params: { get: (key: string) => key === 'echo' ? '1' : null }, display: {},
        publish: () => undefined, actions,
        layout: { create: () => ({
          rowWithinPane: () => true, colWithinPane: () => true,
          learnPrompt: () => undefined, ghostAt: () => false,
          textEnd: model.textEnd, textStart: model.textStart,
        }) },
        navigation: { create: () => ({}) },
        reconcile: { create: () => ({}) },
      });
      session.dispatch({ type: 'input', command: { type: 'insert', text: 'queue' } });
      const result = session.dispatch({ type: 'input', command: { type: 'insert', text: 'rebind' } });
      if (result.view.predicted?.line !== '  mode') {
        throw new Error(`rebound line is ${JSON.stringify(result.view.predicted?.line)}`);
      }
      pass(shown
        ? 'Keys riding an empty continuation replay into the rebound model exactly once'
        : 'Keys riding a still-blank continuation replay at the cursor');
    } catch (error) {
      fail(`Could not replay an empty-continuation ride${shown ? '' : ' onto a blank row'}: ${(error as Error).message}`);
    }
  }

  // A ride hands the row to server echo and queues what the user keeps typing. Every key
  // the ride had already sent past the moved word must be queued too, or the replay takes
  // that key's echo for a queued key and drops a real keystroke from the rebound model.
  for (const ride of [
    {
      name: 'an upward wrap detected under keys in flight',
      final: '  hotel jul',
      run() {
        const p = pane('gemini', 60, 12);
        p.draw(9, '> ');
        p.cursor(9, 2);
        for (const key of 'alpha bravo charlie delta echo foxtrot golf hotel ') p.send(key);
        // The application wraps at 50 columns, inside the ride limit, before ' ' echoes.
        p.draw(8, '> alpha bravo charlie delta echo foxtrot golf');
        p.draw(9, '  hotel');
        p.cursor(9, 7);
        p.frame();
        p.send('j'); // Sees the wrap under the burst and rides.
        p.send('u'); // Queued behind the ride.
        p.draw(9, '  hotel j'); // ' ' and 'j' echo while 'u' is still in flight.
        p.cursor(9, 9);
        p.frame();
        p.wait(100);
        p.reconcile();
        return p.send('l').predicted?.line;
      },
    },
    {
      name: 'an edge space that pulls its word',
      final: '  hotel nex',
      run() {
        // On the pane's last row agy cannot grow down, so the edge space rides.
        const p = pane('agy', 40, 6);
        p.draw(5, '> ');
        p.cursor(5, 2);
        p.echo(5, 'alpha bravo charlie delta echos hotel');
        p.wait(1000);
        p.frame();
        p.send(' ');
        p.send('n'); // Queued behind the ride, as is 'e'.
        p.send('e');
        // agy pulls 'hotel ' onto the continuation, then 'n' echoes.
        p.draw(4, '> alpha bravo charlie delta echos');
        p.draw(5, '  hotel ');
        p.cursor(5, 8);
        p.frame();
        p.draw(5, '  hotel n');
        p.cursor(5, 9);
        p.frame();
        p.wait(100);
        p.reconcile();
        return p.send('x').predicted?.line;
      },
    },
    {
      name: 'a multi-character insert',
      final: '  lasxyzabc',
      run() {
        const p = pane('gemini', 60, 10);
        p.draw(5, '> ');
        p.cursor(5, 2);
        p.echo(5, 'alpha bravo charlie delta echo foxtrot golf hotel las');
        p.wait(1000);
        p.frame();
        p.send('xyz'); // One chunk, as an IME commit sends it, reaching the ride limit.
        p.send('a'); // Queued behind the ride, as is 'b'.
        p.send('b');
        // The wrap lands with the chunk's first character, then the rest of it echoes.
        p.draw(5, '> alpha bravo charlie delta echo foxtrot golf hotel');
        p.draw(6, '  lasx');
        p.cursor(6, 6);
        p.frame();
        p.draw(6, '  lasxyz');
        p.cursor(6, 8);
        p.frame();
        p.wait(100);
        p.reconcile();
        return p.send('c').predicted?.line;
      },
    },
    {
      name: 'a multi-character insert that repeats its first letter',
      final: '  thatabc',
      run() {
        const p = pane('gemini', 60, 10);
        p.draw(5, '> ');
        p.cursor(5, 2);
        p.echo(5, 'alpha bravo charlie delta echo foxtrot golf hotel ab ');
        p.wait(1000);
        p.frame();
        p.send('that'); // Rides on its first 't', so the ride's word is that 't' alone.
        p.send('a');
        p.send('b');
        p.draw(5, '> alpha bravo charlie delta echo foxtrot golf hotel ab');
        p.draw(6, '  th');
        p.cursor(6, 4);
        p.frame();
        p.draw(6, '  that');
        p.cursor(6, 6);
        p.frame();
        p.wait(100);
        p.reconcile();
        return p.send('c').predicted?.line;
      },
    },
    ...([['x', 'yz'], [' ', 'y']] as const).map(([trigger, landed]) => ({
      name: `a hard wrap on the pane's last row triggered by ${trigger === ' ' ? 'a space' : 'a letter'}`,
      final: 'yzw',
      run() {
        // zsh keeps the trigger in the old row's last column and scrolls the pane. The
        // landing frame shows what of the queue has echoed so far.
        const p = pane('zsh', 40, 4);
        const typed = '➜  dir echo alpha bravo charlie delta echo'.slice(0, 39); // The seeded wrap column.
        p.draw(3, '➜  dir ');
        p.cursor(3, 7);
        p.echo(3, typed.slice(7));
        p.wait(1000);
        p.frame();
        p.send(trigger);
        p.send('y');
        p.send('z');
        p.draw(2, typed + trigger);
        p.draw(3, landed);
        p.cursor(3, landed.length);
        p.frame();
        p.wait(100);
        p.reconcile();
        return p.send('w').predicted?.line;
      },
    })),
  ]) {
    try {
      const line = ride.run();
      if (line !== ride.final) {
        throw new Error(`rebound line is ${JSON.stringify(line)}, the pane will hold ${JSON.stringify(ride.final)}`);
      }
      pass(`A ride over ${ride.name} replays every sent key exactly once`);
    } catch (error) {
      fail(`Ride over ${ride.name}: ${(error as Error).message}`);
    }
  }

  try {
    // Claude's composer rides a wrap while unpinned. Its first landed frame can already
    // echo a queued key, here 'juli' for a ride that moved 'jul'.
    const p = pane('claude', 60, 20);
    const rule = '─'.repeat(60);
    p.draw(2, rule);
    p.draw(3, '❯ ');
    p.draw(4, rule);
    p.cursor(3, 2);
    p.echo(3, 'alpha bravo charlie delta echo foxtrot golf hotel ind ju');
    p.wait(1000);
    p.frame();
    for (const key of 'liet') p.send(key); // 'l' crosses the wrap column and rides.
    p.draw(3, '❯ alpha bravo charlie delta echo foxtrot golf hotel ind');
    p.draw(4, '  juli');
    p.draw(5, rule);
    p.cursor(4, 6);
    p.frame();
    p.wait(100);
    p.reconcile();
    const learned = p.probe().wrap?.atLen, seeded = model.seedStyle('claude', 60)?.atLen;
    if (learned !== seeded) throw new Error(`learned wrap column ${learned}, the composer wraps at ${seeded}`);
    const line = p.send('x').predicted?.line;
    if (line !== '  julietx') throw new Error(`rebound line is ${JSON.stringify(line)}`);
    pass('A landing frame that already echoes a queued key anchors on the word the ride moved');
  } catch (error) {
    fail(`Could not anchor a ride on its moved word: ${(error as Error).message}`);
  }

  try {
    // opencode has no seed, so it rides RIDE_PAD columns before the pane edge. Its row
    // keeps growing after the ride, and the pane then moves 'julie' rather than 'juli'.
    const p = pane('opencode', 60, 10);
    p.draw(5, '> ');
    p.cursor(5, 2);
    p.echo(5, 'alpha bravo charlie delta echo foxtrot golf hotel jul');
    p.wait(1000);
    p.frame();
    p.send('i'); // Rides at column 55.
    p.send('e');
    p.draw(5, '> alpha bravo charlie delta echo foxtrot golf hotel juli');
    p.cursor(5, 56);
    p.frame();
    p.draw(5, '> alpha bravo charlie delta echo foxtrot golf hotel');
    p.draw(6, '  julie');
    p.cursor(6, 7);
    p.frame();
    p.wait(100);
    p.reconcile();
    const learned = p.probe().wrap?.atLen;
    if (learned !== 56) throw new Error(`learned wrap column ${learned}, the pane wraps at 56`);
    const line = p.send('x').predicted?.line;
    if (line !== '  juliex') throw new Error(`rebound line is ${JSON.stringify(line)}`);
    pass('A ride taken before the pane wraps learns the column the pane wrapped at');
  } catch (error) {
    fail(`Could not learn a wrap the pane took after the ride: ${(error as Error).message}`);
  }

  try {
    // codex's lazy edge takes the trigger into the row and moves the word only with the
    // next key, so its row always grows by the trigger. The word it moves is the ride's.
    const p = pane('codex', 40, 6);
    p.draw(5, '› ');
    p.cursor(5, 2);
    p.echo(5, 'alpha bravo charlie delta echos juli'); // The seeded wrap column, 38.
    p.wait(1000);
    p.frame();
    p.send('e'); // Rides: on the pane's last row the box cannot grow down.
    p.send('t');
    p.draw(5, '› alpha bravo charlie delta echos julie');
    p.cursor(5, 39);
    p.frame();
    p.draw(4, '› alpha bravo charlie delta echos');
    p.draw(5, '  juliet');
    p.cursor(5, 8);
    p.frame();
    p.wait(100);
    p.reconcile();
    const learned = p.probe().wrap?.atLen, seeded = model.seedStyle('codex', 40)?.atLen;
    if (learned !== seeded) throw new Error(`learned wrap column ${learned}, codex wraps at ${seeded}`);
    const line = p.send('x').predicted?.line;
    if (line !== '  julietx') throw new Error(`rebound line is ${JSON.stringify(line)}`);
    pass("codex's lazy edge learns the column its ride moved the word from");
  } catch (error) {
    fail(`Could not learn codex's lazy edge: ${(error as Error).message}`);
  }

  for (const editing of [
    { name: 'character navigation', keys: '\x1b[D'.repeat(7), text: 'alpha bravo charlie', col: 14 },
    { name: 'word navigation', keys: '\x1bb', text: 'alpha bravo charlie', col: 14 },
    { name: 'character deletion', keys: '\x1b[D'.repeat(7) + '\x7f', text: 'alpha bravocharlie', col: 13 },
    { name: 'word deletion', keys: '\x1bb\x1b\x7f', text: 'alpha charlie', col: 8 },
    { name: 'character deletion at the end', keys: '\x7f', text: 'alpha bravo charli', col: 20 },
    { name: 'word deletion at the end', keys: '\x1b\x7f', text: 'alpha bravo ', col: 14 },
    { name: 'cursor movement on a slow link', keys: '\x1bb', text: 'alpha bravo charlie', col: 14, settled: true },
    { name: 'word deletion over a placeholder', keys: '\x1bb\x1b\x7f', text: 'alpha charlie', col: 8, ghost: true },
  ]) {
    try {
      const modules = predictionModules();
      const width = 64;
      let row = ('ghost' in editing ? '❯ Try asking a question' : '❯ ').padEnd(width), now = 1000;
      let rejectTimer = false;
      const buffer = {
        baseY: 0, cursorY: 0, cursorX: 2,
        getLine: () => ({
          translateToString: (_trim: boolean, start = 0, end = width) => row.slice(start, end),
          getCell: (x: number) => ({
            getChars: () => row[x] || '', isDim: () => 'ghost' in editing && x >= 2, isFgDefault: () => true,
          }),
        }),
      };
      const session = modules.session.create({
        ...modules, model, term: { rows: 1, cols: width, buffer: { active: buffer } },
        clock: { now: () => now }, timers: {
          setTimeout: () => {
            if (rejectTimer) throw new Error('injected timer failure');
            return 0;
          },
          clearTimeout: () => undefined,
        },
        window: {}, params: { get: (key: string) => key === 'echo' ? '1' : null },
        display: { cursorGrace: 250 }, publish: () => undefined,
      });
      session.dispatch({ type: 'gate', gate: { safe: true, app: 'claude', top: 0, bottom: 1, left: 0, right: width } });
      now += 1000; // The app-switch hold has expired.
      const send = (data: string) => session.dispatch({ type: 'input', command: modules.input.decode(data) });
      const typed = 'alpha bravo charlie';
      send(typed);
      if (editing.name === 'character navigation') {
        const before = session.view();
        const snapshot = JSON.stringify(before);
        rejectTimer = true;
        let rejected = false;
        try { send('x'); } catch { rejected = true; }
        rejectTimer = false;
        if (!rejected || JSON.stringify(session.view()) !== snapshot || JSON.stringify(before) !== snapshot) {
          throw new Error('a failed input edit changed session state or a published view');
        }
        const other = modules.session.create({
          ...modules, model, term: { rows: 1, cols: width, buffer: { active: buffer } },
          clock: { now: () => now }, timers: { setTimeout: () => 0, clearTimeout: () => undefined },
          window: {}, params: { get: () => null }, display: {}, publish: () => undefined,
        });
        other.dispatch({ type: 'disconnect' });
        if (other.view().predicted !== null || JSON.stringify(session.view()) !== snapshot ||
            !Object.isFrozen(before) || !Object.isFrozen(before.predicted)) {
          throw new Error('prediction state escaped its session or its immutable renderer view');
        }
        pass('Failed edits roll back, published views stay immutable, and sessions remain isolated');
      }
      if ('settled' in editing) {
        row = ('❯ ' + typed).padEnd(width);
        buffer.cursorX = 2 + typed.length;
        now += 1000;
        session.dispatch({ type: 'reconcile' });
      }
      // Send each command through the production decoder, including mixed edit runs.
      for (const key of editing.keys.match(/\x1b\[D|\x1bb|\x1b\x7f|\x7f/g) || []) send(key);
      const expected = ('❯ ' + editing.text).padEnd(width);
      const check = () => {
        const burst = session.view().predicted;
        const actual = burst && (burst.line + burst.tail).slice(0, width).padEnd(width);
        if (actual !== expected || burst.line.length !== editing.col) {
          throw new Error(`predicted ${JSON.stringify(actual)} at ${burst?.line.length}, expected ${JSON.stringify(expected)} at ${editing.col}`);
        }
      };
      check();
      if ('settled' in editing) {
        session.dispatch({ type: 'reconcile' });
        now += 300;
        session.dispatch({ type: 'reconcile' });
        check();
      }
      // Every old typing echo arrives before any of the movement/deletion echoes.
      for (let length = ('settled' in editing ? typed.length : 0); length <= typed.length; length++) {
        row = ('❯ ' + typed.slice(0, length)).padEnd(width);
        buffer.cursorX = 2 + length;
        now += 5;
        session.dispatch({ type: 'reconcile' });
        check();
      }
      row = expected;
      buffer.cursorX = editing.col;
      session.dispatch({ type: 'reconcile' });
      check();
      now += 2000;
      if (session.dispatch({ type: 'reconcile' }).view.predicted !== null) {
        throw new Error('the confirmed edit never released its prediction');
      }
      pass(`Delayed typing echoes preserve ${editing.name} and the remaining text`);
    } catch (error) {
      fail(`Delayed echo after ${editing.name}: ${(error as Error).message}`);
    }
  }

  // zsh's default prompt gives no input edge, and after a history recall nothing in the
  // line was typed here, so a deletion cannot be predicted. zsh still performs it.
  for (const [name, key] of [['character', '\x7f'], ['word', '\x1b\x7f']] as const) {
    try {
      const p = pane('zsh', 40, 3);
      p.draw(0, '➜  dir git stauts');
      p.cursor(0, 17);
      p.send('\x1b[A');
      p.wait(1000);
      p.send('\x1b[D');
      const burst = p.send(key).predicted;
      if (burst !== null || !p.probe().hold) {
        throw new Error(`kept ${JSON.stringify(burst?.line)} with hold ${JSON.stringify(p.probe().hold)}`);
      }
      pass(`An unpredictable ${name} deletion hands a moves-only burst back to echo`);
    } catch (error) {
      fail(`Unpredictable ${name} deletion: ${(error as Error).message}`);
    }
  }

  try {
    // zsh-syntax-highlighting colours the command word. On a line already being edited
    // those cells are input, and reading them as a placeholder would blank them.
    const text = '➜  dir git status';
    const p = pane('zsh', 40, 3, (row, col) => row === 0 && col >= 7 && col < 10);
    p.draw(0, text);
    p.cursor(0, 7);
    const burst = p.send('\x1b[C').predicted;
    if (!burst || burst.proven || (burst.line + burst.tail).trimEnd() !== text || burst.line.length !== 8) {
      throw new Error(`Right left ${JSON.stringify(burst && `${burst.line}|${burst.tail.trimEnd()}`)}, proven ${burst?.proven}`);
    }
    pass('Styled input right of the cursor on an edited line stays input');
  } catch (error) {
    fail(`Styled input right of the cursor: ${(error as Error).message}`);
  }

  try {
    const factory = new Function(
      `${runtimeSource('eh-predict-layout.js')}\nreturn EnvHavenConsoleLayout;`,
    )() as { create(deps: unknown): { rowEdge(row: string): number | null } };
    const width = 40;
    const layout = factory.create({
      model, term: { rows: 1, cols: width, buffer: { active: { baseY: 0 } } },
      clock: { now: () => 0 }, display: {}, state: { promptStr: null, wrapStyle: null },
      core: { paneTop: () => 0, paneBottom: () => 1, paneLeft: () => 0, paneRight: () => width },
    });
    // Parrot's and Kali's prompts open with a box glyph that has no gutter after it.
    const wrong = ([
      ['└──╼ $ ls', null], ['└─$ ls', null], ['┃ fx draft', 2], ['│ kimi draft', 2], ['  │   grok draft', 6],
    ] as const).filter(([row, edge]) => layout.rowEdge(row.padEnd(width)) !== edge);
    if (wrong.length) {
      throw new Error(wrong.map(([row, edge]) => `${JSON.stringify(row)} edge ${layout.rowEdge(row.padEnd(width))}, want ${edge}`).join('; '));
    }
    pass('Only a border glyph and its gutter give an unlearned row an input edge');
  } catch (error) {
    fail(`Unlearned border edges: ${(error as Error).message}`);
  }

  try {
    // The renderer owns the cursor for a grace after the last edit, with xterm's hidden.
    // A burst can end inside that grace, and the block then has to show the grid's glyph.
    const factory = new Function(
      `${runtimeSource('eh-predict-renderer.js')}\nreturn EnvHavenConsoleRenderer;`,
    )() as { create(deps: unknown): { render(view: unknown): void } };
    interface FakeElement {
      style: { [key: string]: unknown; setProperty(): void };
      children: FakeElement[];
      textContent: string;
      appendChild(child: FakeElement): FakeElement;
      querySelector(selector: string): FakeElement | null;
    }
    const element = (): FakeElement => {
      const node: FakeElement & Record<string, unknown> = {
        style: { setProperty: () => undefined }, children: [], textContent: '',
        className: '', isConnected: true, clientWidth: 180, clientHeight: 17,
        classList: { add: () => undefined, remove: () => undefined },
        appendChild: (child) => { node.children.push(child); return child; },
        getBoundingClientRect: () => ({ left: 0, right: 0 }),
        querySelector: () => null,
      };
      return node;
    };
    const width = 20, row = '❯ alpha'.padEnd(width), now = 1000;
    const screen = element(), termEl = element();
    termEl.querySelector = (selector) => selector === '.xterm-screen' ? screen : null;
    const line = {
      translateToString: (_trim: boolean, start = 0, end = width) => row.slice(start, end),
      getCell: (x: number) => ({
        getChars: () => row[x], isDim: () => false, isFgDefault: () => true, isInverse: () => false,
      }),
    };
    const renderer = factory.create({
      model, term: { rows: 1, cols: width, buffer: { active: { baseY: 0, cursorY: 0, cursorX: 2, getLine: () => line } } },
      termEl, document: { createElement: element }, getComputedStyle: () => ({}),
      requestAnimationFrame: () => 0, clock: { now: () => now }, connected: () => true,
      theme: { background: () => '#000000' },
      style: { create: () => ({
        ready: () => true, refresh: () => undefined, fontFamily: () => 'monospace', fontSize: () => '13px',
        rowBackground: () => '#000000', rowForeground: () => '#ffffff',
      }) },
    });
    const view = (predicted: unknown) => Object.freeze({
      enabled: true, app: 'claude', top: 0, bottom: 0, left: 0, right: 0,
      predicted, edge: null, boxShift: null, lastEditAt: now - 100,
    });
    const block = () => screen.children[0]?.children
      .find((child) => String(child.style.cssText).includes('z-index:3'))?.textContent;
    renderer.render(view(null));
    const settled = block();
    renderer.render(view({
      absRow: 0, line: '❯ ', tail: 'alpha'.padEnd(width - 2), end: 7,
      dirty: true, matched: false, draining: false, offGrid: false,
    }));
    const editing = block();
    if (settled !== 'a' || editing !== '') {
      throw new Error(`block held ${JSON.stringify(settled)} after the burst and ${JSON.stringify(editing)} during an edit`);
    }
    pass('The cursor block shows the glyph under it once its burst has ended');
  } catch (error) {
    fail(`Cursor block after a burst: ${(error as Error).message}`);
  }

  try {
    // Output can put any URI behind OSC 8 text. xterm's own provider offers http(s) only,
    // and the provider registered ahead of it has to keep that rule.
    const factory = new Function(`${predictorSource}\nreturn EnvHavenConsolePredictor;`)() as {
      create(deps: unknown): unknown;
    };
    interface OfferedLink { text: string; activate(event: unknown, text: string): void }
    const seen: {
      provider?: { provideLinks(line: number, callback: (links: OfferedLink[] | undefined) => void): void };
      activate?: (event: unknown, text: string) => void;
    } = {};
    const opened: string[] = [];
    const uris = ['vscode://x', 'https://x'];
    const noop = () => undefined;
    const line = {
      translateToString: () => 'two link runs',
      getCell: (x: number) => ({ hasExtendedAttrs: () => true, extended: { urlId: x < 10 ? 1 : 2 } }),
    };
    const term = {
      cols: 20, options: {},
      buffer: { active: { getLine: (row: number) => row === 0 ? line : undefined } },
      _core: { _oscLinkService: { getLinkData: (id: number) => ({ uri: uris[id - 1] }) } },
      loadAddon: noop, open: noop, attachCustomKeyEventHandler: noop, onData: noop, onRender: noop, onResize: noop,
      registerLinkProvider: (provider: NonNullable<typeof seen.provider>) => { seen.provider = provider; },
    };
    const page = {
      document: {
        body: { style: {} }, getElementById: () => ({}),
        fonts: { load: () => Promise.resolve(), check: () => false },
      },
      location: { search: '' }, navigator: { platform: '' }, URL,
      addEventListener: noop, open: (url: string) => { opened.push(url); },
    };
    factory.create({
      model, render: { window: page }, socket: { URLSearchParams },
      terminal: {
        create: (options: { linkHandler: { activate(event: unknown, text: string): void } }) => {
          seen.activate = options.linkHandler.activate;
          return term;
        },
        createFitAddon: () => ({ fit: noop }),
      },
      renderer: { create: () => ({ render: noop }) },
      session: { create: () => ({ view: () => ({}) }) },
      status: { create: () => ({}) },
      auth: { create: () => ({}) },
      transport: { create: () => ({ isReady: () => true, connect: noop }) },
      clipboard: { create: noop },
    });
    const offered: OfferedLink[] = [];
    seen.provider!.provideLinks(1, (links) => { offered.push(...(links ?? [])); });
    for (const link of offered) link.activate({}, link.text);
    seen.activate!({}, 'vscode://x');
    seen.activate!({}, 'javascript:alert(1)');
    const texts = offered.map((link) => link.text);
    if (JSON.stringify(texts) !== '["https://x"]' || JSON.stringify(opened) !== '["https://x"]') {
      throw new Error(`offered ${JSON.stringify(texts)} and opened ${JSON.stringify(opened)}`);
    }
    pass('Terminal links offer and open only http and https URLs');
  } catch (error) {
    fail(`Terminal link schemes: ${(error as Error).message}`);
  }
}
