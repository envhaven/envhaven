import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  PLATFORM_TOOL_CATALOG_PATH,
  TOOL_CATALOG_SOURCE_PATH,
  canonicalContentSha256,
  checkGeneratedDocumentation,
  expectedPlatformToolCatalog,
  generatePlatformToolCatalog,
  projectPlatformCatalog,
  validateGeneratedArtifact,
} from './platform-tool-catalog';

describe('platform tool catalog artifact', () => {
  test('matches the deterministic generated snapshot', () => {
    const expected = expectedPlatformToolCatalog();
    const actual = readFileSync(PLATFORM_TOOL_CATALOG_PATH, 'utf8');

    expect(actual).toBe(expected.content);
    expect(validateGeneratedArtifact(actual)).toBe(expected.artifactContentSha256);
    expect(actual).toContain('schemaVersion: 2');
  });

  test('projects one auth summary and icon for every tool', () => {
    const source = JSON.parse(readFileSync(TOOL_CATALOG_SOURCE_PATH, 'utf8'));
    const projected = projectPlatformCatalog(source);

    expect(projected.tools.every((tool) => tool.authSummary.length > 0)).toBe(true);
    expect(Object.keys(projected.icons)).toEqual(projected.tools.map((tool) => tool.id));
  });

  test('canonical source hashes ignore formatting and object key order', () => {
    expect(canonicalContentSha256({ z: 1, a: { y: 2, x: 3 } })).toBe(
      canonicalContentSha256({ a: { x: 3, y: 2 }, z: 1 }),
    );
  });

  test('a source catalog change makes the snapshot stale', () => {
    const source = JSON.parse(readFileSync(TOOL_CATALOG_SOURCE_PATH, 'utf8')) as {
      tools: { name: string }[];
    };
    source.tools[0].name = `${source.tools[0].name} changed`;

    const changed = generatePlatformToolCatalog(JSON.stringify(source));
    expect(changed.content).not.toBe(readFileSync(PLATFORM_TOOL_CATALOG_PATH, 'utf8'));
    expect(changed.sourceContentSha256).not.toBe(expectedPlatformToolCatalog().sourceContentSha256);
  });

  test('a one-byte artifact edit fails its embedded content hash', () => {
    const actual = readFileSync(PLATFORM_TOOL_CATALOG_PATH, 'utf8');
    const changed = actual.replace('Claude Code', 'Claude Codf');
    expect(changed).not.toBe(actual);
    expect(() => validateGeneratedArtifact(changed)).toThrow('Generated artifact content hash');
  });

  test('catalog text cannot forge a provenance marker the platform parses', () => {
    const source = JSON.parse(readFileSync(TOOL_CATALOG_SOURCE_PATH, 'utf8')) as {
      tools: { name: string }[];
    };
    const name = source.tools[0].name;

    source.tools[0].name = `${name} schemaVersion: 1,`;
    expect(() => generatePlatformToolCatalog(JSON.stringify(source))).toThrow('exactly one schemaVersion');

    source.tools[0].name = `${name} sourceContentSha256: '${'0'.repeat(64)}'`;
    expect(() => generatePlatformToolCatalog(JSON.stringify(source))).toThrow('exactly one sourceContentSha256');
  });

  test('rejects icon shapes outside the supported SVG subset', () => {
    const source = JSON.parse(readFileSync(TOOL_CATALOG_SOURCE_PATH, 'utf8')) as {
      tools: { icon: { primitives: Record<string, unknown>[] } }[];
    };
    source.tools[0].icon.primitives[0] = { type: 'ellipse', cx: '12', cy: '12', rx: '10', ry: '8' };

    expect(() => generatePlatformToolCatalog(JSON.stringify(source))).toThrow(
      'unsupported icon primitive type "ellipse"',
    );
  });

  test('checked-in documentation sections are current', () => {
    expect(checkGeneratedDocumentation()).toBe(4);
  });
});
