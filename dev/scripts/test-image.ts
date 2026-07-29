#!/usr/bin/env bun
import { $ } from 'bun';
import { loadConfig, log, formatTestSummary, dockerExec, shellErrorText } from './lib';
import toolDefs from '../../tool-definitions.json';

const config = loadConfig();
const stamp = Date.now();
const containerName = `envhaven-test-${stamp}`;
const noPasswordName = `envhaven-test-nopass-${stamp}`;

// Two kinds of check live in this file, and conflating them is what drove the old CI
// steps to guess at sleeps. `boot` marks the ones that only become true once s6 has
// finished bringing a container up; they share one budget, because they are all waiting
// on the same startup. Everything else is a property of the image, true from the moment
// the container exists, so it runs exactly once: a missing tool is a regression to
// report in a second, not something to retry for minutes.
//
// The budget's floor is init-zsh-config, which waits up to its own MAX_WAIT of 120s for
// the zsh mod to write /config/.zshrc and only then gives up
// (runtime/scripts/init-zsh-config-run) — svc-console is one of the services blocked
// behind that oneshot. Ahead of it, LSIO's mod-init fetches DOCKER_MODS from lscr.io,
// which is the part that varies with the network. Three minutes clears both.
const BOOT_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 2000;

// Fixed, not config.password. These containers are thrown away at the end of the run, so
// the value carries no meaning, and the console check below splices it into a shell
// string — a configured password is free text that may contain spaces or quotes, and
// does not belong there.
const TEST_PASSWORD = 'testpass';

interface Test {
  name: string;
  cmd: string;
  /** Defaults to the password container. */
  container?: string;
  /** Only true once s6 has brought the container up; polled against the shared budget. */
  boot?: boolean;
  user?: string;
  env?: Record<string, string>;
}

const toolCommands = toolDefs.tools.map(({ command }) => command);

// Runs as abc with HOME=/config — the uid and home every workspace process actually gets,
// so a tool that resolves here resolves for the people who use the container. Root has
// neither, and it bypasses DAC on top, which is precisely what the filesystem checks below
// are trying to observe.
const asUser = { user: 'abc', env: { HOME: '/config' } };

const tests: Test[] = [
  { name: 'code-server health', cmd: 'curl -sf http://localhost:8443/healthz', boot: true },
  { name: 'SSH daemon', cmd: 'pgrep sshd', boot: true },
  {
    name: 'browser terminal page',
    cmd: `curl -sf http://localhost:7681/__console/ui | grep -q 'EnvHaven Terminal'`,
    boot: true,
  },

  // Produced by the init-* oneshots, which hang off init-adduser on a different branch of
  // the s6 graph than code-server — /healthz says nothing about whether these ran yet.
  // Read as abc, because a file the workspace user cannot read is not a file that exists
  // as far as the product is concerned, and root's `test -f` cannot tell the difference.
  { name: 'AGENTS.md', cmd: 'test -r /config/workspace/AGENTS.md', boot: true, ...asUser },
  {
    name: 'VS Code settings',
    cmd: 'test -r /config/data/User/settings.json',
    boot: true,
    ...asUser,
  },
  {
    name: 'artifacts drop folder',
    // -w, not just -d: agents write their downloadable output here, so the ownership
    // init-user-config sets is the whole point of the folder.
    cmd: 'test -d /config/artifacts && test -w /config/artifacts',
    boot: true,
    ...asUser,
  },
  {
    name: 'claude seed symlink',
    cmd: 'test -L /config/.local/bin/claude && test -x /config/.local/bin/claude',
    boot: true,
    ...asUser,
  },

  // The gate's mechanism, asserted directly. With neither a managed marker nor a web
  // password, svc-console-run disables its own service with `s6-svc -Od .` and exits 0
  // (runtime/scripts/svc-console-run), which is the state below. It doubles as the
  // positive control, because s6-svstat cannot report that early: before the servicedir is
  // supervised it errors, and between then and the run script it says `down (not started
  // yet)`. Neither matches, so this waits rather than passing on a container that has
  // simply not got there yet.
  {
    name: 'no-password container: console service disabled',
    cmd: `s6-svstat /run/service/svc-console | grep -q 'down (exitcode 0)'`,
    container: noPasswordName,
    boot: true,
  },

  // Everything below runs once, and only if every boot check above passed. These are
  // properties of the image rather than of a running container, so a failure here is a
  // regression to report in a second, not something to wait out.

  // The documented login -> cookie -> token flow, end to end through the real s6-launched
  // binary. One block rather than three tests: the cookie jar ties the steps together,
  // and splitting them would hide that coupling behind list order. Deliberately not a
  // boot check even though it needs the console — `browser terminal page` above already
  // waited for that, and retrying this one would spend the console's own brute-force
  // budget (10 attempts/min, console/selfhost.go:57-59) on its two logins per attempt,
  // until a 429 replaced whatever the real failure was.
  {
    name: 'console login and token flow',
    cmd:
      `set -e; ` +
      `[ "$(curl -s -o /dev/null -w '%{http_code}' -d password=wrong http://localhost:7681/__console/login)" = 401 ]; ` +
      `[ "$(curl -s -o /dev/null -w '%{http_code}' -c /tmp/cj -d password=${TEST_PASSWORD} http://localhost:7681/__console/login)" = 204 ]; ` +
      `curl -sf -b /tmp/cj http://localhost:7681/__console/token | grep -qE '^[0-9]+\\.'`,
  },
  // The user-visible half of the same promise: no password, no port. On its own this
  // would also be satisfied by a console that started and crashed, which is why the boot
  // check above asserts the service exited 0 rather than merely that nothing is listening.
  {
    name: 'console gate holds without a password',
    cmd: '! curl -s --max-time 2 http://localhost:7681/',
    container: noPasswordName,
  },

  // --version, not `which`: cloudflared comes from mise, which writes a shim because the
  // tool is listed in mise.toml, not because it installed. This is the only cloudflared
  // gate anywhere, and svc-cloudflared is a supervised longrun that execs it.
  { name: 'cloudflared', cmd: 'cloudflared --version', ...asUser },

  { name: 'Node.js', cmd: 'node --version', ...asUser },
  { name: 'Python', cmd: 'python --version', ...asUser },
  { name: 'Go', cmd: 'go version', ...asUser },
  { name: 'Rust', cmd: 'rustc --version', ...asUser },
  { name: 'Bun', cmd: 'bun --version', ...asUser },

  { name: 'pnpm', cmd: 'pnpm --version', ...asUser },
  { name: 'yarn', cmd: 'yarn --version', ...asUser },
  { name: 'uv', cmd: 'uv --version', ...asUser },

  { name: 'gh', cmd: 'gh --version', ...asUser },
  { name: 'fd', cmd: 'fd --version', ...asUser },
  { name: 'ripgrep', cmd: 'rg --version', ...asUser },
  { name: 'jq', cmd: 'jq --version', ...asUser },
  { name: 'sqlite3', cmd: 'sqlite3 --version', ...asUser },
  { name: 'zsh', cmd: 'zsh --version', ...asUser },

  // The per-tool checks below are generated from the REPO's tool-definitions.json; this
  // one counts the IMAGE's copy. Comparing them is the only thing that catches an image
  // built from a different tree than the one being tested, which is now a normal thing to
  // do (ENVHAVEN_IMAGE=ghcr.io/... points the harness at a release). An exact count also
  // fails when jq errors or the list is empty, which a bare loop would pass.
  {
    name: 'tool roster matches the repo',
    cmd: `[ "$(jq -r '.tools | length' /opt/envhaven/tool-definitions.json)" -eq ${toolCommands.length} ]`,
    ...asUser,
  },
  ...toolCommands.map((command) => ({
    name: command,
    cmd: `${command} --version`,
    ...asUser,
  })),

  // Every tool must resolve to a real binary outside /config, because users mount a
  // volume there and it hides whatever the build left behind. A `--version` gate can't
  // catch this: /config/.local/bin leads PATH, so a misplaced tool passes at build time
  // and goes missing in production. See docs/architecture.md § The Volume Mount Problem.
  {
    name: 'tools resolve outside /config',
    cmd:
      `for t in ${toolCommands.join(' ')}; do ` +
      `case "$(readlink -f "$(command -v "$t")")" in /config/*) ` +
      `echo "$t resolves inside /config; a volume mount would hide it" >&2; exit 1;; esac; done`,
    ...asUser,
  },
];

// A tool name with a space or a shell metacharacter would split the `for` loop above into
// nonsense and report as a lookup failure rather than as bad data. tool-definitions.json
// is edited every time a tool is added, so say which value is wrong.
for (const command of toolCommands) {
  if (!/^[A-Za-z0-9._-]+$/.test(command)) {
    log.error(`tool-definitions.json: command "${command}" is not a bare executable name`);
    process.exit(1);
  }
}

// Assigned as soon as the containers are asked for. cleanup() waits on it, because
// `docker rm` on a container that is still being created is a no-op and leaves it
// running — a signal arriving between the two `docker run` calls is exactly that case.
let startPromise: Promise<PromiseSettledResult<unknown>[]> = Promise.resolve([]);

// Memoised rather than flagged, so a second signal awaits the first cleanup instead of
// exiting while `docker rm` is still in flight.
let cleanupPromise: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    await startPromise.catch(() => {});
    log.dim('Cleaning up test containers...');
    // -v drops the anonymous volume the image's `VOLUME /config` creates on every run.
    await $`docker rm -f -v ${containerName} ${noPasswordName}`.quiet().nothrow();
  })();
  return cleanupPromise;
}

// Both containers carry a timestamp in their name, so one that leaks is invisible to
// stop.ts and has to be hunted by hand. Interrupting the boot wait is how that happens.
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));
process.on('SIGTERM', () => void cleanup().then(() => process.exit(143)));

function runOnce(test: Test) {
  const target = test.container ?? containerName;
  return dockerExec(target, test.cmd, { user: test.user, env: test.env });
}

async function pollUntilReady(test: Test, deadline: number) {
  for (;;) {
    const result = await runOnce(test);
    if (result.success || Date.now() >= deadline) return result;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

log.info(`Testing image: ${config.image}`);
log.info('Starting test containers...');

// With a password the documented console flow works; without one the gate holds and 7681
// never opens. Both are the image's real behaviour, so both need a container, and they
// start together so neither is penalised for being second.
// allSettled rather than all: `all` rejects while the other `docker run` is still in
// flight, so cleanup could fire before the surviving container exists and leak it.
startPromise = Promise.allSettled([
  $`docker run -d --name ${containerName} -e PASSWORD=${TEST_PASSWORD} -e SUDO_PASSWORD=${TEST_PASSWORD} ${config.image}`.quiet(),
  $`docker run -d --name ${noPasswordName} ${config.image}`.quiet(),
]);
const started = await startPromise;

const startFailures = started.filter((r) => r.status === 'rejected');
if (startFailures.length > 0) {
  log.error('Failed to start test containers');
  for (const failure of startFailures) log.plain(shellErrorText(failure.reason));
  await cleanup();
  process.exit(1);
}

// Boot checks first, unconditionally, rather than by where they sit in the array. The old
// version relied on a comment asking authors to keep them at the top, and the four
// oneshot-produced filesystem checks were already at the bottom in breach of it.
const bootChecks = tests.filter((test) => test.boot);
const imageChecks = tests.filter((test) => !test.boot);

log.dim(
  `Running ${bootChecks.length} boot checks (up to ${BOOT_TIMEOUT_MS / 1000}s) ` +
    `then ${imageChecks.length} image checks...`
);

const deadline = Date.now() + BOOT_TIMEOUT_MS;
let passed = 0;
let failed = 0;
const failedContainers = new Set<string>();

function record(test: Test, result: { success: boolean; output: string }): boolean {
  if (result.success) {
    const version = result.output.split('\n')[0] || '';
    log.success(`${test.name}${version ? `: ${version}` : ''}`);
    passed++;
    return true;
  }
  log.error(test.name);
  // The reason, not just the name. Reproducing a red check by hand somewhere else is
  // the cost of throwing this away.
  if (result.output) log.plain(result.output);
  failed++;
  failedContainers.add(test.container ?? containerName);
  return false;
}

try {
  // The boot checks are a gate, not merely the section that runs first. Whichever one
  // exhausts the budget has already established that the container never came up, and
  // every check after it would then get a single doomed attempt — turning one honest
  // failure into a page of them with nothing marking which is the cause.
  let booted = true;
  for (const test of bootChecks) {
    if (!record(test, await pollUntilReady(test, deadline))) {
      booted = false;
      break;
    }
  }

  if (booted) {
    for (const test of imageChecks) record(test, await runOnce(test));
  } else {
    log.warn(`Container never finished starting; skipped ${imageChecks.length} image checks`);
  }

  // Every container that failed something, not just the default one — the gate check runs
  // against the other container and its logs are the only place its answer is written.
  // Whole log, not a tail: a failed DOCKER_MODS fetch or a oneshot that gave up prints
  // during startup, minutes before the tail this would otherwise show.
  for (const name of failedContainers) {
    log.newline();
    log.header(`Container logs: ${name}`);
    await $`docker logs ${name}`.nothrow();
  }
} finally {
  await cleanup();
}

formatTestSummary(passed, failed);
process.exit(failed === 0 ? 0 : 1);
