import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as client from '../consoleClient';

// ---------------------------------------------------------------------------
// Routed fetch mock. consoleClient talks to two hosts: the platform API (to mint
// a console token) and the loopback console (the skills endpoints). Each is keyed
// off the URL, with a mint counter and a one-shot 401 toggle so the token
// lifecycle can be exercised.
//
// Every test runs order-free: the top-level beforeEach resets the module's auth
// caches (__resetAuthCache) and this mock's counters, and each describe installs
// the credentials it needs, so every test owns its own mint counts.
// ---------------------------------------------------------------------------

const API = 'https://api.test';
const WID = 'ws-123';
const WTOKEN = 'ewt_test';

const state = {
  mintCount: 0,
  consoleStatus: 200,
  consoleBody: {} as unknown,
  fail401Once: false,
  lastConsole: { url: '', authorization: '', method: 'GET', body: '' },
  // Self-host login flow: /__console/login (204 + Set-Cookie) → /__console/token.
  loginCount: 0,
  lastLoginBody: '',
};

/** Managed workspace: the platform-mint credentials, no web password. */
function setManagedCredentials(): void {
  process.env._ENVHAVEN_API_URL = API;
  process.env._ENVHAVEN_WORKSPACE_ID = WID;
  process.env._ENVHAVEN_WORKSPACE_TOKEN = WTOKEN;
  delete process.env.PASSWORD;
}

/** Self-host workspace: only the web password is present. */
function setSelfHostCredentials(): void {
  delete process.env._ENVHAVEN_API_URL;
  delete process.env._ENVHAVEN_WORKSPACE_ID;
  delete process.env._ENVHAVEN_WORKSPACE_TOKEN;
  process.env.PASSWORD = 'hunter2';
}

function clearCredentials(): void {
  delete process.env._ENVHAVEN_API_URL;
  delete process.env._ENVHAVEN_WORKSPACE_ID;
  delete process.env._ENVHAVEN_WORKSPACE_TOKEN;
  delete process.env.PASSWORD;
}

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/console-token')) {
      state.mintCount++;
      return Promise.resolve(Response.json({ token: `tok-${state.mintCount}` }));
    }
    if (url.endsWith('/__console/login')) {
      state.loginCount++;
      state.lastLoginBody = typeof init?.body === 'string' ? init.body : '';
      return Promise.resolve(
        new Response(null, {
          status: 204,
          headers: { 'Set-Cookie': 'envhaven_console_session=sess-1; Path=/__console; HttpOnly; SameSite=Strict' },
        })
      );
    }
    if (url.endsWith('/__console/token')) {
      return Promise.resolve(new Response('sh-tok-1', { status: 200 }));
    }
    if (url.startsWith('http://127.0.0.1:7681/__console/')) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      state.lastConsole = {
        url,
        authorization: headers.Authorization ?? '',
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      };
      if (state.fail401Once) {
        state.fail401Once = false;
        return Promise.resolve(new Response('unauthorized', { status: 401 }));
      }
      return Promise.resolve(Response.json(state.consoleBody, { status: state.consoleStatus }));
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  clearCredentials();
});

beforeEach(() => {
  client.__resetAuthCache();
  state.mintCount = 0;
  state.loginCount = 0;
  state.consoleStatus = 200;
  state.consoleBody = {};
  state.fail401Once = false;
  state.lastConsole = { url: '', authorization: '', method: 'GET', body: '' };
  state.lastLoginBody = '';
});

describe('console token lifecycle', () => {
  beforeEach(setManagedCredentials);

  test('throws when no credential is present at all, without minting', async () => {
    clearCredentials();
    await expect(client.listInstalledSkills()).rejects.toThrow(/no workspace credentials or web password/);
    expect(state.mintCount).toBe(0);
  });

  test('mints a token from the internal route and reuses it while fresh', async () => {
    state.consoleBody = { installed: [] };

    await client.listInstalledSkills();
    await client.listInstalledSkills();
    expect(state.mintCount).toBe(1); // second call served from the cached token
    expect(state.lastConsole.authorization).toBe('Bearer tok-1');
  });

  test('re-mints once on a 401 and retries the request', async () => {
    state.consoleBody = { installed: [] };
    state.fail401Once = true;
    await client.listInstalledSkills();
    expect(state.mintCount).toBe(2); // the 401 forced a fresh mint
    expect(state.lastConsole.authorization).toBe('Bearer tok-2');
  });
});

describe('listInstalledSkills', () => {
  beforeEach(setManagedCredentials);

  test('returns the console `installed` array', async () => {
    state.consoleBody = {
      installed: [
        { name: 'deploy', description: 'd', source: null, path: '/p', agents: ['claude'] },
      ],
    };
    const skills = await client.listInstalledSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('deploy');
  });
});

describe('searchSkills', () => {
  beforeEach(setManagedCredentials);

  test('returns [] for queries under 2 chars without touching the network', async () => {
    expect(await client.searchSkills('a')).toEqual([]);
    expect(await client.searchSkills('  ')).toEqual([]);
    expect(state.mintCount).toBe(0); // no token minted, no fetch
  });

  test('passes `installs` through unchanged: null for first-party, counts kept', async () => {
    state.consoleBody = {
      results: [
        { id: 'envhaven/envhaven/deploy', skillId: 'deploy', name: 'deploy', installs: null, source: 'envhaven/envhaven' },
        { id: 'c1', skillId: 'react', name: 'react', installs: 12, source: 'acme/skills' },
      ],
    };
    const results = await client.searchSkills('deploy');
    expect(results[0].installs).toBeNull(); // the wire value, no normalization
    expect(results[1].installs).toBe(12);
    expect(state.lastConsole.url).toContain('q=deploy');
  });
});

describe('installSkill / removeSkill', () => {
  beforeEach(setManagedCredentials);

  test('install POSTs the action body and resolves on ok', async () => {
    state.consoleBody = { ok: true };
    await client.installSkill('acme/skills', 'react');
    expect(state.lastConsole.method).toBe('POST');
    expect(JSON.parse(state.lastConsole.body)).toEqual({
      action: 'install',
      source: 'acme/skills',
      skillId: 'react',
    });
  });

  test('surfaces the console `{ error }` message on a non-2xx', async () => {
    state.consoleStatus = 500;
    state.consoleBody = { error: 'install failed' };
    await expect(client.installSkill('acme/skills', 'react')).rejects.toThrow('install failed');
  });

  test('remove forwards the installed path as `dir`', async () => {
    state.consoleBody = { ok: true };
    await client.removeSkill('/config/.claude/skills/deploy');
    expect(JSON.parse(state.lastConsole.body)).toEqual({
      action: 'remove',
      dir: '/config/.claude/skills/deploy',
    });
  });
});

describe('fetchSkillMarkdown', () => {
  beforeEach(setManagedCredentials);

  test('returns the stripped markdown and parsed frontmatter', async () => {
    state.consoleBody = { markdown: '# Body', frontmatter: { name: 'deploy', description: 'd' } };
    const out = await client.fetchSkillMarkdown('acme/skills', 'deploy');
    expect(out.markdown).toBe('# Body');
    expect(out.frontmatter).toEqual({ name: 'deploy', description: 'd' });
    expect(state.lastConsole.url).toContain('source=acme%2Fskills');
    expect(state.lastConsole.url).toContain('skillId=deploy');
  });
});

describe('getTools', () => {
  beforeEach(setManagedCredentials);

  test('returns the console `tools` array with installed + auth state', async () => {
    state.consoleBody = {
      tools: [
        {
          id: 'claude',
          name: 'Claude Code',
          command: 'claude',
          authCommand: 'claude-auth-helper',
          description: "Anthropic's official CLI",
          docsUrl: 'https://docs.anthropic.com',
          envVars: ['ANTHROPIC_API_KEY'],
          setupSteps: [],
          installed: true,
          authStatus: 'ready',
          connectedVia: 'ANTHROPIC_API_KEY',
        },
      ],
    };
    const tools = await client.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].id).toBe('claude');
    expect(tools[0].installed).toBe(true);
    expect(tools[0].authStatus).toBe('ready');
    expect(state.lastConsole.url).toContain('/__console/tools');
  });
});

describe('self-host auth (web password)', () => {
  beforeEach(setSelfHostCredentials);

  test('logs in with PASSWORD, exchanges the cookie for a token, and caches both', async () => {
    state.consoleBody = { installed: [] };

    await client.listInstalledSkills();
    expect(state.mintCount).toBe(0); // no platform mint on self-host
    expect(state.loginCount).toBe(1);
    expect(state.lastLoginBody).toContain('password=hunter2');
    expect(state.lastConsole.authorization).toBe('Bearer sh-tok-1');

    await client.listInstalledSkills();
    expect(state.loginCount).toBe(1); // session + token cached, no second login
  });
});
