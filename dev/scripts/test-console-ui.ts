#!/usr/bin/env bun
// Static gate for the console's terminal page and its engine.
//
// console/ui/terminal.html and console/ui/assets/eh-engine.js are embedded into the
// console binary by //go:embed and served verbatim. Nothing else in CI looks inside
// either: the Go job checks Go, and the image job only greps the served page for its
// <title>. So a syntax error anywhere in the engine shipped green, and the terminal
// would be a black rectangle for every user.
//
// This parses the engine the way the browser will. `new Function` compiles the body
// without running it, which is exactly what we want: no DOM, no xterm, no side effects.
// It is a parser, not a browser, and the difference is worth stating: a function body
// permits top-level `return`, which a classic <script> rejects, and nothing here can see
// a runtime fault at all, so a renamed helper or a dead selector still ships green. What
// this catches is the class that used to ship silently, which is malformed syntax and
// drift in the page's structural contract.
import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT, log, formatTestSummary } from './lib';

const PAGE = join(REPO_ROOT, 'console/ui/terminal.html');
const ENGINE = join(REPO_ROOT, 'console/ui/assets/eh-engine.js');

// Third-party bundles, hash-pinned by TestVendoredAssetsPristine, and offline
// self-hosting depends on them being local. Pinning the exact set, rather than only
// rejecting foreign ones, is deliberate: a loop over "every external reference" asserts
// nothing at all when someone deletes the references, and a page that loads no xterm is
// as broken as one that loads it from a CDN.
const VENDORED = [
  '/__console/assets/xterm.css',
  '/__console/assets/xterm.js',
  '/__console/assets/addon-fit.js',
];
// Ours, and load-bearing in a way the vendored three are not: this IS the terminal.
const ENGINE_SRC = '/__console/assets/eh-engine.js';

let passed = 0;
let failed = 0;
function pass(msg: string) { log.success(msg); passed++; }
function fail(msg: string) { log.error(msg); failed++; }

log.header('Console terminal page');

const html = readFileSync(PAGE, 'utf8');
const engine = readFileSync(ENGINE, 'utf8');

// The <title> the image job greps for over HTTP. Pin it here too, so a rename fails in
// seconds rather than after a full image build.
if (html.includes('<title>EnvHaven Terminal</title>')) pass('Page title intact');
else fail('Page title changed; .github/workflows/ci.yml greps for "EnvHaven Terminal"');

// Every <script> in the document with its attributes, so the classification below cannot
// be dodged by an attribute. Matching only a bare `<script>` let `<script type="module">`
// carry unparsed code past both the count and the parser.
const tags = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
const inline = tags.filter((m) => !/\bsrc\s*=/.test(m[1]));

// The engine has its own file now. An inline block reappearing means JavaScript went
// somewhere no tool will parse and no editor will highlight, which is the state this
// page was moved out of.
if (inline.length === 0) pass('No inline script in the page');
else fail(`The page carries ${inline.length} inline script block(s); the engine belongs in ${ENGINE_SRC}`);

// A bare <script src>, loaded after the bundles, is part of the contract rather than a
// formatting preference. `type="module"` would defer the engine and make it strict;
// `async`/`defer` would let it run before the vendored bundles it reads at parse time.
// Any of those breaks the page while still parsing cleanly.
const engineTag = tags.find((m) => m[1].includes(ENGINE_SRC));
const srcOrder = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
if (!engineTag) {
  fail(`The page does not load ${ENGINE_SRC}`);
} else if (/\b(type|async|defer)\s*=/.test(engineTag[1])) {
  fail(`The engine tag carries "${engineTag[1].trim()}"; it must be a plain <script src>`);
} else {
  const late = ['/__console/assets/xterm.js', '/__console/assets/addon-fit.js']
    .filter((v) => srcOrder.indexOf(v) === -1 || srcOrder.indexOf(v) > srcOrder.indexOf(ENGINE_SRC));
  if (late.length) fail(`The engine loads before ${late.join(', ')}, which it needs at parse time`);
  else pass('Engine is a plain <script src>, after the bundles it depends on');
}

try {
  new Function(engine); // compiles, does not execute
  pass(`Engine parses (${engine.split('\n').length} lines)`);
} catch (e) {
  fail(`console/ui/assets/eh-engine.js is not valid JavaScript: ${(e as Error).message}`);
}

// Every reference the browser resolves, whatever tag or attribute order carries it.
const refs = [...html.matchAll(/\s(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
for (const want of [...VENDORED, ENGINE_SRC]) {
  if (refs.includes(want)) pass(`Asset referenced: ${want}`);
  else fail(`Missing asset reference: ${want}`);
}
const foreign = refs.filter((r) => !r.startsWith('/__console/assets/'));
if (foreign.length === 0) pass('No external asset references');
else fail(`External asset reference(s): ${foreign.join(', ')}`);

// The e2e probe must not be reachable through the documented product flag. ?echo=1 is
// advertised in docs/configuration.md; the probe needs its own switch, or every user who
// turns predictive echo on also gets a global that vends terminal rows. Checking that a
// gated line EXISTS proved nothing: a second, ungated assignment beside it passed, and so
// did renaming the global, which landed in the "no probe here" branch. Enumerate every
// line that names a probe global instead, and require each one to be gated.
const probeLines = engine.split('\n')
  .map((line, i) => ({ n: i + 1, line }))
  .filter(({ line }) => /window\.__eh[A-Za-z]*\s*=/.test(line));
const ungated = probeLines.filter(({ line }) => !line.includes("params.get('probe') === '1'"));
if (probeLines.length === 0) pass('No debug probe in the engine');
else if (ungated.length === 0) pass(`Debug probe gated behind ?probe=1 (${probeLines.length} site)`);
else fail(`Ungated debug global at line(s) ${ungated.map((p) => p.n).join(', ')}: must be behind ?probe=1`);

formatTestSummary(passed, failed);
process.exit(failed === 0 ? 0 : 1);
