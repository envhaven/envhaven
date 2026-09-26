// Cursor navigation for one prediction session.
var EnvHavenConsoleNavigation = (function () {
  function create(deps) {
    var MODEL = deps.model, term = deps.term, layout = deps.layout;
    var core = deps.core, s = deps.state;
    var paneRight = layout.paneRight, rowEdge = layout.rowEdge;
    var burstStartsInput = layout.burstStartsInput, textEnd = layout.textEnd;
    var isFrameRow = layout.isFrameRow, rowWithinPane = layout.rowWithinPane;
    var crossUpInfo = layout.crossUpInfo, crossDownInfo = layout.crossDownInfo;
    function wordScan() { return MODEL.wordScan(); }
    function wordLeft(text, index, floor, scan) { return MODEL.wordLeft(s.wordRule, text, index, floor, scan); }
    function seamJoins(separator, scan) { return MODEL.seamJoins(s.wordRule, separator, scan); }
    function wordRight(text, index, max, scan) { return MODEL.wordRight(s.wordRule, text, index, max, scan); }

    var rebaseTo = layout.rebaseTo, moveStop = layout.moveStop, commitLeft = layout.commitLeft;
    function draftMove(cursor) {
      var draft = s.predicted.reflow;
      if (!layout.writeDraft(draft, draft.text, cursor)) { core.handoff('nav'); return; }
      s.predicted.sampled = false;
      s.predicted.mismatched = false;
      core.touchEdit();
    }
    function commitRight(count) {
      s.predicted.line += s.predicted.tail.slice(0, count);
      s.predicted.tail = s.predicted.tail.slice(count);
      s.predicted.walked = true;
    }
    function stepLeft(byWord) {
      var hops = 0, scan = wordScan();
      for (;;) {
        var stop = moveStop(), index = s.predicted.line.length;
        if (!byWord) {
          if (index > stop) {
            commitLeft(index - 1);
            return 1;
          }
        } else {
          index = wordLeft(s.predicted.line, index, stop, scan);
          if (scan.landed) {
            commitLeft(index);
            return 1;
          }
        }
        if (s.predicted.proven) {
          if (byWord) commitLeft(stop);
          return 0;
        }
        var crossing = crossUpInfo();
        if (!crossing) {
          if (burstStartsInput()) {
            if (byWord) commitLeft(stop);
            return 0;
          }
          core.handoff('nav');
          return -1;
        }
        if (++hops > 4) {
          core.handoff('nav');
          return -1;
        }
        if (byWord && !seamJoins(crossing.sep, scan)) {
          commitLeft(stop);
          return 1;
        }
        rebaseTo(crossing.row, crossing.col);
        if (!byWord) return 1;
      }
    }
    function stepRight(byWord) {
      var hops = 0, moved = false, scan = wordScan();
      for (;;) {
        var index = s.predicted.line.length, max = s.predicted.end;
        if (!byWord) {
          if (max > index) {
            commitRight(1);
            moved = true;
          }
        } else {
          var next = wordRight(s.predicted.line + s.predicted.tail, index, max, scan);
          if (next > index) {
            commitRight(next - index);
            moved = true;
          }
          if (scan.landed) return 1;
        }
        if (s.predicted.line.length >= paneRight()) {
          var fullCrossing = crossDownInfo();
          if (!fullCrossing || ++hops > 4) {
            core.handoff('nav');
            return -1;
          }
          rebaseTo(fullCrossing.row, fullCrossing.col);
          if (!byWord) return 1;
          continue;
        }
        if (!byWord && moved) return 1;
        var crossing = crossDownInfo();
        if (!crossing) return moved ? 1 : 0;
        if (++hops > 4) {
          core.handoff('nav');
          return -1;
        }
        if (byWord && crossing.sep !== null) {
          if (scan.cls && s.wordRule.fwd === 'end') return 1;
          if (s.wordRule.delim) {
            rebaseTo(crossing.row, crossing.col);
            return 1;
          }
          scan.phase = 1;
        }
        rebaseTo(crossing.row, crossing.col);
        if (!byWord) return 1;
      }
    }
    function predictMove(direction, times, byWord) {
      if (core.burstDisplaced()) {
        core.handoff('heavy');
        return;
      }
      if (!s.predicted && !core.startBurst()) return;
      if (s.predicted.reflow) {
        var draft = s.predicted.reflow, cursor = layout.draftCursor(draft);
        for (var count = 0; count < times; count++) {
          if (byWord) cursor = direction < 0 ? wordLeft(draft.text, cursor, 0, wordScan()) :
            wordRight(draft.text, cursor, draft.text.length, wordScan());
          else cursor = Math.max(0, Math.min(draft.text.length, cursor + direction));
        }
        draftMove(cursor);
        return;
      }
      for (var index = 0; index < times; index++) {
        var result = direction < 0 ? stepLeft(byWord) : stepRight(byWord);
        if (result < 0) return;
        if (result === 0) break;
      }
      s.predicted.sampled = false;
      s.predicted.mismatched = false;
      core.touchEdit();
    }
    function predictHome() {
      if (core.burstDisplaced()) {
        core.handoff('heavy');
        return;
      }
      if (!s.predicted && !core.startBurst()) return;
      var landed = false;
      if (s.predicted.reflow) {
        var draft = s.predicted.reflow, cursor = layout.draftCursor(draft);
        // lastIndexOf clamps a negative start to 0, where a leading newline would match.
        draftMove(cursor > 0 ? draft.text.lastIndexOf('\n', cursor - 1) + 1 : 0);
        return;
      }
      if (s.predicted.proven) {
        commitLeft(s.predicted.floor);
        landed = true;
      } else {
        var row = s.predicted.line + s.predicted.tail;
        var edge = rowEdge(row);
        if (burstStartsInput() && edge !== null) {
          commitLeft(edge);
          landed = true;
        } else if (s.wrapStyle && s.wrapStyle.pull && edge === s.wrapStyle.indent) {
          var top = s.predicted.absRow;
          for (var previous = s.predicted.absRow - 1;
              rowWithinPane(previous) && s.predicted.absRow - previous <= 6; previous--) {
            var previousRow = core.fullRow(previous);
            if (previousRow === null) break;
            var previousEdge = rowEdge(previousRow);
            if (previousEdge !== null && layout.rowIsPrompt(previousRow)) {
              rebaseTo(previous, previousEdge);
              landed = true;
              break;
            }
            if (isFrameRow(previousRow)) {
              if (s.promptStr === null) {
                if (top === s.predicted.absRow) commitLeft(s.wrapStyle.indent);
                else rebaseTo(top, s.wrapStyle.indent);
                landed = true;
              }
              break;
            }
            if (previousEdge !== s.wrapStyle.indent) break;
            top = previous;
          }
        }
      }
      if (!landed) {
        core.handoff('nav');
        return;
      }
      s.predicted.sampled = false;
      s.predicted.mismatched = false;
      core.touchEdit();
    }
    function predictEnd() {
      if (s.predicted && s.predicted.reflow) {
        var draft = s.predicted.reflow, cursor = layout.draftCursor(draft);
        var end = draft.text.indexOf('\n', cursor);
        draftMove(end < 0 ? draft.text.length : end);
        return;
      }
      predictMove(1, term.rows * term.cols, false);
    }
    function predictVertical(direction, times) {
      if (core.burstDisplaced()) {
        core.handoff('heavy');
        return;
      }
      if (!s.predicted && !core.startBurst()) return;
      if (s.predicted.reflow) {
        var draft = s.predicted.reflow, target = s.predicted.absRow - draft.top + direction * times;
        // Past either end of the draft the key recalls history, which repaints the whole draft.
        if (target < 0 || target >= draft.rows.length) { core.handoff('heavy'); return; }
        var row = draft.rows[target];
        draftMove(row.start + Math.max(0, Math.min(s.predicted.line.length - row.prefix.length, row.end - row.start)));
        return;
      }
      if (!(s.wrapStyle && s.wrapStyle.pull)) {
        core.handoff('heavy');
        return;
      }
      for (var index = 0; index < times; index++) {
        var row = s.predicted.line + s.predicted.tail;
        if (direction < 0) {
          if (rowEdge(row) !== s.wrapStyle.indent || layout.rowIsPrompt(row)) {
            core.handoff('heavy');
            return;
          }
          var up = s.predicted.absRow - 1;
          var previous = rowWithinPane(up) ? core.fullRow(up) : null;
          if (previous === null || rowEdge(previous) === null) {
            core.handoff('heavy');
            return;
          }
          var col = s.predicted.line.length;
          if (col <= textEnd(previous)) rebaseTo(up, col);
          else commitLeft(s.wrapStyle.indent);
        } else {
          var crossing = crossDownInfo();
          if (!crossing) break;
          var next = core.fullRow(crossing.row) || '';
          rebaseTo(crossing.row, Math.max(crossing.col, Math.min(s.predicted.line.length, textEnd(next))));
        }
      }
      s.predicted.sampled = false;
      s.predicted.mismatched = false;
      core.touchEdit();
    }

    return {
      move: predictMove,
      home: predictHome,
      end: predictEnd,
      vertical: predictVertical
    };
  }
  return { create: create };
})();
