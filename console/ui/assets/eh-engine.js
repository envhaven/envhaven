// Browser adapter for the console controller. The controller owns one isolated state
// instance; this file binds it to the classic-script globals supplied by the page.
(function () {
  EnvHavenConsolePredictor.create({
    model: EnvHavenConsoleModel,
    session: EnvHavenConsoleSession,
    input: EnvHavenConsoleInput,
    layout: EnvHavenConsoleLayout,
    navigation: EnvHavenConsoleNavigation,
    actions: EnvHavenConsoleActions,
    reconcile: EnvHavenConsoleReconcile,
    style: EnvHavenConsoleStyle,
    renderer: EnvHavenConsoleRenderer,
    status: EnvHavenConsoleStatus,
    auth: EnvHavenConsoleAuth,
    clipboard: EnvHavenConsoleClipboard,
    transport: EnvHavenConsoleTransport,
    terminal: {
      create: function (options) { return new Terminal(options); },
      createFitAddon: function () { return new FitAddon.FitAddon(); }
    },
    render: {
      window: window,
      getComputedStyle: function (node) { return getComputedStyle(node); },
      requestAnimationFrame: function (callback) { return requestAnimationFrame(callback); },
      matchMedia: function (query) { return matchMedia(query); },
      Blob: Blob,
      ClipboardItem: window.ClipboardItem,
      atob: function (value) { return atob(value); }
    },
    socket: {
      open: function (url, protocols) { return new WebSocket(url, protocols); },
      fetch: function (input, init) { return fetch(input, init); },
      TextEncoder: TextEncoder,
      TextDecoder: TextDecoder,
      Uint8Array: Uint8Array,
      URLSearchParams: URLSearchParams
    },
    clock: performance,
    timers: {
      setTimeout: function (callback, delay) { return setTimeout(callback, delay); },
      clearTimeout: function (id) { clearTimeout(id); },
      setInterval: function (callback, delay) { return setInterval(callback, delay); },
      clearInterval: function (id) { clearInterval(id); }
    }
  });
})();
