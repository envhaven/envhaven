// Thin client for the per-container Go console's out-of-band HTTP API. The
// console is the single source of truth for skills, the AI-tool grid, and tmux
// mutations. The extension host sends typed actions to the loopback API and
// observes the resulting process/window state.
//
// Auth: every `/__console/*` route sits behind an `Authorization: Bearer <token>`
// wall, and this client mints that token three ways, chosen by which credentials
// the workspace carries:
//   - managed: the platform mints a ~60s EdDSA token for in-container callers via
//     an internal route, keyed on the `_ENVHAVEN_*` vars environment.ts reads.
//   - self-hosted plaintext: exchange PASSWORD through the browser login flow.
//   - self-hosted hash: prove knowledge of HASHED_PASSWORD to a loopback-only
//     endpoint without sending the hash itself. HASHED_PASSWORD wins when both
//     variables are set, matching code-server and console/selfhost.go.
// code-server deletes PASSWORD and HASHED_PASSWORD before starting the extension
// host, whose environment then gains whatever the user's login shell exports. Both
// self-hosted paths therefore read the container's copy in
// /run/s6/container_environment, the one svc-console receives through with-contenv,
// and use the environment only when that file is missing.
// Fixed tmux actions alone have a local binary fallback when token minting or a
// definite loopback connection fails; every read remains HTTP-only.

import { type ChildProcess, spawn } from 'node:child_process';
import { createHmac, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  AITool,
  ConsoleActionRequest,
  ConsoleActionResponse,
  EnvVarMeta,
  InstalledSkill,
  SkillFrontmatter,
  SkillsShResult,
  ToolMutationRequest,
  ToolSignOutResponse,
} from './shared-types';

// The console listens on loopback. Managed binds 127.0.0.1:7681, self-host binds
// :7681 (all interfaces) — 127.0.0.1 reaches both. No env var carries the port.
const CONSOLE_BASE = 'http://127.0.0.1:7681';

// Both minting paths yield ~60s tokens; reuse a cached one until the refresh
// margin. The self-host session cookie behind it lives 12h (sessionTTL in
// selfhost.go), so we log in about once and re-exchange as tokens expire.
const CONSOLE_TOKEN_TTL_MS = 60_000;
const TOKEN_REFRESH_MARGIN_MS = 10_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const SESSION_REFRESH_MARGIN_MS = 60_000;
const HASH_PROOF_CONTEXT = 'extension-token';

// Per-call fetch budgets. Reads that fan out to GitHub/skills.sh server-side get
// a generous window; install/remove shell out to `npx skills`, which the console
// bounds at 120s, so the action budget must clear that.
const TOKEN_MINT_TIMEOUT_MS = 5_000;
const CONSOLE_READ_TIMEOUT_MS = 15_000;
const CONSOLE_ACTION_TIMEOUT_MS = 125_000;
const LOCAL_ACTION_TIMEOUT_MS = 10_000;
const LOCAL_ACTION_OUTPUT_LIMIT = 4 << 10;
const CONSOLE_BINARY = '/opt/envhaven/bin/envhaven-console';

let cachedToken: { token: string; expiresAt: number } | null = null;
// Self-host only: the login session cookie exchanged for short tokens.
let cachedSession: { cookie: string; expiresAt: number } | null = null;
let localActionTimeoutMs = LOCAL_ACTION_TIMEOUT_MS;
let containerEnvDir = '/run/s6/container_environment';

class ConsoleActionUnavailableError extends Error {}

/** A non-2xx console answer, keeping its status and any next-step instruction. */
export class ConsoleRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly instruction?: string
  ) {
    super(message);
  }
}

/** Test-only: clear both auth caches so a test can exercise a fresh strategy. */
export function __resetAuthCache(): void {
  cachedToken = null;
  cachedSession = null;
  localActionTimeoutMs = LOCAL_ACTION_TIMEOUT_MS;
}

/** Test-only: shorten the local process deadline without weakening production. */
export function __setLocalActionTimeoutForTests(timeoutMs: number): void {
  localActionTimeoutMs = timeoutMs;
}

/** Test-only: read web credentials from a fixture instead of the container's copy. */
export function __setContainerEnvDirForTests(dir: string): void {
  containerEnvDir = dir;
}

/**
 * Mint (or reuse) a console token. `forceRefresh` drops the caches and re-mints
 * immediately — used after a 401 when a token lapsed between the cache check and
 * the request.
 */
async function getConsoleToken(forceRefresh = false): Promise<string> {
  if (forceRefresh) {
    cachedToken = null;
    cachedSession = null;
  }
  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return cachedToken.token;
  }
  const token = await mintConsoleToken();
  cachedToken = { token, expiresAt: Date.now() + CONSOLE_TOKEN_TTL_MS };
  return token;
}

/**
 * Pick the minting strategy by the credentials present. Managed wins when its
 * vars are set; self-hosted hash then wins over plaintext, matching code-server.
 */
async function mintConsoleToken(): Promise<string> {
  const apiUrl = process.env._ENVHAVEN_API_URL;
  const workspaceId = process.env._ENVHAVEN_WORKSPACE_ID;
  const workspaceToken = process.env._ENVHAVEN_WORKSPACE_TOKEN;
  if (apiUrl && workspaceId && workspaceToken) {
    return mintManagedToken(apiUrl, workspaceId, workspaceToken);
  }
  const hashedPassword = webCredential('HASHED_PASSWORD');
  if (hashedPassword) {
    return mintHashSelfHostToken(hashedPassword);
  }
  const password = webCredential('PASSWORD');
  if (password) {
    return mintSelfHostToken(password);
  }
  throw new Error('console unavailable: no workspace credentials or web credential');
}

/**
 * A web credential exactly as svc-console sees it: the s6 copy read verbatim (no
 * trim), where an empty file counts as unset, as it does for with-contenv. A shell
 * export of the same name must not replace it: a wrong password on every poll
 * would drain the console's shared login limiter and lock the operator out.
 */
function webCredential(name: 'PASSWORD' | 'HASHED_PASSWORD'): string | undefined {
  try {
    return readFileSync(`${containerEnvDir}/${name}`, 'utf8') || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return process.env[name] || undefined;
}

async function mintHashSelfHostToken(hashedPassword: string): Promise<string> {
  const issued = Math.floor(Date.now() / 1000).toString();
  const material = /^[0-9a-f]{64}$/i.test(hashedPassword)
    ? hashedPassword.toLowerCase()
    : hashedPassword;
  const secret = Buffer.from(
    hkdfSync('sha256', Buffer.from(material), Buffer.from('envhaven-console'), Buffer.from('token-signing-key/v1'), 32)
  );
  const proof = createHmac('sha256', secret)
    .update(`${HASH_PROOF_CONTEXT}|${issued}`)
    .digest('base64url');
  const res = await fetch(`${CONSOLE_BASE}/__console/internal-token`, {
    method: 'POST',
    headers: {
      'X-EnvHaven-Issued': issued,
      'X-EnvHaven-Proof': proof,
    },
    signal: AbortSignal.timeout(TOKEN_MINT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`console hash-proof mint failed: HTTP ${res.status}`);
  }
  const token = (await res.text()).trim();
  if (!token) {
    throw new Error('console hash-proof mint returned no token');
  }
  return token;
}

/**
 * Managed: the internal platform route
 *   POST <API_BASE>/v1/internal/workspace/<id>/console-token
 * exchanges the workspace token for a 60s EdDSA JWT the local console verifies.
 */
async function mintManagedToken(
  apiUrl: string,
  workspaceId: string,
  workspaceToken: string
): Promise<string> {
  const res = await fetch(`${apiUrl}/v1/internal/workspace/${workspaceId}/console-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${workspaceToken}` },
    signal: AbortSignal.timeout(TOKEN_MINT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`console token mint failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    throw new Error('console token mint returned no token');
  }
  return data.token;
}

/**
 * Self-host: exchange the cached (or freshly logged-in) session cookie at
 * /__console/token for the 60s ctxWS bearer the API routes verify. Node's fetch
 * sends no Sec-Fetch-Site header, so the console's same-origin gate on that route
 * admits this in-container caller.
 */
async function mintSelfHostToken(password: string): Promise<string> {
  const cookie = await getSelfHostSession(password);
  const res = await fetch(`${CONSOLE_BASE}/__console/token`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(TOKEN_MINT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`console token exchange failed: HTTP ${res.status}`);
  }
  const token = (await res.text()).trim();
  if (!token) {
    throw new Error('console token exchange returned no token');
  }
  return token;
}

const SESSION_COOKIE_NAME = 'envhaven_console_session';

/**
 * Log in with the web password (POST /__console/login) for a 12h signed session
 * cookie, cached so we authenticate about once. Returns the `name=value` pair to
 * replay on the Cookie header (Node's fetch does not manage a cookie jar).
 */
async function getSelfHostSession(password: string): Promise<string> {
  if (cachedSession && Date.now() < cachedSession.expiresAt - SESSION_REFRESH_MARGIN_MS) {
    return cachedSession.cookie;
  }
  const res = await fetch(`${CONSOLE_BASE}/__console/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(password)}`,
    signal: AbortSignal.timeout(TOKEN_MINT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`console login failed: HTTP ${res.status}`);
  }
  const cookie = parseSessionCookie(res.headers);
  if (!cookie) {
    throw new Error('console login returned no session cookie');
  }
  cachedSession = { cookie, expiresAt: Date.now() + SESSION_TTL_MS };
  return cookie;
}

/** Extract the session cookie value from the login response's Set-Cookie header. */
function parseSessionCookie(headers: Headers): string | null {
  const raw = headers.getSetCookie().join('; ');
  const m = raw.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;,\\s]+)`));
  return m ? `${SESSION_COOKIE_NAME}=${m[1]}` : null;
}

/**
 * Call a console endpoint with the bearer token, re-minting once on a 401 (a
 * token that lapsed between the cache check and the request). The body, when
 * present, is a JSON string and so is safe to replay on the retry.
 */
async function consoleFetch(
  path: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  let token = await getConsoleToken();
  let res = await authedFetch(path, init, token, timeoutMs);
  if (res.status === 401) {
    token = await getConsoleToken(true);
    res = await authedFetch(path, init, token, timeoutMs);
  }
  return res;
}

function authedFetch(
  path: string,
  init: RequestInit,
  token: string,
  timeoutMs: number
): Promise<Response> {
  return fetch(`${CONSOLE_BASE}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Turn a non-2xx console response into a ConsoleRequestError carrying the server's
 * explicit instruction when present, otherwise its `{ error }` message. Falls
 * back to the status line when the body isn't the expected shape.
 */
async function consoleError(res: Response): Promise<ConsoleRequestError> {
  try {
    const data = (await res.json()) as { error?: string; instruction?: string };
    if (data.instruction) return new ConsoleRequestError(data.instruction, res.status, data.instruction);
    if (data.error) return new ConsoleRequestError(data.error, res.status);
  } catch {
    /* non-JSON body — fall through to the status line */
  }
  return new ConsoleRequestError(`console request failed: HTTP ${res.status}`, res.status);
}

function hasErrorCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === code) return true;
    current = candidate.cause;
  }
  return false;
}

async function actionToken(forceRefresh = false): Promise<string> {
  try {
    return await getConsoleToken(forceRefresh);
  } catch (error) {
    // The console has run nothing yet (a 401 answer runs nothing either), so the
    // local binary cannot repeat an action.
    throw new ConsoleActionUnavailableError('console token unavailable', { cause: error });
  }
}

async function actionFetch(request: ConsoleActionRequest, token: string): Promise<Response> {
  try {
    return await authedFetch(
      '/__console/action',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
      token,
      CONSOLE_ACTION_TIMEOUT_MS
    );
  } catch (error) {
    // A refused loopback connection proves the request never reached tmux. Other
    // transport failures are ambiguous, so retrying them locally could mutate twice.
    if (hasErrorCode(error, 'ECONNREFUSED')) {
      throw new ConsoleActionUnavailableError('console service unavailable', { cause: error });
    }
    throw error;
  }
}

async function postHTTPAction(request: ConsoleActionRequest): Promise<ConsoleActionResponse> {
  let token = await actionToken();
  let res = await actionFetch(request, token);
  if (res.status === 401) {
    token = await actionToken(true);
    res = await actionFetch(request, token);
  }
  if (!res.ok) throw await consoleError(res);
  const response = (await res.json()) as Partial<ConsoleActionResponse>;
  if (response.ok !== true) throw new Error('console action returned an invalid response');
  return response as ConsoleActionResponse;
}

function stopLocalAction(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The process exited between the failed group kill and this direct fallback.
  }
}

function localActionError(stdout: string, stderr: string, code: number | null): Error {
  try {
    const response = JSON.parse(stdout) as { error?: unknown };
    if (typeof response.error === 'string' && response.error) return new Error(response.error);
  } catch {
    // A startup failure may be plain stderr rather than the CLI JSON envelope.
  }
  const detail = stderr.trim();
  return new Error(detail || `local console action failed: exit ${code ?? 'signal'}`);
}

function runLocalAction(request: ConsoleActionRequest): Promise<ConsoleActionResponse> {
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > LOCAL_ACTION_OUTPUT_LIMIT) {
    return Promise.reject(new Error('local console action request is too large'));
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(CONSOLE_BINARY, ['--action-json', payload], {
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new Error('could not start local console action', { cause: error }));
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fail = (error: Error, stop: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (stop) stopLocalAction(child);
      reject(error);
    };
    const collect = (stream: 'stdout' | 'stderr', data: Buffer | string): void => {
      if (settled) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      outputBytes += chunk.length;
      if (outputBytes > LOCAL_ACTION_OUTPUT_LIMIT) {
        fail(new Error('local console action output exceeded 4096 bytes'), true);
        return;
      }
      if (stream === 'stdout') stdout = Buffer.concat([stdout, chunk]);
      else stderr = Buffer.concat([stderr, chunk]);
    };

    child.stdout?.on('data', (data: Buffer | string) => collect('stdout', data));
    child.stderr?.on('data', (data: Buffer | string) => collect('stderr', data));
    child.once('error', (error) => {
      fail(new Error('could not start local console action', { cause: error }), true);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdoutText = stdout.toString('utf8').trim();
      const stderrText = stderr.toString('utf8');
      if (code !== 0) {
        reject(localActionError(stdoutText, stderrText, code));
        return;
      }
      try {
        const response = JSON.parse(stdoutText) as Partial<ConsoleActionResponse>;
        if (response.ok !== true) throw new Error('local console action returned an invalid response');
        resolve(response as ConsoleActionResponse);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    timer = setTimeout(() => {
      fail(new Error(`local console action timed out after ${localActionTimeoutMs}ms`), true);
    }, localActionTimeoutMs);
  });
}

async function postAction(request: ConsoleActionRequest): Promise<ConsoleActionResponse> {
  try {
    return await postHTTPAction(request);
  } catch (error) {
    if (error instanceof ConsoleActionUnavailableError) return runLocalAction(request);
    throw error;
  }
}

export function launchTool(toolId: string): Promise<ConsoleActionResponse> {
  return postAction({ action: 'launch', toolId });
}

export function connectTool(toolId: string): Promise<ConsoleActionResponse> {
  return postAction({ action: 'connect', toolId });
}

export function newWindow(): Promise<ConsoleActionResponse> {
  return postAction({ action: 'new-window' });
}

export function selectWindow(index: number): Promise<ConsoleActionResponse> {
  return postAction({ action: 'select-window', index });
}

export function killWindow(index: number): Promise<ConsoleActionResponse> {
  return postAction({ action: 'kill-window', index });
}

/**
 * GET /__console/tools — the AI-tool grid: each tool's static catalog fields plus
 * its live installed + auth status, computed by the console reading this
 * container. The single source that replaced environment.ts's local checkAuth.
 */
export async function getTools(): Promise<{
  tools: AITool[];
  envVarMeta: Record<string, EnvVarMeta>;
}> {
  const res = await consoleFetch('/__console/tools', {}, CONSOLE_READ_TIMEOUT_MS);
  if (!res.ok) throw await consoleError(res);
  const data = (await res.json()) as {
    tools?: AITool[];
    envVarMeta?: Record<string, EnvVarMeta>;
  };
  return { tools: data.tools ?? [], envVarMeta: data.envVarMeta ?? {} };
}

/** Persist a declared tool key through the console's one credential path. */
export async function setToolApiKey(toolId: string, envVar: string, key: string): Promise<void> {
  const request: ToolMutationRequest = { action: 'set-key', toolId, envVar, key };
  const res = await consoleFetch(
    '/__console/tools',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    CONSOLE_ACTION_TIMEOUT_MS
  );
  if (!res.ok) throw await consoleError(res);
}

/** Remove tool credentials; interactive vendor logouts return the next instruction. */
export async function signOutTool(toolId: string): Promise<ToolSignOutResponse> {
  const request: ToolMutationRequest = { action: 'sign-out', toolId };
  const res = await consoleFetch(
    '/__console/tools',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    CONSOLE_ACTION_TIMEOUT_MS
  );
  if (!res.ok) throw await consoleError(res);
  return (await res.json()) as ToolSignOutResponse;
}

/** GET /__console/skills — the installed-skills list, enriched + sorted server-side. */
export async function listInstalledSkills(): Promise<InstalledSkill[]> {
  const res = await consoleFetch('/__console/skills', {}, CONSOLE_READ_TIMEOUT_MS);
  if (!res.ok) throw await consoleError(res);
  const data = (await res.json()) as { installed?: InstalledSkill[] };
  return data.installed ?? [];
}

/**
 * GET /__console/skills?q= — merged first-party + skills.sh registry results,
 * passed through as-is (`installs` is null for first-party skills, a count for
 * community ones — exactly the SkillsShResult wire shape).
 */
export async function searchSkills(query: string): Promise<SkillsShResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const res = await consoleFetch(
    `/__console/skills?q=${encodeURIComponent(q)}`,
    {},
    CONSOLE_READ_TIMEOUT_MS
  );
  if (!res.ok) throw await consoleError(res);
  const data = (await res.json()) as { results?: SkillsShResult[] };
  return data.results ?? [];
}

/**
 * POST /__console/skills {action:'install'} — install the skill into every
 * connected skills-capable tool. The console computes that agent set server-side
 * (same auth checks as the tool grid), so the caller passes no tool ids.
 */
export async function installSkill(source: string, skillId: string): Promise<void> {
  const res = await consoleFetch(
    '/__console/skills',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'install', source, skillId }),
    },
    CONSOLE_ACTION_TIMEOUT_MS
  );
  if (!res.ok) throw await consoleError(res);
}

/**
 * POST /__console/skills {action:'remove'} — remove an installed skill. Pass the
 * skill's `path` (from listInstalledSkills); the console basenames it to the
 * directory name the `npx skills` CLI matches on.
 */
export async function removeSkill(dir: string): Promise<void> {
  const res = await consoleFetch(
    '/__console/skills',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', dir }),
    },
    CONSOLE_ACTION_TIMEOUT_MS
  );
  if (!res.ok) throw await consoleError(res);
}

/**
 * GET /__console/skills/markdown — a registry skill's SKILL.md for the detail
 * view, already frontmatter-stripped with the scalars parsed out server-side.
 */
export async function fetchSkillMarkdown(
  source: string,
  skillId: string
): Promise<{ markdown: string; frontmatter: SkillFrontmatter }> {
  const res = await consoleFetch(
    `/__console/skills/markdown?source=${encodeURIComponent(source)}&skillId=${encodeURIComponent(skillId)}`,
    {},
    CONSOLE_READ_TIMEOUT_MS
  );
  if (!res.ok) throw await consoleError(res);
  const data = (await res.json()) as { markdown?: string; frontmatter?: SkillFrontmatter };
  return { markdown: data.markdown ?? '', frontmatter: data.frontmatter ?? {} };
}
