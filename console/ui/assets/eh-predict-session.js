// Prediction session controller. Its collaborators share one private state object;
// only commands and immutable renderer views cross the session boundary.
var EnvHavenConsoleSession = (function () {
  function create(deps) {
    var MODEL = deps.model, term = deps.term, performance = deps.clock;
    var setTimeout = deps.timers.setTimeout, clearTimeout = deps.timers.clearTimeout;
    var window = deps.window, params = deps.params, display = deps.display;
    var publish = deps.publish, effects = null;
    var s = {
      safe: false, localDisarm: false, app: '', top: 0, bottom: 0, left: 0, right: 0,
      inputLen: 0, predicted: null, rttEma: 0, lineFresh: false, hold: null,
      wrapStyle: null, wrapPend: null, edge: null, boxShift: null, lastDataAt: 0,
      styleCache: {}, pendingPull: null, endMemo: null, rideQueue: null, lastWrapAt: 0,
      promptStr: null, promptCache: {}, wordRuleName: 'zsh', wordRule: MODEL.wordRule('zsh'),
      traceRing: [], traceSequence: 0, traceDeaths: 0, lastEditAt: 0
    };
    var echoEnabled = params.get('echo') === '1';
    var echoProbe = echoEnabled && params.get('probe') === '1';

    function trace() {
      if (!echoProbe) return;
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        if (arguments[i] !== undefined) parts.push(String(arguments[i]));
      }
      s.traceRing.push({
        sequence: ++s.traceSequence,
        at: Math.round(performance.now()),
        text: parts.join(' ')
      });
      if (s.traceRing.length > 160) s.traceRing.splice(0, s.traceRing.length - 160);
    }
    function paneTop() { return s.top; }
    function paneBottom() { return s.bottom || term.rows; }
    function paneLeft() { return s.left; }
    function paneRight() { return s.right || term.cols; }
    function seedStyle(app) {
      var left = paneLeft(), seed = MODEL.seedStyle(app, paneRight() - left);
      if (seed) {
        seed.atLen += left;
        seed.indent += left;
      }
      return seed;
    }
    function seedPrompt(app) { return MODEL.seedPrompt(app); }
    function currentApp() { return s.app; }
    function effect(value) {
      if (!effects) throw new Error('prediction effect emitted outside dispatch');
      effects.push(value);
    }
    function resetPrediction(reason) {
      if (reason === 'content-deadline' || reason === 'wrap-deadline' || reason === 'move-mismatch') {
        s.traceDeaths++;
      }
      trace('reset', reason || '-');
      s.predicted = null;
      s.edge = null;
      s.boxShift = null;
      s.inputLen = 0;
      s.pendingPull = null;
      s.endMemo = null;
      s.lastEditAt = 0;
    }
    function switchApplication(previous, app) {
      trace('app', previous || '-', '->', app);
      if (previous !== '') {
        s.styleCache[previous] = s.wrapStyle;
        s.promptCache[previous] = s.promptStr;
      }
      effect({ type: 'forget-ink' });
      s.wrapStyle = Object.prototype.hasOwnProperty.call(s.styleCache, app) ?
        s.styleCache[app] : seedStyle(app);
      s.promptStr = Object.prototype.hasOwnProperty.call(s.promptCache, app) ?
        s.promptCache[app] : seedPrompt(app);
      s.wordRuleName = MODEL.wordRuleName(app);
      s.wordRule = MODEL.wordRule(app);
      s.wrapPend = null;
      handoff('heavy');
    }
    var holdTimer = 0, releaseTimer = 0, wrapLearnTimer = 0;
    function disconnectPrediction() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
      if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = 0; }
      if (wrapLearnTimer) { clearTimeout(wrapLearnTimer); wrapLearnTimer = 0; }
      s.styleCache = {};
      s.promptCache = {};
      s.promptStr = null;
      s.wrapStyle = null;
      effect({ type: 'forget-ink' });
      s.wrapPend = null;
      s.hold = null;
      s.rideQueue = null;
      s.lineFresh = false;
      s.rttEma = 0;
    }
    function resizePrediction() {
      s.styleCache = {};
      s.wrapStyle = seedStyle(currentApp());
      s.wrapPend = null;
      s.hold = null;
      s.rideQueue = null;
      s.lineFresh = false;
      effect({ type: 'forget-ink' });
    }
    function geometryPrediction() {
      resetPrediction('pane-geometry');
      s.styleCache = {};
      s.wrapStyle = null;
      s.wrapPend = null;
      s.hold = null;
      s.rideQueue = null;
      s.lineFresh = false;
      effect({ type: 'forget-ink' });
    }
    function applyPredictorEffects(result) {
      var geometryChanged = false, appChanged = false;
      for (var i = 0; i < result.effects.length; i++) {
        var next = result.effects[i];
        if (next.type === 'geometry') {
          trace('pane', next.top, next.bottom, next.left, next.right);
          geometryPrediction();
          geometryChanged = true;
        } else if (next.type === 'reset') {
          resetPrediction(next.reason);
        } else if (next.type === 'app') {
          switchApplication(next.previous, next.app);
          appChanged = true;
        } else if (next.type === 'disconnect') {
          disconnectPrediction();
        } else if (next.type === 'resize') {
          resizePrediction();
        } else {
          throw new Error('unknown predictor effect: ' + next.type);
        }
      }
      if (geometryChanged && !appChanged) s.wrapStyle = seedStyle(currentApp());
    }
    function predictorEvent(event) {
      var result = MODEL.reducePredictorLifecycle(s, event);
      s.safe = result.state.safe;
      s.localDisarm = result.state.localDisarm;
      s.app = result.state.app;
      s.top = result.state.top;
      s.bottom = result.state.bottom;
      s.left = result.state.left;
      s.right = result.state.right;
      applyPredictorEffects(result);
      return result.state;
    }
    function reset(reason) { predictorEvent({ type: 'reset', reason: reason }); }
    function submit() { predictorEvent({ type: 'submit' }); }
    function applyGate(gate) {
      trace('gate', gate.safe ? 'safe' : 'UNSAFE');
      predictorEvent({
        type: 'gate', safe: gate.safe, app: gate.app,
        top: gate.top, bottom: gate.bottom, left: gate.left, right: gate.right
      });
    }

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
      var buffer = term.buffer.active, absRow = buffer.baseY + buffer.cursorY;
      var row = fullRow(absRow);
      if (row === null || !layout.rowWithinPane(absRow) ||
          !layout.colWithinPane(buffer.cursorX)) return false;
      layout.learnPrompt(buffer.getLine(absRow), row, buffer.cursorX);
      var floor = Math.max(paneLeft(), buffer.cursorX - s.inputLen);
      var atEdge = !s.wrapStyle || Math.abs(buffer.cursorX - s.wrapStyle.atLen) <= 1;
      var inWake = performance.now() < s.lastWrapAt + 2000;
      var slowOp = atEdge || inWake;
      trace(
        'open', 'row:' + (absRow - buffer.baseY), 'col:' + buffer.cursorX,
        'slow:' + (slowOp ? 1 : 0), 'ws:' + (s.wrapStyle ? 1 : 0),
        'at:' + (atEdge ? 1 : 0), 'wake:' + (inWake ? 1 : 0),
        'age:' + Math.round(performance.now() - s.lastWrapAt)
      );
      var ghost = layout.ghostAt(absRow, buffer.cursorX, row);
      var ghostEnd = ghost ? Math.max(buffer.cursorX, layout.textEnd(row)) : buffer.cursorX;
      var memo = s.endMemo && s.endMemo.absRow === absRow &&
        s.endMemo.text === row.replace(/ +$/, '') ? s.endMemo.end : 0;
      s.predicted = {
        absRow: absRow,
        line: row.slice(0, buffer.cursorX),
        tail: new Array(ghostEnd - buffer.cursorX + 1).join(' ') + row.slice(ghostEnd),
        end: ghost ? buffer.cursorX : Math.max(buffer.cursorX, layout.textEnd(row), memo),
        floor: ghost ? buffer.cursorX : floor,
        proven: ghost || (s.lineFresh && floor > paneLeft()),
        openCol: buffer.cursorX,
        dirty: false, draining: false, drainRow: 0, drainCol: 0,
        drainBase: '', drainMissAt: 0, missAt: 0,
        wrapped: false, offGrid: false, wrapAt: 0, wrapRow: -1, wrapCol: 0,
        sampled: false, mismatched: false, walked: false, offRowAt: 0,
        matched: false, wrapKept: null, pullPend: null, slowOp: slowOp
      };
      replayRide();
      if (s.pendingPull) {
        if (!s.predicted.pullPend && s.predicted.absRow === s.pendingPull.fromRow + 1 &&
            s.predicted.line === s.pendingPull.lead) {
          s.predicted.pullPend = s.pendingPull;
        }
        s.pendingPull = null;
      }
      return true;
    }
    function replayRide() {
      var queue = s.rideQueue;
      s.rideQueue = null;
      // Empty is the observed anchor for an edge space that opened a blank continuation.
      if (!queue || !queue.text || queue.moved === null || performance.now() - queue.at > 2500) return;
      var row = s.predicted.line + s.predicted.tail, lead = layout.textStart(row);
      // A continuation still blank up to the cursor has no text to anchor on but the cursor.
      if (queue.moved === '' && (lead === -1 || lead > s.predicted.line.length)) lead = s.predicted.line.length;
      if (lead === -1 || row.slice(lead, lead + queue.moved.length) !== queue.moved) return;
      var echoed = s.predicted.line.length - lead - queue.moved.length;
      if (echoed < 0 || echoed >= queue.text.length) return;
      var rest = queue.text.slice(echoed);
      s.predicted.line += rest;
      s.predicted.end += rest.length;
      s.predicted.dirty = true;
      s.inputLen += rest.length;
    }
    function fullRow(absRow) {
      var buffer = term.buffer.active, relative = absRow - buffer.baseY;
      if (relative < paneTop() || relative >= paneBottom()) return null;
      var line = buffer.getLine(absRow);
      var row = line ? line.translateToString(false, 0, term.cols) : '';
      if (row.length !== term.cols) return null;
      var left = Math.max(0, Math.min(paneLeft(), term.cols));
      var right = Math.max(left, Math.min(paneRight(), term.cols));
      return new Array(left + 1).join(' ') + row.slice(left, right) +
        new Array(term.cols - right + 1).join(' ');
    }
    function burstDisplaced() {
      if (!s.predicted) return false;
      var buffer = term.buffer.active, gridRow = buffer.baseY + buffer.cursorY;
      if (s.predicted.absRow === gridRow || s.predicted.offGrid) return false;
      return !!s.predicted.offRowAt && performance.now() - s.predicted.offRowAt > 60;
    }
    function handoff(kind) {
      trace(
        'handoff', kind, s.predicted && s.predicted.dirty ? 'drain' : 'drop',
        s.predicted && s.predicted.wrapped ? 'wrapped' : ''
      );
      var buffer = term.buffer.active;
      s.hold = {
        row: buffer.baseY + buffer.cursorY,
        col: buffer.cursorX,
        at: performance.now(),
        nav: kind === 'nav'
      };
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(function () { publish(dispatch({ type: 'hold-tick' })); }, 120);
      s.endMemo = null;
      if (s.predicted) s.predicted.pullPend = null;
      if (s.predicted && s.predicted.dirty && s.predicted.absRow === s.hold.row) {
        s.predicted.draining = true;
        s.predicted.drainRow = s.hold.row;
        s.predicted.drainCol = s.hold.col;
        s.predicted.drainBase = (fullRow(s.hold.row) || '').slice(0, s.hold.col);
        s.predicted.drainMissAt = 0;
      } else {
        s.predicted = null;
        s.lastEditAt = 0;
      }
      s.inputLen = 0;
      s.lineFresh = false;
    }
    function holdActive() {
      if (!s.hold) return false;
      var buffer = term.buffer.active, now = performance.now();
      var moved = buffer.baseY + buffer.cursorY !== s.hold.row || buffer.cursorX !== s.hold.col;
      if (moved && (s.hold.nav || now - s.lastDataAt > 60)) {
        trace('release', 'evidence');
        s.hold = null;
        return false;
      }
      if (now - s.hold.at > Math.min(900, Math.max(400, s.rttEma * 2))) {
        trace('release', 'timeout');
        s.hold = null;
        return false;
      }
      return true;
    }
    function holdTick() {
      holdTimer = 0;
      if (!s.hold) return;
      if (holdActive()) {
        holdTimer = setTimeout(function () { publish(dispatch({ type: 'hold-tick' })); }, 120);
      }
    }
    function lastToken(text, floor) {
      var space = text.lastIndexOf(' ');
      return space + 1 >= floor ? text.slice(space + 1) : '';
    }
    function markWrapLanded(absRow) { return reconciliation.markWrapLanded(absRow); }
    function armRelease() {
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(function () {
        releaseTimer = 0;
        publish(dispatch({ type: 'release-tick' }));
      }, display.cursorGrace + 20);
    }
    function touchEdit() {
      s.lastEditAt = performance.now();
      armRelease();
    }
    function armWrapLearn() {
      if (wrapLearnTimer) clearTimeout(wrapLearnTimer);
      wrapLearnTimer = setTimeout(function () {
        wrapLearnTimer = 0;
        publish(dispatch({ type: 'wrap-learn' }));
      }, 90);
    }
    function immutable(value) {
      if (!value || typeof value !== 'object') return value;
      var out = Array.isArray(value) ? [] : {};
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = immutable(value[key]);
      }
      return Object.freeze(out);
    }
    function inputSnapshot() {
      var out = {}, key;
      for (key in s) {
        if (Object.prototype.hasOwnProperty.call(s, key)) out[key] = s[key];
      }
      if (s.predicted) {
        out.predicted = Object.assign({}, s.predicted);
        if (s.predicted.pullPend) out.predicted.pullPend = Object.assign({}, s.predicted.pullPend);
      }
      if (s.wrapPend) out.wrapPend = Object.assign({}, s.wrapPend);
      if (s.wrapStyle) out.wrapStyle = Object.assign({}, s.wrapStyle);
      if (s.rideQueue) out.rideQueue = Object.assign({}, s.rideQueue);
      out.traceRing = s.traceRing.slice();
      return out;
    }
    function view() {
      return immutable({
        enabled: echoEnabled, safe: s.safe, app: s.app,
        top: s.top, bottom: s.bottom, left: s.left, right: s.right,
        predicted: s.predicted, edge: s.edge, boxShift: s.boxShift,
        lastEditAt: s.lastEditAt
      });
    }
    var sessionPort = {
      enabled: function () { return echoEnabled; },
      isSafe: function () { return s.safe; },
      paneTop: paneTop, paneBottom: paneBottom, paneLeft: paneLeft, paneRight: paneRight,
      fullRow: fullRow, trace: trace, effect: effect, reset: reset,
      startBurst: startBurst, burstDisplaced: burstDisplaced,
      handoff: handoff, holdActive: holdActive,
      lastToken: lastToken, markWrapLanded: markWrapLanded,
      touchEdit: touchEdit, submit: submit, armWrapLearn: armWrapLearn
    };
    var layout = deps.layout.create({
      model: MODEL, term: term, clock: performance, display: display, state: s, core: sessionPort
    });
    var navigation = deps.navigation.create({
      model: MODEL, term: term, layout: layout, state: s, core: sessionPort
    });
    var input = deps.actions.create({
      model: MODEL, term: term, clock: performance,
      layout: layout, navigation: navigation, state: s, core: sessionPort
    });
    var reconciliation = deps.reconcile.create({
      model: MODEL, term: term, clock: performance, display: display,
      layout: layout, state: s, core: sessionPort
    });

    function dispatch(event) {
      if (effects) throw new Error('prediction session dispatch is not reentrant');
      if (!event || typeof event.type !== 'string') {
        throw new Error('prediction session event needs a type');
      }
      var rollback = event.type === 'input' ? inputSnapshot() : null;
      effects = [];
      try {
        if (event.type === 'input') input.predict(event.command);
        else if (event.type === 'gate') applyGate(event.gate);
        else if (event.type === 'disconnect') predictorEvent({ type: 'disconnect' });
        else if (event.type === 'resize') {
          trace('resize', term.cols + 'x' + term.rows);
          predictorEvent({ type: 'resize' });
        } else if (event.type === 'reset') reset(event.reason || '');
        else if (event.type === 'data') s.lastDataAt = event.at;
        else if (event.type === 'reconcile') reconciliation.reconcile();
        else if (event.type === 'hold-tick') holdTick();
        else if (event.type === 'wrap-learn') {
          reconciliation.learnWrap();
          if (s.wrapPend) armWrapLearn();
        } else if (event.type === 'release-tick') {
          reconciliation.reconcile();
          if (echoEnabled && (s.predicted !== null ||
              performance.now() - s.lastEditAt < display.cursorGrace)) armRelease();
        } else if (event.type !== 'paint') {
          throw new Error('unknown prediction session event: ' + event.type);
        }
        var nextView = view();
        effect({ type: 'render', view: nextView });
        return Object.freeze({ view: nextView, effects: Object.freeze(effects.slice()) });
      } catch (error) {
        if (rollback) Object.assign(s, rollback);
        throw error;
      } finally {
        effects = null;
      }
    }

    if (echoEnabled && params.get('probe') === '1') {
      window.__ehPredict = {
        get safe() { return s.safe; },
        get burst() {
          return s.predicted && {
            row: s.predicted.absRow, line: s.predicted.line, tail: s.predicted.tail,
            floor: s.predicted.floor, end: s.predicted.end,
            proven: s.predicted.proven, dirty: s.predicted.dirty,
            draining: s.predicted.draining, wrapped: s.predicted.wrapped,
            offGrid: s.predicted.offGrid, matched: s.predicted.matched,
            wrapKept: s.predicted.wrapKept, pullPend: !!s.predicted.pullPend
          };
        },
        get hold() { return s.hold && { row: s.hold.row, col: s.hold.col, nav: s.hold.nav }; },
        get reflow() { return s.predicted && s.predicted.reflow ? immutable(s.predicted.reflow.paint) : null; },
        get app() { return s.app; },
        get words() { return s.wordRuleName; },
        get wrap() {
          return s.wrapStyle && {
            atLen: s.wrapStyle.atLen, indent: s.wrapStyle.indent,
            pull: s.wrapStyle.pull, down: s.wrapStyle.down, lazy: s.wrapStyle.lazy,
            spacePull: s.wrapStyle.spacePull
          };
        },
        get pend() {
          return s.wrapPend && {
            row: s.wrapPend.row, col: s.wrapPend.col, word: s.wrapPend.word,
            moved: s.wrapPend.moved, trigger: s.wrapPend.trigger
          };
        },
        get quiet() { return Math.round(performance.now() - s.lastDataAt); },
        get edge() { return s.edge && { row: s.edge.absRow, col: s.edge.col, text: s.edge.text }; },
        get box() {
          return s.boxShift && {
            from: s.boxShift.from, to: s.boxShift.to, delta: s.boxShift.delta,
            text: s.boxShift.text, textRow: s.boxShift.textRow, wipeRow: s.boxShift.wipeRow
          };
        },
        get inputLen() { return s.inputLen; },
        get fresh() { return s.lineFresh; },
        get owning() { return display.owning(); },
        get rtt() { return s.rttEma; },
        get col() { return term.buffer.active.cursorX; },
        get row() { var buffer = term.buffer.active; return buffer.baseY + buffer.cursorY; },
        get baseY() { return term.buffer.active.baseY; },
        get rows() { return term.rows; },
        get cols() { return term.cols; },
        get top() { return paneTop(); },
        get bottom() { return paneBottom(); },
        get left() { return paneLeft(); },
        get right() { return paneRight(); },
        get trace() {
          return {
            sequence: s.traceSequence,
            deaths: s.traceDeaths,
            entries: s.traceRing.slice()
          };
        },
        text: function (row) {
          var line = term.buffer.active.getLine(row);
          return line ? line.translateToString(false, 0, term.cols) : null;
        }
      };
    }

    return { dispatch: dispatch, view: view };
  }
  return { create: create };
})();
