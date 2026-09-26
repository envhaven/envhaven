import { describe, expect, it } from 'bun:test';
import { parseManagedVersionResponse, parseTmuxWindows, updateAvailableFor } from '../environment';

describe('updateAvailableFor', () => {
  it('offers a newer release over an older one', () => {
    expect(updateAvailableFor('v1.7.4', 'v1.7.5')).toBe(true);
    expect(updateAvailableFor('v1.8.0', 'v1.8.1')).toBe(true);
    expect(updateAvailableFor('1.9.9', '1.10.0')).toBe(true); // components compare as numbers, so 9 sorts before 10
    expect(updateAvailableFor('v1.7.5', 'v1.7.5')).toBe(false);
  });
  it('never offers a pinned or rolled-back latest', () => {
    expect(updateAvailableFor('v1.8.2', 'v1.8.1')).toBe(false);
  });
  it('fails closed for dev builds, prereleases and unknown labels', () => {
    expect(updateAvailableFor('dev', 'v1.7.5')).toBe(false);
    expect(updateAvailableFor('dev-abc1234', 'v1.7.5')).toBe(false);
    expect(updateAvailableFor('devel', 'v1.7.5')).toBe(false);
    expect(updateAvailableFor('v1.9.0-rc.1', 'v1.8.1')).toBe(false);
    expect(updateAvailableFor('v1.8.0', 'v1.9.0-rc.1')).toBe(false);
  });
  it('is silent without both versions', () => {
    expect(updateAvailableFor(null, 'v1.7.5')).toBe(false);
    expect(updateAvailableFor('v1.7.4', null)).toBe(false);
  });
});

describe('parseManagedVersionResponse', () => {
  const digest = `sha256:${'a'.repeat(64)}`;

  it('accepts one internally consistent immutable release object', () => {
    expect(parseManagedVersionResponse({
      latest: 'v1.8.0',
      latestDigest: digest,
      imageReference: `ghcr.io/envhaven/envhaven@${digest}`,
    })).toEqual({
      latest: 'v1.8.0',
      latestDigest: digest,
      imageReference: `ghcr.io/envhaven/envhaven@${digest}`,
    });
  });

  it('fails closed for legacy or mismatched managed responses', () => {
    const empty = { latest: null, latestDigest: null, imageReference: null };
    expect(parseManagedVersionResponse({ latest: 'v1.8.0' })).toEqual(empty);
    expect(parseManagedVersionResponse({
      latest: 'v1.8.0',
      latestDigest: digest,
      imageReference: `ghcr.io/envhaven/envhaven@sha256:${'b'.repeat(64)}`,
    })).toEqual(empty);
  });
});

describe('parseTmuxWindows', () => {
  it('keeps a "|" inside a window name whole (name is the last field)', () => {
    expect(parseTmuxWindows('1|0|my|piped|name')[0]).toEqual({ index: 1, name: 'my|piped|name', active: false });
  });

  it('marks the active window and parses the index', () => {
    expect(parseTmuxWindows('2|1|zsh')[0]).toEqual({ index: 2, name: 'zsh', active: true });
  });

  it('falls back to `Window <index>` when the name is empty', () => {
    expect(parseTmuxWindows('3|0|')[0]).toEqual({ index: 3, name: 'Window 3', active: false });
  });

  it('returns an empty list for empty output', () => {
    expect(parseTmuxWindows('')).toEqual([]);
  });

  it('parses every line of a multi-window session', () => {
    expect(parseTmuxWindows('0|1|zsh\n1|0|claude')).toHaveLength(2);
  });
});
