// Pure policy and geometry for the console's predictive-echo engine.
//
// This is a synchronous classic script for the same reason eh-engine.js is: the
// terminal page has no build step, and the engine must run after its dependencies in
// document order. Keep this file free of DOM, xterm and socket state. The browser loads
// the whole asset, and the Bun tests execute this same asset rather than extracting
// private declarations from the engine.
var EnvHavenConsoleModel = (function () {
  var FRAME = {
    data: 0x00,
    resize: 0x01,
    predictV1: 0x02,
    predictV4: 0x05
  };

  // Decode both shipped predictive-frame versions to one geometry shape. V1 has no
  // pane geometry, so its historical safe bit is refused. V4 carries all four absolute
  // edges; bottom and right are exclusive.
  function decodePredictFrame(bytes, decode) {
    var type = bytes[0];
    if (type === FRAME.predictV1 && bytes.length >= 2) {
      return { version: 1, safe: false, top: 0, bottom: 0, left: 0, right: 0, app: decode(bytes.subarray(2)) };
    }
    if (type === FRAME.predictV4 && bytes.length >= 10) {
      var top = (bytes[2] << 8) | bytes[3], bottom = (bytes[4] << 8) | bytes[5];
      var left = (bytes[6] << 8) | bytes[7], right = (bytes[8] << 8) | bytes[9];
      return {
        version: 4,
        safe: bytes[1] === 1 && top < bottom && left < right,
        top: top,
        bottom: bottom,
        left: left,
        right: right,
        app: decode(bytes.subarray(10))
      };
    }
    return null;
  }

  function predictorLifecycleState(state) {
    return {
      safe: !!state.safe, localDisarm: !!state.localDisarm, app: state.app || '',
      top: state.top || 0, bottom: state.bottom || 0, left: state.left || 0, right: state.right || 0
    };
  }

  // Pure lifecycle reduction. The prediction session owns the resulting state; this
  // policy function retains no mutable bag and is also the deterministic test seam.
  function reducePredictorLifecycle(current, event) {
    var state = predictorLifecycleState(current || {}), effects = [];
    if (!event || typeof event.type !== 'string') throw new Error('predictor event needs a type');

    if (event.type === 'gate') {
      if (event.top !== state.top || event.bottom !== state.bottom || event.left !== state.left || event.right !== state.right) {
        state.top = event.top;
        state.bottom = event.bottom;
        state.left = event.left;
        state.right = event.right;
        effects.push({ type: 'geometry', top: state.top, bottom: state.bottom, left: state.left, right: state.right });
      }
      if (!event.safe) {
        state.localDisarm = false;
        state.safe = false;
        effects.push({ type: 'reset', reason: 'server-unsafe' });
      } else if (!state.localDisarm) {
        state.safe = true;
      }
      if (event.app !== state.app) {
        effects.push({ type: 'app', previous: state.app, app: event.app });
        state.app = event.app;
      }
    } else if (event.type === 'submit') {
      state.localDisarm = state.safe;
      state.safe = false;
    } else if (event.type === 'disconnect') {
      state = predictorLifecycleState({});
      effects.push({ type: 'reset', reason: 'socket-close' }, { type: 'disconnect' });
    } else if (event.type === 'resize') {
      effects.push({ type: 'reset', reason: 'term-resize' }, { type: 'resize' });
    } else if (event.type === 'reset') {
      effects.push({ type: 'reset', reason: event.reason || '' });
    } else {
      throw new Error('unknown predictor event: ' + event.type);
    }
    return { state: state, effects: effects };
  }

  function transportState(phase, gateRequired, canPredict) {
    return { phase: phase || 'disconnected', gateRequired: !!gateRequired, canPredict: !!canPredict };
  }

  // Input has no pending state. Until the current socket has delivered a frame carrying
  // authoritative pane/gate data, the only input effect is an explicit refusal.
  function reduceTransport(current, event) {
    var state = transportState(current && current.phase, current && current.gateRequired, current && current.canPredict), effects = [];
    if (!event || typeof event.type !== 'string') throw new Error('transport event needs a type');
    if (event.type === 'connect') {
      if (state.phase === 'disconnected') state.phase = 'connecting';
    } else if (event.type === 'socket-open') {
      if (state.phase === 'connecting') {
        state.phase = 'awaiting-frame';
        state.gateRequired = !!event.gateRequired;
        state.canPredict = false;
      }
    } else if (event.type === 'data') {
      if (state.phase === 'awaiting-frame' && !state.gateRequired) state.phase = 'ready';
    } else if (event.type === 'gate') {
      if (state.phase === 'awaiting-frame' || state.phase === 'ready') {
        state.phase = 'ready';
        state.canPredict = true;
      }
    } else if (event.type === 'socket-close') {
      state = transportState();
    } else if (event.type === 'input') {
      if (state.phase === 'ready') {
        effects.push({ type: 'send-input', data: event.data });
        if (state.canPredict) effects.push({ type: 'predict-input', data: event.data });
      } else {
        effects.push({ type: 'refuse-input', phase: state.phase });
      }
    } else {
      throw new Error('unknown transport event: ' + event.type);
    }
    return { state: state, effects: effects };
  }

  // Word motion is application policy. A jump one column off is also a word deletion
  // that removes the wrong word, so every measured editor selects an explicit rule.
  var LETTER_RE = /[\p{L}\p{N}]/u;
  var WORD_RULES = {
    zsh:      { word: LETTER_RE,          punct: false, join: false, fwd: 'next' },
    claude:   { word: /[\p{L}\p{N}_]/u,   punct: false, join: true,  fwd: 'next' },
    token:    { word: /[\p{L}\p{N}_]/u,   punct: true,  join: false, fwd: 'end' },
    fx:       { word: /[\p{L}\p{N}_]/u,   punct: false, join: false, fwd: 'end' },
    muse:     { word: LETTER_RE,          punct: false, join: false, fwd: 'end' },
    opencode: { delim: /[ \t\-/\\.,;:!?()[\]{}]/ }
  };
  var WORD_APPS = {
    zsh: 'zsh', claude: 'claude', codex: 'token', 'kimi-code': 'token',
    muse: 'muse', pi: 'token', fx: 'fx', opencode: 'opencode'
  };

  function own(o, key) { return Object.prototype.hasOwnProperty.call(o, key); }
  function isLetter(c) { return !!c && LETTER_RE.test(c); }
  function wordRuleName(app) { return own(WORD_APPS, app) ? WORD_APPS[app] : 'zsh'; }
  function wordRule(app) { return WORD_RULES[wordRuleName(app)]; }
  function wordApps() {
    var out = {};
    for (var app in WORD_APPS) if (own(WORD_APPS, app)) out[app] = WORD_APPS[app];
    return out;
  }

  // The class of s[i] under one pane's rule: 0 separator, 1 word, 2 punctuation word.
  function wordClass(rule, s, i) {
    var c = s.charAt(i);
    if (!c || c === ' ' || c === '\u00a0') return 0;
    if (rule.delim) return rule.delim.test(c) ? 0 : 1;
    if (rule.word.test(c)) return 1;
    if (rule.join && joinsWord(s, i)) return 1;
    return rule.punct ? 2 : 0;
  }
  function wordScan() { return { cls: 0, one: false, phase: 0, landed: false }; }
  function joinsWord(s, i) {
    var c = s.charAt(i), a = s.charAt(i - 1), b = s.charAt(i + 1);
    var letters = /[\p{L}_]/u.test(a) && /[\p{L}_]/u.test(b);
    var digits = /\p{N}/u.test(a) && /\p{N}/u.test(b);
    if (c === '.' || c === "'" || c === '\u2019') return letters || digits;
    if (c === ':') return letters;
    if (c === ',') return digits;
    return false;
  }
  function wordLeft(rule, s, i, floor, st) {
    if (rule.delim) {
      if (!st.one && i > floor) { i--; st.one = true; }
      while (i > floor && !rule.delim.test(s.charAt(i - 1))) i--;
      st.landed = i > floor;
      return i;
    }
    while (i > floor) {
      var c = wordClass(rule, s, i - 1);
      if (!st.cls) { if (c) st.cls = c; i--; continue; }
      if (c !== st.cls) { st.landed = true; return i; }
      i--;
    }
    return i;
  }
  function seamJoins(rule, sep, st) {
    var c = wordClass(rule, sep, 0);
    if (st.cls && c !== st.cls) return false;
    if (!st.cls) st.cls = c;
    return true;
  }
  function wordRight(rule, s, i, max, st) {
    var c;
    if (rule.delim) {
      var j = i + 1;
      while (j < max && !rule.delim.test(s.charAt(j))) j++;
      if (j < max) { st.landed = true; return j + 1; }
      return max;
    }
    if (rule.fwd === 'next') {
      if (!st.phase) {
        if (!st.cls) st.cls = wordClass(rule, s, i);
        while (i < max && st.cls && wordClass(rule, s, i) === st.cls) i++;
        if (i < max || !st.cls) st.phase = 1;
      }
      if (st.phase) while (i < max && wordClass(rule, s, i) === 0) i++;
      st.landed = i < max;
      return i;
    }
    while (i < max && !st.cls) { c = wordClass(rule, s, i); if (c) st.cls = c; else i++; }
    while (i < max && wordClass(rule, s, i) === st.cls) i++;
    st.landed = i < max;
    return i;
  }

  // Measured composer geometry. A row seeds only the first wrap; runtime observation
  // remains authoritative and replaces a stale seed after one disagreement.
  var TUI = {
    claude: { pad: 2, indent: 2, pull: true,  down: null,  prompt: '\u276f ' },
    codex:  { pad: 2, indent: 2, pull: true,  down: true,  prompt: '\u203a ', lazy: true },
    agy:    { pad: 1, indent: 2, pull: true,  down: true,  prompt: '> ', spacePull: true },
    grok:   { pad: 4, indent: 6, pull: true,  down: false, prompt: '\u276f ' },
    'kimi-code': { pad: 5, indent: 5, pull: true, down: true, prompt: '> ', spacePull: true },
    muse:   { pad: 1, indent: 2, pull: true,  down: true,  prompt: '\u276f ', spacePull: true, coldFg: '#d0d0d0' },
    pi:     { pad: 1, indent: 0, pull: true,  down: true,  prompt: null, spacePull: true },
    fx:     { pad: 0, indent: 2, pull: true,  down: true,  prompt: null },
    goose:  { pad: 1, indent: 0, pull: false, down: false, prompt: '> ' },
    zsh:    { pad: 1, indent: 0, pull: false, down: false, prompt: null }
  };

  // An unknown app rides before the earliest measured wrap. opencode deliberately has
  // no row because its two composers have different, width-dependent geometry.
  var RIDE_PAD = 1;
  for (var padKey in TUI) if (own(TUI, padKey) && TUI[padKey].pad > RIDE_PAD) RIDE_PAD = TUI[padKey].pad;

  function tuiRow(app) { return own(TUI, app) ? TUI[app] : null; }
  function seedStyle(app, cols) {
    var t = tuiRow(app);
    if (!t) return null;
    return {
      atLen: cols - t.pad, indent: t.indent, pull: t.pull, down: t.down,
      lazy: !!t.lazy, spacePull: !!t.spacePull, flipped: false
    };
  }
  function seedPrompt(app) {
    var t = tuiRow(app);
    return t ? t.prompt : null;
  }
  // A null seed is geometry-dependent; the first ridden wrap makes it concrete.
  function learnedWrapDown(app, delta) {
    var t = tuiRow(app);
    return t && t.down !== null ? t.down : delta === 1;
  }
  function tuiTable() {
    var out = {};
    for (var app in TUI) {
      if (!own(TUI, app)) continue;
      var row = {};
      for (var key in TUI[app]) if (own(TUI[app], key)) row[key] = TUI[app][key];
      row.lazy = !!row.lazy;
      row.spacePull = !!row.spacePull;
      out[app] = row;
    }
    return out;
  }

  function promptShaped(p) {
    return p.length > 0 && p.length <= 4 && /\S/.test(p) && !/[0-9A-Za-z]/.test(p);
  }
  // Box Drawing and Block Elements are both composer chrome. opencode uses both ranges
  // in one box, so treating only the first as structure misreads its lower rule as text.
  function isBoxGlyph(c) { return c >= 0x2500 && c <= 0x259f; }
  function borderSkip(row) {
    var i = row.search(/\S/);
    if (i === -1 || !isBoxGlyph(row.charCodeAt(i))) return 0;
    for (i++; i < row.length && row.charAt(i) === ' '; i++);
    return i;
  }
  function borderGlyph(row) {
    var i = row.search(/\S/);
    return i === -1 ? '' : row.charAt(i);
  }
  function textStart(row) {
    var i = row.search(/\S/);
    if (i === -1 || !isBoxGlyph(row.charCodeAt(i))) return i;
    i = borderSkip(row);
    return i < row.length ? i : -1;
  }
  function textEnd(row) {
    var n = row.replace(/ +$/, '').length;
    if (n === 0 || !isBoxGlyph(row.charCodeAt(n - 1))) return n;
    for (n--; n > 0 && row.charAt(n - 1) === ' '; n--);
    return n;
  }

  // Grid-dependent geometry is still pure: callers provide live dimensions and a row
  // reader. The browser supplies xterm-backed getters; tests supply captured panes.
  function createGeometry(view) {
    function paneTop() {
      var top = typeof view.paneTop === 'function' ? view.paneTop() : 0;
      return Math.max(0, Math.min(top || 0, view.rows()));
    }
    function paneBottom() {
      var bottom = view.paneBottom(), rows = view.rows();
      return Math.max(paneTop(), bottom > 0 ? Math.min(bottom, rows) : rows);
    }
    function paneLeft() {
      var left = typeof view.paneLeft === 'function' ? view.paneLeft() : 0;
      return Math.max(0, Math.min(left || 0, view.cols()));
    }
    function paneRight() {
      var right = typeof view.paneRight === 'function' ? view.paneRight() : 0;
      return Math.max(paneLeft(), right > 0 ? Math.min(right, view.cols()) : view.cols());
    }
    function paneWidth() { return paneRight() - paneLeft(); }
    function rowIsFull(row) {
      return row.slice(paneLeft(), paneRight()).replace(/ +$/, '').length === paneWidth();
    }
    function isFrameRow(row) {
      if (!row) return false;
      var t = row.slice(paneLeft(), paneRight()).replace(/ +$/, ''), i = t.search(/\S/), j, box = 0;
      if (i === -1) return false;
      if (t.length - i < 20 || t.length - i < paneWidth() / 2) return false;
      if (!isBoxGlyph(t.charCodeAt(i)) || !isBoxGlyph(t.charCodeAt(t.length - 1))) return false;
      for (j = i; j < t.length; j++) if (isBoxGlyph(t.charCodeAt(j))) box++;
      return box * 2 >= t.length - i;
    }
    function boxTop(row) {
      var baseY = view.baseY(), cur = view.row(row) || '';
      var chrome = borderSkip(cur), glyph = borderGlyph(cur), i, r, rw;
      for (i = 1; i <= 16; i++) {
        r = row - i;
        if (!rowWithinPane(r)) return -1;
        rw = view.row(r);
        if (isFrameRow(rw)) return r;
        if (chrome > 0 && (rw === null || borderSkip(rw) === 0 || borderGlyph(rw) !== glyph)) return r + 1;
      }
      return -1;
    }
    function frameEnd(row) {
      var i, r, end;
      if (!rowWithinPane(row + 1) || !isFrameRow(view.row(row + 1))) return -1;
      end = row + 1;
      for (i = 2; i <= 4; i++) {
        r = row + i;
        if (!rowWithinPane(r) || !(view.row(r) || '').trim()) break;
        end = r;
      }
      return end;
    }
    function rowWithinPane(row) {
      var relative = row - view.baseY();
      return relative >= paneTop() && relative < paneBottom();
    }
    function colWithinPane(col) { return col >= paneLeft() && col < paneRight(); }
    function rowsThroughPane(row) {
      return rowWithinPane(row) ? paneBottom() - (row - view.baseY()) : 0;
    }
    function roomBelow(end) { return end < 0 || rowWithinPane(end + 1); }
    return {
      rowIsFull: rowIsFull,
      isFrameRow: isFrameRow,
      boxTop: boxTop,
      frameEnd: frameEnd,
      paneTop: paneTop,
      paneBottom: paneBottom,
      paneLeft: paneLeft,
      paneRight: paneRight,
      paneWidth: paneWidth,
      rowWithinPane: rowWithinPane,
      colWithinPane: colWithinPane,
      rowsThroughPane: rowsThroughPane,
      roomBelow: roomBelow
    };
  }

  return {
    FRAME: FRAME,
    predictQuery: '&echo=1&echoProtocol=4',
    decodePredictFrame: decodePredictFrame,
    reducePredictorLifecycle: reducePredictorLifecycle,
    transportState: transportState,
    reduceTransport: reduceTransport,
    isLetter: isLetter,
    wordRuleName: wordRuleName,
    wordRule: wordRule,
    wordApps: wordApps,
    wordClass: wordClass,
    wordScan: wordScan,
    wordLeft: wordLeft,
    seamJoins: seamJoins,
    wordRight: wordRight,
    RIDE_PAD: RIDE_PAD,
    tuiRow: tuiRow,
    seedStyle: seedStyle,
    seedPrompt: seedPrompt,
    learnedWrapDown: learnedWrapDown,
    tuiTable: tuiTable,
    promptShaped: promptShaped,
    borderSkip: borderSkip,
    textStart: textStart,
    textEnd: textEnd,
    createGeometry: createGeometry
  };
})();
