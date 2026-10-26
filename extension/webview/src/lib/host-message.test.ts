import { describe, expect, test } from 'bun:test';
import { isFromWebviewHost } from './host-message';

// Stand-ins for the windows involved. In code-server the webview frame and VS Code's host
// page share code-server's origin; the preview iframe is the user's app on its own origin.
const WEBVIEW_ORIGIN = 'https://ws-abc.envhaven.app';
const self = { origin: WEBVIEW_ORIGIN } as unknown as Window;
// VS Code's host page holds a pending frame and this page's frame while it swaps content.
const hostPage = { length: 2, 0: {}, 1: self } as unknown as Window;
const previewFrame = { length: 0 } as unknown as Window;

function event(origin: string, source: unknown): MessageEvent {
  return { origin, source, data: { command: 'updateWorkspace' } } as unknown as MessageEvent;
}

describe('isFromWebviewHost', () => {
  test('accepts a message the host page forwards to this frame', () => {
    expect(isFromWebviewHost(event(WEBVIEW_ORIGIN, hostPage), self)).toBe(true);
  });

  test('refuses the preview iframe, which posts from its own origin', () => {
    expect(isFromWebviewHost(event('https://preview-ws-abc.envhaven.app', previewFrame), self)).toBe(false);
    // Even naming the host page as its source cannot help a different origin.
    expect(isFromWebviewHost(event('https://preview-ws-abc.envhaven.app', hostPage), self)).toBe(false);
  });

  test('refuses a sandboxed frame, whose origin is opaque', () => {
    expect(isFromWebviewHost(event('null', previewFrame), self)).toBe(false);
  });

  test('refuses a same-origin window that does not hold this frame', () => {
    const otherWebviewHost = { length: 1, 0: {} } as unknown as Window;
    expect(isFromWebviewHost(event(WEBVIEW_ORIGIN, otherWebviewHost), self)).toBe(false);
    expect(isFromWebviewHost(event(WEBVIEW_ORIGIN, self), self)).toBe(false);
  });

  test('refuses an event with no source window', () => {
    expect(isFromWebviewHost(event(WEBVIEW_ORIGIN, null), self)).toBe(false);
    // A synthetic event dispatched on this window carries an empty origin.
    expect(isFromWebviewHost(event('', null), self)).toBe(false);
  });
});
