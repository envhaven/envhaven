// Thin client for the per-container Go console's out-of-band HTTP API. The
// console (console/api.go) is the single source of truth for the surfaces the
// extension used to re-implement in TypeScript: skills (registry search,
// install/remove via `npx skills`, installed-list enrichment, SKILL.md
// fetch/frontmatter) and the AI-tool grid (installed + per-tool auth status).
// The extension host now just calls the loopback console.
//
// Auth: every `/__console/*` route sits behind an `Authorization: Bearer <token>`
// wall, and this client mints that token two ways, chosen by which credentials
// the workspace carries:
//   - managed: the platform mints a ~60s EdDSA token for in-container callers via
//     an internal route, keyed on the `_ENVHAVEN_*` vars environment.ts reads.
//   - self-hosted: those vars are absent, so we exchange the operator's own web
//     password (PASSWORD, the same one code-server uses) for the console's 60s
//     HMAC token through its EXISTING browser login flow (POST /__console/login →
//     GET /__console/token). No second minting path is added to the image.
// A workspace is one or the other for its whole life. With neither credential
// (e.g. a self-host box configured with only HASHED_PASSWORD, no plaintext) the
// mint throws and callers degrade to an empty panel — the same graceful failure
// the old `npx skills` path had when the CLI was missing.

import type { AITool, InstalledSkill, SkillsShResult, SkillFrontmatter } from './shared-types';

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

// Per-call fetch budgets. Reads that fan out to GitHub/skills.sh server-side get
// a generous window; install/remove shell out to `npx skills`, which the console
// bounds at 120s, so the action budget must clear that.
const TOKEN_MINT_TIMEOUT_MS = 5_000;
const CONSOLE_READ_TIMEOUT_MS = 15_000;
const CONSOLE_ACTION_TIMEOUT_MS = 125_000;

let cachedToken: { token: string; expiresAt: number } | null = null;
// Self-host only: the login session cookie exchanged for short tokens.
let cachedSession: { cookie: string; expiresAt: number } | null = null;

/** Test-only: clear both auth caches so a test can exercise a fresh strategy. */
export function __resetAuthCache(): void {
  cachedToken = null;
  cachedSession = null;
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
 * vars are set; else fall back to the self-host web password. Absent both, throw
 * so the caller degrades to an empty panel.
 */
async function mintConsoleToken(): Promise<string> {
  const apiUrl = process.env._ENVHAVEN_API_URL;
  const workspaceId = process.env._ENVHAVEN_WORKSPACE_ID;
  const workspaceToken = process.env._ENVHAVEN_WORKSPACE_TOKEN;
  if (apiUrl && workspaceId && workspaceToken) {
    return mintManagedToken(apiUrl, workspaceId, workspaceToken);
  }
  const password = process.env.PASSWORD;
  if (password) {
    return mintSelfHostToken(password);
  }
  throw new Error('console unavailable: no workspace credentials or web password');
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
 * Turn a non-2xx console response into an Error carrying the server's
 * `{ error }` message, matching how the old CLI path signalled failure. Falls
 * back to the status line when the body isn't the expected shape.
 */
async function consoleError(res: Response): Promise<Error> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data.error) return new Error(data.error);
  } catch {
    /* non-JSON body — fall through to the status line */
  }
  return new Error(`console request failed: HTTP ${res.status}`);
}

/**
 * GET /__console/tools — the AI-tool grid: each tool's static catalog fields plus
 * its live installed + auth status, computed by the console reading this
 * container. The single source that replaced environment.ts's local checkAuth.
 */
export async function getTools(): Promise<AITool[]> {
  const res = await consoleFetch('/__console/tools', {}, CONSOLE_READ_TIMEOUT_MS);
  if (!res.ok) throw await consoleError(res);
  const data = (await res.json()) as { tools?: AITool[] };
  return data.tools ?? [];
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
