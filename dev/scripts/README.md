# EnvHaven Dev Scripts

Standalone scripts for building, testing, and managing EnvHaven development.

These scripts are the **single source of truth** for build/test operations. The TUI (`eh`) calls them and so does CI, so a green desk and a green pipeline mean the same thing. Only the image *build* still goes through Buildx, for the layer cache the release job shares.

## Usage

All scripts run with Bun:

```bash
bun dev/scripts/build.ts           # Build Docker image
bun dev/scripts/start.ts           # Start test container
bun dev/scripts/stop.ts            # Stop test container
bun dev/scripts/logs.ts            # Stream container logs
bun dev/scripts/test-image.ts      # Validate Docker image
bun dev/scripts/test-ai-tools.ts   # Verify all AI CLI tools
bun dev/scripts/test-cli.ts        # Test Haven CLI
bun dev/scripts/test-extension.ts  # Test extension build
bun dev/scripts/measure-tui.ts     # Check the console's TUI geometry table
bun dev/scripts/test-console-echo.ts  # Predictive echo, end to end in a browser
bun dev/scripts/test-console-ui.ts    # Execute the model and check every runtime module (also run by CI)
bun dev/scripts/platform-tool-catalog.ts --check # Check generated catalog and documentation
bun dev/scripts/extension-build.ts    # Build the extension VSIX
bun dev/scripts/extension-install.ts  # Hot-inject the VSIX into a running container
```

Or use the TUI which wraps these scripts with a nice interface:

```bash
cd dev && bun run setup   # One-time: install, build, link
eh                        # Press 'b' for build, 's' for start, 't' for test, etc.
```

## Scripts

| Script | Description | Options |
|--------|-------------|---------|
| `build.ts` | Build `envhaven:dev` Docker image | `--no-cache` |
| `start.ts` | Start test container | `--fresh` |
| `stop.ts` | Stop and remove test container | |
| `logs.ts` | Stream container logs | `--tail=N` |
| `test-image.ts` | Boot two fresh containers and run every image check | |
| `test-ai-tools.ts` | Re-check the AI roster in the container already running | |
| `test-cli.ts` | Haven CLI integration tests | `--ci` (non-interactive) |
| `test-extension.ts` | Build extension and verify artifacts | |
| `test-console-ui.ts` | Execute the embedded model and check the browser runtime contract. Run by CI | |
| `platform-tool-catalog.ts` | Generate or validate the content-addressed platform catalog and marked documentation sections | `--write [output]`, `--check`, `--print-hash`, `--print-source-hash` |
| `extension-build.ts` | Build extension host and webview | `--webview-only`, `--host-only` |
| `extension-install.ts` | Package and install extension in container | |
| `measure-tui.ts` | Measure AI CLI composer geometry against the console's `TUI` table | `--print`, `--container=`, `<app>...` |
| `test-console-echo.ts` | Drive predictive echo in a real browser over a simulated round trip | `--container=`, `--password=`, `--down=`, `--up=`, `<check>...` |

A managed workspace container works as the container too, with no
password: the rig detects `ENVHAVEN_MANAGED`, mints the console JWT through the
workspace's own internal token route (the same exchange the in-container extension
uses), runs the latency proxy inside the container (a managed console binds
loopback), and resets between checks by owning one named tmux window (`ehtest`)
instead of killing the session.

## Wrapped-draft edits

`keys-reflow` drives Claude Code over the delayed link and checks the painted rows
before echo, then compares every affected input row and the cursor with the real
editor. It covers word and character deletion, shrinking the composer, repeated
edits, navigation, overlong tokens, and explicit blank lines.

```bash
bun dev/scripts/test-console-echo.ts keys-reflow --down=300
```

The predictor reconstructs a framed, eager-wrapping draft as one string with row
offsets. Edits and navigation use that string; layout derives all changed rows,
and reconciliation waits for the whole block. Vacated space returns to the
application when it redraws it. Reconstruction must reproduce the observed rows
exactly. Unframed or lazy editors, off-screen boundaries, and ambiguous seams in
full rows retain the existing prediction path.

`test-console-ui.ts` also exercises cascading edits, both growth directions,
split-pane boundaries, partial echoes, and status output in vacated space without
a browser or container.

## Adding a new AI CLI tool

The last two scripts are how a tool joins the browser terminal rather than merely
running inside it. Installing it is a Dockerfile edit, and registering it in
`tool-definitions.json` is what puts it in every `--version` gate. Neither teaches the
console to predict its wraps.

```bash
bun dev/scripts/measure-tui.ts --print <tool>          # measure its composer
# add the printed row to `var TUI` in console/ui/assets/eh-model.js
# register the tool once, on its row in lib/console-apps.ts (seed, floor, ink, words,
# ghost, trailing: each field turns on the check that reads it)
bun dev/scripts/test-console-echo.ts seedwrap wrapkeep draftink keys-editing-composer keys-words
```

The full procedure is `docs/architecture.md` under "Adding New Tools", steps 7 and 11: what
each field on the row turns on, the fake-key launch pattern, why npm-installed CLIs need an
entry in `runtimeWrappers` in `console/gate.go`, the tmux probe loop for when a measurement
disagrees, and the hot-inject that lets the user test in a live workspace.

### Word rules

Option+Arrow and Option+Backspace move and delete by word, and what a word is differs per
tool (`WORD_RULES` in `console/ui/assets/eh-model.js` lists the measured ones). The
measurement is a tmux loop inside a workspace container where the tool is signed in, on its
own socket, one short draft per case: type it, read the cursor, then `M-b` twice, `C-a`,
`M-f` twice, `C-e`, `M-BSpace` once, reading the cursor after each key. Those are the bytes
the page sends for the Option chords, so the columns are the tool's own answers.

```bash
T="tmux -L words"; $T new -d -s w -x 120 -y 40 '<tool>'; sleep 12   # or `zsh` for the shell
for s in 'aa bb' 'aa.bb' "aa'bb" 'aa-bb' './p/f.txt --f=1 (p)'; do
  $T send-keys -t w -l "$s"; sleep 0.8; printf '%s end=%s' "$s" "$($T display-message -p -t w '#{cursor_x}')"
  for k in M-b M-b C-a M-f M-f C-e M-BSpace; do $T send-keys -t w $k; sleep 0.4; printf ' %s=%s' $k "$($T display-message -p -t w '#{cursor_x}')"; done
  echo; $T send-keys -t w C-e C-u; sleep 0.5
done; $T kill-server
```

`dev/fixtures/word-rules.json` holds the cases for every tool with a rule: `floor` is the
empty composer's cursor column, `back` the two `M-b` columns from the draft's end, `fwd` the
two `M-f` columns from the floor, `kill` the column after one `M-BSpace` from the end.
`test-console-ui.ts` executes the shipped model's scanners on every case, so a rule is checked
without a browser; `keys-words` then holds the same keys to the live pane. When a tool
changes its editor, re-measure and replace its cases rather than editing them by hand.

## Configuration

Scripts read from `dev/.env.dev`:

```bash
cp dev/.env.example dev/.env.dev
```

An exported variable wins over the file, so a one-off override works without editing it:

```bash
ENVHAVEN_IMAGE=envhaven:test bun dev/scripts/test-image.ts
```

| Variable | Default | Description |
|----------|---------|-------------|
| `ENVHAVEN_CONTAINER_NAME` | `envhaven-test` | Test container name |
| `ENVHAVEN_IMAGE` | `envhaven:dev` | Docker image tag |
| `ENVHAVEN_HOST` | `localhost` | Host for access URLs |
| `ENVHAVEN_WEB_PORT` | `8443` | Web UI port |
| `ENVHAVEN_SSH_PORT` | `2222` | SSH port |
| `ENVHAVEN_CONSOLE_PORT` | `7681` | Browser terminal port (opens when a password is set) |
| `ENVHAVEN_PASSWORD` | `test` | Container password |

## CI Usage

EnvHaven's `ci.yml` runs these scripts directly, so a green CI and a green desk mean the same thing. The image is still built with `docker/build-push-action` (for the layer cache the release job shares), and `test-image.ts` then checks the result:

```yaml
- name: Setup Bun
  uses: oven-sh/setup-bun@v2

- name: Test extension
  run: bun dev/scripts/test-extension.ts

- name: Test image
  run: bun dev/scripts/test-image.ts
  env:
    ENVHAVEN_IMAGE: envhaven:test

# In the console job, which never runs `bun install`
- name: Terminal page
  run: bun dev/scripts/test-console-ui.ts
```

`test-image.ts` needs no `bun install`; it imports only runtime builtins and `scripts/lib`. `test-extension.ts` does need one, since it builds the extension.

## Script Library

Shared utilities live in `scripts/lib/`:

- `config.ts` - Configuration loading from `.env.dev`
- `docker.ts` - Docker operations (status, exec, wait)
- `log.ts` - Colored CLI output
- `env.ts` - Environment file parsing
- `engine.ts` - Executes the shipped console model and provides the ordered browser-runtime manifest for structural checks; not in the barrel, imported by path
- `console-apps.ts` - The roster the console harness drives, one row per application with the facts each check reads; `rosterDrift()` says where the rows and the model disagree
- `console-rig.ts` - The Playwright page driver and `ConsoleRig`
- `console-proxy.ts` - Fixed-latency proxy startup, readiness, and bounded cleanup
- `console-managed-tmux.ts` - Managed token minting and test-owned tmux windows

Import with:

```typescript
import { loadConfig, log, isContainerRunning } from './lib';
```

The console harness modules are deliberately absent from that barrel. Check modules
import Playwright for types only, which erases; `console-rig.ts` is the sole runtime
Playwright import. Pulling it into the barrel would make every other script fail
to load without the browser dependency, and CI's console job runs `test-console-ui.ts`
(which imports `./lib`) with no `bun install` at all. Checks import the rig directly:

```typescript
import { ConsoleRig, probe, quiet } from './lib/console-rig';
```

## Fixtures

`dev/fixtures/` holds the terminal applications and the network shim that
`test-console-echo.ts` needs. The rig copies the whole directory into the
container on startup, so nothing there is installed by hand.

| File | Purpose |
|------|---------|
| `composer.py` | Word-wrapping composer, reproducing the measured Claude Code contract (`GHOST=1` adds the `Try "…"` placeholder) |
| `boxcomposer.py` | Same, but painting every row in its own background |
| `invcomposer.py` | Same, but hiding the real cursor and drawing an inverse-video caret |
| `blinkmimic.py` | One coloured band with the cursor parked in it, holding still |
| `latency-proxy.py` | Fixed-delay TCP proxy, so the round trip is visible enough to predict |
| `composer-rows.json` | Rows captured from real composers, held to the engine's row helpers by `test-console-ui.ts` |
| `composer-panes.json` | Whole panes captured from real composers, held to the engine's box and growth helpers by `test-console-ui.ts` |
| `word-rules.json` | Word-jump columns measured off each tool with the recipe under "Word rules", held to the engine's word scanners by `test-console-ui.ts` |

The mimics exist because the real AI CLIs cannot be held in these states on demand:
a background under the engine's control, a caret the app draws itself, a cursor that
never moves. The pixel checks drive both, `boxbg-claude` against the real Claude Code
and `boxbg-mimic` against `boxcomposer.py`, so a vendor redesign shows up as one of
the two diverging rather than as the whole check going quiet.
