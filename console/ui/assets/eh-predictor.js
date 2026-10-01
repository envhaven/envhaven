// Console composition root. It wires independent owners and routes declared effects;
// predictor state crosses this boundary only as immutable renderer view data.
var EnvHavenConsolePredictor = (function () {
  function create(deps) {
    var MODEL = deps.model;
    var window = deps.render.window, document = window.document;
    var location = window.location, navigator = window.navigator;
    var params = new deps.socket.URLSearchParams(location.search);
    var parentOrigin = params.get('parent');
    var embedded = !!parentOrigin;
    var probeSession = params.get('probeSession');
    if (probeSession && (params.get('probe') !== '1' || !/^ehtest-[0-9a-z]{1,8}-[0-9a-z]{8,12}-[0-9a-f]{12}$/.test(probeSession))) {
      throw new Error('invalid console probe session');
    }

    function hexColor(value) {
      return typeof value === 'string' && /^(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ? '#' + value : null;
    }
    var themeBg = hexColor(params.get('bg')) || '#1e1e1e';
    var themeFg = hexColor(params.get('fg'));
    document.body.style.background = themeBg;

    function themeObject() {
      return {
        background: themeBg,
        foreground: themeFg || undefined,
        cursor: themeFg || undefined,
        cursorAccent: themeFg ? themeBg : undefined
      };
    }

    // xterm's own OSC 8 provider offers http(s) links only (allowNonHttpProtocols is
    // unset). The provider below runs ahead of it, so it keeps the same allowlist, and
    // openLink, which every activation path reaches, checks it once more.
    function webLink(uri) {
      try {
        var url = new window.URL(uri);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch (error) {
        return false;
      }
    }

    function openLink(event, text) {
      if (webLink(text)) window.open(text, '_blank', 'noopener,noreferrer');
    }

    var term = deps.terminal.create({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 0,
      theme: themeObject(),
      allowProposedApi: true,
      linkHandler: { activate: openLink }
    });
    var fit = deps.terminal.createFitAddon();
    term.loadAddon(fit);
    var termEl = document.getElementById('term');
    var renderer = null, session = null, status = null, auth = null, transport = null;
    var currentView = null;

    // Wrapped plain URLs and OSC 8 runs share one provider so a tmux hard row break
    // remains one clickable link.
    var URL_RE = /https?:\/\/[^\s"'<>\[\]]+/g;
    var JOIN_HOP = 6;
    function rowText(row) {
      var line = term.buffer.active.getLine(row);
      return line ? line.translateToString(true) : null;
    }
    function oscRuns(row) {
      var runs = [];
      try {
        var line = term.buffer.active.getLine(row);
        if (!line) return runs;
        var work = null, current = null;
        for (var x = 0; x < term.cols; x++) {
          work = line.getCell(x, work || undefined);
          var live = work && work.hasExtendedAttrs && work.hasExtendedAttrs();
          var id = live && work.extended ? work.extended.urlId : undefined;
          var uri = id ? (term._core._oscLinkService.getLinkData(id) || {}).uri : undefined;
          if (uri && !webLink(uri)) uri = undefined;
          if (uri && current && current.uri === uri) current.x1 = x + 1;
          else if (uri) {
            current = { x0: x + 1, x1: x + 1, uri: uri };
            runs.push(current);
          } else current = null;
        }
      } catch (error) { /* pinned xterm internals moved */ }
      return runs;
    }

    term.registerLinkProvider({
      provideLinks: function (lineNo, callback) {
        if (!transport || !transport.isReady()) {
          callback(undefined);
          return;
        }
        var row = lineNo - 1, links = [];
        oscRuns(row).forEach(function (run) {
          var rects = [{ y: lineNo, x0: run.x0, x1: run.x1 }];
          for (var up = row - 1; up >= row - JOIN_HOP; up--) {
            var above = oscRuns(up).filter(function (candidate) { return candidate.uri === run.uri; }).pop();
            if (!above) break;
            rects.unshift({ y: up + 1, x0: above.x0, x1: above.x1 });
          }
          for (var down = row + 1; down <= row + JOIN_HOP; down++) {
            var below = oscRuns(down).filter(function (candidate) { return candidate.uri === run.uri; }).shift();
            if (!below) break;
            rects.push({ y: down + 1, x0: below.x0, x1: below.x1 });
          }
          var firstRect = rects[0], lastRect = rects[rects.length - 1];
          links.push({
            range: { start: { x: firstRect.x0, y: firstRect.y }, end: { x: lastRect.x1, y: lastRect.y } },
            text: run.uri,
            decorations: { pointerCursor: true, underline: false },
            hover: function () { renderer.paintLinkUnderline(rects); },
            leave: function () { renderer.clearLinkUnderline(); },
            activate: openLink
          });
        });

        var first = row, last = row;
        while (first > row - JOIN_HOP) {
          var previous = rowText(first - 1);
          if (previous === null || previous.length < term.cols) break;
          first--;
        }
        while (last < row + JOIN_HOP) {
          var text = rowText(last);
          if (text === null || text.length < term.cols) break;
          last++;
        }
        var joined = '', starts = [];
        for (var r = first; r <= last; r++) {
          starts.push(joined.length);
          joined += rowText(r) || '';
        }
        function cellOf(offset) {
          var index = 0;
          while (index + 1 < starts.length && starts[index + 1] <= offset) index++;
          return { x: offset - starts[index] + 1, y: first + index + 1 };
        }
        var match;
        URL_RE.lastIndex = 0;
        while ((match = URL_RE.exec(joined))) {
          var url = match[0].replace(/[.,;:!?')\]]+$/, '');
          if (!url) continue;
          var start = cellOf(match.index), end = cellOf(match.index + url.length - 1);
          if (end.y < lineNo || start.y > lineNo) continue;
          if (links.some(function (link) {
            return start.y >= link.range.start.y && end.y <= link.range.end.y;
          })) continue;
          links.push({ range: { start: start, end: end }, text: url, activate: openLink });
        }
        callback(links.length ? links : undefined);
      }
    });
    try {
      var providers = term._core._linkProviderService.linkProviders;
      if (providers.length > 1) providers.unshift(providers.pop());
    } catch (error) { /* pinned xterm internals moved */ }

    term.open(termEl);
    fit.fit();

    function routePrediction(result) {
      currentView = result.view;
      for (var i = 0; i < result.effects.length; i++) {
        var effect = result.effects[i];
        if (effect.type === 'render') renderer.render(effect.view);
        else if (effect.type === 'forget-ink') renderer.forgetInk();
        else if (effect.type === 'queue-ink') renderer.queueInk(effect.row, effect.col);
        else throw new Error('unknown prediction effect: ' + effect.type);
      }
    }

    function route(effect) {
      if (effect.type === 'show-status') status.show(effect.message, effect.spinning);
      else if (effect.type === 'show-login') status.showLogin(effect.message);
      else if (effect.type === 'hide-login') status.hideLogin();
      else if (effect.type === 'login-accepted') {
        status.loginAccepted();
        transport.connect();
      }
      else if (effect.type === 'refuse-input') status.refuseInput(effect.phase);
      else if (effect.type === 'prediction-disconnect') routePrediction(session.dispatch({ type: 'disconnect' }));
      else if (effect.type === 'clear-link-underline') renderer.clearLinkUnderline();
      else if (effect.type === 'prediction-gate') routePrediction(session.dispatch({ type: 'gate', gate: effect.gate }));
      else if (effect.type === 'predict-input') {
        routePrediction(session.dispatch({ type: 'input', command: deps.input.decode(effect.data) }));
      }
      else if (effect.type === 'terminal-data') {
        routePrediction(session.dispatch({ type: 'data', at: effect.at }));
        term.write(effect.text, function () { routePrediction(session.dispatch({ type: 'reconcile' })); });
      }
      else if (effect.type === 'transport-ready') status.connected(effect.refocus);
      // `input` tells the parent it may send keys and arm modifiers (envhaven-console:input and
      // :modifiers, below).
      else if (effect.type === 'parent-ready') auth.toParent({ type: 'envhaven-console:ready', input: true });
      else throw new Error('unknown console effect: ' + effect.type);
    }

    renderer = deps.renderer.create({
      model: MODEL, style: deps.style, term: term, termEl: termEl, document: document,
      getComputedStyle: deps.render.getComputedStyle,
      requestAnimationFrame: deps.render.requestAnimationFrame,
      clock: deps.clock,
      theme: { background: function () { return themeBg; } },
      connected: function () { return !!transport && transport.isReady(); }
    });
    session = deps.session.create({
      model: MODEL, layout: deps.layout, navigation: deps.navigation,
      actions: deps.actions, reconcile: deps.reconcile,
      term: term, clock: deps.clock,
      timers: deps.timers, window: window, params: params, display: renderer,
      publish: routePrediction
    });
    currentView = session.view();
    renderer.render(currentView);

    status = deps.status.create({
      window: window, term: term, termEl: termEl, fit: fit, timers: deps.timers,
      matchMedia: deps.render.matchMedia, name: params.get('name'),
      background: themeBg, foreground: themeFg,
      onReconnect: function () { transport.connect(); },
      onLogin: function (password) { auth.login(password); }
    });
    auth = deps.auth.create({
      window: window, fetch: deps.socket.fetch, timers: deps.timers,
      URLSearchParams: deps.socket.URLSearchParams, parentOrigin: parentOrigin, emit: route
    });
    transport = deps.transport.create({
      model: MODEL, term: term, location: location, clock: deps.clock,
      TextEncoder: deps.socket.TextEncoder, TextDecoder: deps.socket.TextDecoder,
      Uint8Array: deps.socket.Uint8Array, open: deps.socket.open,
      getToken: auth.getToken, embedded: embedded,
      echoEnabled: params.get('echo') === '1', probeSession: probeSession,
      statusVisible: status.visible, emit: route
    });
    deps.clipboard.create({
      window: window, term: term, termEl: termEl, timers: deps.timers,
      Blob: deps.render.Blob, ClipboardItem: deps.render.ClipboardItem,
      Uint8Array: deps.socket.Uint8Array, TextDecoder: deps.socket.TextDecoder,
      atob: deps.render.atob, embedded: embedded, toParent: auth.toParent
    });

    document.fonts.load('13px "JetBrains Mono"').then(function () {
      return document.fonts.load('bold 13px "JetBrains Mono"');
    }).then(function () {
      if (document.fonts.check('13px "JetBrains Mono"')) {
        term.options.fontFamily = '"JetBrains Mono", monospace';
        fit.fit();
        renderer.refreshStyle();
      }
    }).catch(function () {});

    var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
    var altArrow = { ArrowLeft: '\x1bb', ArrowRight: '\x1bf', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B' };
    var cmdKeys = { ArrowLeft: '\x01', ArrowRight: '\x05', Backspace: '\x15' };
    term.attachCustomKeyEventHandler(function (event) {
      if (event.type !== 'keydown') return true;
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && altArrow[event.key]) {
        event.preventDefault();
        transport.sendInput(altArrow[event.key]);
        return false;
      }
      if (isMac && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && cmdKeys[event.key]) {
        event.preventDefault();
        transport.sendInput(cmdKeys[event.key]);
        return false;
      }
      if (!isMac && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key === 'Backspace') {
        event.preventDefault();
        transport.sendInput('\x17');
        return false;
      }
      return true;
    });
    // Ctrl and Alt armed on the dashboard's key bar apply to the next key typed on the keyboard,
    // which reaches this page and never the dashboard. One key uses them (a paste or a terminal
    // report is not a key), and the dashboard is told, so its key lets go.
    var armed = { ctrl: false, alt: false };
    function withArmed(data) {
      if (!(armed.ctrl || armed.alt) || data.length !== 1) return data;
      var out = data;
      if (armed.ctrl && /[@-_a-z]/i.test(data)) out = String.fromCharCode(data.charCodeAt(0) & 0x1f);
      else if (armed.ctrl && data === ' ') out = '\x00';
      else if (armed.ctrl && data === '?') out = '\x7f';
      if (armed.alt) out = '\x1b' + out;
      armed = { ctrl: false, alt: false };
      auth.toParent({ type: 'envhaven-console:modifiers-used' });
      return out;
    }
    term.onData(function (data) { transport.sendInput(withArmed(data)); });
    term.onRender(function () { renderer.render(currentView); });
    term.onResize(function () {
      transport.sendResize();
      routePrediction(session.dispatch({ type: 'resize' }));
    });
    window.addEventListener('resize', function () { fit.fit(); });

    if (embedded) window.addEventListener('message', function (event) {
      if (!auth.fromParent(event)) return;
      var data = event.data;
      if (!data) return;
      // Keys from the dashboard's on-screen key bar. The parent already holds this session (it
      // mints the token), so they are the user's own keystrokes and take the typed-input path.
      if (data.type === 'envhaven-console:input') {
        if (typeof data.data === 'string') transport.sendInput(data.data);
        return;
      }
      if (data.type === 'envhaven-console:modifiers') {
        armed = { ctrl: data.ctrl === true, alt: data.alt === true };
        return;
      }
      if (data.type !== 'envhaven-console:theme') return;
      var background = hexColor(data.bg), foreground = hexColor(data.fg);
      if (background) themeBg = background;
      if (foreground) themeFg = foreground;
      document.body.style.background = themeBg;
      status.setTheme(themeBg, themeFg);
      term.options.theme = themeObject();
      renderer.refreshStyle();
      routePrediction(session.dispatch({ type: 'reset', reason: 'theme' }));
    });

    transport.connect();
    return { terminal: term };
  }
  return { create: create };
})();
