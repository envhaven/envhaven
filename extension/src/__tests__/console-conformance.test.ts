import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { AITool, EnvVarMeta, InstalledSkill, SkillsShResult } from '../shared-types';

// Closes the Go↔TS wire loop for /tools and /skills. The Go side
// (console/api_golden_test.go) asserts the server emits console/testdata/
// tools.golden.json and skills.golden.json; here we assert those same goldens
// conform to the TypeScript AITool, InstalledSkill, and SkillsShResult. A field
// added, renamed, or retyped on either side of the boundary breaks a test on
// that side — the drift guard that replaces a codegen pipeline for this small,
// stable contract.

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

function readGolden<T>(name: string): T {
  return JSON.parse(
    readFileSync(join(__dirname, '../../../console/testdata', name), 'utf-8'),
  ) as T;
}

// ---------------------------------------------------------------------------
// /tools — AITool
// ---------------------------------------------------------------------------

// Compile-time: AITool must have EXACTLY these keys. Adding/removing/renaming a field in
// shared-types without updating this list (and the Go struct + golden) fails to compile.
type ExpectedAIToolKey =
  | 'id'
  | 'name'
  | 'command'
  | 'authCommand'
  | 'description'
  | 'docsUrl'
  | 'installed'
  | 'authStatus'
  | 'connectedVia'
  | 'setupSteps'
  | 'envVars';
const _aitoolKeysAreExact: AssertExact<keyof AITool, ExpectedAIToolKey> = true;
void _aitoolKeysAreExact;

const AITOOL_KEYS: string[] = [
  'id',
  'name',
  'command',
  'authCommand',
  'description',
  'docsUrl',
  'installed',
  'authStatus',
  'connectedVia',
  'setupSteps',
  'envVars',
].sort();

// Compile-time: EnvVarMeta must have EXACTLY these keys — the API-key input the dashboard
// renders from /tools' envVarMeta map reads placeholder/hint/url and nothing else.
type ExpectedEnvVarMetaKey = 'placeholder' | 'hint' | 'url';
const _envVarMetaKeysAreExact: AssertExact<keyof EnvVarMeta, ExpectedEnvVarMetaKey> = true;
void _envVarMetaKeysAreExact;

const ENV_VAR_META_KEYS: string[] = ['placeholder', 'hint', 'url'].sort();

const toolsGolden = readGolden<{
  tools: Record<string, unknown>[];
  envVarMeta: Record<string, Record<string, unknown>>;
}>('tools.golden.json');

describe('/tools golden conforms to the TS AITool', () => {
  test('the golden has tools', () => {
    expect(toolsGolden.tools.length).toBeGreaterThan(0);
  });

  test('every golden tool has exactly the AITool fields', () => {
    for (const tool of toolsGolden.tools) {
      expect(Object.keys(tool).sort()).toEqual(AITOOL_KEYS);
    }
  });

  test('field types match AITool', () => {
    for (const raw of toolsGolden.tools) {
      // Consuming as AITool here would need a cast; assert the wire values instead so a
      // retype on the Go side (e.g. installed number-not-bool) is caught at runtime.
      expect(typeof raw.id).toBe('string');
      expect(typeof raw.name).toBe('string');
      expect(typeof raw.command).toBe('string');
      expect(raw.authCommand === null || typeof raw.authCommand === 'string').toBe(true);
      expect(typeof raw.description).toBe('string');
      expect(typeof raw.docsUrl).toBe('string');
      expect(typeof raw.installed).toBe('boolean');
      expect(['ready', 'needs-auth', 'unknown']).toContain(raw.authStatus as string);
      expect(raw.connectedVia === null || typeof raw.connectedVia === 'string').toBe(true);
      expect(Array.isArray(raw.setupSteps)).toBe(true);
      expect(Array.isArray(raw.envVars)).toBe(true);
    }
  });
});

describe('/tools golden envVarMeta conforms to the TS EnvVarMeta', () => {
  const entries = Object.values(toolsGolden.envVarMeta);

  test('the golden has envVarMeta entries', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  test('the golden exercises both branches of the nullable url', () => {
    // Guards the fixture itself: `url` must appear as null AND as a string, or the
    // type check below proves nothing about it.
    expect(entries.some((m) => m.url === null)).toBe(true);
    expect(entries.some((m) => typeof m.url === 'string')).toBe(true);
  });

  test('every envVarMeta entry has exactly the EnvVarMeta fields', () => {
    for (const meta of entries) {
      expect(Object.keys(meta).sort()).toEqual(ENV_VAR_META_KEYS);
    }
  });

  test('envVarMeta field types match EnvVarMeta', () => {
    for (const raw of entries) {
      expect(typeof raw.placeholder).toBe('string');
      expect(typeof raw.hint).toBe('string');
      expect(raw.url === null || typeof raw.url === 'string').toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// /skills — InstalledSkill (the GET list) + SkillsShResult (the ?q= search)
// ---------------------------------------------------------------------------

type ExpectedInstalledSkillKey = 'name' | 'description' | 'source' | 'path' | 'agents';
const _installedSkillKeysAreExact: AssertExact<keyof InstalledSkill, ExpectedInstalledSkillKey> =
  true;
void _installedSkillKeysAreExact;

type ExpectedSkillsShResultKey = 'id' | 'skillId' | 'name' | 'installs' | 'source';
const _skillsShResultKeysAreExact: AssertExact<keyof SkillsShResult, ExpectedSkillsShResultKey> =
  true;
void _skillsShResultKeysAreExact;

const INSTALLED_SKILL_KEYS: string[] = ['name', 'description', 'source', 'path', 'agents'].sort();
const SKILLS_SH_RESULT_KEYS: string[] = ['id', 'skillId', 'name', 'installs', 'source'].sort();

const skillsGolden = readGolden<{
  installed: Record<string, unknown>[];
  results: Record<string, unknown>[];
}>('skills.golden.json');

describe('/skills golden conforms to the TS InstalledSkill + SkillsShResult', () => {
  test('the golden has installed entries and search results', () => {
    expect(skillsGolden.installed.length).toBeGreaterThan(0);
    expect(skillsGolden.results.length).toBeGreaterThan(0);
  });

  test('the golden exercises both branches of each nullable field', () => {
    // Guards the fixture itself: `source` and `installs` must each appear as
    // null AND as a value, or the type checks below prove nothing about them.
    expect(skillsGolden.installed.some((s) => s.source === null)).toBe(true);
    expect(skillsGolden.installed.some((s) => typeof s.source === 'string')).toBe(true);
    expect(skillsGolden.results.some((r) => r.installs === null)).toBe(true);
    expect(skillsGolden.results.some((r) => typeof r.installs === 'number')).toBe(true);
  });

  test('every installed entry has exactly the InstalledSkill fields', () => {
    for (const skill of skillsGolden.installed) {
      expect(Object.keys(skill).sort()).toEqual(INSTALLED_SKILL_KEYS);
    }
  });

  test('installed field types match InstalledSkill', () => {
    for (const raw of skillsGolden.installed) {
      expect(typeof raw.name).toBe('string');
      expect(typeof raw.description).toBe('string');
      expect(raw.source === null || typeof raw.source === 'string').toBe(true);
      expect(typeof raw.path).toBe('string');
      expect(Array.isArray(raw.agents)).toBe(true);
    }
  });

  test('every search result has exactly the SkillsShResult fields', () => {
    for (const result of skillsGolden.results) {
      expect(Object.keys(result).sort()).toEqual(SKILLS_SH_RESULT_KEYS);
    }
  });

  test('search result field types match SkillsShResult', () => {
    for (const raw of skillsGolden.results) {
      expect(typeof raw.id).toBe('string');
      expect(typeof raw.skillId).toBe('string');
      expect(typeof raw.name).toBe('string');
      expect(raw.installs === null || typeof raw.installs === 'number').toBe(true);
      expect(typeof raw.source).toBe('string');
    }
  });
});
