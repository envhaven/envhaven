import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT } from '../config';
import { BROWSER_RUNTIME_ASSETS } from '../engine';
import { exact } from './fixtures';
import type { TestReporter } from './types';

const PAGE = join(REPO_ROOT, 'console/ui/terminal.html');
const VENDORED = [
  '/__console/assets/xterm.css',
  '/__console/assets/xterm.js',
  '/__console/assets/addon-fit.js',
] as const;
const EXPECTED_RUNTIME = [
  'eh-model.js',
  'eh-predict-input.js',
  'eh-predict-layout.js',
  'eh-predict-navigation.js',
  'eh-predict-actions.js',
  'eh-predict-style.js',
  'eh-predict-renderer.js',
  'eh-predict-reconcile.js',
  'eh-predict-session.js',
  'eh-status.js',
  'eh-auth.js',
  'eh-clipboard.js',
  'eh-transport.js',
  'eh-predictor.js',
  'eh-engine.js',
] as const;
const PREDICTION_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  'eh-predict-input.js': [],
  'eh-predict-layout.js': ['clock', 'core', 'display', 'model', 'state', 'term'],
  'eh-predict-navigation.js': ['core', 'layout', 'model', 'state', 'term'],
  'eh-predict-actions.js': ['clock', 'core', 'layout', 'model', 'navigation', 'state', 'term'],
  'eh-predict-style.js': ['getComputedStyle', 'model', 'term', 'termEl', 'theme'],
  'eh-predict-renderer.js': [
    'clock', 'connected', 'document', 'getComputedStyle', 'model',
    'requestAnimationFrame', 'style', 'term', 'termEl', 'theme',
  ],
  'eh-predict-reconcile.js': ['clock', 'core', 'display', 'layout', 'model', 'state', 'term'],
  'eh-predict-session.js': [
    'actions', 'clock', 'display', 'layout', 'model', 'navigation',
    'params', 'publish', 'reconcile', 'term', 'timers', 'window',
  ],
  'eh-predictor.js': [
    'actions', 'auth', 'clipboard', 'clock', 'input', 'layout', 'model',
    'navigation', 'reconcile', 'render', 'renderer', 'session', 'socket',
    'status', 'style', 'terminal', 'timers', 'transport',
  ],
};
const MAX_RUNTIME_LINES = 750;

const runtimeAssets = BROWSER_RUNTIME_ASSETS.map((asset) => ({
  ...asset,
  url: `/__console/assets/${asset.name}`,
  contents: asset.source(),
}));

function runtimeSource(name: string): string {
  const asset = runtimeAssets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`unknown browser runtime asset: ${name}`);
  return asset.contents;
}

function codeOnly(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '');
}

export function runAssetManifestTests(report: TestReporter): void {
  const { pass, fail } = report;
  const html = readFileSync(PAGE, 'utf8');
  const engine = runtimeSource('eh-engine.js');
  const predictor = runtimeSource('eh-predictor.js');
  const session = runtimeSource('eh-predict-session.js');
  const input = runtimeSource('eh-predict-input.js');
  const renderer = runtimeSource('eh-predict-renderer.js');

  try {
    const names = runtimeAssets.map((asset) => asset.name);
    if (names.length !== EXPECTED_RUNTIME.length ||
        names.some((name, index) => name !== EXPECTED_RUNTIME[index])) {
      throw new Error(`browser runtime assets must be ${JSON.stringify(EXPECTED_RUNTIME)}, got ${JSON.stringify(names)}`);
    }
    pass(`Runtime manifest pins ${runtimeAssets.length} first-party assets`);
  } catch (error) {
    fail(`Runtime manifest contract failed: ${(error as Error).message}`);
  }

  if (html.includes('<title>EnvHaven Terminal</title>')) pass('Page title intact');
  else fail('Page title changed; dev/scripts/test-image.ts greps for "EnvHaven Terminal"');

  const tags = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  const inline = tags.filter((match) => !/\bsrc\s*=/.test(match[1]!));
  if (inline.length === 0) pass('No inline script in the page');
  else fail(`The page carries ${inline.length} inline script block(s); the engine belongs in its asset`);

  const runtimeTags = runtimeAssets.map((asset) => ({
    asset,
    tag: tags.find((candidate) => candidate[1]!.includes(asset.url)),
  }));
  const sourceOrder = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*"([^"]*)"/g)]
    .map((match) => match[1]!);
  if (runtimeTags.some(({ tag }) => !tag)) {
    fail(`The page is missing: ${runtimeTags.filter(({ tag }) => !tag).map(({ asset }) => asset.url).join(', ')}`);
  } else if (runtimeTags.some(({ tag }) => /\b(type|async|defer)(?:\s*=|\s|$)/.test(tag![1]!))) {
    fail('First-party runtime assets must use plain synchronous <script src> tags');
  } else {
    const expectedOrder = [
      '/__console/assets/xterm.js',
      '/__console/assets/addon-fit.js',
      ...runtimeAssets.map((asset) => asset.url),
    ];
    const positions = expectedOrder.map((url) => sourceOrder.indexOf(url));
    const wrong = positions.some((position) => position === -1) ||
      positions.some((position, index) => index > 0 && position <= positions[index - 1]!);
    if (wrong) fail(`Runtime script order is ${JSON.stringify(sourceOrder)}, want ${JSON.stringify(expectedOrder)}`);
    else pass('Runtime assets are synchronous classic scripts in dependency order');
  }

  const lineCounts = runtimeAssets.map((asset) => ({
    name: asset.name,
    lines: asset.contents.split('\n').length - (asset.contents.endsWith('\n') ? 1 : 0),
  }));
  const oversized = lineCounts.filter((asset) => asset.lines >= MAX_RUNTIME_LINES);
  if (oversized.length === 0) {
    pass(`Every first-party runtime asset stays below ${MAX_RUNTIME_LINES} lines (${lineCounts.map((asset) => `${asset.name}:${asset.lines}`).join(', ')})`);
  } else {
    fail(`Runtime asset line limit exceeded: ${oversized.map((asset) => `${asset.name}:${asset.lines}`).join(', ')}`);
  }

  try {
    new Function(engine);
    if (!engine.includes('EnvHavenConsolePredictor.create({')) {
      throw new Error('adapter does not create the controller');
    }
    for (const dependency of runtimeAssets.flatMap((asset) => asset.factory ? [asset.factory] : [])) {
      if (!engine.includes(dependency)) throw new Error(`adapter does not inject ${dependency}`);
    }
    if (engine.split('\n').length >= predictor.split('\n').length) {
      throw new Error('adapter is not smaller than the stateful controller');
    }
    pass(`Browser adapter parses (${engine.split('\n').length} lines)`);
  } catch (error) {
    fail(`console/ui/assets/eh-engine.js is not valid JavaScript: ${(error as Error).message}`);
  }

  try {
    for (const asset of runtimeAssets.filter((candidate) => candidate.factory !== null)) {
      const factory = new Function(`${asset.contents}\nreturn ${asset.factory};`)() as {
        create?: unknown;
        decode?: unknown;
      };
      const valid = asset.name === 'eh-model.js' ||
        (asset.name === 'eh-predict-input.js' ? typeof factory.decode === 'function' : typeof factory.create === 'function');
      if (!factory || !valid) throw new Error(`${asset.name} does not expose ${asset.factory}`);
    }
    pass(`Browser runtime factories parse (${runtimeAssets.filter((asset) => asset.factory).length} factories)`);
  } catch (error) {
    fail(`Browser runtime factory contract failed: ${(error as Error).message}`);
  }

  try {
    for (const [name, allowed] of Object.entries(PREDICTION_DEPENDENCIES)) {
      const actual = [...codeOnly(runtimeSource(name)).matchAll(/\bdeps\.([A-Za-z][A-Za-z0-9_]*)/g)]
        .map((match) => match[1]!)
        .filter((value, index, values) => values.indexOf(value) === index);
      exact(actual, allowed, `${name} dependencies`);
    }
    const globals = runtimeAssets.flatMap((asset) => asset.factory ? [asset.factory] : []);
    for (const asset of runtimeAssets.filter((candidate) => candidate.factory)) {
      const source = codeOnly(asset.contents);
      for (const dependency of globals) {
        if (dependency !== asset.factory && new RegExp(`\\b${dependency}\\b`).test(source)) {
          throw new Error(`${asset.name} reaches global ${dependency} instead of an injected dependency`);
        }
      }
    }
    pass('Prediction dependencies are explicit and flow toward the session composition boundary');
  } catch (error) {
    fail(`Prediction dependency contract failed: ${(error as Error).message}`);
  }

  try {
    const predictionNames = Object.keys(PREDICTION_DEPENDENCIES);
    const predictionModules = predictionNames.map(runtimeSource);
    if (predictionModules.some((source) => /\bcore\.state\b/.test(codeOnly(source)))) {
      throw new Error('a module reaches through core.state');
    }
    if (predictionModules.some((source) => /\bbindRenderer\b|\bfunction\s+bind\s*\(|\.bind\s*\(/.test(codeOnly(source)))) {
      throw new Error('a post-construction bind seam remains');
    }
    if (/\bdeps\.(?:core|input|session|actions)\b|\bcore\.|\binput\./.test(codeOnly(renderer))) {
      throw new Error('renderer depends on a mutable prediction collaborator');
    }
    if (/\bfunction\s+create\b|\b(?:core|state)\s*=/.test(codeOnly(input)) ||
        !input.includes('return { decode: decode };')) {
      throw new Error('terminal input owns state instead of submitting commands');
    }
    if (!session.includes('return Object.freeze({ view: nextView') ||
        !predictor.includes("session.dispatch({ type: 'input', command: deps.input.decode(effect.data) })") ||
        !predictor.includes("if (effect.type === 'render') renderer.render(effect.view)")) {
      throw new Error('commands or immutable views bypass the prediction-session boundary');
    }
    pass('Input submits commands and the renderer consumes immutable views');
  } catch (error) {
    fail(`Prediction architecture contract failed: ${(error as Error).message}`);
  }

  const refs = [...html.matchAll(/\s(?:src|href)\s*=\s*"([^"]*)"/g)].map((match) => match[1]!);
  for (const wanted of [...VENDORED, ...runtimeAssets.map((asset) => asset.url)]) {
    if (refs.includes(wanted)) pass(`Asset referenced: ${wanted}`);
    else fail(`Missing asset reference: ${wanted}`);
  }
  const foreign = refs.filter((reference) => !reference.startsWith('/__console/assets/'));
  if (foreign.length === 0) pass('No external asset references');
  else fail(`External asset reference(s): ${foreign.join(', ')}`);

  const probeAssignments = runtimeAssets.flatMap((asset) =>
    [...asset.contents.matchAll(/window\.__eh[A-Za-z]*\s*=/g)]
      .map((match) => ({ asset: asset.name, index: match.index })),
  );
  const gatedProbe = /if \(echoEnabled && params\.get\('probe'\) === '1'\)\s*\{\s*window\.__ehPredict\s*=/.test(session);
  if (probeAssignments.length === 0) pass('No debug probe in the runtime');
  else if (probeAssignments.length === 1 && gatedProbe) pass('Debug probe has one owner behind ?probe=1');
  else fail(`Debug probe ownership is not singular and gated: ${JSON.stringify(probeAssignments)}`);
}
