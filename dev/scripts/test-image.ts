#!/usr/bin/env bun
import {
  loadConfig,
  log,
  formatTestSummary,
  dockerExec,
  runBoundedProcess,
  type ProcessResult,
} from './lib';
import toolDefs from '../../tool-definitions.json';

const config = loadConfig();
const stamp = Date.now();
const containerName = `envhaven-test-${stamp}`;
const noPasswordName = `envhaven-test-nopass-${stamp}`;
const hashPasswordName = `envhaven-test-hash-${stamp}`;
const filesystemSecurityName = `envhaven-test-fs-${stamp}`;

// Two kinds of check live in this file, and conflating them is what drove the old CI
// steps to guess at sleeps. `boot` marks the ones that only become true once s6 has
// finished bringing a container up; they share one budget, because they are all waiting
// on the same startup. Everything else is a property of the image, true from the moment
// the container exists, so it runs exactly once: a missing tool is a regression to
// report in a second, not something to retry for minutes.
//
// Most of the budget is LSIO's mod-init, which fetches DOCKER_MODS from lscr.io and is the
// part that varies with the network. code-server, sshd and svc-console all wait behind it:
// they depend on init-zsh-config, which s6 runs only after the mods
// (runtime/scripts/init-zsh-config-run).
const BOOT_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 2000;
const DOCKER_OPERATION_TIMEOUT_MS = 30_000;
const BOOT_PROBE_TIMEOUT_MS = 10_000;

// Fixed, not config.password. These containers are thrown away at the end of the run, so
// the value carries no meaning, and the console check below splices it into a shell
// string — a configured password is free text that may contain spaces or quotes, and
// does not belong there.
const TEST_PASSWORD = 'testpass';
const TEST_PASSWORD_SHA256 = '13d249f2cb4127b40cfa757866850278793f814ded3c587fe5889e889a7a9f6c';

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
const launcherCommands = toolDefs.tools
  .filter((tool) => tool.launchArgs?.length)
  .map(({ command }) => command);

// Runs as abc with HOME=/config — the uid and home every workspace process actually gets,
// so a tool that resolves here resolves for the people who use the container. Root has
// neither, and it bypasses DAC on top, which is precisely what the filesystem checks below
// are trying to observe.
const asUser = { user: 'abc', env: { HOME: '/config' } };

const launcherContract = String.raw`set -eu
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT HUP INT TERM
mkdir -p "$d/bin" "$d/override"
for tool in agy grok muse; do
  printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*"' >"$d/bin/$tool"
  chmod +x "$d/bin/$tool"
done
printf '%s\n' '#!/usr/bin/env bash' 'printf override' >"$d/override/agy"
chmod +x "$d/override/agy"
printf '%s\n' '{"tools":[{"command":"agy","launchArgs":["--dangerously-skip-permissions"]},{"command":"grok","launchArgs":["--always-approve"],"prepareCommand":["false"]},{"command":"muse","launchArgs":["--disable-approval"],"launchArgsWhen":"bare"}]}' >"$d/tools.json"
agy_out=$(ENVHAVEN_TOOL_BIN_DIR="$d/bin" ENVHAVEN_TOOL_DEFS_JSON="$d/tools.json" /opt/envhaven/wrappers/agy prompt)
grok_out=$(ENVHAVEN_TOOL_BIN_DIR="$d/bin" ENVHAVEN_TOOL_DEFS_JSON="$d/tools.json" /opt/envhaven/wrappers/grok prompt 2>"$d/grok.err")
muse_bare=$(ENVHAVEN_TOOL_BIN_DIR="$d/bin" ENVHAVEN_TOOL_DEFS_JSON="$d/tools.json" /opt/envhaven/wrappers/muse)
muse_login=$(ENVHAVEN_TOOL_BIN_DIR="$d/bin" ENVHAVEN_TOOL_DEFS_JSON="$d/tools.json" /opt/envhaven/wrappers/muse login)
[ "$agy_out" = '--dangerously-skip-permissions prompt' ]
[ "$grok_out" = '--always-approve prompt' ]
grep -qxF 'envhaven: grok preparation failed; starting without it' "$d/grok.err"
[ "$muse_bare" = '--disable-approval' ]
[ "$muse_login" = 'login' ]
[ "$(PATH="$d/override:$PATH" agy prompt)" = 'override' ]`;

const bashrcMigrationContract = String.raw`set -eu
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT HUP INT TERM
mkdir -p "$d/dotfiles"
printf '%s' "alias agy='agy --dangerously-skip-permissions'
export USER_SETTING=kept" >"$d/dotfiles/bashrc"
ln -s dotfiles/bashrc "$d/.bashrc"
printf guard >"$d/outside"
ln -s "$d/outside" "$d/.bashrc.tmp"
HOME="$d" /usr/local/lib/envhaven/envhaven-install-rc-hook bash
[ -L "$d/.bashrc" ]
[ "$(cat "$d/outside")" = guard ]
[ -L "$d/.bashrc.tmp" ]
grep -q '^export USER_SETTING=kept$' "$d/dotfiles/bashrc"
grep -qxF '[ -f /defaults/bashrc-additions ] && . /defaults/bashrc-additions' "$d/dotfiles/bashrc"
if grep -q '^alias agy=' "$d/dotfiles/bashrc"; then
  echo 'the legacy agy alias survived the migration' >&2
  exit 1
fi
set -- "$d"/dotfiles/.bashrc.envhaven.*
[ ! -e "$1" ]`;

// The zsh hook is the credential store's only zsh loader, so it has to reach a fresh HOME,
// follow a dotfiles link without replacing it, stay single across boots, and refuse a
// link that leaves HOME.
const zshrcHookContract = String.raw`set -eu
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT HUP INT TERM
hook='if [ -r "$HOME/.config/envhaven/environment" ]; then . "$HOME/.config/envhaven/environment"; fi'
mkdir -p "$d/fresh" "$d/linked/dotfiles" "$d/escape"
HOME="$d/fresh" /usr/local/lib/envhaven/envhaven-install-rc-hook zsh
[ "$(cat "$d/fresh/.zshrc")" = "$hook" ]
printf '%s' 'export USER_SETTING=kept' >"$d/linked/dotfiles/zshrc"
ln -s dotfiles/zshrc "$d/linked/.zshrc"
HOME="$d/linked" /usr/local/lib/envhaven/envhaven-install-rc-hook zsh
HOME="$d/linked" /usr/local/lib/envhaven/envhaven-install-rc-hook zsh
[ -L "$d/linked/.zshrc" ]
[ "$(head -n 1 "$d/linked/dotfiles/zshrc")" = 'export USER_SETTING=kept' ]
[ "$(tail -n 1 "$d/linked/dotfiles/zshrc")" = "$hook" ]
[ "$(grep -cxF "$hook" "$d/linked/dotfiles/zshrc")" = 1 ]
set -- "$d"/linked/dotfiles/.zshrc.envhaven.*
[ ! -e "$1" ]
printf guard >"$d/outside"
ln -s "$d/outside" "$d/escape/.zshrc"
if HOME="$d/escape" /usr/local/lib/envhaven/envhaven-install-rc-hook zsh 2>/dev/null; then
  echo 'a .zshrc link leaving HOME was followed' >&2
  exit 1
fi
[ "$(cat "$d/outside")" = guard ]`;

// tmux copies the environment of the shell that starts its server into every later
// window, where removing a stored key can no longer reach. A login outside tmux starts
// that server from the welcome and execs into it (the attach fails here, with no
// terminal), so the store must not be loaded yet at that point. Shells that skip the
// welcome still load it: through the ~/.zshrc line when the Oh My Zsh drop-in never
// runs, and through the drop-in when ~/.zshrc lacks that line.
const credentialStoreLoadContract = String.raw`set -eu
d=$(mktemp -d)
trap 'for shell in bash zsh; do TMUX_TMPDIR="$d/tmux-$shell" tmux kill-server 2>/dev/null || :; done; rm -rf "$d"' EXIT HUP INT TERM
store="export ENVHAVEN_STORE_PROBE='stored'"
for home in home omz omz-nohook; do
  mkdir -p "$d/$home/.config/envhaven"
  printf '%s\n' "$store" >"$d/$home/.config/envhaven/environment"
done
mkdir -p "$d/omz-custom" "$d/tmux-bash" "$d/tmux-zsh"
printf '%s\n' '. /defaults/zshrc-additions' >"$d/home/.zshrc"
HOME="$d/home" /usr/local/lib/envhaven/envhaven-install-rc-hook bash
HOME="$d/home" /usr/local/lib/envhaven/envhaven-install-rc-hook zsh
for shell in bash zsh; do
  HOME="$d/home" TMUX_TMPDIR="$d/tmux-$shell" "$shell" -i -c : </dev/null >/dev/null 2>&1 || :
  TMUX_TMPDIR="$d/tmux-$shell" tmux has-session -t =envhaven
  if TMUX_TMPDIR="$d/tmux-$shell" tmux show-environment -g ENVHAVEN_STORE_PROBE >/dev/null 2>&1; then
    echo "$shell seeded the tmux server with a stored key" >&2
    exit 1
  fi
  HOME="$d/home" ENVHAVEN_SKIP_WELCOME=1 "$shell" -i -c 'printf "probe=%s\n" "$ENVHAVEN_STORE_PROBE"' </dev/null 2>/dev/null | grep -qx probe=stored
done
printf '%s\n' 'ZSH_DISABLE_COMPFIX=true' 'export ZSH=/config/.oh-my-zsh' "ZSH_CUSTOM=$d/omz-custom" 'source "$ZSH/oh-my-zsh.sh"' >"$d/omz/.zshrc"
HOME="$d/omz" /usr/local/lib/envhaven/envhaven-install-rc-hook zsh
HOME="$d/omz" zsh -i -c 'printf "probe=%s\n" "$ENVHAVEN_STORE_PROBE"' </dev/null 2>/dev/null | grep -qx probe=stored
printf '%s\n' 'ZSH_DISABLE_COMPFIX=true' 'export ZSH=/config/.oh-my-zsh' 'source "$ZSH/oh-my-zsh.sh"' >"$d/omz-nohook/.zshrc"
HOME="$d/omz-nohook" ENVHAVEN_SKIP_WELCOME=1 zsh -i -c 'printf "probe=%s\n" "$ENVHAVEN_STORE_PROBE"' </dev/null 2>/dev/null | grep -qx probe=stored`;

const antigravityPreparationContract = String.raw`set -eu
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT HUP INT TERM
mkdir -p "$d/.gemini/antigravity-cli"
printf '%s\n' '{"modelProvider":"oauth","theme":"dark"}' >"$d/.gemini/antigravity-cli/settings.json"
HOME="$d" /usr/local/lib/envhaven/envhaven-prepare-antigravity --force >/dev/null
jq -e '.modelProvider == "gemini" and .theme == "dark"' "$d/.gemini/antigravity-cli/settings.json" >/dev/null
mkdir -p "$d/keyless" "$d/elsewhere/antigravity-cli"
printf '%s\n' '{"theme":"guard"}' >"$d/elsewhere/antigravity-cli/settings.json"
ln -s "$d/elsewhere" "$d/keyless/.gemini"
env -u GEMINI_API_KEY HOME="$d/keyless" /usr/local/lib/envhaven/envhaven-prepare-antigravity
[ "$(cat "$d/elsewhere/antigravity-cli/settings.json")" = '{"theme":"guard"}' ]
mkdir -p "$d/empty/.gemini/antigravity-cli"
: >"$d/empty/.gemini/antigravity-cli/settings.json"
if HOME="$d/empty" /usr/local/lib/envhaven/envhaven-prepare-antigravity --force >/dev/null 2>&1; then
  echo 'an empty Antigravity settings file was rewritten' >&2
  exit 1
fi
[ ! -s "$d/empty/.gemini/antigravity-cli/settings.json" ]
[ ! -e "$d/empty/.gemini/antigravity-cli/.model-provider.envhaven" ]`;

const ownershipRepairContract = String.raw`set -eu
target=$(mktemp /tmp/envhaven-ownership-target.XXXXXX)
link=/opt/envhaven/.ownership-test-link
trap 'rm -f "$link" "$target"' EXIT HUP INT TERM
chown root:root "$target"
ln -s "$target" "$link"
chown -h root:root "$link"
/usr/local/lib/envhaven/envhaven-repair-tool-ownership
[ "$(stat -c %u "$target")" = 0 ]
[ "$(stat -c %u "$link")" = 1000 ]`;

// ~/.oh-my-zsh/custom is a dotfiles link inside HOME, which is followed, and its themes
// directory links outside HOME, which is refused. The theme target is abc-owned, so only
// the HOME check stands between it and the write, and the refusal must not keep any
// service from starting.
const filesystemSecurityFixture = String.raw`set -eu
mkdir -p /config/.oh-my-zsh /config/dotfiles/omz-custom /tmp/envhaven-kimi-target /tmp/envhaven-antigravity-target/antigravity-cli /tmp/envhaven-theme-target
printf kimi-guard >/tmp/envhaven-kimi-target/guard
printf zsh-guard >/tmp/envhaven-zsh-target
printf '%s\n' '{"modelProvider":"outside","theme":"guard"}' >/tmp/envhaven-antigravity-target/antigravity-cli/settings.json
ln -s /tmp/envhaven-kimi-target /config/.kimi-code
ln -s ../dotfiles/omz-custom /config/.oh-my-zsh/custom
ln -s /tmp/envhaven-zsh-target /config/dotfiles/omz-custom/envhaven.zsh
ln -s /tmp/envhaven-theme-target /config/dotfiles/omz-custom/themes
ln -s /tmp/envhaven-antigravity-target /config/.gemini
printf '%s\n' 'export ANTHROPIC_API_KEY="legacy-value"' >/config/.zshrc
printf '%s\n' 'export ANTHROPIC_API_KEY="legacy-value"' >/config/.bashrc
chown -R 1234:1234 /config /tmp/envhaven-theme-target
exec /init`;

const filesystemSecurityContract = String.raw`set -eu
[ "$(id -u abc)" = 1234 ]
[ "$(id -g abc)" = 1234 ]
[ -L /config/.kimi-code ]
[ "$(cat /tmp/envhaven-kimi-target/guard)" = kimi-guard ]
[ ! -e /tmp/envhaven-kimi-target/region ]
[ -L /config/.oh-my-zsh/custom ]
[ -f /config/dotfiles/omz-custom/envhaven.zsh ]
[ ! -L /config/dotfiles/omz-custom/envhaven.zsh ]
[ "$(stat -c %u:%g /config/dotfiles/omz-custom/envhaven.zsh)" = 1234:1234 ]
grep -qxF '# EnvHaven zsh configuration' /config/dotfiles/omz-custom/envhaven.zsh
[ "$(cat /tmp/envhaven-zsh-target)" = zsh-guard ]
[ "$(stat -c %u:%g /tmp/envhaven-zsh-target)" = 0:0 ]
[ -z "$(ls -A /tmp/envhaven-theme-target)" ]
jq -e '.modelProvider == "outside" and .theme == "guard"' /tmp/envhaven-antigravity-target/antigravity-cli/settings.json >/dev/null
[ "$(stat -c %u:%g /tmp/envhaven-antigravity-target/antigravity-cli/settings.json)" = 0:0 ]
grep -qxF 'if [ -r "$HOME/.config/envhaven/environment" ]; then . "$HOME/.config/envhaven/environment"; fi' /config/.zshrc
[ "$(stat -c %u:%g /config/.zshrc)" = 1234:1234 ]
grep -qxF "export ANTHROPIC_API_KEY='legacy-value'" /config/.config/envhaven/environment
if grep -q '^export ANTHROPIC_API_KEY=' /config/.zshrc /config/.bashrc; then
  echo 'a legacy rc export survived the migration' >&2
  exit 1
fi
if grep -q '^# EnvHaven legacy sidebar migration ' /config/.config/envhaven/environment; then
  echo 'a legacy migration receipt survived in the store' >&2
  exit 1
fi
curl -sf http://localhost:8443/healthz >/dev/null
pgrep sshd >/dev/null
curl -sf http://localhost:7681/__console/ui | grep -q 'EnvHaven Terminal'`;

const hashProofContract = String.raw`set -eu
issued=$(date +%s)
proof=$(node -e 'const c=require("crypto");const key=Buffer.from(c.hkdfSync("sha256",Buffer.from(process.env.HASHED_PASSWORD),Buffer.from("envhaven-console"),Buffer.from("token-signing-key/v1"),32));process.stdout.write(c.createHmac("sha256",key).update("extension-token|"+process.argv[1]).digest("base64url"))' "$issued")
token=$(curl -sf -X POST -H "X-EnvHaven-Issued: $issued" -H "X-EnvHaven-Proof: $proof" http://localhost:7681/__console/internal-token)
printf '%s' "$token" | grep -qE '^[0-9]+\.'
wrong=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-EnvHaven-Issued: $issued" -H 'X-EnvHaven-Proof: wrong' http://localhost:7681/__console/internal-token)
[ "$wrong" = 401 ]`;

const passwordlessActionContract = String.raw`set -eu
action() {
  output=$(/opt/envhaven/bin/envhaven-console --action-json "$1") || {
    status=$?
    printf 'local action failed (%s) for %s: %s\n' "$status" "$1" "$output" >&2
    return "$status"
  }
  printf '%s\n' "$output" | jq -e '.ok == true' >/dev/null || {
    printf 'invalid local action response: %s\n' "$output" >&2
    return 1
  }
}
action '{"action":"new-window"}'
index=$(tmux list-windows -t envhaven -F '#{window_index}' | sort -n | tail -n 1)
[ -n "$index" ] || { printf 'new window was not listed\n' >&2; exit 1; }
action "$(printf '{"action":"select-window","index":%s}' "$index")"
[ "$(tmux display-message -p -t envhaven '#{window_index}')" = "$index" ] || {
  printf 'window %s was not selected\n' "$index" >&2
  exit 1
}
action "$(printf '{"action":"kill-window","index":%s}' "$index")"
if tmux list-windows -t envhaven -F '#{window_index}' 2>/dev/null | grep -qx "$index"; then
  printf 'window %s was not killed\n' "$index" >&2
  exit 1
fi
if /opt/envhaven/bin/envhaven-console --action-json '{"action":"select-window"}' >/tmp/envhaven-action-error.json; then
  printf 'invalid action unexpectedly succeeded\n' >&2
  exit 1
fi
jq -e '.ok == false and .error == "invalid index"' /tmp/envhaven-action-error.json >/dev/null || {
  printf 'invalid error response: ' >&2
  cat /tmp/envhaven-action-error.json >&2
  exit 1
}`;

const tests: Test[] = [
  { name: 'code-server health', cmd: 'curl -sf http://localhost:8443/healthz', boot: true },
  { name: 'SSH daemon', cmd: 'pgrep sshd', boot: true },
  {
    name: 'browser terminal page',
    cmd: `curl -sf http://localhost:7681/__console/ui | grep -q 'EnvHaven Terminal'`,
    boot: true,
  },
  {
    name: 'hash-password container: browser terminal page',
    cmd: `curl -sf http://localhost:7681/__console/ui | grep -q 'EnvHaven Terminal'`,
    container: hashPasswordName,
    boot: true,
  },
  {
    name: 'custom PUID filesystem security, dotfiles links, and legacy migration',
    cmd: filesystemSecurityContract,
    container: filesystemSecurityName,
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
  {
    name: 'Kimi region marker is an abc-owned regular file',
    cmd:
      `set -e; test -f /config/.kimi-code/region; test ! -L /config/.kimi-code/region; ` +
      `[ "$(cat /config/.kimi-code/region)" = global ]; ` +
      `[ "$(stat -c %u:%g /config/.kimi-code/region)" = "$(id -u):$(id -g)" ]; ` +
      `set -- /config/.kimi-code/.region.envhaven.*; test ! -e "$1"`,
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
  {
    name: 'hash-only extension token flow',
    cmd: hashProofContract,
    container: hashPasswordName,
  },
  // The user-visible half of the same promise: no password, no port. On its own this
  // would also be satisfied by a console that started and crashed, which is why the boot
  // check above asserts the service exited 0 rather than merely that nothing is listening.
  {
    name: 'console gate holds without a password',
    cmd: '! curl -s --max-time 2 http://localhost:7681/',
    container: noPasswordName,
  },
  {
    name: 'no-password container: typed local console actions',
    cmd: passwordlessActionContract,
    container: noPasswordName,
    ...asUser,
  },
  {
    name: 'startup creates no root-owned workspace state',
    cmd:
      `set -e; for path in /config/.cache/amp /config/.factory /config/.kiro; do ` +
      `test ! -e "$path" || [ "$(stat -c %u "$path")" = "$(id -u)" ]; done`,
    ...asUser,
  },
  // As root: /tmp/tmux-0 is root's 0700 socket directory, so abc could never see the socket.
  { name: 'startup starts no root tmux server', cmd: 'test ! -S /tmp/tmux-0/default' },

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
  {
    name: 'tool launcher defaults, subcommands, and user override',
    cmd: launcherContract,
    ...asUser,
  },
  {
    name: 'tool launcher policy is image-owned',
    cmd: '[ "$(stat -c %u /opt/envhaven/wrappers)" -eq 0 ] && ! test -w /opt/envhaven/wrappers',
    ...asUser,
  },
  // Generated from the REPO's catalog: every tool with launchArgs resolves to its own
  // launcher link, and no other tool has one. The Dockerfile derives the same list from
  // the image's copy, so a new tool cannot ship without its defaults.
  {
    name: 'catalog launch defaults resolve through the launcher',
    cmd:
      `[ "$(ls -A /opt/envhaven/wrappers | wc -l)" -eq ${launcherCommands.length} ] && ` +
      `for t in ${launcherCommands.join(' ')}; do ` +
      `[ "$(command -v "$t")" = "/opt/envhaven/wrappers/$t" ] && ` +
      `[ "$(readlink "/opt/envhaven/wrappers/$t")" = /usr/local/lib/envhaven/envhaven-tool-launcher ] || exit 1; done`,
    ...asUser,
  },
  {
    name: 'ownership repair does not dereference symlinks',
    cmd: ownershipRepairContract,
  },
  {
    name: 'bashrc migration is atomic and ignores the legacy temp path',
    cmd: bashrcMigrationContract,
    ...asUser,
  },
  {
    name: 'zshrc store hook follows dotfiles links, stays single, and stays inside HOME',
    cmd: zshrcHookContract,
    ...asUser,
  },
  {
    name: 'credential store loads after the welcome and without the zsh drop-in',
    cmd: credentialStoreLoadContract,
    ...asUser,
  },
  {
    name: 'Antigravity preparation preserves settings, skips keyless launches, refuses empty settings',
    cmd: antigravityPreparationContract,
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
    const result = await runBoundedProcess(
      ['docker', 'rm', '-f', '-v', containerName, noPasswordName, hashPasswordName, filesystemSecurityName],
      DOCKER_OPERATION_TIMEOUT_MS
    );
    if (!result.success && result.output) log.plain(result.output);
  })();
  return cleanupPromise;
}

// Both containers carry a timestamp in their name, so one that leaks is invisible to
// stop.ts and has to be hunted by hand. Interrupting the boot wait is how that happens.
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));
process.on('SIGTERM', () => void cleanup().then(() => process.exit(143)));

function runOnce(test: Test, timeoutMs = DOCKER_OPERATION_TIMEOUT_MS) {
  const target = test.container ?? containerName;
  return dockerExec(target, test.cmd, { user: test.user, env: test.env, timeoutMs });
}

async function pollUntilReady(test: Test, deadline: number) {
  let lastResult: ProcessResult = {
    success: false,
    output: `Image boot deadline expired before ${test.name}`,
  };

  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return lastResult;

    lastResult = await runOnce(test, Math.min(BOOT_PROBE_TIMEOUT_MS, remainingMs));
    if (lastResult.success || Date.now() >= deadline) return lastResult;
    await Bun.sleep(Math.max(0, Math.min(POLL_INTERVAL_MS, deadline - Date.now())));
  }
}

async function startContainer(args: string[], deadline: number): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error('Image boot deadline expired before container creation');

  const result = await runBoundedProcess(['docker', 'run', ...args], remainingMs);
  if (!result.success) throw new Error(result.output || 'docker run failed');
}

log.info(`Testing image: ${config.image}`);
log.info('Starting test containers...');
const bootDeadline = Date.now() + BOOT_TIMEOUT_MS;

// Plaintext and hash-only credentials exercise both self-host token paths; without
// either credential the gate holds and 7681 never opens. The fourth container seeds
// hostile persisted paths before s6 starts and uses a non-default uid/gid.
// allSettled rather than all: `all` rejects while the other `docker run` is still in
// flight, so cleanup could fire before the surviving container exists and leak it.
startPromise = Promise.allSettled([
  startContainer([
    '-d', '--name', containerName,
    '-e', `PASSWORD=${TEST_PASSWORD}`,
    '-e', `SUDO_PASSWORD=${TEST_PASSWORD}`,
    config.image,
  ], bootDeadline),
  startContainer(['-d', '--name', noPasswordName, config.image], bootDeadline),
  startContainer([
    '-d', '--name', hashPasswordName,
    '-e', `HASHED_PASSWORD=${TEST_PASSWORD_SHA256}`,
    config.image,
  ], bootDeadline),
  startContainer([
    '-d', '--name', filesystemSecurityName,
    '-e', 'PUID=1234',
    '-e', 'PGID=1234',
    '-e', 'DOCKER_MODS=',
    '-e', `PASSWORD=${TEST_PASSWORD}`,
    '--entrypoint', '/bin/bash',
    config.image,
    '-c', filesystemSecurityFixture,
  ], bootDeadline),
]);
const started = await startPromise;

const startFailures = started.filter((r) => r.status === 'rejected');
if (startFailures.length > 0) {
  log.error('Failed to start test containers');
  for (const failure of startFailures) log.plain(String(failure.reason));
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
    if (!record(test, await pollUntilReady(test, bootDeadline))) {
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
    const result = await runBoundedProcess(
      ['docker', 'logs', name],
      DOCKER_OPERATION_TIMEOUT_MS
    );
    if (result.output) log.plain(result.output);
  }
} finally {
  await cleanup();
}

formatTestSummary(passed, failed);
process.exit(failed === 0 ? 0 : 1);
