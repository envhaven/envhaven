import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  fetchEnvhavenSkills,
  parseSkillFrontmatter,
  searchAllSkills,
  searchSkillsSh,
  stripSkillFrontmatter,
} from '../skillsService';

// ---------------------------------------------------------------------------
// Routed fetch mock. skillsService talks to three hosts; each gets a handler
// keyed off the URL, with per-host call counters and failure toggles.
//
// NOTE ON ORDER: skillsService holds module-level caches (per-query for
// skills.sh, a singleton for the EnvHaven list) with a 5-minute TTL, so tests
// in this file run in declaration order by design. The double-failure test
// must come first (it needs the EnvHaven cache empty), the cache test
// populates it, and the merge tests below rely on that populated cache.
// ---------------------------------------------------------------------------

const TREE = {
  tree: [
    { path: 'skills/deploy/SKILL.md', type: 'blob' },
    { path: 'skills/verify/SKILL.md', type: 'blob' },
    { path: 'skills/zeta/SKILL.md', type: 'blob' }, // raw fetch for this one fails
    { path: 'skills/deploy', type: 'tree' }, // not a blob: ignored
    { path: 'skills/nested/sub/SKILL.md', type: 'blob' }, // too deep: ignored
    { path: 'README.md', type: 'blob' }, // not a skill: ignored
  ],
};

const RAW: Record<string, string> = {
  'skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploy things\n---\nbody',
  'skills/verify/SKILL.md': '---\nname: verify\ndescription: Verify things\n---\nbody',
  // skills/zeta/SKILL.md intentionally absent -> raw fetch 500 -> skill dropped
};

const state = {
  shFail: false,
  treeFail: false,
  shByQuery: {} as Record<string, unknown[]>,
  counts: { sh: 0, tree: 0, raw: 0 },
};

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = String(input);
    if (url.startsWith('https://skills.sh/api/search')) {
      state.counts.sh++;
      if (state.shFail) return Promise.resolve(new Response('down', { status: 500 }));
      const q = new URL(url).searchParams.get('q') ?? '';
      return Promise.resolve(Response.json({ skills: state.shByQuery[q] ?? [] }));
    }
    if (url.includes('api.github.com/repos/envhaven/envhaven/git/trees')) {
      state.counts.tree++;
      if (state.treeFail) return Promise.resolve(new Response('down', { status: 500 }));
      return Promise.resolve(Response.json(TREE));
    }
    if (url.includes('raw.githubusercontent.com/envhaven/envhaven/HEAD/')) {
      state.counts.raw++;
      const body = RAW[decodeURIComponent(url.split('/HEAD/')[1])];
      if (body === undefined) return Promise.resolve(new Response('missing', { status: 500 }));
      return Promise.resolve(new Response(body));
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('searchAllSkills', () => {
  test('throws only when both sources fail, naming each failure', async () => {
    state.shFail = true;
    state.treeFail = true;
    await expect(searchAllSkills('boom')).rejects.toThrow(/skills\.sh:.*envhaven:/);
    state.shFail = false;
    state.treeFail = false;
  });

  test('fetchEnvhavenSkills enumerates the tree, drops unfetchable skills, sorts, and caches', async () => {
    const results = await fetchEnvhavenSkills();
    expect(results.map((s) => s.name)).toEqual(['deploy', 'verify']); // zeta dropped, sorted
    expect(results[0]).toEqual({
      id: 'envhaven/envhaven/deploy',
      skillId: 'deploy',
      name: 'deploy',
      source: 'envhaven/envhaven',
    });
    expect(results[0].installs).toBeUndefined();
    expect(state.counts.tree).toBe(2); // 1 from the double-failure test, 1 here

    await fetchEnvhavenSkills();
    expect(state.counts.tree).toBe(2); // second call served from cache
  });

  test('the literal query "envhaven" lists every first-party skill, ahead of community results', async () => {
    state.shByQuery['envhaven'] = [
      { id: 'c1', skillId: 'envhaven-tips', name: 'envhaven-tips', installs: 3, source: 'acme/skills' },
    ];
    const results = await searchAllSkills('envhaven');
    expect(results.map((s) => s.name)).toEqual(['deploy', 'verify', 'envhaven-tips']);
  });

  test('filters first-party skills by name and dedupes against skills.sh by (source, skillId)', async () => {
    state.shByQuery['deploy'] = [
      // Same skill surfaced by skills.sh: must not appear twice.
      { id: 'd1', skillId: 'deploy', name: 'deploy', installs: 12, source: 'envhaven/envhaven' },
      { id: 'd2', skillId: 'react-deploy', name: 'react-deploy', installs: 5, source: 'acme/skills' },
    ];
    const results = await searchAllSkills('deploy');
    expect(results.map((s) => s.name)).toEqual(['deploy', 'react-deploy']);
    expect(results[0].installs).toBeUndefined(); // the first-party entry won the dedup
    expect(results[1].installs).toBe(5); // community installs stat intact
  });

  test('tolerates a skills.sh failure: first-party matches still render', async () => {
    state.shFail = true;
    const results = await searchAllSkills('ver');
    expect(results.map((s) => s.name)).toEqual(['verify']);
    state.shFail = false;
  });

  test('returns only community results when no first-party name matches', async () => {
    state.shByQuery['zz'] = [
      { id: 'z1', skillId: 'zzz', name: 'zzz', installs: 1, source: 'acme/skills' },
    ];
    const results = await searchAllSkills('zz');
    expect(results.map((s) => s.name)).toEqual(['zzz']);
  });

  test('queries under 2 characters return empty without touching the network', async () => {
    const before = { ...state.counts };
    expect(await searchAllSkills('a')).toEqual([]);
    expect(await searchAllSkills('  ')).toEqual([]);
    expect(state.counts).toEqual(before);
  });
});

describe('searchSkillsSh', () => {
  test('caches per query', async () => {
    state.shByQuery['cachetest'] = [
      { id: 'q1', skillId: 'q', name: 'q', installs: 1, source: 'acme/skills' },
    ];
    const before = state.counts.sh;
    await searchSkillsSh('cachetest');
    await searchSkillsSh('cachetest');
    expect(state.counts.sh).toBe(before + 1);
  });

  test('throws on a non-OK response', async () => {
    state.shFail = true;
    await expect(searchSkillsSh('failing')).rejects.toThrow(/HTTP 500/);
    state.shFail = false;
  });
});

describe('skill frontmatter', () => {
  const md = '---\nname: "quoted"\ndescription: plain text\nignored: field\n---\n# Body\n';

  test('parseSkillFrontmatter reads known keys and unquotes values', () => {
    expect(parseSkillFrontmatter(md)).toEqual({ name: 'quoted', description: 'plain text' });
    expect(parseSkillFrontmatter('no frontmatter')).toEqual({});
  });

  test('stripSkillFrontmatter removes the leading block only', () => {
    expect(stripSkillFrontmatter(md)).toBe('# Body\n');
    expect(stripSkillFrontmatter('no frontmatter')).toBe('no frontmatter');
  });
});
