import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { createHmac, hkdfSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as client from '../consoleClient';

// ---------------------------------------------------------------------------
// Routed fetch mock. consoleClient talks to two hosts: the platform API (to mint
// a console token) and the loopback console (the skills endpoints). Each is keyed
// off the URL, with a mint counter and a one-shot 401 toggle so the token
// lifecycle can be exercised.
//
// Every test runs order-free: the top-level beforeEach resets the module's auth
// caches (__resetAuthCache) and this mock's counters and gives the client an empty
// container environment directory, and each describe installs the credentials it
// needs, so every test owns its own mint counts.
// ---------------------------------------------------------------------------

const API = 'https://api.test';
const WID = 'ws-123';
const WTOKEN = 'ewt_test';
const HASH = 'C4BBCB1FBEC99D65BF59D85C8CB62EE2DB963F0FE106F483D9AFA73BD4E39A8A';
const realSpawn = childProcess.spawn;
const spawnMock = mock(
  (command: string, args: readonly string[] = [], options: childProcess.SpawnOptions = {}) =>
    realSpawn(command, args, options)
);
mock.module('node:child_process', () => ({ spawn: spawnMock }));

/** Make the local console binary print `body` and exit with `exitCode`. */
function returnLocalJSON(body: object, exitCode = 0): void {
  const source = `process.stdout.write(${JSON.stringify(JSON.stringify(body))}); process.exitCode = ${exitCode};`;
  spawnMock.mockImplementation(
    (_command: string, _args: readonly string[] = [], options: childProcess.SpawnOptions = {}) =>
      realSpawn(process.execPath, ['-e', source], options)
  );
}

/** The loopback proof for HASH at `issued`, derived independently of the client. */
function hashProof(issued: string): string {
  const secret = Buffer.from(
    hkdfSync('sha256', Buffer.from('c4bbcb1fbec99d65bf59d85c8cb62ee2db963f0fe106f483d9afa73bd4e39a8a'), Buffer.from('envhaven-console'), Buffer.from('token-signing-key/v1'), 32)
  );
  return createHmac('sha256', secret).update(`extension-token|${issued}`).digest('base64url');
}

const state = {
  mintCount: 0,
  mintStatus: 200,
  consoleStatus: 200,
  consoleBody: {} as unknown,
  consoleFailure: null as unknown,
  fail401Once: false,
  lastConsole: { url: '', authorization: '', method: 'GET', body: '' },
  // Self-host login flow: /__console/login (204 + Set-Cookie) → /__console/token.
  loginCount: 0,
  lastLoginBody: '',
  internalTokenCount: 0,
  lastInternalHeaders: {} as Record<string, string>,
};

/** Managed workspace: the platform-mint credentials, no web password. */
function setManagedCredentials(): void {
  process.env._ENVHAVEN_API_URL = API;
  process.env._ENVHAVEN_WORKSPACE_ID = WID;
  process.env._ENVHAVEN_WORKSPACE_TOKEN = WTOKEN;
  delete process.env.PASSWORD;
  delete process.env.HASHED_PASSWORD;
}

/** Self-host workspace: only the web password is present. */
function setSelfHostCredentials(): void {
  delete process.env._ENVHAVEN_API_URL;
  delete process.env._ENVHAVEN_WORKSPACE_ID;
  delete process.env._ENVHAVEN_WORKSPACE_TOKEN;
  delete process.env.HASHED_PASSWORD;
  process.env.PASSWORD = 'hunter2';
}

function setHashSelfHostCredentials(): void {
  delete process.env._ENVHAVEN_API_URL;
  delete process.env._ENVHAVEN_WORKSPACE_ID;
  delete process.env._ENVHAVEN_WORKSPACE_TOKEN;
  delete process.env.PASSWORD;
  process.env.HASHED_PASSWORD = HASH;
}

function clearCredentials(): void {
  delete process.env._ENVHAVEN_API_URL;
  delete process.env._ENVHAVEN_WORKSPACE_ID;
  delete process.env._ENVHAVEN_WORKSPACE_TOKEN;
  delete process.env.PASSWORD;
  delete process.env.HASHED_PASSWORD;
}

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/console-token')) {
      state.mintCount++;
      if (state.mintStatus !== 200) {
        return Promise.resolve(new Response('platform unavailable', { status: state.mintStatus }));
      }
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
    if (url.endsWith('/__console/internal-token')) {
      state.internalTokenCount++;
      state.lastInternalHeaders = { ...((init?.headers ?? {}) as Record<string, string>) };
      return Promise.resolve(new Response('hash-tok-1', { status: 200 }));
    }
    if (url.startsWith('http://127.0.0.1:7681/__console/')) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      state.lastConsole = {
        url,
        authorization: headers.Authorization ?? '',
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
      };
      if (state.consoleFailure) return Promise.reject(state.consoleFailure);
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

// This container may carry a real /run/s6/container_environment/PASSWORD, and no
// test may read it, so each test gets a fresh empty stand-in.
let containerEnv = '';

beforeEach(() => {
  client.__resetAuthCache();
  containerEnv = mkdtempSync(join(tmpdir(), 'envhaven-container-env-'));
  client.__setContainerEnvDirForTests(containerEnv);
  state.mintCount = 0;
  state.mintStatus = 200;
  state.loginCount = 0;
  state.consoleStatus = 200;
  state.consoleBody = {};
  state.consoleFailure = null;
  state.fail401Once = false;
  state.lastConsole = { url: '', authorization: '', method: 'GET', body: '' };
  state.lastLoginBody = '';
  state.internalTokenCount = 0;
  state.lastInternalHeaders = {};
  spawnMock.mockClear();
  spawnMock.mockImplementation(
    (command: string, args: readonly string[] = [], options: childProcess.SpawnOptions = {}) =>
      realSpawn(command, args, options)
  );
});

afterEach(() => {
  rmSync(containerEnv, { recursive: true, force: true });
});

describe('console token lifecycle', () => {
  beforeEach(setManagedCredentials);

  test('throws when no credential is present at all, without minting', async () => {
    clearCredentials();
    await expect(client.listInstalledSkills()).rejects.toThrow(/no workspace credentials or web credential/);
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
          authSource: 'process-env',
        },
      ],
      envVarMeta: {
        ANTHROPIC_API_KEY: {
          placeholder: 'sk-ant-...',
          hint: 'Anthropic API key',
          url: 'https://console.anthropic.com/settings/keys',
        },
      },
    };
    const data = await client.getTools();
    expect(data.tools).toHaveLength(1);
    expect(data.tools[0].id).toBe('claude');
    expect(data.tools[0].installed).toBe(true);
    expect(data.tools[0].authStatus).toBe('ready');
    expect(data.envVarMeta.ANTHROPIC_API_KEY.hint).toBe('Anthropic API key');
    expect(state.lastConsole.url).toContain('/__console/tools');
  });
});

describe('tmux action contracts', () => {
  beforeEach(setManagedCredentials);

  const cases: Array<{
    name: string;
    run: () => Promise<{ ok: true }>;
    body: Record<string, unknown>;
  }> = [
    { name: 'launch', run: () => client.launchTool('claude'), body: { action: 'launch', toolId: 'claude' } },
    { name: 'connect', run: () => client.connectTool('codex'), body: { action: 'connect', toolId: 'codex' } },
    { name: 'new window', run: () => client.newWindow(), body: { action: 'new-window' } },
    { name: 'select window', run: () => client.selectWindow(7), body: { action: 'select-window', index: 7 } },
    { name: 'kill window', run: () => client.killWindow(8), body: { action: 'kill-window', index: 8 } },
  ];

  for (const action of cases) {
    test(`${action.name} POSTs only its typed action fields`, async () => {
      state.consoleBody = { ok: true };
      expect(await action.run()).toEqual({ ok: true });
      expect(state.lastConsole.url).toBe('http://127.0.0.1:7681/__console/action');
      expect(state.lastConsole.method).toBe('POST');
      expect(JSON.parse(state.lastConsole.body)).toEqual(action.body);
    });
  }

  test('rejects a malformed success envelope', async () => {
    state.consoleBody = {};
    await expect(client.newWindow()).rejects.toThrow('console action returned an invalid response');
  });

  test('does not repeat an HTTP action after a server error', async () => {
    state.consoleStatus = 500;
    state.consoleBody = { error: 'tmux failed' };
    await expect(client.newWindow()).rejects.toThrow('tmux failed');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('local tmux action fallback', () => {
  beforeEach(clearCredentials);

  test('uses the fixed binary and one JSON argv value when credentials are absent', async () => {
    returnLocalJSON({ ok: true });

    await expect(client.newWindow()).resolves.toEqual({ ok: true });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0];
    expect(command).toBe('/opt/envhaven/bin/envhaven-console');
    expect(args).toEqual(['--action-json', '{"action":"new-window"}']);
    expect(options).toMatchObject({
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  test('surfaces the CLI JSON error', async () => {
    returnLocalJSON({ ok: false, error: 'unknown tool' }, 1);
    await expect(client.launchTool('ghost')).rejects.toThrow('unknown tool');
  });

  test('kills the local action process group at its hard deadline', async () => {
    client.__setLocalActionTimeoutForTests(1000);
    const fixture = mkdtempSync(join(tmpdir(), 'envhaven-local-action-'));
    const pidFile = join(fixture, 'descendant.pid');
    let spawned: childProcess.ChildProcess | undefined;
    let descendantPID = 0;
    spawnMock.mockImplementation(
      (_command: string, _args: readonly string[] = [], options: childProcess.SpawnOptions = {}) => {
        const source = `
          const { spawn } = require('node:child_process');
          const { writeFileSync } = require('node:fs');
          const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
          writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
          setTimeout(() => {}, 10000);
        `;
        spawned = realSpawn(process.execPath, ['-e', source], options);
        return spawned;
      }
    );

    try {
      const started = Date.now();
      await expect(client.newWindow()).rejects.toThrow('timed out after 1000ms');
      expect(Date.now() - started).toBeLessThan(3000);
      if (spawned && spawned.exitCode === null && spawned.signalCode === null) {
        await once(spawned, 'close');
      }
      expect(spawned?.signalCode).toBe('SIGKILL');

      descendantPID = Number(readFileSync(pidFile, 'utf8'));
      let descendantRunning = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          process.kill(descendantPID, 0);
          await Bun.sleep(10);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            descendantRunning = false;
            break;
          }
          throw error;
        }
      }
      expect(descendantRunning).toBe(false);
    } finally {
      if (descendantPID > 0) {
        try { process.kill(descendantPID, 'SIGKILL'); } catch {}
      }
      if (spawned && spawned.exitCode === null && spawned.signalCode === null) {
        try { spawned.kill('SIGKILL'); } catch {}
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('kills a local action whose combined output exceeds 4096 bytes', async () => {
    spawnMock.mockImplementation(
      (_command: string, _args: readonly string[] = [], options: childProcess.SpawnOptions = {}) =>
        realSpawn(
          process.execPath,
          ['-e', `process.stdout.write('x'.repeat(4097)); setTimeout(() => {}, 10000)`],
          options
        )
    );
    await expect(client.newWindow()).rejects.toThrow('output exceeded 4096 bytes');
  });

  test('falls back after a definite loopback connection refusal', async () => {
    setManagedCredentials();
    returnLocalJSON({ ok: true });
    const cause = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
    state.consoleFailure = new TypeError('fetch failed', { cause });

    await expect(client.selectWindow(2)).resolves.toEqual({ ok: true });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test('falls back when the platform refuses to mint a token', async () => {
    setManagedCredentials();
    state.mintStatus = 503;
    returnLocalJSON({ ok: true });

    await expect(client.newWindow()).resolves.toEqual({ ok: true });
    expect(state.mintCount).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(state.lastConsole.url).toBe(''); // no action ever reached the console
  });

  test('does not repeat an action after an ambiguous transport failure', async () => {
    setManagedCredentials();
    state.consoleFailure = new TypeError('fetch failed');

    await expect(client.killWindow(2)).rejects.toThrow('fetch failed');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('tool credential mutations', () => {
  beforeEach(setManagedCredentials);

  test('setToolApiKey POSTs the tool id and credential fields', async () => {
    state.consoleBody = { ok: true };
    await client.setToolApiKey('amp', 'AMP_API_KEY', 'amp-secret');
    expect(state.lastConsole.method).toBe('POST');
    expect(JSON.parse(state.lastConsole.body)).toEqual({
      action: 'set-key',
      toolId: 'amp',
      envVar: 'AMP_API_KEY',
      key: 'amp-secret',
    });
  });

  test('signOutTool returns an interactive logout instruction', async () => {
    state.consoleBody = { ok: true, instruction: 'Run /logout.' };
    expect(await client.signOutTool('factory')).toEqual({
      ok: true,
      instruction: 'Run /logout.',
    });
    expect(JSON.parse(state.lastConsole.body)).toEqual({
      action: 'sign-out',
      toolId: 'factory',
    });
  });

  test('surfaces a credential mutation error', async () => {
    state.consoleStatus = 500;
    state.consoleBody = { error: 'tool credential setup failed' };
    await expect(client.setToolApiKey('amp', 'AMP_API_KEY', 'bad')).rejects.toThrow(
      'tool credential setup failed'
    );
  });

  test('surfaces a sign-out conflict instruction', async () => {
    state.consoleStatus = 409;
    state.consoleBody = {
      error: 'tool sign-out blocked',
      instruction: 'OPENAI_API_KEY is shared. Remove it from Environment.',
    };
    await expect(client.signOutTool('qwen')).rejects.toThrow(
      'OPENAI_API_KEY is shared. Remove it from Environment.'
    );
  });

  test('keeps the status and instruction of an incomplete sign-out', async () => {
    const instruction =
      'The logout session opened, but managed credential cleanup did not finish. Finish the vendor logout, then retry sign-out.';
    state.consoleStatus = 500;
    state.consoleBody = { error: 'tool sign-out incomplete', instruction };

    const error = await client.signOutTool('factory').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(client.ConsoleRequestError);
    expect(error).toMatchObject({ message: instruction, status: 500, instruction });
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
    expect(state.internalTokenCount).toBe(0);

    await client.listInstalledSkills();
    expect(state.loginCount).toBe(1); // session + token cached, no second login
  });
});

describe('self-host auth (hashed password)', () => {
  beforeEach(setHashSelfHostCredentials);

  test('uses a hash-derived loopback proof without exposing the hash', async () => {
    process.env.PASSWORD = 'ignored-because-the-hash-wins';
    state.consoleBody = { installed: [] };

    await client.listInstalledSkills();

    expect(state.loginCount).toBe(0);
    expect(state.internalTokenCount).toBe(1);
    expect(state.lastConsole.authorization).toBe('Bearer hash-tok-1');
    expect(state.lastInternalHeaders['X-EnvHaven-Proof']).toBe(
      hashProof(state.lastInternalHeaders['X-EnvHaven-Issued'])
    );
    expect(JSON.stringify(state.lastInternalHeaders)).not.toContain(process.env.HASHED_PASSWORD!);
  });
});

// code-server deletes PASSWORD and HASHED_PASSWORD before forking the extension
// host, so on a real self-host the s6 container environment is the source that
// counts; the host environment is used only when a file is missing.
describe('self-host auth (container environment)', () => {
  beforeEach(clearCredentials);

  test('proves a HASHED_PASSWORD read from the container environment', async () => {
    writeFileSync(join(containerEnv, 'HASHED_PASSWORD'), HASH);
    writeFileSync(join(containerEnv, 'PASSWORD'), 'ignored-because-the-hash-wins');
    state.consoleBody = { installed: [] };

    await client.listInstalledSkills();

    expect(state.loginCount).toBe(0);
    expect(state.internalTokenCount).toBe(1);
    expect(state.lastConsole.authorization).toBe('Bearer hash-tok-1');
    expect(state.lastInternalHeaders['X-EnvHaven-Proof']).toBe(
      hashProof(state.lastInternalHeaders['X-EnvHaven-Issued'])
    );
  });

  test('skips an empty HASHED_PASSWORD file and logs in with PASSWORD verbatim', async () => {
    writeFileSync(join(containerEnv, 'HASHED_PASSWORD'), '');
    writeFileSync(join(containerEnv, 'PASSWORD'), ' hunter2\n');
    process.env.HASHED_PASSWORD = HASH; // a login-shell export must not revive it
    state.consoleBody = { installed: [] };

    await client.listInstalledSkills();

    expect(state.internalTokenCount).toBe(0);
    expect(state.loginCount).toBe(1);
    // svc-console reads the file through with-contenv untrimmed, so the login must too.
    expect(state.lastLoginBody).toBe(`password=${encodeURIComponent(' hunter2\n')}`);
    expect(state.lastConsole.authorization).toBe('Bearer sh-tok-1');
  });

  // VS Code merges the user's login-shell environment into the extension host, and a
  // shell that exports PASSWORD for its own use must not replace the web password.
  test('prefers the container copy over a PASSWORD the login shell exports', async () => {
    writeFileSync(join(containerEnv, 'PASSWORD'), 'web');
    process.env.PASSWORD = 'other';
    state.consoleBody = { installed: [] };

    await client.listInstalledSkills();

    expect(state.loginCount).toBe(1);
    expect(state.lastLoginBody).toBe('password=web');
    expect(state.lastConsole.authorization).toBe('Bearer sh-tok-1');
  });

  test('with both files empty, reads fail and tmux actions use the local binary', async () => {
    writeFileSync(join(containerEnv, 'HASHED_PASSWORD'), '');
    writeFileSync(join(containerEnv, 'PASSWORD'), '');
    returnLocalJSON({ ok: true });

    await expect(client.listInstalledSkills()).rejects.toThrow(/no workspace credentials or web credential/);
    await expect(client.newWindow()).resolves.toEqual({ ok: true });
    expect(state.loginCount).toBe(0);
    expect(state.internalTokenCount).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe('/opt/envhaven/bin/envhaven-console');
  });
});
