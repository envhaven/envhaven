// Reconcile one session's predictions against the authoritative terminal grid.
var EnvHavenConsoleReconcile = (function () {
  function create(deps) {
    var MODEL = deps.model, term = deps.term, performance = deps.clock;
    var display = deps.display, layout = deps.layout;
    var core = deps.core, s = deps.state;

    function fullRow(row) { return core.fullRow(row); }
    function paneLeft() { return core.paneLeft(); }
    function paneRight() { return core.paneRight(); }
    function currentApp() { return s.app; }
    function tuiRow(app) { return MODEL.tuiRow(app); }
    function lastToken(text, floor) { return core.lastToken(text, floor); }
    function trace() { return core.trace.apply(null, arguments); }
    function reset(reason) { return core.reset(reason); }
    function effect(value) { return core.effect(value); }

    // A ridden wrap teaches the next wrap from the settled pane geometry.
    function learnWrap() {
      if (!s.wrapPend) return;
      if (performance.now() - s.wrapPend.at > 2500) {
        s.wrapPend = null;
        return;
      }
      var buffer = term.buffer.active, curAbs = buffer.baseY + buffer.cursorY, curCol = buffer.cursorX;
      var delta = curAbs - s.wrapPend.row;
      if (delta === 0 && curCol > s.wrapPend.col) {
        var ridden = fullRow(curAbs);
        if (ridden !== null) {
          s.wrapPend.col = curCol;
          s.wrapPend.line = ridden.slice(0, curCol);
          s.wrapPend.word = lastToken(s.wrapPend.line, 0);
        }
        return;
      }
      var row0 = fullRow(curAbs);
      var lagging = delta === 0 && row0 !== null &&
        row0.slice(0, curCol) === s.wrapPend.line.slice(0, curCol) &&
        !layout.rowAboveHoldsLine(curAbs, s.wrapPend.line);
      var landed = delta === 1 || (delta === 0 && curCol < s.wrapPend.col && !lagging);
      if (landed && s.wrapPend.moved === null) markWrapLanded(curAbs);
      if (!landed) return;
      var row = row0;
      var previous = layout.rowWithinPane(curAbs - 1) ? fullRow(curAbs - 1) : null;
      if (row === null || previous === null) return;
      var now = performance.now();
      if (now - s.lastDataAt <= 60) {
        if (s.wrapPend.prevSeen !== previous) {
          s.wrapPend.prevSeen = previous;
          s.wrapPend.seenAt = now;
          return;
        }
        if (now - s.wrapPend.seenAt < 90) return;
      }
      var seed = tuiRow(currentApp());
      var shape = wrapShape(row, previous, delta, curCol, s.wrapPend, seed);
      if (!shape) return;
      s.wrapStyle = {
        atLen: shape.atLen,
        indent: shape.indent,
        pull: shape.pull,
        down: shape.pull && MODEL.learnedWrapDown(currentApp(), delta),
        lazy: !!(shape.pull && seed && seed.lazy),
        spacePull: !!(shape.pull && seed && seed.spacePull),
        flipped: false
      };
      trace('learned', currentApp(), 'atLen', shape.atLen, 'indent', shape.indent, shape.pull ? 'pull' : 'hard');
      s.wrapPend = null;
    }
    function wrapShape(row, previous, delta, curCol, pending, seed) {
      var previousFull = layout.rowIsFull(previous);
      var previousEnd = layout.textEnd(previous);
      var indent = layout.textStart(row);
      var pull, atLen;
      if (indent === -1) {
        if (delta !== 1 || curCol !== paneLeft()) return null;
        pull = false;
        indent = paneLeft();
        atLen = paneRight() - 1;
      } else if (previousFull) {
        if (curCol < indent) return null;
        pull = false;
        indent = paneLeft();
        atLen = paneRight() - 1;
      } else {
        if (curCol < indent) return null;
        pull = true;
        if (pending.trigger === ' ' && seed && !seed.spacePull) {
          // This edge space opens an empty continuation, so no moved word can anchor it.
          atLen = previousEnd;
        } else {
          var first = firstToken(row.slice(indent));
          if (!pending.word || first.indexOf(pending.word) !== 0) return null;
          var moved = pending.moved || first;
          atLen = previousEnd + moved.length + (pending.trigger === ' ' ? 1 : 0);
        }
      }
      if (atLen - paneLeft() < Math.max(16, Math.floor((paneRight() - paneLeft()) / 3)) ||
          atLen > paneRight()) return null;
      return { pull: pull, indent: indent, atLen: atLen };
    }
    // The anchor is what the ride moved: the word a pull carried, or nothing for an edge
    // space that opened an empty continuation. A landing frame can already echo queued
    // keys, so it only confirms that word. A detected wrap has queued nothing yet, so its
    // frame is exact. A hard wrap moves no word: its trigger stays in the old row's last
    // column, unless that row was already full and the trigger moved on alone.
    function markWrapLanded(absRow) {
      var row = fullRow(absRow), indent = row === null ? -1 : layout.textStart(row);
      var first = indent === -1 ? '' : firstToken(row.slice(indent)), pend = s.wrapPend;
      var moved = pend.own;
      if (!pend.trigger) moved = first;
      else if (pend.hard) {
        var keptTrigger = (fullRow(absRow - 1) || '').replace(/ +$/, '').slice(-1) === pend.trigger;
        moved = pend.trigger === ' ' || keptTrigger ? '' : pend.trigger;
      } else if (!moved || first.indexOf(moved) !== 0) moved = pend.trigger === ' ' ? '' : first;
      // Learning needs the word the pane itself moved. A row that grew after the ride wrapped
      // later than the ride, so that word is the frame's. codex's lazy edge grows by its
      // trigger on every wrap and still moves the ride's word.
      var grew = pend.col > pend.cut - pend.trigger.length;
      pend.moved = grew && !(tuiRow(currentApp()) || {}).lazy ? first : moved;
      if (s.rideQueue) {
        // The replay reads every cell after the anchor as a queued key, so the queue starts
        // with what the ride had already sent after it: keys still in flight, the rest of
        // a multi-character insert, the space a pull carries behind its word. The ride's
        // own word ends where the ride put it, never inside that rest.
        var at = moved && !pend.hard ?
          pend.sent.lastIndexOf(moved, moved === pend.own ? pend.cut - moved.length : Infinity) : -1;
        at = at >= 0 ? at + moved.length : pend.trigger === ' ' || pend.hard ? pend.cut : -1;
        s.rideQueue.text = (at >= 0 ? pend.sent.slice(at) : '') + s.rideQueue.text;
        s.rideQueue.moved = moved;
      }
      pend.at = performance.now();
    }
    function firstToken(text) {
      var space = text.indexOf(' ');
      return space === -1 ? text : text.slice(0, space);
    }
    function keptLanded() {
      if (s.boxShift.text === null || s.boxShift.textRow < 0) return false;
      var row = fullRow(s.boxShift.textRow);
      return row !== null && row.replace(/ +$/, '') === s.boxShift.text.replace(/ +$/, '');
    }

    function reconcile() {
      if (s.edge) {
        var edgeLine = term.buffer.active.getLine(s.edge.absRow);
        var edgeCell = edgeLine ? edgeLine.translateToString(false, s.edge.col, s.edge.col + s.edge.text.length) : '';
        var edgeTrimmed = edgeCell.replace(/ +$/, ''), oldTrimmed = s.edge.was.replace(/ +$/, '');
        var behind = edgeTrimmed !== '' && oldTrimmed.indexOf(edgeTrimmed) === 0;
        if ((edgeCell !== s.edge.was && !behind) || performance.now() - s.edge.at > 2000) s.edge = null;
      }
      if (s.boxShift && !(s.predicted && s.predicted.reflow) && (!s.predicted || !s.predicted.wrapAt || fullRow(s.boxShift.from) !== s.boxShift.was ||
          keptLanded() || performance.now() - s.boxShift.at > 2000)) {
        s.boxShift = null;
      }
      learnWrap();
      if (!s.predicted) return;

      var buffer = term.buffer.active, curAbs = buffer.baseY + buffer.cursorY, curCol = buffer.cursorX;
      var line = buffer.getLine(curAbs);
      if (curAbs !== s.predicted.absRow) {
        if (!s.predicted.offRowAt) s.predicted.offRowAt = performance.now();
      } else {
        s.predicted.offRowAt = 0;
      }
      var trails = layout.echoTrails(curAbs, curCol, line);
      var match = trails && curCol === s.predicted.line.length;
      // A cursor can revisit the same column before the edits that put it there
      // have echoed. Confirm the known suffix too, rather than losing it to an
      // older typing frame that happens to share our prefix and cursor.
      if (match && s.predicted.walked) {
        match = (fullRow(curAbs) || '').slice(0, s.predicted.end) ===
          (s.predicted.line + s.predicted.tail).slice(0, s.predicted.end);
      }
      if (match && s.predicted.reflow) {
        var draft = s.predicted.reflow;
        for (var i = 0; i < draft.paint.length; i++) {
          var row = draft.paint[i], actual = fullRow(row.row);
          if (actual !== row.text && !(row.clear && actual !== row.was)) { match = false; break; }
        }
      }
      var now = performance.now();
      var deadline = s.rttEma ? Math.max(display.cursorGrace, s.rttEma * 3) : 800;
      if (s.predicted.wrapped || s.predicted.slowOp) deadline = Math.max(deadline, s.rttEma * 12);

      if (s.predicted.draining) {
        if (match) {
          trace('drain-end', 'match');
          s.predicted = null;
          return;
        }
        var rowNow = (fullRow(s.predicted.drainRow) || '').slice(0, s.predicted.drainCol);
        if (rowNow !== s.predicted.drainBase) {
          trace('drain-end', 'content');
          s.predicted = null;
          return;
        }
        if (curAbs !== s.predicted.drainRow || curCol !== s.predicted.drainCol) {
          if (!s.predicted.drainMissAt) s.predicted.drainMissAt = now;
          else if (now - s.predicted.drainMissAt > 60) {
            trace('drain-end', 'cursor');
            s.predicted = null;
            return;
          }
        } else {
          s.predicted.drainMissAt = 0;
        }
        if (now - s.lastEditAt > deadline) {
          s.wrapPend = null;
          trace('drain-deadline', 'dl:' + Math.round(deadline));
          reset('drain-deadline');
        }
        return;
      }

      if (trails) {
        // Tail adoption is valid only for insertion-only bursts. Once a cursor
        // move or deletion occurred, the two cursor positions no longer measure
        // pending insertions. Keep that distinction for the whole burst, even
        // across a transient match followed by older in-flight echoes.
        if (!s.predicted.walked) {
          var keep = term.cols - s.predicted.line.length;
          var scopedRow = fullRow(curAbs);
          var tail = scopedRow === null ? '' : scopedRow.slice(curCol, curCol + keep);
          if (tail.length === keep) {
            s.predicted.tail = tail;
            if (s.predicted.matched) {
              s.predicted.end = Math.max(
                s.predicted.end,
                layout.textEnd(s.predicted.line + s.predicted.tail)
              );
            }
          }
        }
        if (curCol !== s.predicted.openCol) s.predicted.matched = true;
        if (s.predicted.dirty && curCol > s.predicted.openCol) {
          effect({ type: 'queue-ink', row: curAbs, col: curCol - 1 });
        }
        if (!s.predicted.reflow) s.predicted.offGrid = false;
      }

      if (s.predicted.wrapAt && (trails || layout.wrapUnresolved(curAbs, curCol))) {
        s.predicted.wrapAt = now;
      }
      if (match) {
        if (s.predicted.reflow) s.boxShift = null;
        s.predicted.missAt = 0;
        if (s.predicted.wrapAt) {
          s.predicted.wrapAt = 0;
          s.boxShift = null;
          if (s.wrapStyle) s.wrapStyle.flipped = false;
        }
        if (!s.predicted.sampled && s.predicted.mismatched) {
          s.predicted.sampled = true;
          var echoTime = now - s.lastEditAt;
          s.rttEma = echoTime > s.rttEma ? echoTime : s.rttEma * 0.8 + echoTime * 0.2;
        }
        if (now - s.lastEditAt >= deadline) {
          trace('close', 'match');
          s.pendingPull = s.predicted.pullPend;
          s.endMemo = {
            absRow: s.predicted.absRow,
            text: (fullRow(s.predicted.absRow) || '').replace(/ +$/, ''),
            end: s.predicted.end
          };
          s.predicted = null;
        }
        return;
      }

      s.predicted.mismatched = true;
      if (!s.predicted.missAt) s.predicted.missAt = now;
      if (s.predicted.wrapAt && now - s.predicted.wrapAt > Math.max(900, deadline)) {
        if (s.wrapStyle && s.wrapStyle.pull && !s.wrapStyle.flipped) {
          s.wrapStyle.down = !s.wrapStyle.down;
          s.wrapStyle.flipped = true;
        } else {
          s.wrapStyle = null;
        }
        s.lineFresh = false;
        reset('wrap-deadline');
        return;
      }
      if (!s.predicted.dirty) {
        if (now - s.predicted.missAt > deadline && now - s.lastEditAt > deadline) {
          s.lineFresh = false;
          reset('move-mismatch');
        }
        return;
      }
      if (now - s.lastEditAt > deadline) {
        trace(
          'content-death',
          'row:' + (s.predicted.absRow - term.buffer.active.baseY),
          'len:' + s.predicted.line.length,
          'wrapped:' + (s.predicted.wrapped ? 1 : 0),
          'slow:' + (s.predicted.slowOp ? 1 : 0),
          'dl:' + Math.round(deadline),
          'age:' + Math.round(now - s.lastEditAt),
          'wake:' + Math.round(s.lastWrapAt + 2000 - now),
          'trails:' + (trails ? 1 : 0),
          'match:' + (match ? 1 : 0)
        );
        var ahead = curAbs === s.predicted.absRow && curCol > s.predicted.line.length;
        if (s.predicted.wrapped ||
            (s.wrapStyle && !ahead && s.predicted.line.length >= s.wrapStyle.atLen - 8)) {
          s.wrapStyle = null;
        }
        s.lineFresh = false;
        reset('content-deadline');
      }
    }

    return {
      reconcile: reconcile,
      learnWrap: learnWrap,
      markWrapLanded: markWrapLanded
    };
  }
  return { create: create };
})();
