import { describe, expect, it } from 'bun:test';
import { parseTmuxWindows } from '../environment';

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
