#!/usr/bin/env bun
// Static gate for the console's terminal page.
//
// console/ui/terminal.html is embedded into the console binary by //go:embed and served
// verbatim. Nothing else in CI looks inside it: the Go job checks Go, and the image job
// only greps the served page for its <title>. So a syntax error anywhere in its script
// shipped green, and the terminal would be a black rectangle for every user.
//
// This parses the script the way the browser will. `new Function` compiles the body
// without running it, which is exactly what we want: no DOM, no xterm, no side effects.
// It is a parser, not a browser, and the difference is worth stating: a function body
// permits top-level `return`, which a classic <script> rejects, and nothing here can see
// a runtime fault at all — a renamed helper or a dead selector still ships green. What
// this catches is the class that used to ship silently, which is malformed syntax and
// drift in the page's structural contract.
import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT, log, formatTestSummary } from './lib';

const PAGE = join(REPO_ROOT, 'console/ui/terminal.html');

// The page promises it fetches nothing external: TestVendoredAssetsPristine hash-pins
// these files and offline self-hosting depends on them being local. Pinning the exact
// set, rather than only rejecting foreign ones, is deliberate — a loop over "every
// external reference" asserts nothing at all when someone deletes the references, and
// a page that loads no xterm is as broken as one that loads it from a CDN.
const VENDORED = [
  '/__console/assets/xterm.css',
  '/__console/assets/xterm.js',
  '/__console/assets/addon-fit.js',
];

let passed = 0;
let failed = 0;
function pass(msg: string) { log.success(msg); passed++; }
function fail(msg: string) { log.error(msg); failed++; }

log.header('Console terminal page');

const html = readFileSync(PAGE, 'utf8');

// The <title> the image job greps for over HTTP. Pin it here too, so a rename fails in
// seconds rather than after a full image build.
if (html.includes('<title>EnvHaven Terminal</title>')) pass('Page title intact');
else fail('Page title changed; .github/workflows/ci.yml greps for "EnvHaven Terminal"');

// Every <script> in the document with its attributes, so the classification below cannot
// be dodged by an attribute. Matching only a bare `<script>` let `<script type="module">`
// carry unparsed code past both the count and the parser.
const tags = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
const inline = tags.filter((m) => !/\bsrc\s*=/.test(m[1]));

if (inline.length === 1) pass(`Exactly one inline script block (${inline[0][2].trim().split('\n').length} lines)`);
else fail(`Expected 1 inline script block, found ${inline.length}`);

// A bare <script> is part of the contract, not a formatting preference: `type="module"`
// would defer the engine and give it module scope, `async`/`defer` would let the vendored
// bundles land after it. Any of those breaks the page while still parsing cleanly.
for (const [i, m] of inline.entries()) {
  if (m[1].trim() === '') pass(`Inline script ${i + 1} is a plain <script>`);
  else fail(`Inline script ${i + 1} carries attributes "${m[1].trim()}"; the engine must be a bare <script>`);
}

for (const [i, m] of inline.entries()) {
  try {
    new Function(m[2]); // compiles, does not execute
    pass(`Inline script ${i + 1} parses`);
  } catch (e) {
    fail(`Inline script ${i + 1} is not valid JavaScript: ${(e as Error).message}`);
  }
}

// Every reference the browser resolves, whatever tag or attribute order carries it.
const refs = [...html.matchAll(/\s(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
for (const want of VENDORED) {
  if (refs.includes(want)) pass(`Vendored asset referenced: ${want}`);
  else fail(`Missing vendored asset reference: ${want}`);
}
const foreign = refs.filter((r) => !r.startsWith('/__console/assets/'));
if (foreign.length === 0) pass('No external asset references');
else fail(`External asset reference(s): ${foreign.join(', ')}`);

// The e2e probe must not be reachable through the documented product flag. ?echo=1 is
// advertised in docs/configuration.md; the probe needs its own switch, or every user who
// turns predictive echo on also gets a global that vends terminal rows. Checking that a
// gated line EXISTS proved nothing — a second, ungated assignment beside it passed, and
// so did renaming the global, which landed in the "no probe here" branch. Enumerate every
// line that names a probe global instead, and require each one to be gated.
const probeLines = html.split('\n')
  .map((line, i) => ({ n: i + 1, line }))
  .filter(({ line }) => /window\.__eh[A-Za-z]*\s*=/.test(line));
const ungated = probeLines.filter(({ line }) => !line.includes("params.get('probe') === '1'"));
if (probeLines.length === 0) pass('No debug probe in the page');
else if (ungated.length === 0) pass(`Debug probe gated behind ?probe=1 (${probeLines.length} site)`);
else fail(`Ungated debug global at line(s) ${ungated.map((p) => p.n).join(', ')}: must be behind ?probe=1`);

formatTestSummary(passed, failed);
process.exit(failed === 0 ? 0 : 1);
