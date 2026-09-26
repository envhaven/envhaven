// Pane, prompt, and wrap geometry for one prediction session.
var EnvHavenConsoleLayout = (function () {
  function create(deps) {
    var MODEL = deps.model, term = deps.term, display = deps.display, performance = deps.clock;
    var core = deps.core, s = deps.state;

    function isLetter(c) { return MODEL.isLetter(c); }
    function promptShaped(p) { return MODEL.promptShaped(p); }
    function paneLeft() { return geometry.paneLeft(); }
    function paneRight() { return geometry.paneRight(); }
    function paneTop() { return geometry.paneTop(); }
    function paneBottom() { return geometry.paneBottom(); }
    function paneWidth() { return geometry.paneWidth(); }
    function rowWithinPane(row) { return geometry.rowWithinPane(row); }
    function colWithinPane(col) { return geometry.colWithinPane(col); }
    function rowsThroughPane(row) { return geometry.rowsThroughPane(row); }
    function borderSkip(row) { return MODEL.borderSkip(row); }
    function textStart(row) { return MODEL.textStart(row); }
    function textEnd(row) { return MODEL.textEnd(row); }
    function rowIsFull(row) { return geometry.rowIsFull(row); }
    function isFrameRow(row) { return geometry.isFrameRow(row); }
    function boxTop(row) { return geometry.boxTop(row); }
    function frameEnd(row) { return geometry.frameEnd(row); }
    function roomBelow(end) { return geometry.roomBelow(end); }
    function repeatSp(n) { return new Array(Math.max(0, n) + 1).join(' '); }

    // A wrapped draft has one string and offsets into it. Screen rows are a layout
    // of that string, never independently edited copies of its suffix.
    function wrapDraft(text, first, continuation, limit) {
      var rows = [], start = 0;
      for (;;) {
        var prefix = rows.length ? continuation : first;
        var end = Math.min(text.length, start + limit - prefix.length), next = end;
        var newline = text.indexOf('\n', start);
        if (newline >= 0 && newline <= end) {
          end = newline;
          next = end + 1;
        } else if (end < text.length) {
          // A non-final word also needs room for its separator. Otherwise an
          // exact-edge word belongs to the following row when the editor reflows.
          var space = text.lastIndexOf(' ', end - 1);
          var wordEnd = text.indexOf(' ', end);
          if (wordEnd < 0) wordEnd = text.length;
          if (newline >= 0) wordEnd = Math.min(wordEnd, newline);
          // An overlong token must split anyway, so it uses the current row's
          // remaining cells rather than leaving a hole before the first chunk.
          if (space >= start && wordEnd - space - 1 <= limit - continuation.length) {
            end = space;
            next = space + 1;
          }
        }
        rows.push({ start: start, end: end, next: next, prefix: prefix, text: prefix + text.slice(start, end) });
        if (end === text.length) return rows;
        if (next <= start) return null;
        start = next;
      }
    }
    function readDraft() {
      if (s.predicted.reflow) return s.predicted.reflow;
      if (!s.wrapStyle || !s.wrapStyle.pull || s.wrapStyle.lazy || s.boxShift || s.edge) return null;
      var current = s.predicted.absRow, top = current, row = s.predicted.line + s.predicted.tail;
      var indent = s.wrapStyle.indent, limit = s.wrapStyle.atLen;
      if (limit <= indent || (rowEdge(row) === null && row.trim())) return null;
      while (!rowIsPrompt(row)) {
        if (!rowWithinPane(top - 1)) return null;
        var above = core.fullRow(top - 1);
        if (isFrameRow(above)) break;
        if (above === null || (rowEdge(above) === null && above.trim())) return null;
        row = above;
        top--;
      }
      var first = row.slice(0, rowEdge(row)), continuation = leftChrome(row, indent);
      var source = [], contents = [], end = top;
      for (; rowWithinPane(end); end++) {
        row = end === current ? s.predicted.line + s.predicted.tail : core.fullRow(end);
        if (row === null || isFrameRow(row) || (end > top && rowIsPrompt(row))) break;
        var prefix = end === top ? first : continuation;
        if (row.slice(0, prefix.length) !== prefix || textEnd(row) > limit) break;
        source.push(core.fullRow(end));
        contents.push(row.slice(prefix.length, end === current ? s.predicted.end : textEnd(row)));
      }
      if (contents.length < 2 || current >= end) return null;
      var text = contents[0];
      for (var i = 1; i < contents.length; i++) {
        var previousWidth = (i === 1 ? first : continuation).length + contents[i - 1].length;
        // A full row cannot tell us whether its seam was a space or part of an
        // unbroken token. Do not invent a character at that boundary.
        if (previousWidth >= limit) return null;
        var word = (contents[i].match(/^[^ ]*/) || [''])[0];
        var separator = contents[i].length > word.length || i + 1 < contents.length ? 1 : 0;
        text += previousWidth + 1 + word.length + separator > limit ? ' ' : '\n';
        text += contents[i];
      }
      var rows = wrapDraft(text, first, continuation, limit);
      if (!rows || rows.length !== contents.length) return null;
      for (i = 0; i < rows.length; i++) {
        if (rows[i].text !== (i ? continuation : first) + contents[i]) return null;
      }
      var footer = frameEnd(end - 1), header = boxTop(top);
      // Without both frame boundaries, an indented status line is indistinguishable
      // from another input row. Leave those editors on the existing local-row path.
      if (header < 0 || footer < 0) return null;
      var down = s.wrapStyle.down;
      if (down === null) down = footer >= 0 && roomBelow(footer) &&
        rowsThroughPane(footer + 1) < ((paneBottom() - paneTop()) >> 1);
      var chromeFrom = down ? end : header, chromeTo = down ? footer : top - 1, chrome = [];
      for (i = chromeFrom; i >= 0 && i <= chromeTo; i++) chrome.push(core.fullRow(i));
      return { text: text, rows: rows, top: top, originalTop: top, originalEnd: end,
        first: first, continuation: continuation, limit: limit, down: down,
        chromeFrom: chromeFrom, chromeTo: chromeTo, chrome: chrome,
        source: source };
    }
    function draftCursor(draft) {
      var row = draft.rows[s.predicted.absRow - draft.top];
      return row ? row.start + s.predicted.line.length - row.prefix.length : -1;
    }
    function writeDraft(draft, text, cursor) {
      var rows = wrapDraft(text, draft.first, draft.continuation, draft.limit);
      if (!rows) return false;
      var delta = rows.length - (draft.originalEnd - draft.originalTop);
      var top = draft.originalTop - (draft.down ? 0 : delta);
      var chromeDelta = draft.down ? delta : -delta;
      if (!rowWithinPane(top) || !rowWithinPane(top + rows.length - 1)) return false;
      if (delta && (draft.chromeFrom < 0 || draft.chromeTo < draft.chromeFrom ||
          !rowWithinPane(draft.chromeFrom + chromeDelta) || !rowWithinPane(draft.chromeTo + chromeDelta))) return false;
      var from = Math.min(draft.originalTop, top), to = Math.max(draft.originalEnd, top + rows.length);
      if (delta) {
        from = Math.min(from, draft.chromeFrom, draft.chromeFrom + chromeDelta);
        to = Math.max(to, draft.chromeTo + 1, draft.chromeTo + chromeDelta + 1);
      }
      var paint = [], selected = 0;
      for (var r = from; r < to; r++) {
        var index = r - top, chrome = delta && r >= draft.chromeFrom + chromeDelta && r <= draft.chromeTo + chromeDelta;
        var original = core.fullRow(r);
        if (original === null) return false;
        var value = repeatSp(term.cols);
        if (index >= 0 && index < rows.length) {
          value = rowAfterWrap(rows[index].text, draft.source[Math.min(index, draft.source.length - 1)]);
        } else if (chrome) {
          value = draft.chrome[r - chromeDelta - draft.chromeFrom];
        }
        paint.push({ row: r, text: value, chrome: !!chrome,
          clear: !chrome && (index < 0 || index >= rows.length),
          was: draft.source[r - draft.originalTop] || draft.chrome[r - draft.chromeFrom] || original });
      }
      for (var j = 1; j < rows.length; j++) if (cursor >= rows[j].start) selected = j;
      var active = rows[selected], col = active.prefix.length + cursor - active.start;
      if (col > draft.limit) return false;
      s.predicted.reflow = Object.assign({}, draft, {
        text: text, rows: rows, top: top, paint: paint
      });
      s.predicted.absRow = top + selected;
      s.predicted.line = active.text.slice(0, col);
      s.predicted.tail = rowAfterWrap(active.text, draft.source[Math.min(selected, draft.source.length - 1)]).slice(col);
      s.predicted.floor = active.prefix.length;
      s.predicted.end = active.text.length;
      s.predicted.proven = false;
      s.predicted.offGrid = true;
      s.predicted.walked = true;
      s.boxShift = delta ? { from: draft.chromeFrom, to: draft.chromeTo, delta: chromeDelta,
        text: null, textRow: -1, wipeRow: -1, was: core.fullRow(draft.chromeFrom), at: performance.now() } : null;
      return true;
    }

    var geometry = MODEL.createGeometry({
      cols: function () { return term.cols; },
      rows: function () { return term.rows; },
      baseY: function () { return term.buffer.active.baseY; },
      paneTop: function () { return core.paneTop(); },
      paneBottom: function () { return core.paneBottom(); },
      paneLeft: function () { return core.paneLeft(); },
      paneRight: function () { return core.paneRight(); },
      row: function (index) { return core.fullRow(index); }
    });

    function learnPrompt(line, row, col) {
      if (s.promptStr !== null || s.inputLen !== 0 || col <= paneLeft()) return;
      if (!s.lineFresh && !draftEmpty(line, col)) return;
      var at = Math.max(borderSkip(row), paneLeft());
      var prompt = row.slice(at, col);
      if (promptShaped(prompt)) s.promptStr = prompt;
    }
    function draftEmpty(line, col) {
      var found = firstInk(line, col);
      return !found || found.cell.isDim() || !found.cell.isFgDefault();
    }
    function firstInk(line, col) {
      var cell = null, char;
      for (var x = col; line && x < paneRight(); x++) {
        cell = line.getCell(x, cell || undefined);
        if (!cell) return null;
        char = cell.getChars();
        if (char !== '' && char !== ' ') return { cell: cell, x: x };
      }
      return null;
    }
    function ghostAt(absRow, col, row) {
      if (s.inputLen > 0) return false;
      var edge = rowEdge(row);
      // Without an edge, only a fresh line proves the cursor sits at the input's start.
      // Later, styled cells right of it are highlighted input or a suggestion.
      if (edge === null ? !s.lineFresh : col > edge) return false;
      var buffer = term.buffer.active, found = firstInk(buffer.getLine(absRow), col);
      if (!found) return false;
      if (found.cell.isDim()) return true;
      if (found.cell.isFgDefault()) return false;
      return !display.inputForeground() ||
        display.cellForeground(absRow - buffer.baseY, found.x) !== display.inputForeground();
    }
    function spaceish(c) { return c === 0x20 || c === 0xa0; }
    function promptAt(row) {
      if (s.promptStr === null) return -1;
      var at = Math.max(borderSkip(row), paneLeft());
      if (at + s.promptStr.length > row.length) return -1;
      for (var k = 0; k < s.promptStr.length; k++) {
        var actual = row.charCodeAt(at + k), expected = s.promptStr.charCodeAt(k);
        if (actual !== expected && !(spaceish(actual) && spaceish(expected))) return -1;
      }
      return at;
    }
    function rowIsPrompt(row) { return promptAt(row) !== -1; }
    function rowEdge(row) {
      var at = promptAt(row);
      if (at !== -1) return at + s.promptStr.length;
      if (s.wrapStyle && s.wrapStyle.pull) {
        var indent = textStart(row);
        if (indent === s.wrapStyle.indent) return indent;
      }
      if (s.promptStr === null) {
        // A composer border is one box glyph and then its gutter. Prompt art such as
        // Parrot's '└──╼ $ ' also opens with a box glyph, and it is no input edge.
        var skip = borderSkip(row);
        if (skip > 0 && row.charAt(skip - 1) === ' ' && skip < row.length && !isFrameRow(row)) return skip;
      }
      return null;
    }
    function burstStartsInput() {
      var row = s.predicted.line + s.predicted.tail;
      if (rowIsPrompt(row)) return true;
      if (s.promptStr !== null || borderSkip(row) === 0) return false;
      var up = s.predicted.absRow - 1;
      return !rowWithinPane(up) || rowEdge(core.fullRow(up) || '') === null;
    }
    function leftChrome(row, indent) {
      var at = Math.min(borderSkip(row), indent);
      return row.slice(0, at) + repeatSp(indent - at);
    }
    function rowAfterWrap(text, row) {
      var at = s.wrapStyle ? s.wrapStyle.atLen : paneRight();
      return (text + repeatSp(term.cols)).slice(0, at) + row.slice(at);
    }
    function frameUp(row, kept) {
      var top = boxTop(row);
      if (top < 0 || top === row || !rowWithinPane(top - 1)) return null;
      return { from: top, to: row - 1, delta: -1, text: kept, textRow: row - 1,
        wipeRow: -1, was: core.fullRow(top), at: performance.now() };
    }
    function frameDown(row, end) {
      if (end < 0) return null;
      return { from: row + 1, to: end, delta: 1, text: null, textRow: -1,
        wipeRow: row + 1, was: core.fullRow(row + 1), at: performance.now() };
    }
    function crossUpInfo() {
      var up = s.predicted.absRow - 1;
      if (!rowWithinPane(up)) return null;
      var row = s.predicted.line + s.predicted.tail;
      var previous = core.fullRow(up);
      if (previous === null) return null;
      var previousEnd = textEnd(previous);
      if (s.wrapStyle && s.wrapStyle.pull) {
        if (rowIsPrompt(row) || rowEdge(row) !== s.wrapStyle.indent ||
            isFrameRow(previous) || rowEdge(previous) === null) return null;
        return { row: up, col: Math.min(previousEnd, paneRight() - 1), sep: ' ' };
      }
      if (s.predicted.floor === paneLeft() && previousEnd === paneRight()) {
        return { row: up, col: paneRight() - 1, sep: previous[paneRight() - 1] };
      }
      return null;
    }
    function crossDownInfo() {
      var down = s.predicted.absRow + 1;
      if (!rowWithinPane(down)) return null;
      var next = core.fullRow(down);
      if (next === null) return null;
      if (s.wrapStyle && s.wrapStyle.pull) {
        var edge = rowEdge(next);
        if (edge === null || rowIsPrompt(next) || !isLetter(next[edge])) return null;
        return { row: down, col: edge, sep: ' ' };
      }
      if (rowIsFull(s.predicted.line + s.predicted.tail)) {
        return { row: down, col: paneLeft(), sep: null };
      }
      return null;
    }
    function setEnd() {
      s.predicted.end = Math.max(s.predicted.line.length, textEnd(s.predicted.line + s.predicted.tail));
    }
    function rebaseTo(row, col) {
      var text = core.fullRow(row) || repeatSp(term.cols);
      s.predicted.absRow = row;
      s.predicted.line = text.slice(0, col);
      s.predicted.tail = text.slice(col);
      setEnd();
      s.predicted.pullPend = null;
      var edge = rowEdge(text);
      s.predicted.floor = edge !== null ? edge : paneLeft();
      s.predicted.proven = false;
      s.predicted.offGrid = true;
      s.predicted.walked = true;
    }
    function commitLeft(index) {
      if (index < s.predicted.line.length) s.predicted.walked = true;
      s.predicted.tail = s.predicted.line.slice(index) + s.predicted.tail;
      s.predicted.line = s.predicted.line.slice(0, index);
    }
    function moveStop() {
      if (s.predicted.proven) return s.predicted.floor;
      var edge = rowEdge(s.predicted.line + s.predicted.tail);
      return edge !== null ? edge : paneLeft();
    }
    function dropBurst(row, lead, floor, tail) {
      s.predicted.absRow = row;
      s.predicted.line = lead;
      s.predicted.floor = floor;
      s.predicted.tail = tail;
      setEnd();
      s.predicted.offGrid = true;
    }
    function edgeAt(absRow, col, text, was) {
      return { absRow: absRow, col: col, text: text, was: was, at: performance.now() };
    }
    function reflowRisk(count) {
      var row = s.predicted.line + s.predicted.tail;
      var pull = s.wrapStyle && s.wrapStyle.pull;
      if (pull) {
        if (rowIsPrompt(row) || rowEdge(row) !== s.wrapStyle.indent) return false;
      } else if (s.predicted.floor > paneLeft()) {
        return false;
      }
      var buffer = term.buffer.active;
      if (s.predicted.absRow - buffer.baseY < 1) return true;
      var previous = rowWithinPane(s.predicted.absRow - 1) ? core.fullRow(s.predicted.absRow - 1) : null;
      if (previous === null) return true;
      if (pull && (rowEdge(previous) === null || isFrameRow(previous))) return false;
      var indent = pull ? s.wrapStyle.indent : paneLeft();
      var content = textEnd(row) - indent;
      var limit = pull ? s.wrapStyle.atLen : paneRight();
      return textEnd(previous) + 1 + (content - count) <= limit;
    }
    function rowAboveHoldsLine(curAbs, line) {
      var above = rowWithinPane(curAbs - 1) ? core.fullRow(curAbs - 1) : null;
      if (above === null) return false;
      var text = above.slice(0, textEnd(above)), lead = borderSkip(above);
      return text.length > lead + 8 && line.indexOf(text) === 0;
    }
    function echoTrails(curAbs, curCol, line) {
      var row = line ? core.fullRow(curAbs) : null;
      return curAbs === s.predicted.absRow && curCol <= s.predicted.line.length && row !== null &&
        row.slice(0, curCol) === s.predicted.line.slice(0, curCol);
    }
    function paneWrappedUnderUs() {
      if (!s.predicted || s.wrapStyle || s.predicted.offGrid || s.predicted.draining) return -1;
      var buffer = term.buffer.active, row = buffer.baseY + buffer.cursorY, col = buffer.cursorX;
      return row === s.predicted.absRow && s.predicted.line.length - col > 8 &&
        s.predicted.line.length > s.predicted.floor + Math.max(16, paneWidth() >> 2) &&
        (!echoTrails(row, col, buffer.getLine(row)) || rowAboveHoldsLine(row, s.predicted.line)) ? row : -1;
    }
    function wrapUnresolved(curAbs, curCol) {
      if (s.predicted.offGrid && curAbs > s.predicted.wrapRow + 1) return true;
      if (curAbs !== s.predicted.wrapRow || curCol > s.predicted.wrapCol) return false;
      var above = s.predicted.wrapKept ? core.fullRow(s.predicted.wrapRow - 1) : null;
      return !(above !== null && above.slice(0, textEnd(above)) === s.predicted.wrapKept);
    }

    return {
      readDraft: readDraft, writeDraft: writeDraft, draftCursor: draftCursor,
      learnPrompt: learnPrompt, ghostAt: ghostAt,
      paneLeft: paneLeft, paneRight: paneRight, paneTop: paneTop, paneBottom: paneBottom,
      rowWithinPane: rowWithinPane, colWithinPane: colWithinPane,
      rowsThroughPane: rowsThroughPane, rowEdge: rowEdge,
      rowIsPrompt: rowIsPrompt,
      burstStartsInput: burstStartsInput, textStart: textStart, textEnd: textEnd,
      rowIsFull: rowIsFull, leftChrome: leftChrome, rowAfterWrap: rowAfterWrap,
      isFrameRow: isFrameRow, frameUp: frameUp, frameDown: frameDown,
      frameEnd: frameEnd, roomBelow: roomBelow, crossUpInfo: crossUpInfo,
      crossDownInfo: crossDownInfo, repeatSp: repeatSp, dropBurst: dropBurst,
      rebaseTo: rebaseTo, commitLeft: commitLeft, moveStop: moveStop,
      edgeAt: edgeAt, reflowRisk: reflowRisk, rowAboveHoldsLine: rowAboveHoldsLine,
      echoTrails: echoTrails, paneWrappedUnderUs: paneWrappedUnderUs,
      wrapUnresolved: wrapUnresolved
    };
  }
  return { create: create };
})();
