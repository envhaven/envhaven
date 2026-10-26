/**
 * Whether a `message` event was posted by the VS Code webview host, the one sender this
 * page trusts. Everything the extension host sends arrives that way: VS Code's webview host
 * page (workbench/contrib/webview/browser/pre/index.html, which code-server serves from its
 * own origin) is this frame's parent and forwards each message with
 * `contentWindow.postMessage(message, window.origin)`. A genuine message therefore carries
 * this page's own origin and comes from the window that holds this frame.
 *
 * Anything else is refused. The live preview iframe shows the user's own web app from
 * preview-<subdomain>.envhaven.app, a different origin, and any script there (a compromised
 * dependency of the dev server, say) can still call `window.parent.postMessage` to forge a
 * workspace update whose SSH command the user is invited to copy and run.
 *
 * The parent is found by looking for this window among the sender's frames, because
 * `event.source === window.parent` cannot work here: the API script VS Code injects into
 * every webview reassigns `window.parent` to the webview's own window (measured in
 * code-server 4.139.1). `window.top` survives the same attempt, but it is the workbench
 * page, not the host page that posts.
 */
export function isFromWebviewHost(event: MessageEvent, self: Window): boolean {
  if (event.origin !== self.origin) return false;
  const sender = event.source as Window | null;
  if (!sender) return false;
  for (let i = 0; i < sender.length; i++) {
    if (sender[i] === self) return true;
  }
  return false;
}
