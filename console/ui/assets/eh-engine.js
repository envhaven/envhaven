// The console's terminal engine: xterm wiring, the wire protocol, the predictive
// echo model and everything it paints.
//
// A CLASSIC script, not a module, and still wrapped in its own IIFE. Both of those are
// deliberate. Loaded after the vendored bundles with no `type`, `async` or `defer`, it
// runs at exactly the point in the parse the inline block used to, with exactly the
// scope it had, so moving it out of terminal.html changed no semantics at all. A module
// would defer it and make it strict, which are two behaviour changes to carry for no
// gain while the page holds one script.
//
// It lives here rather than inside the page because 2,600 lines of JavaScript embedded
// in HTML cannot be read by a JavaScript tool: no highlighting, no navigation, and a
// syntax error reported against a line number in a document. `bun dev/scripts/test-console-ui.ts`
// parses this file the way the browser will, and `bun dev/scripts/test-console-echo.ts`
// runs it against a real terminal.
//
// The engine is one closure on purpose. Its state is genuinely shared: `predicted` is
// read by 28 functions, `wrapStyle` by 14. Splitting those apart is a redesign, not a
// file move, and is not what this file is.
(function () {
  // Wire protocol (shared with the managed dashboard client): every binary frame
  // is [type][payload]; 0x00 = terminal bytes (both directions), 0x01 = a resize
  // request carrying {cols,rows} JSON, browser to server only.
  var DATA = 0x00, RESIZE = 0x01, PGATE = 0x02;
  var enc = new TextEncoder();

  // Query params. ?parent=<origin> marks an EMBEDDED page (the managed dashboard
  // frames this same file): the token is injected by that parent over postMessage,
  // because managed mode has no cookie-gated /__console/token to fetch. ?bg/?fg theme
  // the terminal to the host that framed it; absent, self-host keeps VS Code dark.
  var params = new URLSearchParams(location.search);
  var parentOrigin = params.get('parent');
  // Theme colours arrive as bare hex digits. They are concatenated into style.cssText
  // below, and cssText parses a whole declaration list — so an unvalidated value can
  // close the property with a ';' and inject arbitrary CSS (measured: a crafted ?bg
  // turned the 9x17 cursor block into a fixed, full-viewport, click-catching layer).
  // Validating at the source is the one guard that covers every sink, this one and the
  // live retheme both. Anything that is not a CSS hex colour falls back to the default.
  function hexColor(v) {
    return typeof v === 'string' && /^(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) ? '#' + v : null;
  }
  var themeBg = hexColor(params.get('bg')) || '#1e1e1e';
  var themeFg = hexColor(params.get('fg'));
  // Embedded (managed dashboard, ?parent set): the terminal's bg is locked to the dashboard's
  // exact background (?bg), so it sits flush with no distinct panel and inherits the theme.
  // The dashboard re-sends bg+fg on a light/dark toggle so the terminal tracks it live.
  // Self-host keeps its own default bg. `embedded` gates that live-retheme channel.
  var embedded = !!parentOrigin;
  // The postMessage wall for everything exchanged with the embedding dashboard:
  // accept only from the exact ?parent origin AND window.parent, and post only
  // to that exact origin (never '*'); a foreign frame can neither inject nor read.
  function fromParent(ev) { return ev.origin === parentOrigin && ev.source === window.parent; }
  function toParent(msg) { window.parent.postMessage(msg, parentOrigin); }

  var termEl = document.getElementById('term');
  var loginEl = document.getElementById('login');
  var errEl = document.getElementById('err');
  var pwEl = document.getElementById('password');

  document.body.style.background = themeBg;
  // One builder for the xterm theme object, used by the constructor and the live
  // retheme (undefined-valued and omitted keys are equivalent for xterm). Cursor
  // wears the theme's ink over the page background (the glyph inside the block
  // inverts via cursorAccent). Blink itself is xterm's own, engaged by tmux's
  // cursor-style request (DECSCUSR outranks the cursorBlink option).
  function themeObj() {
    return {
      background: themeBg,
      foreground: themeFg || undefined,
      cursor: themeFg || undefined,
      cursorAccent: themeFg ? themeBg : undefined,
    };
  }
  // scrollback:0 makes this a pure viewport onto the shared tmux session: tmux owns all
  // history and scrolling (the mouse wheel scrolls tmux's copy mode), so xterm never grows
  // a buffer of its own. Two things follow. xterm 6's scroll UI — the VS Code-derived
  // overview-ruler scrollbar — has nothing to show, so it never overlays and clips the
  // grid's last column. And the bundled fit addon reserves the scrollbar's width only when
  // scrollback>0, so it now reserves nothing and the grid fills the panel edge to edge with
  // no custom proposeDimensions override to maintain.
  // Open a clicked terminal link in a new top-level tab; noopener/noreferrer severs
  // window.opener to block reverse tabnabbing (the iframe never navigates itself).
  function openLink(ev, text) { window.open(text, '_blank', 'noopener,noreferrer'); }
  var term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    scrollback: 0,
    theme: themeObj(),
    allowProposedApi: true,
    // OSC 8 hyperlinks (tmux forwards them per the terminal-features declaration in
    // tmux.conf) carry the exact URL out of band, immune to line wrapping — TUIs that
    // emit them (pi's /login) get precise links; everything else falls back to the
    // wrapped-URL provider below.
    linkHandler: { activate: openLink },
  });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // URLs printed in the terminal become clickable and open in a NEW top-level browser tab,
  // never navigating this iframe; noopener/noreferrer severs window.opener to block reverse
  // tabnabbing. Hover shows a pointer and underline from xterm core's link decorations.
  //
  // This is a custom provider rather than @xterm/addon-web-links because tmux repaints
  // long lines as HARD row breaks (no wrap flags), so per-row detection sees only the
  // first fragment of a wrapped URL — the classic broken TUI OAuth link (pi and claude
  // /login). iTerm2's continuation heuristic fixes it: a row whose content runs to the
  // terminal's last column is joined with the next row before matching, and match
  // offsets map back to real buffer cells so hover and click cover every row.
  var URL_RE = /https?:\/\/[^\s"'<>\[\]]+/g;
  var JOIN_HOP = 6; // rows a single URL may span; bounds the scan either side
  function rowText(row) {
    var line = term.buffer.active.getLine(row);
    return line ? line.translateToString(true) : null; // right-trimmed grid content
  }
  // oscRuns reads one row's OSC 8 hyperlink runs off the pinned bundle's cell
  // attrs. Internal reach is this file's pinned-bundle pattern; if the internals
  // ever move, oscRuns returns nothing and OSC 8 falls back to per-row links.
  function oscRuns(row) { // 0-based row -> [{x0,x1,uri}] (1-based inclusive cols)
    var runs = [];
    try {
      var line = term.buffer.active.getLine(row);
      if (!line) return runs;
      // Cells must be interrogated through getCell/hasExtendedAttrs: the line's
      // sparse extended-attrs storage is not scrubbed when a cell is overwritten
      // with plain content, so reading it directly resurrects links from rows the
      // application has since repainted (ghost underlines where a dialog used to
      // be). The has-extended flag on the cell itself is the truth.
      var work = null, cur = null;
      for (var x = 0; x < term.cols; x++) {
        work = line.getCell(x, work || undefined);
        var live = work && work.hasExtendedAttrs && work.hasExtendedAttrs();
        var id = live && work.extended ? work.extended.urlId : undefined;
        var uri = id ? (term._core._oscLinkService.getLinkData(id) || {}).uri : undefined;
        if (uri && cur && cur.uri === uri) cur.x1 = x + 1;
        else if (uri) { cur = { x0: x + 1, x1: x + 1, uri: uri }; runs.push(cur); }
        else cur = null;
      }
    } catch (e) { /* internals moved */ }
    return runs;
  }
  term.registerLinkProvider({
    provideLinks: function (lineNo, cb) { // lineNo is 1-based
      // While disconnected the grid is a frozen snapshot of a session that has moved
      // on — its links (and everything else) are stale, so none are offered until the
      // socket is live again.
      if (!ws || ws.readyState !== 1) { cb(undefined); return; }
      var row = lineNo - 1;
      var links = [];

      // OSC 8 hyperlinks (pi's /login): the bundled OscLinkProvider emits strictly
      // per-row ranges, so its hover underline never spans a wrapped link, and tmux
      // re-opens the link per repainted row so each row even gets a fresh urlId. This
      // provider replaces it: runs are collected per row (oscRuns above), resolved to
      // their URI, and adjacent rows with the same URI merge into one full-range link.
      // Registration below puts this provider ahead of the built-in, whose per-row
      // fragment then loses the linkifier's intersection dedup.
      oscRuns(row).forEach(function (run) {
        // Collect the per-row text runs while merging: the link's RANGE must span
        // them all (activation and the pointer cursor), but a multi-row range is a
        // contiguous block that would also underline the dialog's indent and padding
        // cells, so xterm's own underline is disabled and hover paints exactly these
        // rects instead.
        var rects = [{ y: lineNo, x0: run.x0, x1: run.x1 }];
        for (var up = row - 1; up >= row - JOIN_HOP; up--) { // same-URI runs above
          var r2 = oscRuns(up).filter(function (r3) { return r3.uri === run.uri; }).pop();
          if (!r2) break;
          rects.unshift({ y: up + 1, x0: r2.x0, x1: r2.x1 });
        }
        for (var dn = row + 1; dn <= row + JOIN_HOP; dn++) { // and below
          var r4 = oscRuns(dn).filter(function (r5) { return r5.uri === run.uri; }).shift();
          if (!r4) break;
          rects.push({ y: dn + 1, x0: r4.x0, x1: r4.x1 });
        }
        var head = rects[0], tail = rects[rects.length - 1];
        links.push({
          range: { start: { x: head.x0, y: head.y }, end: { x: tail.x1, y: tail.y } },
          text: run.uri,
          decorations: { pointerCursor: true, underline: false },
          hover: function () { paintLinkUnderline(rects); },
          leave: function () { clearLinkUnderline(); },
          activate: openLink,
        });
      });

      // Wrapped plain-text URLs, matched on the joined row text (see URL_RE above).
      var first = row, last = row;
      while (first > row - JOIN_HOP) { // full-width rows above may start the URL
        var prev = rowText(first - 1);
        if (prev === null || prev.length < term.cols) break;
        first--;
      }
      while (last < row + JOIN_HOP) { // and it continues below while rows stay full
        var cur = rowText(last);
        if (cur === null || cur.length < term.cols) break;
        last++;
      }
      var joined = '', starts = [];
      for (var r = first; r <= last; r++) {
        starts.push(joined.length);
        joined += rowText(r) || '';
      }
      function cellOf(offset) { // joined-text offset -> 1-based buffer cell
        var i = 0;
        while (i + 1 < starts.length && starts[i + 1] <= offset) i++;
        return { x: offset - starts[i] + 1, y: first + i + 1 };
      }
      var m;
      URL_RE.lastIndex = 0;
      while ((m = URL_RE.exec(joined))) {
        var url = m[0].replace(/[.,;:!?')\]]+$/, ''); // trim trailing prose punctuation
        if (!url) continue;
        var start = cellOf(m.index), end = cellOf(m.index + url.length - 1);
        if (end.y < lineNo || start.y > lineNo) continue; // only links touching this row
        // OSC 8 already owns these rows; row-range containment suffices because a
        // merged OSC link spans its continuation rows in full.
        var insideOsc = links.some(function (l) {
          return start.y >= l.range.start.y && end.y <= l.range.end.y;
        });
        if (insideOsc) continue;
        links.push({
          range: { start: start, end: end },
          text: url,
          activate: openLink,
        });
      }

      cb(links.length ? links : undefined);
    },
  });
  // Ahead of the built-in OscLinkProvider so the merged full-range link wins the
  // linkifier's first-provider-at-position pick; guarded, worst case is old order.
  try {
    var lps = term._core._linkProviderService.linkProviders;
    if (lps.length > 1) lps.unshift(lps.pop());
  } catch (e) { /* internals moved: built-in order stands */ }

  // ── Screen geometry + style ───────────────────────────────────────────────
  // Shared by the link-underline overlay below and the predictive-echo renderer:
  // overlay layers inside xterm's screen element, the exact cell size, and the
  // live text style.

  // Lazy overlay layer inside xterm's screen element: absolutely positioned over
  // the grid, transparent to the mouse, stacked by z. Null until the screen exists.
  // Sized to the screen explicitly: every child is absolutely positioned too, so an
  // auto-width layer shrinks to fit zero in-flow content and measures 0px — a
  // percentage-sized child (wipeLine's width:100%) needs a definite containing block
  // or it resolves against that 0 and paints nothing.
  function newScreenLayer(z) {
    var screen = termEl.querySelector('.xterm-screen');
    if (!screen) return null;
    var layer = document.createElement('div');
    layer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:' + z;
    screen.appendChild(layer);
    return layer;
  }

  // xterm's exact CSS cell size (pinned build), so an overlay glyph lands on the
  // same pixel as the real one and does not wiggle when it settles. Falls back to
  // the averaged screen size if the internal shape ever moves.
  function cellDims() {
    try {
      var c = term._core._renderService.dimensions.css.cell;
      if (c && c.width) return [c.width, c.height];
    } catch (e) { /* fall through */ }
    var s = termEl.querySelector('.xterm-screen');
    return s ? [s.clientWidth / term.cols, s.clientHeight / term.rows] : [9, 17];
  }

  // Match the real text so predictions look native under any theme: read the
  // foreground colour and font off the live xterm rows.
  var styleFg = '', styleFF = '', styleFS = '', styleBg = '';
  function refreshStyle() {
    var rows = termEl.querySelector('.xterm-rows');
    var cs = rows ? getComputedStyle(rows) : null;
    styleFg = (term.options.theme && term.options.theme.foreground) || (cs && cs.color) || '#ffffff';
    styleFF = (cs && cs.fontFamily) || 'monospace';
    styleFS = (cs && cs.fontSize) || '13px';
    styleBg = themeBg;
    bgCache = Object.create(null); // the theme moved: every remembered class colour is stale
    // The blink override in the page's CSS repaints the cursor's ON beat itself, so it
    // needs the same two colours xterm resolved. Read them off the theme service rather
    // than from themeObj(), which leaves both undefined when no ?fg was given and lets
    // xterm's own defaults stand in.
    var tc = term._core && term._core._themeService && term._core._themeService.colors;
    if (tc && tc.cursor && tc.cursorAccent) {
      termEl.style.setProperty('--eh-cursor-bg', tc.cursor.css);
      termEl.style.setProperty('--eh-cursor-fg', tc.cursorAccent.css);
    }
  }

  // The background xterm actually painted at a cell, which every opaque overlay layer has
  // to sit on. The terminal's own background is only right where the application did not
  // paint one of its own: a TUI that draws its input box in its colour (Codex, Claude
  // Code, gemini) otherwise gets a rectangle of terminal background stamped inside the box
  // wherever we draw, and it moves with the cursor as you type and delete. (Measured
  // against a composer mimic: the row rendered rgb(48,48,48) and our layers painted
  // rgb(30,30,30) across twelve columns.)
  //
  // Read off the RENDERED span rather than the cell's attributes. xterm resolves a palette
  // index against the live theme into a class it injects at runtime — xterm.css ships no
  // .xterm-bg-N rules at all — so the span already carries the exact colour and there is no
  // palette arithmetic to keep in sync with the bundle. Same reason wrapFrame moves rows by
  // cloning them. Cached by class list, since the colour is a pure function of it, so this
  // costs one getComputedStyle per distinct run styling per theme rather than one a frame.
  // '' means "this run has no background of its own". Only a FOUR-component rgba() with a
  // zero alpha is transparent: testing the last component instead throws away every opaque
  // colour whose blue channel is zero, which is most of a red or yellow panel.
  function opaque(v) { return v && v !== 'transparent' && !/^rgba\([^)]*,\s*0(\.0+)?\)$/.test(v) ? v : ''; }
  var bgCache = Object.create(null); // no inherited keys to collide with a class name
  function spanBg(sp) {
    // Truecolor backgrounds, decorations and selection are written INLINE, and xterm only
    // sets className when a class list is non-empty — so a truecolor run and a plain run
    // BOTH key on "". Read every inline background directly and cache only the class-driven
    // ones, whose colour really is a pure function of the class list.
    if (sp.style.backgroundColor) return opaque(sp.style.backgroundColor);
    var key = sp.className;
    if (!(key in bgCache)) bgCache[key] = opaque(getComputedStyle(sp).backgroundColor);
    return bgCache[key];
  }
  // The row's OWN background is the background of its WIDEST run — counting runs that carry
  // no background at all, which is the entire point.
  //
  // Two earlier attempts got this wrong in ways worth recording, because both looked
  // reasonable. Sampling at the cursor's column picks the one cell an app is most likely to
  // have drawn specially: a TUI that renders its own caret puts an inverse-video cell right
  // at the insertion point, and an inverse cell's background IS the foreground colour.
  // Considering only runs that HAVE a background has the same failure by another route: on
  // an ordinary row of blanks, that caret is the sole candidate, so one cell hands its
  // colour to the whole row. Both turned every predicted character dark-on-white in pi.
  //
  // Widest-run over all runs separates the three shapes with nothing to configure: a panel
  // is most of its row, an inverse caret is one cell of it, and a plain row is mostly
  // default — which resolves to the terminal's own background, exactly as before this
  // existed. xterm's own cursor span is excluded outright, since while we own the cursor its
  // background is the variable this function feeds and it would otherwise latch onto itself.
  function rowBackground(vrow) {
    var rows = termEl.querySelector('.xterm-rows');
    var el = rows && rows.children[vrow];
    if (!el) return styleBg;
    var kids = el.children, best = '', bestLen = -1, i, sp, n;
    for (i = 0; i < kids.length; i++) {
      sp = kids[i];
      // Skip xterm's own cursor (its background is the variable this feeds) and any
      // decoration or selection run, which is painted OVER the row, not by it.
      if (/xterm-cursor|xterm-decoration/.test(sp.className)) continue;
      n = (sp.textContent || '').length;
      if (n > bestLen) { bestLen = n; best = spanBg(sp); }
    }
    return best || styleBg;
  }

  // Hover underline for merged OSC 8 links: one hairline per text run, in its own
  // overlay layer (below the predictor's) using the same exact cell geometry, so
  // indent and padding cells inside the link's rectangular range stay bare.
  var linkLayer = null;
  function clearLinkUnderline() {
    if (linkLayer) linkLayer.textContent = '';
  }
  function paintLinkUnderline(rects) {
    if (!styleFg) refreshStyle(); // same seed render() uses: the hairline colour has one owner
    if (!linkLayer || !linkLayer.isConnected) {
      linkLayer = newScreenLayer(9);
      if (!linkLayer) return;
    }
    clearLinkUnderline();
    var dims = cellDims(), cw = dims[0], ch = dims[1];
    rects.forEach(function (r) {
      var u = document.createElement('div');
      u.style.cssText = 'position:absolute;height:1px;background:' + (styleFg || '#ffffff');
      u.style.left = (r.x0 - 1) * cw + 'px';
      u.style.top = (r.y - 1) * ch + (ch - 1) + 'px';
      u.style.width = (r.x1 - r.x0 + 1) * cw + 'px';
      linkLayer.appendChild(u);
    });
  }
  term.open(termEl);
  fit.fit();

  // Match the dashboard's mono font. The terminal opens immediately on xterm's default
  // metrics (in the managed cockpit the parent's loader covers first paint), and once the
  // vendored JetBrains Mono is loaded, CHANGING fontFamily makes xterm re-measure its
  // grid — setting an identical value is a no-op, which is why the constructor leaves it
  // default. If the font never loads, the default stack simply stays.
  document.fonts.load('13px "JetBrains Mono"').then(function () {
    return document.fonts.load('bold 13px "JetBrains Mono"');
  }).then(function () {
    if (document.fonts.check('13px "JetBrains Mono"')) {
      term.options.fontFamily = '"JetBrains Mono", monospace';
      fit.fit();
      // The overlay measures the grid's font ONCE and keeps it (refreshStyle), and its
      // one lazy trigger can fire before this promise settles: owning() is true for the
      // first CURSOR_GRACE ms of page life, because lastEditAt starts at 0. A first paint
      // in that window latches xterm's default courier and every predicted glyph then
      // renders in the wrong face over a JetBrains Mono grid, drifting further along the
      // row with each character, for as long as the page stays open. Re-read here and
      // drop the cursor x measured against the old face.
      refreshStyle();
      lastMeasureS = null;
    }
  }).catch(function () {});

  // Clipboard bridge. tmux already emits OSC 52 (ESC]52;;<base64>BEL) on every
  // copy because the xterm-256color terminfo carries the Ms capability and the
  // tmux config sets `set-clipboard on`; we just have to catch it here and land it
  // on the browser clipboard. Write-only on purpose: the '?' read form is ignored
  // so nothing running in the pty can read the operator's clipboard.
  //
  // The OSC 52 arrives on the socket, outside any user gesture. This frame writes the
  // clipboard itself: during a selection the iframe is the focused document (Chromium
  // rejects writeText from an unfocused one, which rules the top-level page out at
  // exactly the moment copies happen) and the dashboard delegates clipboard-write to
  // it via the iframe allow attribute. The text is still handed up to the dashboard,
  // which is the fallback writer where delegation is missing and owns the "Copied"
  // toast. Self-host is top-level, so the direct write is the whole story. Either way
  // tmux still mirrors every selection to /tmp/.envhaven-clipboard for the extension.

  // Safari rejects every clipboard write that does not START inside a user gesture, and
  // the OSC 52 for a mouse selection only lands after the tmux round-trip — always too
  // late. Safari's own escape hatch is a promise-backed ClipboardItem: open the write
  // synchronously in the gesture (the selection-ending mouseup) and let the imminent
  // OSC 52 supply the text. A mouseup that produces no copy times out and rejects, which
  // aborts the write and leaves the clipboard untouched. Chromium takes the writeText
  // path below regardless, so a double write of the same text is the worst case there.
  var pendingCopy = null;
  termEl.addEventListener('mouseup', function () {
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) return;
    if (pendingCopy) { clearTimeout(pendingCopy.timer); pendingCopy.reject(); }
    var entry = {};
    var text = new Promise(function (resolve, reject) { entry.resolve = resolve; entry.reject = reject; });
    entry.timer = setTimeout(function () {
      if (pendingCopy === entry) { pendingCopy = null; entry.reject(); }
    }, 500);
    pendingCopy = entry;
    navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })]).catch(function () {});
  }, true);

  function writeClipboard(text) {
    if (pendingCopy) { // a gesture-opened write is waiting for exactly this text (Safari path)
      var entry = pendingCopy;
      pendingCopy = null;
      clearTimeout(entry.timer);
      entry.resolve(new Blob([text], { type: 'text/plain' }));
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () {});
    if (embedded) toParent({ type: 'envhaven-console:clipboard', text: text });
  }

  term.parser.registerOscHandler(52, function (data) {
    var i = data.indexOf(';'); // data is "<Pc>;<Pd>"; the 52; identifier is already stripped
    if (i === -1) return true;
    var pd = data.slice(i + 1);
    if (pd === '' || pd === '?') return true;
    try {
      var bytes = Uint8Array.from(atob(pd), function (c) { return c.charCodeAt(0); });
      writeClipboard(new TextDecoder().decode(bytes)); // fresh decoder; never reuse the socket's streaming decoder
    } catch (e) { /* not valid base64; ignore */ }
    return true;
  });
  termEl.addEventListener('contextmenu', function (e) {
    if (!term.hasSelection()) return; // nothing selected: let the native menu open
    e.preventDefault();
    writeClipboard(term.getSelection());
  });

  // Image paste. A pasted image has no text form, so xterm's built-in paste — which reads
  // only clipboardData's 'text/plain' — silently drops it. Catch it here and hand the blob
  // up to the embedding dashboard, the top-level page that holds the platform session and
  // uploads it to /config/artifacts, over the same postMessage channel as the clipboard and
  // token. We read the paste event's OWN clipboardData synchronously inside the gesture,
  // never navigator.clipboard.read, so no iframe allow="clipboard-read" is required. A plain
  // text paste carries no image item: we return without preventing default, so xterm pastes
  // it to the pty exactly as before.
  //
  // Capture phase, not bubbling: xterm's own paste handler runs on its hidden textarea and
  // calls stopPropagation(), so a bubble-phase listener on this element (or document) would
  // never see the event. Capturing on termEl fires on the way DOWN to the textarea, ahead of
  // xterm, so an image is caught while text still flows straight through untouched.
  function pasteImageExt(type) {
    if (type === 'image/jpeg') return 'jpg';
    if (type === 'image/gif') return 'gif';
    if (type === 'image/webp') return 'webp';
    return 'png'; // image/png, and any unrecognised image/* type
  }
  termEl.addEventListener('paste', function (e) {
    var items = (e.clipboardData || window.clipboardData).items;
    if (!items) return;
    var image = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image/') === 0) { image = items[i]; break; }
    }
    if (!image) return;    // no image on the clipboard: let xterm's text paste proceed untouched
    if (!embedded) return; // self-host has no parent to receive the blob; leave the paste alone
    e.preventDefault();     // an image must never fall through to the pty
    e.stopPropagation();    // and xterm's textarea handler must not also paste it as empty text
    var blob = image.getAsFile();
    if (!blob) return;     // advertised an image but yielded no file: nothing to hand up
    var name = 'pasted-' + Date.now() + '.' + pasteImageExt(blob.type);
    toParent({ type: 'envhaven-console:paste-image', name: name, blob: blob });
  }, true);

  // ── Predictive echo (zero-latency input) ──────────────────────────────────
  // Each printable keystroke is painted instantly over the xterm screen, never
  // touching the authoritative grid or cursor, so tmux's repaint can never be knocked
  // out of sync. The optimistic state is ONE burst — `predicted` — snapshotted from
  // the confirmed grid when it opens: `line` is the expected row content left of the
  // cursor, which edits apply to (append on insert, pop on delete); `tail` is the
  // known content right of it, which cursor moves shuttle into and out of; `floor`
  // is the leftmost column predictions may reach. render() diffs `line` against the
  // live grid and draws the difference; reconcile() only ever asks "is the grid
  // WALKING this line?" — is its cursor on the burst's row, no further right than the
  // model's end, with every column it has painted holding what the model says. Walking
  // all the way to the end is the special case that confirms the burst (see echoTrails
  // and `match`); short of that the pane is simply behind the typist, which is the
  // ordinary state during a fast run and must never be read as disagreement.
  //
  // Per-keystroke bookkeeping is deliberately absent. The server applies keystrokes
  // in order, so with inserts alone every intermediate echo state is a prefix of the
  // predicted line and per-key checks would be sound; a deletion breaks that
  // monotonicity (the echo of a char a later backspace removes passes through states
  // that contradict newer predictions), so any per-key instantaneous test mis-confirms
  // or mis-kills around deletes. Whole-line matching is immune: contradictory
  // intermediates simply stay covered by the overlay until the echo stream converges,
  // or an echo-patience deadline snaps back to server truth.
  //
  // SAFETY: a predicted character must never be painted where a secret is typed.
  // The server watches the active tmux pane and sends a one-byte gate frame
  // (0x02: 1 = safe, 0 = unsafe); the browser ADMITS a keystroke into the burst
  // only while serverSafe is true, and a server "unsafe" clears everything pending.
  // It starts false and re-arms only on an explicit server "safe", so a prediction
  // can never precede the server's judgement of the pane. Every newline also
  // disarms locally, so a password typed ahead in the same burst as its command
  // (e.g. `sudo x`⏎`hunter2`⏎) is never drawn before the server re-inspects. A
  // burst that exists at the local disarm is kept: it repaints only keystrokes that
  // were typed while safe and are already on screen.
  // Predictive echo is OPT-IN. Append ?echo=1 to the URL to turn on zero-latency
  // local echo; without the parameter, or with ?echo=0, the page is a plain
  // server-echo terminal that never draws a predicted character. The safety gate
  // below still applies whenever echo is on.
  var echoEnabled = params.get('echo') === '1';
  var serverSafe = false;  // the sole gate; set by the 0x02 frame, default-off fail-safe
  var localDisarm = false; // we disarmed ourselves at a newline and are waiting for the
                           // server's own "unsafe" to confirm the submit window. Needed
                           // because the gate frame is also emitted when only the pane's
                           // APP NAME changes, and such a frame carries the current safe
                           // byte — landing mid-submit it would re-arm us inside the very
                           // window the server's grace exists to cover. Only an explicit
                           // server "unsafe" clears it, which that grace guarantees.
  var inputLen = 0;        // count of the user's own typed chars on the current line; a
                           // predicted delete may never reach below this (never the prompt/output)
  var predicted = null;    // the open edit burst: null while no optimism is pending. The model is
                           // {absRow, line, tail, floor, proven} — expected row content up to the
                           // cursor (line), the known content right of it (tail), the leftmost
                           // column edits may reach (floor) and whether that floor is the exact
                           // input start (proven). The rest of the object is bookkeeping (drain,
                           // wrap and match state); startBurst is the authoritative shape.
  var rttEma = 0;          // smoothed ms round-trip of confirmed bursts, sizes the give-up timeout
  var lineFresh = false;   // the line under edit began at a fresh prompt (the last submit) and
                           // every keystroke since was modelled, so `floor` is the PROVEN input
                           // start: boundary refusals (backspace/Home at the floor) match the
                           // shell exactly. Broken by any unmodelled key; re-proven at each Enter.
  var hold = null;         // {row, col, at, nav} after a handoff: the pane is mid-transition, so new
                           // bursts would bind to a stale cursor; suppressed until the grid
                           // cursor moves off this spot (the transition's echo landing) or a
                           // short deadline passes. Input typed during a hold rides the echo.
                           // nav marks the light kind (a cursor move): holdActive releases it on
                           // the first cursor step, while a heavy hold also waits for wire quiet.
  var wrapStyle = null;    // learned end-of-row behavior of the current pane: {atLen, indent,
                           // pull, down, flipped}. pull=true is a word-wrapping composer (Claude Code: the
                           // last word moves to a continuation row at `indent`, cursor keeps
                           // its screen row); pull=false is a hard wrap (zsh: the edge char
                           // fills the last column and the cursor drops to col 0 of the next
                           // row). atLen is the line length whose next char triggers the wrap.
  var wrapPend = null;     // {row, col, at, word} a wrap is riding the echo unpredicted; its
                           // observed outcome teaches wrapStyle so the NEXT wrap paints. col is
                           // the MODEL's edge at the ride, which learnWrap compares the settled
                           // grid cursor against.
  var edge = null;         // {absRow, col, text, was, at} the one glyph a hard wrap leaves on
                           // the pre-wrap row's last column, painted until its echo lands (`was`
                           // is the grid content it replaces, so reconcile knows when to retire
                           // it). wrapStep's downward-growth wrap path reuses the same variable
                           // as a multi-cell COVER instead: text is a run of spaces the width of
                           // the word that moved off the row, was is that word.
  var boxShift = null;     // {from, to, delta, text, textRow, wipeRow, was, at} the composer
                           // rows a predicted wrap moves one row over (see wrapFrame), drawn
                           // from clones of xterm's own rows until the echo lands. `was` is
                           // what the SOURCE row held when the wrap was predicted: the clone
                           // reads that row's live content every paint, so the moment the
                           // grid stops matching, the rows have already moved and ours must
                           // go (reconcile retires it).
  var lastDataAt = 0;      // when the last inbound data frame arrived; "wire quiet" is the
                           // signal that a transition's echo has fully drained.
  var appDec = new TextDecoder(); // gate frames carry whole strings, never split mid-UTF-8
  var paneApp = '';        // the pane's foreground command name, from the gate frame
                           // ("zsh", "claude", ...): wrap styles are facts about the
                           // APPLICATION editing the line, so they live and die with it.
  var styleCache = {};     // app name -> the wrapStyle it had when it last held the pane
                           // (null = seen, nothing learned); an app never seen before
                           // starts from seedStyle instead.
  var promptStr = null;    // the current pane's prompt prefix (see appPrompt), learned
  var promptCache = {};    // and cached per app exactly like the wrap style above

  // Insertable characters: every printable the terminal renders one column wide.
  // ASCII plus the narrow Latin/Greek/Cyrillic BMP ranges covers accented input on
  // all layouts (ñ á é í ó ú ü ç ß ø å, Greek, Cyrillic, Vietnamese). Everything
  // else — combining marks, CJK/emoji (2 columns; string indices would stop
  // matching grid columns), C1 controls — stays unpredicted and rides the echo.
  var INSERT_RE = /^[\x20-\x7e\u00a1-\u024f\u0370-\u03ff\u0400-\u04ff\u1e00-\u1eff]+$/;
  // The line editor's word class. zsh with WORDCHARS='' (this image's oh-my-zsh)
  // and Claude Code both treat an alphanumeric run as the word and everything
  // else as separators; iswalnum spans the same narrow ranges as INSERT_RE.
  var WORD_RE = /[0-9A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u1e00-\u1eff]/;
  function isWord(c) { return !!c && WORD_RE.test(c); }

  // The server tells us when the active pane stops being a safe place to draw (a
  // password/passphrase/PIN prompt, a running command, a remote or nested session,
  // copy-mode). On "unsafe" we also drop any pending overlays so nothing lingers
  // into a secret context.
  // The two directions are separate paths on purpose. Sharing one `s === serverSafe`
  // early return made the server's own "unsafe" a no-op for the PAINT whenever we had
  // already zeroed serverSafe ourselves — which is every submit, since the newline
  // disarms locally and deliberately KEEPS the burst for the server's unsafe to clear.
  // The burst then outlived the frame that exists to retire it and sat there until a
  // content deadline, repainting the just-submitted line over the fresh prompt.
  // owning() is justified on the rule that a server unsafe always clears the burst, so
  // the reset has to run on the frame itself, not on a transition.
  function setSafe(s) {
    if (!s) {
      localDisarm = false; // the submit window the server promised has closed
      serverSafe = false;
      resetPredictions();
      return;
    }
    if (localDisarm) return; // not the post-grace re-arm; keep waiting
    serverSafe = true;
  }

  // The pane's foreground application changed (a TUI started or exited): swap in
  // that app's own wrap style — a hard-wrap style learned in zsh must never paint
  // a mid-word split in Claude Code's word-pulling composer, nor the reverse — and
  // treat the moment as a heavyweight transition, because the pane is repainting
  // wholesale and every line-local fact (input boundary, proven floor) is stale.
  function setPaneApp(app) {
    if (app === paneApp) return;
    if (paneApp !== '') { styleCache[paneApp] = wrapStyle; promptCache[paneApp] = promptStr; }
    wrapStyle = Object.prototype.hasOwnProperty.call(styleCache, app) ? styleCache[app] : seedStyle(app);
    promptStr = Object.prototype.hasOwnProperty.call(promptCache, app) ? promptCache[app] : seedPrompt(app);
    paneApp = app;
    wrapPend = null;
    handoff('heavy');
  }

  // ── Measured composer geometry ────────────────────────────────────────────
  // One row per application this engine has been measured against, applied the
  // first time that app takes the pane so even its FIRST wrap paints instead of
  // riding the echo. Every field here is also LEARNED at runtime (learnWrap,
  // learnPrompt): a row buys the first wrap of a session and nothing more, and a
  // wrong row costs one mispredicted wrap before the ordinary path unlearns it.
  // An app with no row starts unlearned, which is correct rather than degraded.
  //
  //   pad     columns the composer leaves unused at the right, so its rows wrap
  //           at cols - pad. A MARGIN, not a width: measured to hold at both 100
  //           and 120 columns for every row below.
  //   indent  column a wrapped continuation row starts at.
  //   pull    word wrap (the whole last word moves to the continuation row)
  //           against a hard wrap (the triggering char fills the last column).
  //   down    where the new row comes from: DOWN, the cursor takes the row below
  //           while the first input row holds station; or UP, the box lifts into
  //           the space above and the cursor keeps its screen row.
  //           Measured, every word-wrapping composer here grows DOWN: the frame
  //           gets one row longer at its bottom. What changes mid-session is how
  //           that row is DELIVERED. Once the pane has no blank rows left below
  //           it the terminal scrolls instead, and a scroll moves the content up
  //           while the cursor keeps its screen row — which, to this page, IS the
  //           upward case: xterm runs here with scrollback 0, so baseY never
  //           moves and a screen row is the only row the engine has. (Measured in
  //           tmux at 120x30: codex and pi both report cursor_y +1 with the
  //           history unchanged while blank rows remain below, and history +1
  //           with cursor_y unchanged once the frame reaches the last row.)
  //           Claude Code never changes: it takes the ALTERNATE screen, which has
  //           no scrollback to scroll into, and repaints its whole frame one row
  //           higher in place. So a seed is the direction AT SESSION START; the
  //           engine owns the change, flipping it on a mispredicted pull wrap,
  //           and codex and pi pay one wrap at the moment their pane fills up.
  //   prompt  the chrome before the input on the first row. null for none, which
  //           is not the same as '' — see rowIsPrompt.
  //
  // `bun dev/scripts/measure-tui.ts` drives these applications in a real terminal
  // and checks this table against them. It is how a row gets written, and it is
  // the answer when one of them redesigns its composer: measure again, replace
  // the row. Never hand-derive these numbers.
  //
  // A row also needs a check that presses it, or it rots unnoticed: add the app to
  // dev/scripts/lib/console-rig.ts and to seedwrap's own table, which restates
  // these numbers on purpose so drift between the two shows up as a failure. The
  // whole procedure for a newly added tool is docs/architecture.md, "Adding New
  // Tools", step 7.
  var TUI = {
    // Rules above and below, no side borders, the box pinned to the bottom of the
    // screen and lifting into the space above as it grows. The separator after ❯
    // is U+00A0 in the live composer and U+0020 in plain redraws; rowIsPrompt
    // accepts either, so the seed carries the ordinary space.
    claude: { pad: 2, indent: 2, pull: true,  down: false, prompt: '\u276f ' },
    // No rules at all: a bare prompt in the scrolling stream, with its status
    // line moving down as the draft grows.
    codex:  { pad: 1, indent: 2, pull: true,  down: true,  prompt: '\u203a ' },
    // Rules above and below, and the draft starts hard against column 0. pi has
    // no prompt to seed, which is why this is null rather than ''.
    pi:     { pad: 1, indent: 0, pull: true,  down: true,  prompt: null },
    // zle hard-wraps at the screen edge and never moves a word: the triggering
    // char fills the row's last cell and the cursor drops to column 0 of the next
    // row. A full row is a full row whatever the prompt's width, so the geometry
    // is the whole seed.
    zsh:    { pad: 1, indent: 0, pull: false, down: false, prompt: null }
  };
  // opencode is measured and deliberately absent: it runs TWO composers, and no
  // single row describes both.
  //   splash, until the first submit — a box of FIXED 70-column text width centred
  //     in the terminal, so its wrap column tracks cols/2 and not the right edge
  //     at all (measured: wraps at 96 of 120, at 86 of 100; indent 26 and 16).
  //     Centred vertically too, so it grows up and down on alternate wraps.
  //   steady, from the first submit on — bottom-anchored, indent 5, growing
  //     upward like Claude Code's, pad 4 (measured at 120 columns) — but its
  //     sidebar opens above 120 columns and takes 42 more, so even here the
  //     margin is not a constant: it is pad 4 at 120 and pad 46 at 121.
  // Neither `pad` nor `down` is a constant for this app, so a row here would
  // assert something untrue in one of the two states, and seeding either one
  // mispredicts in the other. It learns from its first wrap like any unknown app.
  // Give it a row only if it grows a single composer of a constant margin.

  // An app with no row here and nothing learned yet still has to decide when to
  // stop predicting and let a wrap ride. That has to start before the earliest
  // wrap any composer could take, which is the widest right margin the table
  // knows about.
  var RIDE_PAD = 1;
  for (var padKey in TUI) if (TUI[padKey].pad > RIDE_PAD) RIDE_PAD = TUI[padKey].pad;

  // `app` is a name off the wire, so this is an own-property lookup and never the
  // prototype's: an app named "constructor" would otherwise hand back a function
  // and seed an atLen of NaN.
  function tuiRow(app) {
    return Object.prototype.hasOwnProperty.call(TUI, app) ? TUI[app] : null;
  }
  function seedStyle(app) {
    var t = tuiRow(app);
    if (!t) return null;
    return { atLen: term.cols - t.pad, indent: t.indent, pull: t.pull, down: t.down, flipped: false };
  }
  function seedPrompt(app) {
    var t = tuiRow(app);
    return t ? t.prompt : null;
  }

  // A predicted char is drawn as our OWN absolutely-positioned span over the
  // xterm screen (xterm decorations do not render glyph text reliably), so it is
  // guaranteed visible yet still never touches the authoritative grid or cursor.
  // Geometry comes straight from the screen element's measured cell size.
  var predOverlay = null; // the single z-index:10 layer that holds all optimistic drawing
  function overlay() {
    if (predOverlay && predOverlay.isConnected) return predOverlay;
    predOverlay = newScreenLayer(10);
    if (!predOverlay) return null;
    glyphLine = coverLine = predCursor = edgeLine = boxLine = wipeLine = null; // children of a replaced overlay are detached; rebuild them
    return predOverlay;
  }

  // xterm's DOM renderer stretches every cell to exactly cell.width by applying
  // letter-spacing = cell.width - measured('W') to the rows. A real glyph therefore
  // advances by charWidth + that spacing, which is NOT col*cell.width once charWidth
  // differs even slightly from the cached 'W' — the gap accumulates left-to-right.
  // Painting a predicted glyph at col*cell.width thus drifts a fraction of a pixel
  // from where xterm will land the real one, so it visibly shifts as it settles. We
  // avoid the drift entirely by flowing the run through the browser's own layout with
  // this exact spacing (getComputedStyle rounds it, which reintroduces the drift).
  function exactLetterSpacing(cw) {
    try {
      var w = term._core._renderService._renderer.value._widthCache.get('W', false, false);
      if (w) return cw - w;
    } catch (e) { /* fall through */ }
    var s = termEl.querySelector('.xterm-rows span[style*="letter-spacing"]');
    return s && s.style.letterSpacing ? parseFloat(s.style.letterSpacing) : 0;
  }

  // Whether the application has hidden the caret (DECTCEM, ESC[?25l). xterm stops
  // painting .xterm-cursor when this is set, so we must not draw our predicted block
  // over it either. Fails toward drawing if the internal shape ever moves.
  function cursorHidden() {
    try { return term._core._coreService.isCursorHidden; } catch (e) { return false; }
  }

  // ── One renderer for the whole optimistic view ────────────────────────────
  // Predicted glyphs, delete covers, and the cursor are ALL rebuilt from
  // `predicted.line` by render(), laid out by the browser's own text engine so every
  // glyph lands on the exact pixel xterm will use (no per-cell arithmetic, no
  // settle-drift). We never touch the authoritative grid or the real cursor: as the
  // server's echo catches up, the divergence point moves right and each rebuild lets
  // the real glyphs beneath show through.
  var glyphLine = null, coverLine = null, predCursor = null, edgeLine = null, boxLine = null, wipeLine = null;
  var owningNow = false, lastEditAt = 0, releaseTimer = 0;
  var lastMeasureS = null, lastMeasureGx = 0; // cache the cursor's measured x by predicted text
  var CURSOR_GRACE = 250; // keep owning the cursor this long after the last keystroke,
                          // so a burst of edits never hands it back mid-stream (no flicker)

  function lineCss(top, cw, ch, z) {
    return 'position:absolute;left:0;top:' + top + 'px;white-space:pre;line-height:' + ch +
      'px;font-family:' + styleFF + ';font-size:' + styleFS + ';letter-spacing:' + exactLetterSpacing(cw) + 'px;z-index:' + z;
  }

  // We own the cursor only while actively editing — an edit burst still open, or
  // within a short grace of the last keystroke. Outside that window we release to
  // xterm's real cursor, so blink, focus, and cursor-hide (DECTCEM) stay xterm's job
  // and we never fight it during plain output. serverSafe is deliberately NOT
  // consulted here: it gates what may ENTER the burst (predict) and a server
  // "unsafe" clears the burst (setSafe), so an open burst is always safe to show —
  // hiding it at the local newline disarm would un-paint a submitted line's tail
  // while its echo is still in flight.
  function owning() {
    return echoEnabled && ws && ws.readyState === 1 &&
      (predicted !== null || (performance.now() - lastEditAt) < CURSOR_GRACE);
  }
  function releaseCursor() {
    // Every child of the overlay, whatever it is called. This used to name the six
    // layers one by one, which made a seventh layer two edits: its own drawing code,
    // and a line here. Forgetting the second left that layer painted over a live
    // terminal after the engine had let go of it, with nothing left to take it down.
    // The overlay already knows what it is holding, so ask it rather than keeping a
    // second list in step with the first.
    if (predOverlay) {
      for (var li = 0; li < predOverlay.children.length; li++) {
        predOverlay.children[li].style.display = 'none';
      }
    }
    if (owningNow) { owningNow = false; termEl.classList.remove('eh-hide-cursor'); }
    lastMeasureS = null; // drop the cached x; cell width may differ next session (resize)
  }

  function render() {
    var ov = overlay(); if (!ov) return;
    if (!styleFg) refreshStyle();
    // The background of the cell the REAL cursor sits on, kept current whether we are
    // drawing or not. Both cursor rules in the page's CSS read it: the one that
    // neutralises xterm's cursor while we own it, and the blink override that runs when
    // we do not. Set before the ownership check for that second reader, since the blink
    // is exactly what happens once we have released. Cheap enough for every repaint —
    // rowBackground caches by class list, so a settled screen costs one row scan.
    termEl.style.setProperty('--eh-cell-bg', rowBackground(term.buffer.active.cursorY));
    if (!owning()) { releaseCursor(); return; }
    var dm = cellDims(), cw = dm[0], ch = dm[1];
    var b = term.buffer.active, gridAbs = b.baseY + b.cursorY;
    // A burst deliberately off the grid cursor's row — rebased below by a
    // predicted hard wrap, or above by a predicted cross-row move — paints at
    // the burst's own row, with the model's length as the diff anchor (the stale
    // grid cursor column means nothing on another row, and no cover applies
    // there). Everything else — including a draining burst — paints at the grid
    // cursor as before, so a burst on another row for any OTHER reason still
    // degrades to just the block.
    var stacked = predicted && !predicted.draining && predicted.offGrid &&
      predicted.absRow !== gridAbs &&
      predicted.absRow - b.baseY >= 0 && predicted.absRow - b.baseY < term.rows;
    var absRow = stacked ? predicted.absRow : gridAbs;
    var cursorX = stacked ? Math.min(predicted.line.length, term.cols) : b.cursorX;
    var line = b.getLine(absRow);
    var base = line ? line.translateToString(false, 0, cursorX) : ''; // grid content, cols [0, cursorX)
    // The predicted text up to the cursor. A burst on another row (the line scrolled
    // under us) draws nothing extra: s = base degrades to just the block cursor.
    var s = predicted && predicted.absRow === absRow ? predicted.line : base;
    // First column where the prediction diverges from the grid: everything to its
    // left is already correct on screen, so draw nothing there.
    var div = 0, m = Math.min(s.length, base.length);
    while (div < m && s.charCodeAt(div) === base.charCodeAt(div)) div++;
    var fg = s.slice(div);                // predicted new glyphs to paint (inserts / overwrites)
    if (!glyphLine) {
      glyphLine = document.createElement('div');
      coverLine = document.createElement('div');
      predCursor = document.createElement('div');
      ov.appendChild(glyphLine); ov.appendChild(coverLine); ov.appendChild(predCursor);
    }
    var top = (absRow - b.baseY) * ch;
    // Every opaque layer on this row sits on the background the APPLICATION drew, sampled
    // where our first paint lands. Falls back to the terminal's own where the app drew none.
    var rowBg = rowBackground(absRow - b.baseY);
    // Cover (z-index 1, behind the glyphs): of the grid cells between the predicted
    // cursor and the real one, paint out ONLY those whose expected char (the tail)
    // differs from what the grid shows — glyphs the model deleted, awaiting their
    // erase echo. Cells the cursor merely stepped left over still hold their
    // content and must stay visible. Same flow as the grid => each cover is exactly
    // as wide as the glyph it hides, so no sliver escapes.
    var coverFrom = Math.max(div, s.length), anyCover = false;
    if (cursorX > coverFrom) {
      coverLine.style.cssText = lineCss(top, cw, ch, 1);
      coverLine.textContent = '';
      var cpre = document.createElement('span'); cpre.style.color = 'transparent'; cpre.textContent = base.slice(0, coverFrom);
      coverLine.appendChild(cpre);
      for (var j = coverFrom, runStart = coverFrom, hideRun = null; j <= cursorX; j++) {
        var hide = j < cursorX &&
          !(predicted && predicted.absRow === absRow && predicted.tail[j - s.length] === base[j]);
        if (hideRun === null) { hideRun = hide; runStart = j; continue; }
        if (j < cursorX && hide === hideRun) continue;
        var cspan = document.createElement('span'); cspan.textContent = base.slice(runStart, j);
        if (hideRun) { cspan.style.color = rowBg; cspan.style.background = rowBg; anyCover = true; }
        else { cspan.style.color = 'transparent'; }
        coverLine.appendChild(cspan);
        hideRun = hide; runStart = j;
      }
      // A pane that paints its OWN cursor (Claude Code: an inverse-video cell at its
      // insertion point) leaves that cell stale at the REAL cursor while ours has
      // already moved left. Repaint just that cell in plain video until the echo
      // catches up. Gated on the inverse attribute so legitimately styled content
      // (dim ghost text, syntax colours) is never touched.
      if (predicted && predicted.absRow === absRow) {
        var cc = line && line.getCell(cursorX);
        if (cc && cc.isInverse()) {
          var patch = document.createElement('span');
          patch.style.color = styleFg; patch.style.background = rowBg;
          patch.textContent = cc.getChars() || ' ';
          coverLine.appendChild(patch);
          anyCover = true;
        }
      }
    } else if (predicted && predicted.absRow === absRow && !predicted.matched) {
      // The other direction: the app was showing GHOST TEXT right where the user just
      // started typing — Claude Code's `Try "…"` placeholder, a shell's suggestion — and
      // it deletes the whole run the instant a real character lands. Until that echo
      // arrives the grid still holds it, so the prediction paints over the run's first
      // columns and the REST sits beside the cursor, eaten one character per keystroke.
      // (Measured: typing into `❯ Try "how do I log an error?"` shows
      // `❯ h█y "how do I log an error?"`, then `❯ ho█ "how do I log an error?"`. It reads
      // as the placeholder being dragged along inside the cursor, which is how it was
      // reported.) Nothing above covers it: that cover spans predicted cursor → REAL
      // cursor, and while inserting the real cursor is the one on the left.
      //
      // The run is identified by the app's own declaration: cells it drew UNLIKE plain
      // input text, either dimmed (SGR 2) or in an explicit foreground colour. Both are
      // needed — measured on one Claude Code build, the opening `Try "…"` placeholder is
      // `xterm-dim` while the hint it redraws after the input is cleared is a plain grey
      // `xterm-fg-246`, so a dim-only test covers the first and silently misses the
      // second. What the two have in common is the only thing that matters here: the app
      // styled them, and the user's own typing is default-foreground.
      //
      // The box rule beside the composer and the row's blank tail are default-styled, so
      // neither is ever painted out. Contiguity from the cursor keeps it local: styled
      // chrome further along the row (a right-aligned key hint) is separated by plain
      // blanks, and the run ends there.
      //
      // Only until the burst first matches. After that, dim text right of the cursor is
      // a suggestion the app produced in RESPONSE to this input — zsh-autosuggestions
      // regenerates one per keystroke — and blanking that would flicker it off on every
      // character. A stale suggestion held still beats a blinking one.
      var gEnd = s.length, gCell = null;
      while (line && gEnd < term.cols) {
        gCell = line.getCell(gEnd, gCell || undefined); // reused cell: one alloc, not one per column
        if (!gCell || (!gCell.isDim() && gCell.isFgDefault())) break;
        gEnd++;
      }
      if (gEnd > s.length) {
        coverLine.style.cssText = lineCss(top, cw, ch, 1);
        coverLine.textContent = '';
        // The predicted text itself is the spacer: exactly as many columns as the run
        // has to skip, and drawn transparent so the glyph layer above still shows.
        var gpad = document.createElement('span'); gpad.style.color = 'transparent'; gpad.textContent = s;
        var ghide = document.createElement('span'); ghide.style.color = rowBg; ghide.style.background = rowBg;
        ghide.textContent = line.translateToString(false, s.length, gEnd);
        coverLine.appendChild(gpad); coverLine.appendChild(ghide);
        anyCover = true;
      }
    }
    coverLine.style.display = anyCover ? 'block' : 'none';
    // Glyphs (z-index 2, on top): transparent prefix so the run flows onto the right
    // columns, then the predicted characters in the foreground colour on a SOLID
    // background — a doomed grid glyph beneath (erase echo still in flight) must not
    // show through and overlap the prediction drawn over its cell.
    glyphLine.style.cssText = lineCss(top, cw, ch, 2);
    glyphLine.textContent = '';
    var gpre = document.createElement('span'); gpre.style.color = 'transparent'; gpre.textContent = s.slice(0, div);
    var gvis = document.createElement('span'); gvis.style.color = styleFg; gvis.style.background = rowBg; gvis.textContent = fg;
    glyphLine.appendChild(gpre); glyphLine.appendChild(gvis);
    glyphLine.style.display = 'block';
    // Cursor (z-index 3): an OPAQUE block at the predicted column = the right edge of
    // the whole predicted line, showing the char it sits on in inverse video like a
    // real block cursor. Opaque so a half-deleted glyph can never show through it.
    // Its x is the flowed width of `s`, cached by that text so identical predicted
    // content does not force a layout read every frame. Suppressed when the application
    // itself hid the caret (DECTCEM), so we never draw a block where xterm shows none.
    if (cursorHidden()) {
      predCursor.style.display = 'none';
    } else {
      var gx;
      if (s === lastMeasureS) { gx = lastMeasureGx; }
      else {
        var screen = termEl.querySelector('.xterm-screen');
        gx = glyphLine.getBoundingClientRect().right - screen.getBoundingClientRect().left;
        lastMeasureS = s; lastMeasureGx = gx;
      }
      predCursor.style.cssText = 'position:absolute;pointer-events:none;z-index:3;left:' + gx + 'px;top:' + top +
        'px;width:' + cw + 'px;height:' + ch + 'px;background:' + styleFg + ';color:' + rowBg +
        ';font-family:' + styleFF + ';font-size:' + styleFS + ';line-height:' + ch + 'px;white-space:pre';
      // The glyph inside the block is read from the GRID, live, never from `tail`, and a
      // burst that has changed content draws no glyph at all.
      //
      // `tail` cannot answer this: it is a snapshot that goes stale in a way no freshness
      // flag catches. Measured — type a few characters and erase back to an empty input
      // without pausing long enough to end the burst. The app redraws its placeholder and
      // reconcile MATCHES at the prompt column (curCol, line.length and the prefix all
      // agree), so it refreshes `tail` from that row, and that row is the placeholder. The
      // burst survives because the user is still typing, so `line` grows while `tail` stays
      // frozen on `Try "…"` and the block paints its first letter for the whole run.
      // Reproduced at 260ms and 450ms after the erase, clean at 120ms.
      //
      // The split is what we DID, not how fresh a snapshot looks, and not whether the model
      // happens to agree with the grid. Both weaker rules were tried and both put the
      // placeholder back: "draw where the app has already drawn" re-paints the very cells
      // the cover layer is blanking during a backspace, and "draw where the model agrees
      // with the grid" passes trivially in the one state that matters, because there the
      // model and the grid are stale TOGETHER (measured: glyph="T", tail="Try \"fix lin",
      // both pointing at the same doomed cell). A burst that changed content has, by
      // construction, made the cells right of the cursor unknowable until the echo lands;
      // an empty block is the only honest answer, and it is what the cell is about to be
      // every time you type at the end of an input. A moves-only burst changed nothing, so
      // the grid at the block's own column IS the answer and stays current.
      //
      // The cost is small and known: while a burst that edited content is still open, a
      // cursor stepping back over that text shows an empty block instead of the glyph
      // under it. Restoring that glyph is not worth reopening the bug above.
      //
      // s.length is the block's column in both cases — it is what gx was measured from —
      // so the read needs no separate branch for a burst that owns the row.
      predCursor.textContent = (predicted && predicted.absRow === absRow && predicted.dirty
        ? ''
        : line && line.translateToString(false, s.length, s.length + 1)) || '';
      predCursor.style.display = 'block';
    }
    // The hard-wrap edge glyph: the one char the wrap left on the pre-wrap row's
    // last column, painted until its echo lands (reconcile retires it).
    if (edge && edge.absRow - b.baseY >= 0 && edge.absRow - b.baseY < term.rows) {
      if (!edgeLine) { edgeLine = document.createElement('div'); ov.appendChild(edgeLine); }
      edgeLine.style.cssText = lineCss((edge.absRow - b.baseY) * ch, cw, ch, 2);
      edgeLine.textContent = '';
      var epre = document.createElement('span'); epre.style.color = 'transparent';
      epre.textContent = (fullRow(edge.absRow) || repeatSp(term.cols)).slice(0, edge.col);
      var ech = document.createElement('span'); ech.style.color = styleFg;
      ech.style.background = rowBackground(edge.absRow - b.baseY); // the edge glyph's own row
      ech.textContent = edge.text;
      edgeLine.appendChild(epre); edgeLine.appendChild(ech);
      edgeLine.style.display = 'block';
    } else if (edgeLine) {
      edgeLine.style.display = 'none';
    }
    // The composer rows the wrap moved. Each is drawn from a CLONE of xterm's own
    // rendered row, so the rule's colour and the hint's highlights come along with
    // no palette arithmetic; the wrapper restores the font metrics the row inherited
    // from .xterm-rows. Rows landing outside the viewport are simply dropped — that
    // is exactly what the app does to the hint row when the box grows downward.
    var xrows = termEl.querySelector('.xterm-rows');
    if (boxShift && xrows) {
      if (!boxLine) { boxLine = document.createElement('div'); ov.appendChild(boxLine); }
      // The clones must sit under the same classes their source row does, or they change
      // colour. xterm styles a cell two ways: an explicit palette class (.xterm-fg-244),
      // which survives a clone anywhere, or NO class at all, which inherits — and the
      // inherited colour is set by `.xterm-dom-renderer-owner-N .xterm-rows`, with the
      // dim attribute likewise scoped to `.xterm-rows .xterm-dim`. Cloned into a plain
      // div the unclassed cells fall through to the page's own foreground and every dim
      // run stops being dim, so the moved rows paint a visibly different colour than the
      // identical rows beside them. (Measured: a cloned rule read rgb(204,204,204)
      // against the real rgb(255,255,255).)
      //
      // Copied from the live container rather than hardcoded, because `xterm-rows` is
      // not the whole story: xterm also toggles `xterm-focus` there, and several of its
      // rules key off the pair. (Measured: with only `xterm-rows`, a cloned cursor cell
      // matched the plain block-fill rule instead of the focused blink rule and painted
      // a solid rgb(0,0,0)-on-white block that the real row did not have.) Taking the
      // class list as it is keeps the clone in whatever context xterm is rendering in,
      // this version and the next. Our inline styles below still win over any of it.
      boxLine.className = xrows.className;
      boxLine.textContent = '';
      // The moved rows are CONTIGUOUS, so stack them in normal flow inside one
      // block placed at the first destination row and let the browser lay them out
      // exactly as it lays out xterm's own rows — matching metrics by construction
      // instead of by arithmetic, which is what keeps a cloned rule on the very
      // same scanline as the real one. The block is opaque (it hides the rows it
      // covers) and clipped at the screen's last row: growing downward, the app
      // pushes its hint off-screen and so must we.
      var rcs = getComputedStyle(xrows), dstTop = boxShift.from + boxShift.delta - b.baseY;
      var painted = (boxShift.to - boxShift.from + 1) + (boxShift.text !== null ? 1 : 0);
      var clipped = Math.max(0, Math.min(painted, term.rows - dstTop));
      boxLine.style.cssText = 'position:absolute;left:0;top:' + (dstTop * ch) + 'px;z-index:1' +
        ';height:' + (clipped * ch) + 'px;overflow:hidden;background:' + rowBackground(Math.max(0, dstTop)) +
        ';font-family:' + rcs.fontFamily + ';font-size:' + rcs.fontSize +
        ';line-height:' + rcs.lineHeight + ';white-space:pre';
      var fr, vi, srcEl, cloneEl, cur, ci;
      for (fr = boxShift.from; fr <= boxShift.to; fr++) {
        vi = fr - b.baseY;
        if (vi < 0 || vi >= term.rows) continue;
        srcEl = xrows.children[vi];
        if (!srcEl) continue;
        cloneEl = srcEl.cloneNode(true); // colours ride on the clone
        // xterm's CURSOR styling rides on it too, and under `.xterm-rows` it now
        // applies: the block-cursor rule is scoped there exactly like the colour is.
        // wrapFrame never puts the cursor's own row inside this range, but the clone is
        // taken at PAINT time and the cursor moves between the two, so a moved row can
        // arrive carrying a second block cursor into the overlay. Drop the marker
        // classes; the cell keeps its text and its palette.
        cur = cloneEl.querySelectorAll('.xterm-cursor');
        for (ci = 0; ci < cur.length; ci++) {
          cur[ci].classList.remove('xterm-cursor', 'xterm-cursor-block', 'xterm-cursor-blink',
                                   'xterm-cursor-bar', 'xterm-cursor-underline', 'xterm-cursor-outline');
        }
        boxLine.appendChild(cloneEl);
      }
      // The pre-wrap row's kept text, on the row it rose to — the one moved row we
      // draw ourselves, because its content changed (the wrapped word left it).
      if (boxShift.text !== null) {
        var keptEl = document.createElement('div');
        keptEl.style.cssText = 'color:' + styleFg + ';letter-spacing:' + exactLetterSpacing(cw) + 'px';
        keptEl.textContent = boxShift.text;
        boxLine.appendChild(keptEl);
      }
      boxLine.style.display = 'block';
    } else if (boxLine) {
      boxLine.style.display = 'none';
    }
    // Growing downward, the burst row IS the old bottom rule: blank whatever the
    // predicted text does not cover, or the rest of the rule shows through beside it.
    if (boxShift && boxShift.wipeRow >= 0 &&
        boxShift.wipeRow - b.baseY >= 0 && boxShift.wipeRow - b.baseY < term.rows) {
      if (!wipeLine) { wipeLine = document.createElement('div'); ov.appendChild(wipeLine); }
      wipeLine.style.cssText = 'position:absolute;left:0;z-index:1;background:' +
        rowBackground(boxShift.wipeRow - b.baseY) +
        ';top:' + ((boxShift.wipeRow - b.baseY) * ch) + 'px;height:' + ch + 'px;width:100%';
      wipeLine.style.display = 'block';
    } else if (wipeLine) {
      wipeLine.style.display = 'none';
    }
    if (!owningNow) { owningNow = true; termEl.classList.add('eh-hide-cursor'); }
  }

  // Re-check ownership after the grace window even if no further server output arrives
  // to trigger a render. The tick also reconciles, so a burst that never converges
  // (a server stall, a pane that echoes differently) ages out by its timeout and the
  // overlay releases instead of hanging on screen; it re-arms until ownership ends.
  function armRelease() {
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(function () {
      releaseTimer = 0;
      reconcile();                // release a confirmed burst, or time out a stalled one
      render();                   // repaint what remains, or release if the burst closed
      if (owning()) armRelease(); // keep ticking until we truly stop owning the cursor
    }, CURSOR_GRACE + 20);
  }
  function touchEdit() { lastEditAt = performance.now(); armRelease(); }

  // Rebuild the overlay AFTER every xterm paint: as the echo lands, the divergence
  // point moves right and the run and covers shrink onto the freshly painted real
  // glyphs with no gap, and the cursor tracks the real one when idle.
  term.onRender(function () { render(); });

  // Open an edit burst: snapshot the whole row. [0,cursor) becomes `line`, the
  // predicted content left of the cursor that edits apply to; the rest becomes
  // `tail`, the known content cursor moves shuttle into and out of. `floor` is the
  // leftmost column predictions may reach: inputLen columns left of the cursor.
  // Opened at the input's end that is exactly where the user's input starts; opened
  // mid-input it can only be too far LEFT (inputLen counts own chars on both sides
  // of the cursor), so an over-navigation stays possible and is corrected by the
  // echo like any other mispredict. Refuses when the row holds wide (2-column)
  // glyphs: string indices would stop matching grid columns and both the drawing
  // and the whole-line match would misalign. (Predicted chars are narrow-only.)
  function startBurst() {
    var b = term.buffer.active, absRow = b.baseY + b.cursorY;
    var row = fullRow(absRow);
    if (row === null) return false;
    learnPrompt(b.getLine(absRow), row, b.cursorX); // the cursor column IS the input start
    var floor = Math.max(0, b.cursorX - inputLen);
    // `proven`: the floor is the exact input start, so a boundary refusal (backspace
    // or Home at the floor) is what the shell will do too and may be claimed as a
    // no-op. True only when the line began at a fresh prompt and every keystroke
    // since was modelled AND the input never reached back past column 0 (a floor
    // clamped to 0 means the input continues on the row above — a wrap continuation
    // — where the real boundary is off-row and unknowable).
    // `dirty`: the burst holds content edits whose paint must survive until their
    // echo lands; a clean (moves-only) burst paints nothing but the cursor block
    // and may be dropped the moment the pane visibly disagrees.
    // `draining`: handed off — admits nothing, keeps its paint, dies on evidence.
    // `matched`: the pane has been seen walking this burst's line at least once, so
    // `tail` has been re-read from the pane and describes real content. Until then it is
    // only the snapshot taken here, and a snapshot can hold text the app is about to
    // delete — Claude Code's `Try "…"` placeholder is exactly that, and it survived four
    // seconds of typing back when only a full `match` could retire it.
    predicted = { absRow: absRow, line: row.slice(0, b.cursorX), tail: row.slice(b.cursorX),
                  floor: floor, proven: lineFresh && floor > 0, openCol: b.cursorX,
                  dirty: false, draining: false, drainRow: 0, drainCol: 0, drainBase: '', drainMissAt: 0,
                  missAt: 0, wrapped: false, offGrid: false, wrapAt: 0, wrapRow: -1, wrapCol: 0,
                  sampled: false, mismatched: false, walked: false,
                  matched: false };
    return true;
  }

  // The exact-width row snapshot every model update works from; null when the row
  // holds wide (2-column) glyphs, which would break string-index/grid-column
  // correspondence (the caller then declines to predict).
  function fullRow(absRow) {
    var line = term.buffer.active.getLine(absRow);
    var row = line ? line.translateToString(false, 0, term.cols) : '';
    return row.length === term.cols ? row : null;
  }

  // The burst no longer describes the row the cursor is on (output scrolled the
  // line under it) — EXCEPT while the burst sits off the grid cursor's row ON
  // PURPOSE (a predicted hard wrap one row below, a predicted cross-row move
  // above), waiting for its echo; edits must keep flowing into it there, not
  // hand it off. A runaway offGrid burst still dies by its ordinary deadlines.
  function burstDisplaced() {
    if (!predicted) return false;
    var b = term.buffer.active, g = b.baseY + b.cursorY;
    if (predicted.absRow === g) return false;
    if (predicted.offGrid) return false;
    return true;
  }

  // Graceful handoff: the pane is doing something we do not model (an unmapped key,
  // an unproven boundary, an unlearned wrap). Unlike resetPredictions this never
  // tears down paint that is still ahead of the echo — a dirty burst is kept
  // DRAINING: it admits nothing further, keeps covering its typed chars, and is
  // released the moment the echo shows the pane acting (or by deadline). A clean
  // burst just drops. Either way a hold marks the current grid cursor as stale so
  // no new burst binds to it before the transition's echo lands.
  function handoff(kind) {
    var b = term.buffer.active;
    hold = { row: b.baseY + b.cursorY, col: b.cursorX, at: performance.now(), nav: kind === 'nav' };
    if (predicted && predicted.dirty && predicted.absRow === hold.row) {
      predicted.draining = true;
      predicted.drainRow = hold.row;
      predicted.drainCol = hold.col;
      predicted.drainBase = (fullRow(hold.row) || '').slice(0, hold.col);
      predicted.drainMissAt = 0;
    } else {
      predicted = null;
      lastEditAt = 0;
      releaseCursor();
    }
    inputLen = 0;
    lineFresh = false;
  }

  // A HEAVY hold (an unmapped key that rewrites the pane, a ridden wrap, an app
  // switch) ends when the transition's echo has both ARRIVED (the grid cursor
  // moved off the held spot) and DRAINED (the wire quiet for a beat) — a wrap
  // repaint moves the cursor several times across chunks, and rebinding on the
  // first twitch would open bursts at mid-repaint positions right at the old
  // edge, whose deadline deaths then poison the freshly learned wrap style. A
  // NAV hold (a cursor op we merely could not model: an over-navigation, a
  // boundary crossing) settles in a single repaint, so it releases on the first
  // cursor movement alone — this is what keeps navigation echo-paced instead of
  // frozen behind the quiet window while typing continues. An op the pane never
  // echoes at all falls to the timeout either way.
  function holdActive() {
    if (!hold) return false;
    var b = term.buffer.active, now = performance.now();
    var moved = b.baseY + b.cursorY !== hold.row || b.cursorX !== hold.col;
    if (moved && (hold.nav || now - lastDataAt > 60)) { hold = null; return false; }
    if (now - hold.at > Math.min(600, Math.max(250, rttEma * 1.5))) { hold = null; return false; }
    return true;
  }

  // The last whitespace-delimited word of `s`, or '' when it starts left of `floor`
  // (there it is not ours to move). `>=` because a word may start exactly AT the floor:
  // a composer continuation row is `indent` spaces then one word, so its word begins at
  // floor precisely. Reading that as "no word" made wrapStep move only the trigger char
  // while the pane moved the whole word, which mispredicts the wrap and then flips a
  // correct growth direction on the way out.
  function lastToken(s, floor) {
    var sp = s.lastIndexOf(' ');
    return sp + 1 >= floor ? s.slice(sp + 1) : '';
  }

  // Observe how the pane actually resolved a wrap that rode the echo, and remember
  // the style so the NEXT wrap is painted instantly. Measured ground truth of the
  // two real styles: zsh hard-wraps — the pre-wrap row stays full, the cursor drops
  // to column 0 of the next row; Claude Code's composer word-wraps — the last word
  // moves to a continuation row at a small indent and the cursor keeps its screen
  // row while the block grows upward. atLen (the line length whose next char
  // wraps) is reconstructed from the settled grid: for a word-pull it is the
  // pre-wrap row rebuilt (prior row + separating space + moved word); for a hard
  // wrap it is the full prior row minus the edge char. A bad read self-corrects:
  // a mispredicted wrap unlearns the style and the next one re-teaches it.
  function learnWrap() {
    if (!wrapPend) return;
    if (performance.now() - wrapPend.at > 2500) { wrapPend = null; return; }
    // Only a QUIET wire shows a settled grid: mid-repaint cursor positions and
    // half-painted rows must never teach a style (the timer in armWrapLearn
    // keeps retrying between frames until this window opens).
    if (performance.now() - lastDataAt <= 60) return;
    var b = term.buffer.active, curAbs = b.baseY + b.cursorY, curCol = b.cursorX;
    var delta = curAbs - wrapPend.row;
    // The wrap's own echo: the cursor resting on the next row (hard wrap) or left
    // of the model's edge on the same row (word pull). A cursor still AT the edge
    // means the line simply ended there — nothing wrapped, keep waiting.
    if (!(delta === 1 || (delta === 0 && curCol < wrapPend.col))) return;
    var row = fullRow(curAbs), prev = curAbs > 0 ? fullRow(curAbs - 1) : null;
    if (row === null || prev === null) return;
    var prevTrim = prev.replace(/ +$/, '').length;
    var indent = row.search(/\S/);
    var pull, atLen;
    if (indent === -1) {
      // An empty continuation row: the rode char landed on the previous row's
      // last column and the cursor dropped alone — the hard-wrap signature.
      if (delta !== 1 || curCol !== 0) return;
      pull = false; indent = 0; atLen = prevTrim - 1;
    } else if (prevTrim === term.cols) {
      // The pre-wrap row is full to the last column: a hard wrap (zsh). A word
      // wrapper never fills the final column, so fullness is the discriminator.
      if (curCol < indent) return;
      pull = false; indent = 0; atLen = prevTrim - 1;
    } else {
      // Word pull: the row above was left short where the moved word used to be.
      // atLen (the pre-wrap line length whose next char wraps) is the prior row
      // rebuilt: prior + separating space + the moved word as we knew it at the
      // ride (excluding the trigger char, which is exactly the reconstruction the
      // measured composer trigger arithmetic wants). Without a word match the
      // pull cannot be sized: keep riding this pane's wraps.
      if (curCol < indent) return;
      var firstTok = firstToken(row.slice(indent));
      if (!wrapPend.word || firstTok.indexOf(wrapPend.word) !== 0) return;
      pull = true; atLen = prevTrim + 1 + wrapPend.word.length;
    }
    // A wrap column below a third of the terminal is not a line edge we should
    // ever predict against (a narrow inner box, a garbled read): stay unlearned
    // and keep riding such wraps by echo.
    if (atLen < Math.max(16, Math.floor(term.cols / 3)) || atLen > term.cols) return;
    wrapStyle = { atLen: atLen, indent: pull ? indent : 0, pull: pull,
                  down: pull && delta === 1, flipped: false };
    wrapPend = null;
  }
  function firstToken(s) {
    var sp = s.indexOf(' ');
    return sp === -1 ? s : s.slice(0, sp);
  }

  // ── Cross-row modeling ────────────────────────────────────────────────────
  // The burst models one row, but the line under it may span several: a hard-
  // wrapped zsh command, a word-wrapped composer draft. These helpers encode the
  // measured row-hop rules of both editors, so cursor work crosses row seams
  // optimistically instead of riding the echo.

  // The pane app's own prompt prefix \u2014 the chrome before the input on the buffer's first
  // row. It is what identifies that row while navigating a multi-row draft, and it is
  // LEARNED per app and cached beside the wrap style, for the same reason: it is a fact
  // about the application editing the line, so it lives and dies with it. The TUI table's
  // `prompt` seeds it only so an app's very first line is instant; delete the seed and it
  // converges on its own like any other app. null = unknown, and floors then rest on the inputLen proof
  // alone, which is where every shell stays.
  function appPrompt() { return promptStr; }

  // Only composer chrome may be learned: a symbol or two and a separator. A shell's prompt
  // carries a path, a branch, an exit status \u2014 letters and digits \u2014 and it is rewritten
  // between lines, so taking it for a structural edge would claim a boundary that moves.
  // This is also what makes learning self-guarding: if the app has not repainted yet when
  // the burst opens, the row still holds the previous line's words and is refused.
  function promptShaped(p) { return p.length > 0 && p.length <= 4 && /\S/.test(p) && !/[0-9A-Za-z]/.test(p); }

  // Learned on the first keystroke where the cursor column provably IS the input start, so
  // everything left of it is the prompt. Two ways to know that, and an app entered mid
  // session needs the second: the line began at a fresh prompt (lineFresh), or the draft is
  // simply empty. Without one of them the cursor could sit at the end of existing text and
  // the "prompt" would be that text — inputLen alone does not rule it out, because a
  // handoff resets the count while the draft stays on screen.
  function learnPrompt(line, row, col) {
    if (promptStr !== null || inputLen !== 0 || col <= 0) return;
    if (!lineFresh && !draftEmpty(line, col)) return;
    var p = row.slice(0, col);
    if (promptShaped(p)) promptStr = p;
  }

  // Whether nothing the USER has typed sits right of the cursor. An app's placeholder does
  // sit there — codex opens on a dim `Run /review on my current changes`, Claude Code on
  // `Try "…"` — but a placeholder is chrome, drawn dimmed or in an explicit colour, which is
  // the same declaration the ghost cover keys on. Without this an app that greets you with
  // one could not be read until after its first submit.
  function draftEmpty(line, col) {
    var c = null, ch;
    for (var x = col; line && x < term.cols; x++) {
      c = line.getCell(x, c || undefined);
      if (!c) break;
      ch = c.getChars();
      if (ch === '' || ch === ' ') continue;
      return c.isDim() || !c.isFgDefault();
    }
    return true;
  }

  // A separator cell is U+00A0 in Claude Code's live composer and U+0020 in its plain
  // redraws, so a space matches either way round.
  function spaceish(c) { return c === 0x20 || c === 0xa0; }
  function rowIsPrompt(row) {
    if (promptStr === null || row.length < promptStr.length) return false;
    for (var i = 0; i < promptStr.length; i++) {
      var a = row.charCodeAt(i), b = promptStr.charCodeAt(i);
      if (a !== b && !(spaceish(a) && spaceish(b))) return false;
    }
    return true;
  }
  // The structural left edge of `row`: its first editable column, when the row's
  // shape proves one — the known prompt row, or a word-wrap continuation at the
  // learned indent. null when the shape says nothing (every zsh row: its prompt
  // is arbitrary and its continuations start at column 0).
  function rowEdge(row) {
    if (rowIsPrompt(row)) return appPrompt().length;
    if (wrapStyle && wrapStyle.pull) {
      var ind = row.search(/\S/);
      if (ind === wrapStyle.indent) return ind;
    }
    return null;
  }

  // A full-width horizontal rule — the composer draws one above and one below its
  // input, and they are the only rows of that shape adjacent to it. Every cell the
  // same box-drawing glyph, spanning most of the row (a tmux pane narrower than the
  // terminal still counts: its rules are as wide as the pane).
  function isRule(row) {
    if (!row) return false;
    var t = row.replace(/ +$/, ''), c0 = t.charCodeAt(0), i;
    if (t.length < 20 || t.length < term.cols / 2) return false;
    if (c0 < 0x2500 || c0 > 0x257f) return false;
    for (i = 1; i < t.length; i++) if (t.charCodeAt(i) !== c0) return false;
    return true;
  }

  // The composer rows a predicted wrap MOVES, and by how much. Growing upward (the
  // norm — the box is pinned to the bottom of the screen) everything from the top
  // rule down to the row above the cursor rises one row, and the pre-wrap row's own
  // text minus the word that just moved down (`kept`) lands directly above the
  // cursor row. Growing downward — only when nothing is left above — the bottom rule
  // and the hint under it fall one row instead, the hint clipping off-screen. Either
  // way the cursor row's own new content is the burst's job, not the frame's. null
  // when the box is not shaped the way we expect: then nothing is painted and the
  // wrap simply looks like it did before.
  function wrapFrame(row, up, kept) {
    var b = term.buffer.active, i, r;
    if (up) {
      for (i = 1; i <= 16; i++) {                     // the composer caps at 14 input rows
        r = row - i;
        if (r - b.baseY < 0) return null;
        if (!isRule(fullRow(r))) continue;
        if (r - 1 - b.baseY < 0) return null;         // no room above to rise into
        return { from: r, to: row - 1, delta: -1, text: kept, textRow: row - 1,
                 wipeRow: -1, was: fullRow(r), at: performance.now() };
      }
      return null;
    }
    if (!isRule(fullRow(row + 1))) return null;       // the bottom rule is not below us
    var end = row + 1;                                // the rule, plus the hint rows under it
    for (i = 2; i <= 4; i++) {
      r = row + i;
      if (r - b.baseY >= term.rows || !(fullRow(r) || '').trim()) break;
      end = r;
    }
    return { from: row + 1, to: end, delta: 1, text: null, textRow: -1,
             wipeRow: row + 1, was: fullRow(row + 1), at: performance.now() };
  }

  // Whether the burst's row provably continues on the row above/below, and the
  // landing of one cursor step across that seam. Measured: zsh's evidence going
  // up is the input reaching back past column 0 (floor clamped to 0) under a
  // FULL row — landing ON its last character; going down, the full row itself is
  // the evidence and the landing is the next row's column 0. The composer's
  // evidence is shape: continuation rows sit at the learned indent, the seam
  // holds the wrap's eaten space, so leftward lands at the previous row's
  // content end and rightward at the next row's indent. sep is the one character
  // a scan consumes crossing the seam (null = the rows are butt-joined).
  function crossUpInfo() {
    var b = term.buffer.active, up = predicted.absRow - 1;
    if (up - b.baseY < 0) return null;
    var row = predicted.line + predicted.tail;
    var prev = fullRow(up);
    if (prev === null) return null;
    var prevTrim = prev.replace(/ +$/, '').length;
    if (wrapStyle && wrapStyle.pull) {
      if (rowIsPrompt(row)) return null;                  // the buffer starts on this row
      if (rowEdge(row) !== wrapStyle.indent) return null; // not a continuation row
      if (isRule(prev)) return null;                      // the box's top rule: so does this
      if (rowEdge(prev) === null) return null;            // the row above is outside the block
      return { row: up, col: Math.min(prevTrim, term.cols - 1), sep: ' ' };
    }
    if (predicted.floor === 0 && prevTrim === term.cols) {
      return { row: up, col: term.cols - 1, sep: prev[term.cols - 1] };
    }
    return null;
  }
  function crossDownInfo() {
    var b = term.buffer.active, dn = predicted.absRow + 1;
    if (dn - b.baseY >= term.rows) return null;
    var next = fullRow(dn);
    if (next === null) return null;
    if (wrapStyle && wrapStyle.pull) {
      var e = rowEdge(next);
      if (e === null || rowIsPrompt(next)) return null;   // the row below is not a continuation
      if (!isWord(next[e])) return null;                  // shape guard: status furniture leads with symbols
      return { row: dn, col: e, sep: ' ' };
    }
    if ((predicted.line + predicted.tail).replace(/ +$/, '').length === term.cols) {
      return { row: dn, col: 0, sep: null };
    }
    return null;
  }

  // Rebase the burst onto another row of the same logical line, cursor at col.
  // offGrid: the burst now deliberately sits off the grid cursor's row until the
  // move's echo lands (render paints there; burstDisplaced exempts it).
  function rebaseTo(r, col) {
    var row = fullRow(r) || repeatSp(term.cols);
    predicted.absRow = r;
    predicted.line = row.slice(0, col);
    predicted.tail = row.slice(col);
    var e = rowEdge(row);
    predicted.floor = e !== null ? e : 0;
    predicted.proven = false;
    predicted.offGrid = true;
    predicted.walked = true; // both halves came straight off the grid; nothing to re-read
  }

  // Where a leftward scan may reach on this row: a proven floor is exact; a
  // structurally shaped row (composer) stops at its edge; otherwise (zsh,
  // unproven) the scan runs to column 0 and the seam logic decides there — a
  // prompt's symbols end every word scan naturally, so recalled-line word
  // navigation stays optimistic without knowing where the input starts.
  function moveStop() {
    if (predicted.proven) return predicted.floor;
    var e = rowEdge(predicted.line + predicted.tail);
    return e !== null ? e : 0;
  }

  function commitLeft(i) {
    predicted.tail = predicted.line.slice(i) + predicted.tail;
    predicted.line = predicted.line.slice(0, i);
  }
  function commitRight(n) {
    predicted.line += predicted.tail.slice(0, n);
    predicted.tail = predicted.tail.slice(n);
    predicted.walked = true; // over standing content, not over anything we inserted
  }

  // One leftward cursor step, plain or word, hopping row seams as the measured
  // editors do. Returns 1 = moved, 0 = a true boundary (the pane refuses too),
  // -1 = handed off (an unknowable crossing).
  function stepLeft(byWord) {
    var inWord = false, hops = 0;
    for (;;) {
      var stop = moveStop(), i = predicted.line.length;
      if (!byWord) {
        if (i > stop) { commitLeft(i - 1); return 1; }
      } else {
        var landed = false;
        while (i > stop) {
          var c = predicted.line[i - 1];
          if (isWord(c)) { inWord = true; i--; }
          else if (inWord) { landed = true; break; }
          else i--;
        }
        if (landed) { commitLeft(i); return 1; }
      }
      if (predicted.proven) {
        if (byWord) commitLeft(stop);
        return 0; // the input's proven start: the pane refuses to go further
      }
      var x = crossUpInfo();
      if (!x) {
        if (rowIsPrompt(predicted.line + predicted.tail)) { // the buffer's start: the pane refuses too
          if (byWord) commitLeft(stop);
          return 0;
        }
        handoff('nav'); return -1;
      }
      if (++hops > 4) { handoff('nav'); return -1; }
      if (byWord && inWord && !isWord(x.sep)) { commitLeft(stop); return 1; } // the word truly starts here
      if (isWord(x.sep)) inWord = true;
      rebaseTo(x.row, x.col);
      if (!byWord) return 1; // the crossing consumed the seam: that IS the step
    }
  }

  // One rightward cursor step. Same contract as stepLeft. zsh forward-word goes
  // past the current word, then the separators, landing at the NEXT word's start
  // (measured); walking off a full row's end lands at the next row's column 0.
  function stepRight(byWord) {
    var phase = 0, hops = 0, moved = false; // 0: leaving the current word, 1: crossing separators
    for (;;) {
      var tail = predicted.tail;
      var max = (predicted.line + tail).replace(/ +$/, '').length - predicted.line.length;
      if (!byWord) {
        if (max > 0) { commitRight(1); moved = true; }
      } else {
        var j = 0;
        while (j < max) {
          var c = tail[j];
          if (phase === 0 && !isWord(c)) phase = 1;
          if (phase === 1 && isWord(c)) break;
          j++;
        }
        if (j > 0) { commitRight(j); moved = true; }
        if (j < max) return 1; // landed on the next word's first character
      }
      // This row's known content is exhausted, or a full row was walked off its
      // end: the seam decides.
      if (predicted.line.length >= term.cols) {
        var xf = crossDownInfo();
        if (!xf || ++hops > 4) { handoff('nav'); return -1; }
        rebaseTo(xf.row, xf.col);
        if (!byWord) return 1;
        continue;
      }
      if (!byWord && moved) return 1;
      var x = crossDownInfo();
      if (!x) return moved ? 1 : 0; // a true end: land here (the pane parks at the buffer end) or refuse
      if (++hops > 4) { handoff('nav'); return -1; }
      if (byWord && phase === 0) phase = 1; // the seam's eaten space ends the current word
      rebaseTo(x.row, x.col);
      if (!byWord) return 1; // the crossing consumed the seam: that IS the step
    }
  }

  // Cursor navigation, char (arrows) or word (Option/Ctrl+Arrow): pure movement,
  // content unchanged — chars shuttle between the end of `line` and the front of
  // `tail` so the whole-line match and the renderer keep working unmodified, and
  // row seams are crossed by rebasing the burst (the measured rules above). A
  // move the pane resolves differently (an autosuggest accept) mismatches and
  // converges to the echo like any other mispredict.
  function predictMove(dir, times, byWord) {
    if (burstDisplaced()) { handoff('heavy'); return; }
    if (!predicted && !startBurst()) return;
    for (var t = 0; t < times; t++) {
      var r = dir < 0 ? stepLeft(byWord) : stepRight(byWord);
      if (r < 0) return;  // handed off: the echo owns the rest of the chunk
      if (r === 0) break; // a true boundary: the pane refuses too
    }
    predicted.sampled = false; predicted.mismatched = false;
    touchEdit(); render();
  }

  // Home (⌘←, Ctrl-A, the Home key): the buffer's start. A proven floor is
  // exact — shuttle everything left of the cursor into the tail. Unproven but
  // shaped (a composer block): the start is the prompt row's edge — walk the
  // continuation rows up to it. Otherwise hand off and let the echo land it.
  function predictHome() {
    if (burstDisplaced()) { handoff('heavy'); return; }
    if (!predicted && !startBurst()) return;
    var landed = false;
    if (predicted.proven) {
      commitLeft(predicted.floor);
      landed = true;
    } else {
      var row = predicted.line + predicted.tail;
      if (rowIsPrompt(row)) { commitLeft(appPrompt().length); landed = true; }
      else if (wrapStyle && wrapStyle.pull && rowEdge(row) === wrapStyle.indent) {
        // Walk the continuation rows up to the prompt row. The shape guards below do
        // the real work — every row has to sit at the learned indent — so the row
        // count is only how far back optimism is worth attempting. Deliberately
        // shorter than the composer's 14-row cap: past a handful of rows a draft is
        // being edited, not typed, and failing here costs nothing (the walk hands
        // off and Home rides the echo, correct but not instant) whereas guessing
        // wrong up there paints a cursor into the middle of someone's paragraph.
        var b = term.buffer.active;
        for (var r = predicted.absRow - 1; r - b.baseY >= 0 && predicted.absRow - r <= 6; r--) {
          var rw = fullRow(r);
          if (rw === null) break;
          if (rowIsPrompt(rw)) { rebaseTo(r, appPrompt().length); landed = true; break; }
          if (isRule(rw)) break;                          // the box's own top edge
          if (rowEdge(rw) !== wrapStyle.indent) break;
        }
      }
    }
    if (!landed) { handoff('nav'); return; }
    predicted.sampled = false; predicted.mismatched = false;
    touchEdit(); render();
  }

  // End (⌘→, Ctrl-E, the End key): walk right to the end of the known content,
  // crossing wrap seams so a multi-row line lands at its true end. One step is one
  // column, so the count has to cover the longest line that can exist on screen —
  // the whole viewport. It is a runaway guard, not a budget: stepRight reports the
  // true end and predictMove stops there, so the bound is never what ends the walk.
  // (A tighter multiple of cols instead parks the cursor mid-line on any longer
  // draft, and the echo then snaps it to the real end — measured at cols*4: on a
  // 66-column terminal a 464-character line predicted row 17 and echoed row 20.
  // That snap is the stutter this engine exists to remove.)
  function predictEnd() {
    predictMove(1, term.rows * term.cols, false);
  }

  // Kill the line left of the cursor (⌘⌫, Ctrl-U). zsh's ^U kills the whole
  // line and Claude Code's kills to the input start; both leave the cursor at
  // the input start with the prefix intact, which is what the whole-line prefix
  // match reconciles on, so one prediction serves both. The tail drops to
  // blanks — the zsh outcome; a composer shifting the remainder left instead
  // converges via the tail refresh at match. The kill stops at a proven floor,
  // or at the shaped prompt edge of a composer draft row (everything right of
  // it is draft text by construction).
  function predictKillLeft() {
    if (burstDisplaced()) { handoff('heavy'); return; }
    if (!predicted && !startBurst()) return;
    var row = predicted.line + predicted.tail;
    var stop = -1;
    if (predicted.proven) stop = predicted.floor;
    else { var e = rowEdge(row); if (e !== null) stop = e; } // the composer kills to the VISUAL row's start (measured)
    if (stop < 0) { handoff('nav'); return; }
    var k = predicted.line.length - stop;
    if (predicted.proven) k = Math.min(k, inputLen);
    if (k <= 0) {
      if (predicted.proven || rowIsPrompt(row)) { touchEdit(); return; } // the buffer's start: the pane refuses too
      handoff('nav'); return; // a continuation's start: the kill takes the PREVIOUS row (measured) — ride
    }
    predicted.line = predicted.line.slice(0, predicted.line.length - k);
    predicted.tail = repeatSp(term.cols - predicted.line.length);
    predicted.dirty = true;
    predicted.sampled = false; predicted.mismatched = false;
    inputLen = Math.max(0, inputLen - k);
    touchEdit(); render();
  }
  function repeatSp(n) { return new Array(Math.max(0, n) + 1).join(' '); }

  // A delete on a wrap-continuation row can make the remaining content fit back
  // onto the row above; a word-wrapping composer then reflows the block
  // immediately and the cursor row rewrites wholesale — those ride the echo.
  // zsh's hard-wrapped row above is always full, so its continuation deletes
  // stay fully optimistic.
  function reflowRisk(k) {
    var row = predicted.line + predicted.tail;
    var pull = wrapStyle && wrapStyle.pull;
    if (pull ? rowEdge(row) !== wrapStyle.indent : predicted.floor > 0) return false;
    var b = term.buffer.active;
    if (predicted.absRow - b.baseY < 1) return true;
    var prev = fullRow(predicted.absRow - 1);
    if (prev === null) return true;
    var indent = pull ? wrapStyle.indent : 0;
    var content = row.replace(/ +$/, '').length - indent;
    var limit = pull ? wrapStyle.atLen : term.cols;
    return prev.replace(/ +$/, '').length + 1 + (content - k) <= limit;
  }

  function predictBackspace() {
    if (burstDisplaced()) { handoff('heavy'); return; }
    // Only the user's OWN input may be deleted optimistically — never the
    // prompt or command output. Proof is the typed-char count (inputLen), or
    // the row's structural shape: everything right of a composer row's edge is
    // draft text by construction. Checked BEFORE any burst opens: an op that
    // predicts nothing must leave nothing behind.
    var b0 = term.buffer.active;
    var rowNow = predicted ? predicted.line + predicted.tail : (fullRow(b0.baseY + b0.cursorY) || '');
    if (inputLen <= 0 && rowEdge(rowNow) === null) return;
    if (!predicted && !startBurst()) return;
    var row = predicted.line + predicted.tail;
    var edgeCol = rowEdge(row);
    var stop = edgeCol !== null ? edgeCol : predicted.floor;
    if (predicted.line.length <= stop) {
      // The row's left boundary. A proven floor and the composer's prompt edge
      // are the input's true start: the pane refuses too — claim the no-op. A
      // composer continuation boundary reflows the block wholesale — ride. A
      // zsh continuation deletes the previous row's last character and shifts
      // the remainder left one (measured): rebase up and model exactly that.
      if (predicted.proven || (edgeCol !== null && rowIsPrompt(row))) { touchEdit(); return; } // a claimed no-op still ticks
      var x = crossUpInfo();
      if (!x || (wrapStyle && wrapStyle.pull)) { handoff('nav'); return; }
      var rem = predicted.tail.replace(/ +$/, '');
      rebaseTo(x.row, x.col);
      predicted.tail = (rem + repeatSp(term.cols)).slice(0, term.cols - predicted.line.length);
      predicted.dirty = true;
      predicted.sampled = false; predicted.mismatched = false;
      if (inputLen > 0) inputLen--;
      touchEdit(); render();
      return;
    }
    if (reflowRisk(1)) { handoff('nav'); return; }
    predicted.line = predicted.line.slice(0, -1);
    predicted.dirty = true;
    predicted.sampled = false; predicted.mismatched = false;
    if (inputLen > 0) inputLen--;
    touchEdit(); render();
  }

  // One backward-kill-word (Option+Backspace, Ctrl-W): separators, then the
  // alphanumeric run — the rule zsh (WORDCHARS='') and the composer share. The
  // scan mirrors stepLeft, hopping zsh wrap seams (the killed span may end on
  // the row above, where the remainder then shifts in — measured); a composer
  // boundary kill reflows the whole block, so it rides. The kill is clamped to
  // the user's own input, or to the row's structural shape.
  function predictWordBackspace() {
    if (burstDisplaced()) { handoff('heavy'); return; }
    var b0 = term.buffer.active;
    var rowNow = predicted ? predicted.line + predicted.tail : (fullRow(b0.baseY + b0.cursorY) || '');
    if (inputLen <= 0 && rowEdge(rowNow) === null) return;
    if (!predicted && !startBurst()) return;
    var row = predicted.line + predicted.tail;
    var edgeCol = rowEdge(row);
    var rem = predicted.tail.replace(/ +$/, '');
    var inWord = false, k = 0, hops = 0, landed = false;
    while (!landed) {
      var stop = moveStop(), i = predicted.line.length;
      while (i > stop) {
        var c = predicted.line[i - 1];
        if (isWord(c)) { inWord = true; i--; k++; }
        else if (inWord) { landed = true; break; }
        else { i--; k++; }
      }
      commitLeft(i);
      if (landed || predicted.proven) break;
      var x = crossUpInfo();
      if (!x) {
        // No seam: the span is bounded by what we can see. An empty span on an
        // unshaped, unproven row has no landing we can claim — ride it.
        if (k === 0 && edgeCol === null && !predicted.proven) { handoff('nav'); return; }
        break;
      }
      if (wrapStyle && wrapStyle.pull) { handoff('nav'); return; } // composer boundary kill reflows: ride
      if (inWord && !isWord(x.sep)) break; // the word starts at this row's start
      if (++hops > 4) { handoff('nav'); return; }
      if (isWord(x.sep)) inWord = true;
      k++; // the seam character is part of the killed span
      rebaseTo(x.row, x.col);
    }
    if (k <= 0) {
      if (predicted.proven || edgeCol !== null) { touchEdit(); return; } // at the start: the pane refuses too
      handoff('nav'); return;
    }
    if (edgeCol === null && k > inputLen) { handoff('nav'); return; } // the span outruns what is provably input
    if (reflowRisk(k)) { handoff('nav'); return; }
    // The content right of the original cursor shifts in behind the new one.
    predicted.tail = (rem + repeatSp(term.cols)).slice(0, term.cols - predicted.line.length);
    predicted.dirty = true;
    predicted.sampled = false; predicted.mismatched = false;
    inputLen = Math.max(0, inputLen - k);
    touchEdit(); render();
  }

  // Vertical cursor movement (Up/Down). Inside a shaped composer block the
  // cursor keeps its visual column: Up onto the row above when the column
  // exists there, else to the START of the current row; Down clamps to the
  // target row's end, and refuses on the last block row (all measured). Up from
  // the prompt row is history recall — a wholesale box swap we never predict —
  // and zsh's Up/Down are prefix-searches whose outcome depends on history we
  // cannot see: both ride the echo.
  function predictVert(dir, times) {
    if (burstDisplaced()) { handoff('heavy'); return; }
    if (!predicted && !startBurst()) return;
    var pull = wrapStyle && wrapStyle.pull;
    if (!pull) { handoff('nav'); return; }
    var b = term.buffer.active;
    for (var t = 0; t < times; t++) {
      var row = predicted.line + predicted.tail;
      if (dir < 0) {
        if (rowEdge(row) !== wrapStyle.indent || rowIsPrompt(row)) { handoff('heavy'); return; } // history recall
        var up = predicted.absRow - 1;
        var prev = up - b.baseY >= 0 ? fullRow(up) : null;
        if (prev === null || rowEdge(prev) === null) { handoff('heavy'); return; }
        var col = predicted.line.length;
        if (col <= prev.replace(/ +$/, '').length) rebaseTo(up, col);
        else commitLeft(wrapStyle.indent); // an unfittable column goes to the current row's start (measured)
      } else {
        var x = crossDownInfo();
        if (!x) break; // the last block row: the composer refuses (measured)
        var next = fullRow(x.row) || '';
        rebaseTo(x.row, Math.max(x.col, Math.min(predicted.line.length, next.replace(/ +$/, '').length)));
      }
    }
    predicted.sampled = false; predicted.mismatched = false;
    touchEdit(); render();
  }

  // The next char would cross the pane's wrap column. With a learned wrapStyle the
  // wrap itself is predicted; without one (the first wrap of a pane, an unbreakable
  // word, the bottom row) it rides the echo via wrapRide, whose observed outcome
  // teaches the style so every later wrap paints instantly.
  function wrapStep(ch) {
    var b = term.buffer.active;
    // Where this wrap came FROM: the row it leaves and the column it wraps at. reconcile
    // needs both to tell "the pane has not got here yet" from "the pane went somewhere
    // else" — see wrapUnresolved. Recorded before either branch rewrites them, and
    // harmless on the paths below that ride instead.
    predicted.wrapRow = predicted.absRow;
    predicted.wrapCol = predicted.line.length;
    if (wrapStyle && wrapStyle.pull) {
      var indent = wrapStyle.indent, word = '', restWord = '';
      if (ch !== ' ') {
        word = lastToken(predicted.line, predicted.floor);
        restWord = (predicted.tail.match(/^[^ ]*/) || [''])[0].replace(/ +$/, '');
        // An EMPTY word is still exact: the line ends in a space, so the next word
        // starts right at the edge and — measured — the composer drops the overflow
        // char alone onto the continuation. Only a word too long to fit its own
        // continuation row rides.
        if (indent + word.length + 1 + restWord.length > wrapStyle.atLen) { wrapRide(); return; }
      }
      // A word-wrapping composer (Claude Code): the last word — with the typed
      // char, and any part of it right of a mid-word cursor — moves to a
      // continuation row at the indent; a space at the edge opens an EMPTY
      // continuation instead: nothing moves and the space itself is invisible
      // (measured). WHERE the continuation lands is the box's growth direction:
      // UPWARD at a full screen — the box repaints one row higher without
      // scrolling, the cursor's absolute row unchanged, the continuation
      // replacing the pre-wrap content on that very row — or DOWNWARD into
      // blank screen (the cursor drops to absRow+1). Probe-measured both ways.
      // The direction is NOT reliably visible in the grid (dead viewport rows
      // below a smaller tmux pane look exactly like composer space), so the
      // style carries it: seeded upward (the full-screen norm), corrected by
      // observation — a ridden wrap teaches it, a mispredicted one flips it.
      var nl = repeatSp(indent) + word + (ch === ' ' ? '' : ch);
      if (wrapStyle.down) {
        var nr = predicted.absRow + 1;
        if (nr - b.baseY >= term.rows) { wrapRide(); return; }
        // The box grows over its own bottom rule: the rule (and the hint under it)
        // move down a row, so paint them there rather than leaving a hole punched
        // in the border for a round trip.
        boxShift = wrapFrame(predicted.absRow, false, null);
        if (word) {
          // The burst leaves this row, so the moved word's old cells need an
          // explicit cover until the repaint erases them.
          edge = { absRow: predicted.absRow, col: predicted.line.length - word.length,
                   text: repeatSp(word.length), was: word, at: performance.now() };
        }
        predicted.absRow = nr;
        predicted.offGrid = true;
      } else {
        // The box grows upward: the top rule and the earlier input rows rise one
        // row, and this row's kept text rises with them onto the row above.
        boxShift = wrapFrame(predicted.absRow, true,
                             predicted.line.slice(0, predicted.line.length - word.length));
      }
      // (Upward growth covers the old row via the tail diff on the same row.)
      predicted.line = nl;
      predicted.floor = indent;
      predicted.tail = (restWord + repeatSp(term.cols)).slice(0, term.cols - nl.length);
    } else if (wrapStyle) {
      var nr2 = predicted.absRow + 1;
      if (nr2 - b.baseY >= term.rows) { wrapRide(); return; } // bottom row: never predict the scroll
      // A hard wrap (zsh): the edge char fills the pre-wrap row's next column —
      // kept painted via `edge` until its echo lands — and the cursor drops to
      // column 0 of the next row, whose current content becomes the new tail.
      // Nothing moves: a shell has no box around its input.
      boxShift = null;
      edge = { absRow: predicted.absRow, col: predicted.line.length, text: ch, was: ' ', at: performance.now() };
      var row = fullRow(nr2);
      predicted.absRow = nr2;
      predicted.line = ''; // the continuation starts empty; ch itself lives in `edge` on the old row
      predicted.tail = row !== null ? row : repeatSp(term.cols);
      predicted.floor = 0;
      predicted.offGrid = true;
    } else { wrapRide(); return; }
    predicted.proven = false;
    predicted.wrapped = true;
    // The wrap's own convergence clock: typing keeps refreshing the ordinary
    // deadline (lastEditAt), so a MISpredicted wrap would otherwise absorb
    // keystrokes onto a phantom row for as long as the user keeps typing.
    // reconcile clears this on the first match; expiry = wrap never converged.
    predicted.wrapAt = performance.now();
    predicted.dirty = true;
    predicted.sampled = false; predicted.mismatched = false;
    inputLen++;
  }
  function wrapRide() {
    // The pend's column anchor is the MODEL's edge, not the grid cursor: the grid
    // may already show the post-wrap position (a stale style rides late), and any
    // resting cursor LEFT of the model edge is wrap evidence either way.
    wrapPend = { row: predicted.absRow, col: predicted.line.length, at: performance.now(),
                 word: lastToken(predicted.line, predicted.floor) };
    handoff('heavy');
    armWrapLearn();
  }

  // learnWrap needs a QUIET wire (a settled grid), and reconcile only runs inside
  // write callbacks — the one place the wire is never quiet. This timer keeps
  // probing between frames until the pend learns or expires.
  var wrapLearnTimer = 0;
  function armWrapLearn() {
    if (wrapLearnTimer) clearTimeout(wrapLearnTimer);
    wrapLearnTimer = setTimeout(function () {
      wrapLearnTimer = 0;
      learnWrap();
      if (wrapPend) armWrapLearn();
    }, 90);
  }

  // Enter is CR; a newline INSIDE a draft is not. Three forms, none of which needs to know
  // which application is running:
  //   * a bare LF with no CR — Ctrl-J, which is what pi inserts a line with
  //   * ESC CR — Option/Alt+Enter
  //   * a bracketed paste, whose CRs are content: xterm rewrites every newline in a
  //     paste to CR and wraps the lot in ESC[200~ … ESC[201~, and a shell or composer
  //     that asked for bracketed paste inserts those newlines instead of running them
  //   * a trailing backslash the model is already holding, then Enter
  // The asymmetry is deliberate. Mistaking a submit for a soft newline only costs the next
  // line its proven floor, so boundary refusals ride the echo for one line. Mistaking a soft
  // newline for a submit proves a floor at the wrong column, and then a backspace at the
  // start of the new row is claimed as a no-op the pane does not perform — a visible
  // mispredict. So anything ambiguous is treated as soft.
  function softNewline(d) {
    if (d.indexOf('\r') === -1) return true;
    if (d.indexOf('\x1b[200~') !== -1) return true;
    if (/\x1b[\r\n]/.test(d)) return true;
    var b = term.buffer.active;
    var row = predicted ? predicted.line : (fullRow(b.baseY + b.cursorY) || '').slice(0, b.cursorX);
    return row.slice(-1) === '\\';
  }

  function predict(d) {
    if (!echoEnabled) return;                                     // opt-in via ?echo=1; off by default
    // A newline (Enter, or a multi-line paste) submits the line: disarm instantly —
    // covering the round trip before the server's grace-driven "unsafe" frame — and
    // close the input boundary. The burst itself is KEPT: dropping it would un-paint
    // keystrokes that were typed while safe and are already on screen (fast typing +
    // Enter made the line's tail vanish until its echo landed), and keeping it paints
    // nothing new — while disarmed, nothing can enter the burst. Echo frames outrun
    // the gate's unsafe frame on the same ordered socket, so the line has normally
    // converged (overlay invisible) before setSafe(false) clears it. The NEXT line
    // starts at a fresh prompt, which is what proves the floor (lineFresh).
    // localDisarm only latches if we were actually armed: disarming a pane the server
    // already calls unsafe would leave us waiting for an "unsafe" frame that the
    // change-only feed has no reason to send, and predictions would never come back.
    if (d.indexOf('\r') !== -1 || d.indexOf('\n') !== -1) {
      localDisarm = serverSafe; serverSafe = false;
      // A SOFT newline continues the same buffer: the composer grows a row and the draft
      // is still being edited. Claiming a fresh prompt there would prove a floor at the
      // wrong column, and a backspace at the start of the new row would be claimed as a
      // no-op when the pane actually deletes back into the row above. Two forms, both
      // recognisable without knowing the application: Option/Alt+Enter arrives as ESC CR,
      // and backslash-Enter is a literal backslash the model is already holding. (Shift+
      // Enter under the newer key protocols carries no CR at all, so it never reaches
      // here and falls to the ordinary heavy handoff below, which is already right.)
      if (softNewline(d)) { handoff('heavy'); return; }
      inputLen = 0; lineFresh = true; return;
    }
    if (!serverSafe) return;                                      // the sole safety gate
    // Mid-transition (a handoff's hold, or a draining burst): the pane is between
    // states we cannot bind to — everything rides the echo until the cursor speaks.
    if (holdActive() || (predicted && predicted.draining)) return;
    // One or more backspaces (OS key-repeat can coalesce them into a single chunk).
    if (/^[\x08\x7f]+$/.test(d)) { for (var k = 0; k < d.length; k++) predictBackspace(); return; }
    // One or more word deletes: Option+Backspace arrives as ESC DEL (or ESC BS with
    // Ctrl held), Ctrl-W as 0x17; key-repeat can coalesce several into one chunk.
    if (/^(?:\x17|\x1b[\x08\x7f])+$/.test(d)) {
      var times = d.match(/\x17|\x1b[\x08\x7f]/g).length;
      for (var w = 0; w < times; w++) predictWordBackspace();
      return;
    }
    // Cursor navigation. Arrows arrive as CSI (\x1b[D) or, under application cursor
    // mode (DECCKM, set by zle and most TUIs), SS3 (\x1bOD). Word jumps are the
    // ESC b / ESC f this page sends for Option/Alt+Arrow plus the CSI 1;5 forms
    // xterm emits for Ctrl+Arrow on Windows/Linux (oh-my-zsh binds both). Home/End
    // cover ⌘←/⌘→ (sent as ^A/^E below), the physical keys in both cursor modes,
    // and tmux's translated forms; ^U is ⌘⌫ and the literal Ctrl-U. Key-repeat can
    // coalesce a run into one chunk, so each arm counts its fixed-width tokens.
    if (/^(?:\x1b\[D|\x1bOD)+$/.test(d)) { predictMove(-1, d.length / 3, false); return; }
    if (/^(?:\x1b\[C|\x1bOC)+$/.test(d)) { predictMove(1, d.length / 3, false); return; }
    if (/^(?:\x1bb|\x1b\[1;5D)+$/.test(d)) { predictMove(-1, d.match(/\x1bb|\x1b\[1;5D/g).length, true); return; }
    if (/^(?:\x1bf|\x1b\[1;5C)+$/.test(d)) { predictMove(1, d.match(/\x1bf|\x1b\[1;5C/g).length, true); return; }
    if (/^(?:\x01|\x1b\[H|\x1bOH|\x1b\[1~)+$/.test(d)) { predictHome(); return; }
    if (/^(?:\x05|\x1b\[F|\x1bOF|\x1b\[4~)+$/.test(d)) { predictEnd(); return; }
    if (/^(?:\x1b\[A|\x1bOA)+$/.test(d)) { predictVert(-1, d.length / 3); return; }
    if (/^(?:\x1b\[B|\x1bOB)+$/.test(d)) { predictVert(1, d.length / 3); return; }
    if (/^\x15+$/.test(d)) { predictKillLeft(); return; }
    // One or more printable narrow chars — ASCII and accented Latin/Greek/Cyrillic
    // alike — each a plain insert at the end of the predicted line (fast input can
    // coalesce several keystrokes into one chunk).
    if (INSERT_RE.test(d)) {
      if (burstDisplaced()) { handoff('heavy'); return; } // row moved under the burst: ride until the echo settles
      if (!predicted && !startBurst()) return;
      var limit = wrapStyle ? wrapStyle.atLen : term.cols - RIDE_PAD;
      // Count into inputLen ONLY what is actually modelled — a char that rides the
      // echo must not inflate the count, or a later backspace could cover the
      // prompt. Under-counting is the safe direction.
      for (var c = 0; c < d.length; c++) {
        var content = (predicted.line + predicted.tail).replace(/ +$/, '').length;
        if (content > predicted.line.length) {
          // Mid-line typing. In a word-pulling composer only the row's LAST
          // word ever moves down on overflow (measured), so the cursor's prefix
          // append stays exact — unless the cursor sits inside that last word,
          // in which case the word (cursor included) jumps to the continuation,
          // which wrapStep models. A hard wrap's mid-line overflow shifts
          // unknown content across the seam: ride it.
          var pull = wrapStyle && wrapStyle.pull;
          var inLast = pull && predicted.tail.replace(/ +$/, '').indexOf(' ') === -1;
          if (content >= limit && (!pull || (inLast ? false : predicted.line.length >= limit))) { handoff('nav'); return; }
          if (content >= limit && inLast) {
            wrapStep(d[c]);
            if (!predicted || predicted.draining) return;
            continue;
          }
        } else if (predicted.line.length >= limit) {
          wrapStep(d[c]);
          if (!predicted || predicted.draining) return; // wrap rode the echo; so does the rest of the chunk
          continue;
        }
        predicted.line += d[c];
        predicted.dirty = true;
        inputLen++;
      }
      predicted.sampled = false; predicted.mismatched = false;
      touchEdit(); render();
      return;
    }
    // Terminal REPORTS — focus in/out (CSI I/O), mouse tracking (SGR and legacy),
    // cursor-position and device-attribute responses — are the terminal talking,
    // not the user typing: they change no line state and must not break the
    // proven floor or open a hold (a click to focus would otherwise silently
    // downgrade every boundary claim on the line).
    if (/^(?:\x1b\[I|\x1b\[O|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[\d+;\d+R|\x1b\[\?\d+(?:;\d+)*[cu]|\x1b\[>\d+(?:;\d+)*c)+$/.test(d)) return;
    // Anything else — Tab, Esc, Ctrl-C/K, forward delete, IME, a bracketed paste,
    // any other ESC sequence — moves or rewrites the line in ways we do not model.
    // Hand off: paint already on screen keeps covering until its echo lands, the
    // input boundary is forgotten, and new bindings wait for the pane to settle.
    handoff('heavy');
  }

  // The grid is BEHIND the burst rather than at odds with it: the cursor rests on the
  // burst's own row, no further right than the model's end, and every column painted so
  // far holds what the model says it should. This is what a CORRECT prediction looks
  // like while the typist runs ahead of the echo. `match` cannot say this — it also
  // wants the cursor to have REACHED the model's end, which never happens for as long
  // as the keys keep coming — so anything that treats "not matched yet" as "wrong" is
  // really measuring how fast the user types.
  function echoTrails(curAbs, curCol, line) {
    return curAbs === predicted.absRow && curCol <= predicted.line.length && !!line &&
      line.translateToString(false, 0, curCol) === predicted.line.slice(0, curCol);
  }

  // The pane has not resolved a predicted wrap yet: its cursor is still filling the row
  // the wrap left, no further right than the column we said would wrap it. Its repaint is
  // simply still on the wire. That is not evidence of anything and must not spend the
  // wrap's patience — under load an application's wrap repaint can take longer than three
  // measured echoes, and judging it there condemns a correct prediction for being slow.
  // The grace ends the moment the pane types PAST that column: a pane that keeps filling
  // the row beyond where we said it would break is telling us the COLUMN was wrong, and
  // that is judged like any other mispredict.
  function wrapUnresolved(curAbs, curCol) {
    return curAbs === predicted.wrapRow && curCol <= predicted.wrapCol;
  }

  // Runs after each inbound chunk is fully parsed (and on the grace tick), when the
  // real grid and cursor hold tmux's truth. The burst is confirmed only when the row
  // up to the cursor equals the predicted line EXACTLY; intermediate echo states (a
  // char a later backspace removes, a coalesced erase+retype repaint) never match,
  // so they neither confirm nor kill anything — the overlay keeps covering them.
  function reconcile() {
    // The hard-wrap edge glyph lives until the grid paints it (or contradicts it).
    if (edge) {
      var eLine = term.buffer.active.getLine(edge.absRow);
      var eCell = eLine ? eLine.translateToString(false, edge.col, edge.col + edge.text.length) : '';
      if (eCell !== edge.was || performance.now() - edge.at > 2000) edge = null;
    }
    // The moved composer rows are in flight only while the wrap that moved them is —
    // AND only while the grid still shows the box where we found it. render() records
    // WHICH rows to clone at wrap time but reads their CONTENT at paint time, so once
    // the app's own repaint lands the box one row higher, `from` no longer holds the
    // rule: cloning it would stamp a duplicate input row over the real border (the
    // block is opaque, so the border simply vanishes). Retire on that evidence exactly
    // as the edge glyph does, and the overlay yields to a grid that is already correct.
    if (boxShift && (!predicted || !predicted.wrapAt || fullRow(boxShift.from) !== boxShift.was ||
                     performance.now() - boxShift.at > 2000)) boxShift = null;
    learnWrap(); // a wrap riding the echo teaches wrapStyle the moment its repaint lands
    if (!predicted) return;
    var b = term.buffer.active, curAbs = b.baseY + b.cursorY, curCol = b.cursorX;
    var line = b.getLine(curAbs);
    // `match` is the special case of echoTrails where the pane has walked all the way
    // to the end of the predicted line. Everything the engine used to hang on `match`
    // alone is really about the weaker fact, because the strong one is unreachable for
    // as long as the keys keep coming: a continuous run produced NO agreement at all,
    // and the model drifted from the pane for the whole of it.
    var trails = echoTrails(curAbs, curCol, line);
    var match = trails && curCol === predicted.line.length;
    // The deadline must outlast the WHOLE echo path — keystroke to application
    // repaint — which is not a network round trip: through a tunnel into a busy TUI
    // (Claude Code mid-render) that path is routinely hundreds of ms. Dropping a
    // burst before its echo returns un-paints the typed chars and repaints them
    // when the echo lands: exactly the flash this whole file exists to prevent. So
    // patience is generous until measured (800ms), then three measured echo times
    // floored at the cursor grace. Cost of over-patience is only how long a truly
    // diverging pane keeps a stale overlay; the gate covers anything secret.
    var now = performance.now(), deadline = rttEma ? Math.max(CURSOR_GRACE, rttEma * 3) : 800;
    // A draining burst (handed off) admits nothing and only waits: its paint stands
    // until the echo shows the pane acting — the cursor resting off the handoff spot
    // for more than one repaint transient — then server truth takes over seamlessly.
    if (predicted.draining) {
      if (match) { predicted = null; releaseCursor(); return; }
      // Content evidence releases instantly: the handed-off row's prefix changed,
      // so the pane's repaint has landed — dropping the paint in the same parse
      // callback means the swap happens before the next frame, with no stale
      // overlay ever visible over the rewritten row.
      var rowNow = (fullRow(predicted.drainRow) || '').slice(0, predicted.drainCol);
      if (rowNow !== predicted.drainBase) { predicted = null; releaseCursor(); return; }
      // Cursor evidence needs one repaint transient of persistence (a streaming
      // TUI parks the cursor elsewhere mid-chunk).
      if (curAbs !== predicted.drainRow || curCol !== predicted.drainCol) {
        if (!predicted.drainMissAt) predicted.drainMissAt = now;
        else if (now - predicted.drainMissAt > 60) { predicted = null; releaseCursor(); return; }
      } else predicted.drainMissAt = 0;
      if (now - lastEditAt > deadline) { wrapPend = null; resetPredictions(); }
      return;
    }
    // The pane is walking our line, so three things it alone can tell us are true now —
    // whether or not it has walked all the way to the end.
    if (trails) {
      // The cells right of the PANE's cursor are the truth about what sits right of
      // OURS: an insert carries that content along, it never rewrites it, so it can be
      // adopted whole even while the echo trails, sized to the room our own cursor
      // leaves. This is what retires a snapshot the app has already thrown away.
      // (Measured: Claude Code's `Try "…"` placeholder, taken when the burst opened and
      // deleted by the app on the very first keystroke, was still sitting in `tail` four
      // seconds of continuous typing later — because `match` never came. At the wrap
      // column the engine read it as content right of the cursor, judged the wrap
      // unmodellable and handed off, and the replacement burst then bound to a grid
      // eight keystrokes stale and silently lost them.) Skipped if wide glyphs
      // appeared there.
      //
      // What makes the read sound is WHY the two cursors differ. Characters we inserted
      // and the pane has not echoed put our cursor ahead by exactly the distance the
      // standing content is about to be pushed right, so reading from the PANE's cursor
      // and sizing to the room OURS leaves lands the tail exactly where it will end up.
      // A cursor that WALKED right over content that never moved opens the same gap and
      // means the opposite: the read would splice the walked-over characters into the
      // tail and push the row's last characters off the end. (Measured: Home, then a
      // 60-key Right run on a 120ms link — 61 of 81 samples had the model believing
      // `...echo alpha bravocho alpha bravo charlie...`, a row the pane never held.)
      // `walked` says which gap this is, and the pane catching up settles it.
      if (curCol === predicted.line.length) predicted.walked = false;
      if (!predicted.walked) {
        var keep = term.cols - predicted.line.length;
        var t = line.translateToString(false, curCol, curCol + keep);
        if (t.length === keep) predicted.tail = t;
      }
      // `matched` needs more than trailing, because trailing is VACUOUS the moment a
      // burst opens: the pane's cursor is still sitting where the burst was snapshotted
      // from, one keystroke behind, which satisfies echoTrails while proving nothing.
      // The evidence that the pane has RESPONDED — the only thing that says a placeholder
      // right of the cursor is gone and that dim text there is now an answer to this
      // input rather than something left over — is its cursor having moved off the
      // column the burst opened at.
      if (curCol !== predicted.openCol) predicted.matched = true;
      // The echo is on the burst's own row, so the deliberate off-row window is over.
      // Leaving the flag set would exempt this burst from burstDisplaced() for the rest
      // of its life, so output landing on the pane while the user keeps typing would no
      // longer hand off — and since one burst now survives a whole typing run, "the rest
      // of its life" is no longer a moment. echoTrails already requires the pane's
      // cursor to be on that row, which is the whole of the evidence a match had.
      predicted.offGrid = false;
    }
    // The wrap's patience is spent ONLY while the pane has both resolved the wrap and
    // resolved it somewhere else. Walking our line means it landed where we said;
    // wrapUnresolved means it has not landed at all yet. Neither is a reason to judge.
    if (predicted.wrapAt && (trails || wrapUnresolved(curAbs, curCol))) predicted.wrapAt = now;
    if (match) {
      predicted.missAt = 0;
      if (predicted.wrapAt) {
        predicted.wrapAt = 0; // the predicted wrap converged: the style is confirmed
        boxShift = null;      // the grid holds the moved rows now — drop ours in the
                              // same parse callback, so no frame ever shows both
        if (wrapStyle) wrapStyle.flipped = false; // direction proven; future flips re-allowed
      }
      // Sample the echo time only on a mismatch→match transition: a burst whose grid
      // never diverged (a type-then-erase back to the start) matched before any echo
      // landed, and its sample would drag the average toward zero. The average also
      // jumps UP to a slow sample instantly and decays slowly, tracking the envelope
      // of echo latency rather than its mean — patience is cheap, impatience flashes.
      if (!predicted.sampled && predicted.mismatched) {
        predicted.sampled = true;
        var e = now - lastEditAt;
        rttEma = e > rttEma ? e : rttEma * 0.8 + e * 0.2;
      }
      // Hold the burst even though it matches: a type-then-erase pair makes the grid
      // match BEFORE the doomed char's echo arrives, and the held cover is what
      // hides that transient when it lands. Nothing is drawn wrongly meanwhile — at
      // zero divergence the overlay is invisible.
      if (now - lastEditAt >= deadline) predicted = null;
    } else {
      predicted.mismatched = true;
      if (!predicted.missAt) predicted.missAt = now;
      // A predicted wrap is judged on SUSTAINED contradiction: patience is spent only
      // while the pane actually disagrees, and any frame showing the echo walking our
      // line gives it all back. The clock alone could not tell WRONG from BEHIND —
      // `match` was its only escape, and `match` is unreachable while the typist stays
      // ahead of the echo, so a CORRECT wrap aged out and flipped the growth direction,
      // and the NEXT wrap then painted its continuation one row off the real one. That
      // is the duplicated line this was reported as. (Measured at 30ms/char over a
      // 390ms link: wrap predicted correctly at 4417ms, direction flipped at 5615ms,
      // exactly one deadline later, with nothing wrong on screen in between.)
      // The re-arm above also makes a half-painted intermediate frame harmless: it
      // disagrees for an instant and agrees again on the next one, and a verdict now
      // needs a whole deadline of disagreement rather than one unlucky sample.
      if (predicted.wrapAt && now - predicted.wrapAt > deadline) {
        // A mispredicted PULL wrap is usually just the growth direction: the pane ran
        // out of blank rows below it, so the app's extra row now arrives as a SCROLL,
        // which lands the cursor on the same screen row instead of the next one. Flip
        // it once and keep the style — the next wrap tries the other landing. A second
        // death in a row means the style itself is wrong: unlearn, ride, re-teach.
        if (wrapStyle && wrapStyle.pull && !wrapStyle.flipped) {
          wrapStyle.down = !wrapStyle.down;
          wrapStyle.flipped = true;
        } else {
          wrapStyle = null;
        }
        lineFresh = false;
        resetPredictions();
        return;
      }
      if (!predicted.dirty) {
        // A moves-only burst paints nothing but the cursor block, so there is no
        // paint to protect: the moment the pane visibly disagrees for longer than
        // one repaint transient (a streaming TUI parks the cursor mid-chunk),
        // follow its truth. This is what keeps over-navigation at echo speed
        // instead of frozen until the content deadline. But only once the KEYS
        // pause: during a rapid navigation run the grid trails the model by a
        // full round trip while every prediction is correct, and releasing
        // mid-run would snap the cursor back to the echo and re-bind against a
        // stale grid — the stutter this engine exists to prevent.
        if (now - predicted.missAt > 150 && now - lastEditAt > 150) { lineFresh = false; resetPredictions(); }
        return;
      }
      if (now - lastEditAt > deadline) {
        // Never converged: the pane is not echoing what we predicted. Snap to server
        // truth and forget the input boundary too — after a divergence the count no
        // longer maps to the grid, and a backspace measured against a fresh snapshot
        // could cover the prompt. Under-counting is the safe direction.
        // A wrap-adjacent mispredict also unlearns the style: either the burst
        // WAS a predicted wrap that never converged, or it died while inserting
        // right at the style's supposed edge — the signature of a style carried
        // across a pane switch that wraps too late, so the real wrap landed as a
        // plain mispredict. Either way the next wrap rides the echo and
        // re-teaches the style exactly. Bursts failing elsewhere on the line
        // (a TUI rewrite, a completion) leave a correct learned style alone.
        if (predicted.wrapped || (wrapStyle && predicted.line.length >= wrapStyle.atLen - 8)) wrapStyle = null;
        lineFresh = false;
        resetPredictions();
      }
    }
  }

  function resetPredictions() {
    predicted = null;
    edge = null;    // a wrap's edge glyph must never outlive its burst
    boxShift = null; // nor the rows its wrap moved
    inputLen = 0;   // forget the input boundary; re-armed input starts counting fresh
    lastEditAt = 0; // surrender the grace too, so owning() is false and the release sticks
    releaseCursor();
  }

  // Read-only e2e probe: engine state without DOM scraping (paint assertions race the
  // echo on fast links). It has its OWN flag, deliberately not the feature's: ?echo=1 is
  // a documented product option, so sharing one switch would hand a global that vends
  // terminal rows to every user who turns predictive echo on. Exposes nothing writable.
  if (echoEnabled && params.get('probe') === '1') window.__ehPredict = {
    get safe() { return serverSafe; },
    get burst() {
      return predicted && { row: predicted.absRow, line: predicted.line, tail: predicted.tail,
        floor: predicted.floor,
        proven: predicted.proven, dirty: predicted.dirty, draining: predicted.draining,
        wrapped: predicted.wrapped, offGrid: predicted.offGrid, matched: predicted.matched };
    },
    get hold() { return hold && { row: hold.row, col: hold.col, nav: hold.nav }; },
    get app() { return paneApp; },
    get wrap() { return wrapStyle && { atLen: wrapStyle.atLen, indent: wrapStyle.indent, pull: wrapStyle.pull, down: wrapStyle.down }; },
    get pend() { return wrapPend && { row: wrapPend.row, col: wrapPend.col, word: wrapPend.word }; },
    get quiet() { return Math.round(performance.now() - lastDataAt); },
    get edge() { return edge && { row: edge.absRow, col: edge.col, text: edge.text }; },
    get box() { return boxShift && { from: boxShift.from, to: boxShift.to, delta: boxShift.delta,
                                     text: boxShift.text, textRow: boxShift.textRow, wipeRow: boxShift.wipeRow }; },
    get inputLen() { return inputLen; },
    get fresh() { return lineFresh; },
    get owning() { return owningNow; },
    get rtt() { return rttEma; },
    get col() { return term.buffer.active.cursorX; },
    get row() { var b = term.buffer.active; return b.baseY + b.cursorY; },
    get baseY() { return term.buffer.active.baseY; },
    get rows() { return term.rows; },
    text: function (row) { var l = term.buffer.active.getLine(row); return l ? l.translateToString(false, 0, term.cols) : null; },
  };

  var ws = null;             // the live socket; null while disconnected
  var connecting = false;    // single-flight guard for connect()
  var everConnected = false; // once a session worked, a transient token failure retries
                             // from the status surface; only a real 401 falls back to the login form
  var postedReady = false;   // tell the embedding dashboard once, when the socket first opens

  function showLogin(msg) {
    hideStatus(); // the password IS the next step; two surfaces would stack
    errEl.textContent = msg || '';
    loginEl.classList.add('show');
    termEl.classList.add('hide');
    pwEl.focus();
  }
  function hideLogin() {
    loginEl.classList.remove('show');
    termEl.classList.remove('hide');
    fit.fit();
    term.focus();
  }

  // getToken resolves the short-lived bearer for the NEXT socket. It is the one
  // seam between the two deployment modes; everything downstream (openSocket, the
  // wire protocol, predictive echo) is identical. Self-host fetches the cookie-gated
  // endpoint (401 → show the password form, resolve null). An embedded managed page
  // (?parent set) has no such endpoint, so it asks the dashboard that framed it for a
  // platform-minted JWT over postMessage. Resolving null means "handled, do not open".
  function getToken() {
    if (parentOrigin) return requestTokenFromParent();
    return fetch('/__console/token').then(function (r) {
      if (r.status === 401) { showLogin(''); return null; }
      if (!r.ok) throw new Error('token request failed: ' + r.status);
      return r.text();
    });
  }

  // requestTokenFromParent asks the embedding dashboard for a fresh 60s JWT. Only the
  // parent holds the platform session, so it is the only party that can mint; we
  // re-ask on every (re)connect, so the token is always fresh with no in-band refresh.
  // SECURITY: we accept a token ONLY from the exact ?parent origin AND window.parent,
  // and post the request to that exact origin (never '*'), so the bearer never leaks to
  // another frame. Bounded retries cover the first-load race where we ask before the
  // parent's message listener has mounted, AND a slow re-mint on reconnect: the parent's
  // mint is a session read plus an API round-trip that can take multiple seconds on a
  // jittery uplink, so the budget is 12s (40 x 300ms), not one race window. Re-asking is
  // idempotent (each request just mints again); exhausting the budget rejects into the
  // status surface, whose Reconnect button starts a fresh one.
  function requestTokenFromParent() {
    return new Promise(function (resolve, reject) {
      var done = false, tries = 0, timer = 0;
      function onMsg(ev) {
        if (!fromParent(ev)) return;
        if (!ev.data || ev.data.type !== 'envhaven-console:token' || typeof ev.data.token !== 'string') return;
        done = true; cleanup(); resolve(ev.data.token);
      }
      function cleanup() { window.removeEventListener('message', onMsg); if (timer) clearTimeout(timer); }
      function ask() {
        if (done) return;
        if (tries++ >= 40) { cleanup(); reject(new Error('no token from parent')); return; }
        toParent({ type: 'envhaven-console:token-request' });
        timer = setTimeout(ask, 300);
      }
      window.addEventListener('message', onMsg);
      ask();
    });
  }

  // ── Connection status surface ─────────────────────────────────────────────
  // Shown whenever there is no session to type into. The FIRST connect stays
  // deliberately silent — the dashboard's loader already covers it and self-host
  // shows its login form — so landing here is unchanged; this appears only once a
  // session has existed, or when a connect we announced fails. `spinning` is the
  // difference between "we are trying" (animate, no button: the user has nothing
  // to decide yet) and "your move" (static mark, Reconnect).
  var statusEl = document.getElementById('status');
  var statusWho = document.getElementById('statusWho');
  var statusMsg = document.getElementById('statusMsg');
  var statusBtn = document.getElementById('statusBtn');
  var statusSpin = document.getElementById('statusSpin');
  var statusLift = document.getElementById('statusLift');
  var SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  // The six dots of ⠿ (U+283F) one at a time: U+2801 is dot 1 (top left) and each
  // following bit is the next dot down the left column, then the right. ⠿ is a single
  // glyph, so laying one of these over it is the only way to give one dot of the mark
  // its own opacity while the mark stays the mark.
  var LIFT = ['⠁', '⠂', '⠄', '⠈', '⠐', '⠠'];
  var spinTimer = 0, spinAt = 0, statusOn = false;
  var liftTimer = 0, liftAt = Math.floor(Math.random() * LIFT.length);
  statusEl.style.background = themeBg;
  if (themeFg) statusEl.style.color = themeFg;
  // The dashboard names the workspace for us; self-host falls back to its own host.
  // Capped and set as TEXT: it is display copy, never markup.
  statusWho.textContent = (params.get('name') || location.hostname || '').slice(0, 64);

  // The dead mark's beat. One self-rescheduling timeout runs both phases, so there is a
  // single handle to clear, exactly like spinTimer: lit for 500-1100ms, dark for
  // 900-2400ms, both drawn fresh every phase so the rhythm never settles into one the
  // eye can follow. The next dot is never the one just lit, since a repeat in place
  // reads as a blink, which is a signal; a dot somewhere else reads as the mark
  // guttering. Nothing advances in order and no cycle completes, so there is no progress
  // to read into it. The fade itself is CSS (.lift.on), which is why the lit phase is
  // never shorter than the .45s transition it has to finish.
  function stutter(lit) {
    if (lit) {
      liftAt = (liftAt + 1 + Math.floor(Math.random() * (LIFT.length - 1))) % LIFT.length;
      statusLift.textContent = LIFT[liftAt];
    }
    statusLift.classList.toggle('on', lit);
    liftTimer = setTimeout(function () { stutter(!lit); },
                           lit ? 500 + Math.random() * 600 : 900 + Math.random() * 1500);
  }
  // Clears the dot as well as the timer: a lifted dot left standing would sit under the
  // spinner's next frame, two marks in one glyph box.
  function stopStutter() {
    if (liftTimer) { clearTimeout(liftTimer); liftTimer = 0; }
    statusLift.textContent = '';
    statusLift.classList.remove('on');
  }

  function showStatus(msg, spinning) {
    statusMsg.textContent = msg;
    statusBtn.classList.toggle('away', !!spinning);
    statusSpin.textContent = spinning ? SPIN[spinAt] : '⠿';
    statusSpin.classList.toggle('dim', !spinning);
    statusEl.classList.add('show');
    statusOn = true;
    if (spinTimer) { clearInterval(spinTimer); spinTimer = 0; }
    stopStutter();
    if (spinning) {
      spinTimer = setInterval(function () {
        spinAt = (spinAt + 1) % SPIN.length;
        statusSpin.textContent = SPIN[spinAt];
      }, 80);
    } else if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Read here and not in the stylesheet: no CSS rule can stop a textContent swap,
      // and the preference can be turned on while this page is open. Under it the six
      // dots stay dim and still, which is the whole message anyway.
      stutter(true);
    }
  }
  function hideStatus() {
    if (spinTimer) { clearInterval(spinTimer); spinTimer = 0; }
    stopStutter();
    statusEl.classList.remove('show');
    statusOn = false;
  }
  statusBtn.addEventListener('click', function () { connect(); });

  // connect gets a short-lived token and opens the socket. Single-flight: `ws` stays
  // null for the whole token round-trip, so without the guard every key typed in that
  // window would open ANOTHER socket — each one a second tmux client whose broadcast
  // repaints land in this same terminal, doubling every echoed character.
  function connect() {
    if (connecting || ws) return;
    connecting = true;
    // Announce the attempt only if the user is already looking at the status surface
    // (a reconnect, or a retry after a failure). A first connect stays silent.
    if (everConnected || statusOn) showStatus('reconnecting', true);
    getToken().then(function (token) {
      if (!token) { connecting = false; return; } // self-host showed the login form
      hideLogin();
      openSocket(token);
    }).catch(function (e) {
      connecting = false;
      if (everConnected) showStatus('reconnect failed', false);
      else if (parentOrigin) showStatus('console unavailable', false);
      else showLogin(String(e));
    });
  }

  function openSocket(token) {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // cols/rows on the URL let the server create the pty at the terminal's real
    // geometry, so the tmux attach paints once instead of 80x24-then-resize.
    // echo=1 forwards the predictive-echo opt-in: the server runs its
    // tmux-polling predict gate only for sessions that will actually draw.
    var url = proto + '//' + location.host + '/__console?cols=' + term.cols + '&rows=' + term.rows;
    if (echoEnabled) url += '&echo=1';
    var sock = new WebSocket(url, ['envhaven.console', token]);
    sock.binaryType = 'arraybuffer';
    var sdec = new TextDecoder(); // per-socket stream state: a chunk cut mid-UTF-8 at disconnect must not bleed into the next session
    ws = sock;
    connecting = false;
    sock.onopen = function () {
      var reconnected = statusOn;
      everConnected = true; hideStatus(); sendResize(); // resize catches a fit() that landed between URL build and open
      if (reconnected) term.focus(); // the click that reconnected left focus on the button
      // Signal the embedding dashboard that the terminal is live, so it can drop its loader.
      if (embedded && !postedReady) { postedReady = true; toParent({ type: 'envhaven-console:ready' }); }
    };
    // Handlers ignore a superseded socket: it must never write into the live
    // terminal, and its late close must never clobber the live connection.
    sock.onmessage = function (ev) {
      if (ws !== sock) return;
      var u8 = new Uint8Array(ev.data);
      if (u8[0] === DATA) { lastDataAt = performance.now(); term.write(sdec.decode(u8.subarray(1), { stream: true }), reconcile); }
      else if (u8[0] === PGATE) { setSafe(u8[1] === 1); setPaneApp(appDec.decode(u8.subarray(2))); }
    };
    sock.onclose = function () {
      if (ws !== sock) return;
      ws = null;
      serverSafe = false; // fail closed: re-arm only when a fresh server "safe" arrives
      localDisarm = false; // the next session's gate frames stand on their own
      resetPredictions();
      styleCache = {}; promptCache = {}; promptStr = null; paneApp = ''; wrapStyle = null;
      wrapPend = null; hold = null; lineFresh = false; // the next session re-proves everything
      rttEma = 0; // and re-measures the link: a reconnect is often onto a slower one, and
                  // a stale fast estimate kills the new session's first bursts early
      clearLinkUnderline(); // a hovered link's hairlines must not linger under the overlay
      showStatus('session disconnected', false);
    };
  }

  function frame(type, payload) {
    var out = new Uint8Array(payload.length + 1);
    out[0] = type;
    out.set(payload, 1);
    return out;
  }
  function sendResize() {
    if (!ws || ws.readyState !== 1) return;
    ws.send(frame(RESIZE, enc.encode(JSON.stringify({ cols: term.cols, rows: term.rows }))));
  }

  function sendInput(d) {
    if (!ws) { connect(); return; } // reconnect after a disconnect on first keypress
    predict(d);
    if (ws.readyState === 1) ws.send(frame(DATA, enc.encode(d)));
  }
  term.onData(sendInput);
  // ── OS-aware chords ───────────────────────────────────────────────────────
  // Option/Alt+Arrow (every OS): xterm.js encodes it as CSI 1;3A-D, which stock
  // zsh leaves unbound — ZLE then self-inserts the sequence tail, printing a
  // stray A/B/C/D. Translate left/right to the emacs meta sequences every line
  // editor understands (backward-word / forward-word) — the mapping VS Code's
  // terminal ships — and up/down to plain arrows. Claude Code accepts both.
  //
  // macOS ⌘-chords: xterm emits NOTHING for ⌘+Arrow (the browser would navigate
  // history) and a bare DEL for ⌘⌫ (a lone char delete); translate them to the
  // line edits a Mac hand expects — ⌘←/⌘→ = start/end of line (^A/^E), ⌘⌫ =
  // kill the line (^U) — again VS Code's exact mapping. Option+⌫ already
  // arrives as ESC DEL from xterm on every platform (word delete).
  //
  // Windows/Linux: Ctrl+Arrow already arrives as CSI 1;5C/D (bound by oh-my-zsh)
  // and needs no translation; Ctrl+Backspace would arrive as a bare ^H (a single
  // char delete), so it becomes ^W — the word delete every platform means by it.
  //
  // preventDefault is explicit and per-chord: xterm does NOT cancel events its
  // handler rejects, and ⌘←/Alt+← are browser history gestures inside an iframe.
  // ⌘C/⌘V/⌘A and every unlisted chord stay with the browser untouched.
  var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
  var altArrow = { ArrowLeft: '\x1bb', ArrowRight: '\x1bf', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B' };
  var cmdKeys = { ArrowLeft: '\x01', ArrowRight: '\x05', Backspace: '\x15' };
  term.attachCustomKeyEventHandler(function (ev) {
    if (ev.type !== 'keydown') return true;
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && altArrow[ev.key]) {
      ev.preventDefault();
      sendInput(altArrow[ev.key]);
      return false;
    }
    if (isMac && ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && cmdKeys[ev.key]) {
      ev.preventDefault();
      sendInput(cmdKeys[ev.key]);
      return false;
    }
    if (!isMac && ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey && ev.key === 'Backspace') {
      ev.preventDefault();
      sendInput('\x17');
      return false;
    }
    return true;
  });
  term.onResize(sendResize);
  window.addEventListener('resize', function () {
    fit.fit();
    resetPredictions();
    // Geometry changed: every learned or pending row-edge fact is stale, in the
    // cache too; the current app reseeds at the new width. promptCache is left
    // alone on purpose — a prompt prefix is a fact about the app, not about the
    // width, and it survives a resize exactly as it survives a pane switch.
    styleCache = {}; wrapStyle = seedStyle(paneApp); wrapPend = null; hold = null; lineFresh = false;
  });

  // Live re-theme from the embedding dashboard on light/dark toggle — no reload, so the
  // tmux session and predictor state stay intact. Same wall as the token: accept only from
  // the exact ?parent origin AND window.parent. Repaints everything the theme touches
  // (page + xterm background, foreground and cursor colours), then reseeds the cached
  // style and resets predictions so no overlay keeps painting the old palette.
  if (embedded) window.addEventListener('message', function (ev) {
    if (!fromParent(ev)) return;
    var d = ev.data;
    if (!d || d.type !== 'envhaven-console:theme') return;
    var nbg = hexColor(d.bg), nfg = hexColor(d.fg);
    if (nbg) themeBg = nbg;
    if (nfg) themeFg = nfg;
    document.body.style.background = themeBg;
    statusEl.style.background = themeBg;
    if (themeFg) statusEl.style.color = themeFg;
    term.options.theme = themeObj();
    refreshStyle();
    resetPredictions();
  });

  document.getElementById('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var body = new URLSearchParams();
    body.set('password', pwEl.value);
    fetch('/__console/login', { method: 'POST', body: body }).then(function (r) {
      if (r.status === 204) { pwEl.value = ''; connect(); }
      else if (r.status === 429) showLogin('Too many attempts. Wait a moment and try again.');
      else showLogin('Invalid password.');
    }).catch(function (e) { showLogin(String(e)); });
  });

  connect();
})();
