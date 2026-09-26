// Input edits for one prediction session. The controller dispatches commands here.
var EnvHavenConsoleActions = (function () {
  function create(deps) {
    var MODEL = deps.model, term = deps.term;
    var performance = deps.clock;
    var layout = deps.layout, navigation = deps.navigation;
    var core = deps.core, s = deps.state;
    function isLetter(c) { return MODEL.isLetter(c); }
    function wordScan() { return MODEL.wordScan(); }
    function wordLeft(text, index, floor, scan) { return MODEL.wordLeft(s.wordRule, text, index, floor, scan); }
    function seamJoins(separator, scan) { return MODEL.seamJoins(s.wordRule, separator, scan); }
    var paneLeft = layout.paneLeft, paneRight = layout.paneRight, paneBottom = layout.paneBottom;
    var rowEdge = layout.rowEdge, burstStartsInput = layout.burstStartsInput, textEnd = layout.textEnd;
    var leftChrome = layout.leftChrome, rowAfterWrap = layout.rowAfterWrap;
    var frameUp = layout.frameUp, frameDown = layout.frameDown, frameEnd = layout.frameEnd;
    var roomBelow = layout.roomBelow, crossUpInfo = layout.crossUpInfo, repeatSp = layout.repeatSp;
    var rebaseTo = layout.rebaseTo, commitLeft = layout.commitLeft, moveStop = layout.moveStop;
    var dropBurst = layout.dropBurst, edgeAt = layout.edgeAt, reflowRisk = layout.reflowRisk;
    var paneWrappedUnderUs = layout.paneWrappedUnderUs;
    function setEnd() { s.predicted.end = Math.max(s.predicted.line.length, textEnd(s.predicted.line + s.predicted.tail)); }
    function shiftIn() { return s.predicted.tail.slice(0, Math.max(0, s.predicted.end - s.predicted.line.length)); }
    function predictReflow(command) {
        var draft = layout.readDraft();
        if (!draft) return false;
        var cursor = layout.draftCursor(draft), from = cursor, text = command.text || '';
        if (cursor < 0 || cursor > draft.text.length) { core.handoff('heavy'); return true; }
        if (command.type === 'backspace') from = Math.max(0, cursor - command.count);
        else if (command.type === 'word-backspace') {
            for (var n = 0; n < command.count; n++) from = wordLeft(draft.text, from, 0, wordScan());
        }
        var next = draft.text.slice(0, from) + text + draft.text.slice(cursor);
        if (!layout.writeDraft(draft, next, from + text.length)) {
            core.handoff('heavy');
            return true;
        }
        s.predicted.dirty = true;
        s.predicted.slowOp = true;
        s.predicted.sampled = false;
        s.predicted.mismatched = false;
        s.inputLen = Math.max(0, s.inputLen + text.length - (cursor - from));
        core.touchEdit();
        return true;
    }
    function predictKillLeft() {
        if (s.predicted && s.predicted.reflow) { core.handoff('heavy'); return; }
        if (core.burstDisplaced()) {
            core.handoff('heavy');
            return;
        }
        if (!s.predicted && !core.startBurst())
            return;
        var row = s.predicted.line + s.predicted.tail;
        var stop = -1;
        if (s.predicted.proven)
            stop = s.predicted.floor;
        else {
            var e = rowEdge(row);
            if (e !== null)
                stop = e;
        }
        if (stop < 0) {
            core.handoff('heavy');
            return;
        }
        var k = s.predicted.line.length - stop;
        if (s.predicted.proven)
            k = Math.min(k, s.inputLen);
        if (k <= 0) {
            if (s.predicted.proven || burstStartsInput()) {
                core.touchEdit();
                return;
            }
            core.handoff('heavy');
            return;
        }
        s.predicted.line = s.predicted.line.slice(0, s.predicted.line.length - k);
        s.predicted.tail = repeatSp(term.cols - s.predicted.line.length);
        s.predicted.end = s.predicted.line.length;
        s.predicted.walked = true;
        s.predicted.dirty = true;
        s.predicted.sampled = false;
        s.predicted.mismatched = false;
        s.inputLen = Math.max(0, s.inputLen - k);
        core.touchEdit();
    }
    // Content edits either update the burst exactly or hand control back to echo.
    function predictBackspace() {
        if (core.burstDisplaced()) {
            core.handoff('heavy');
            return;
        }
        var b0 = term.buffer.active;
        var rowNow = s.predicted ? s.predicted.line + s.predicted.tail : (core.fullRow(b0.baseY + b0.cursorY) || '');
        if (s.inputLen <= 0 && rowEdge(rowNow) === null) {
            // The key reaches the app, but with nothing typed and no input edge the model
            // cannot follow it. An open burst would keep drawing what it deletes; a proven
            // burst sits at an empty input, where a handoff would only forget that.
            if (s.predicted && !s.predicted.draining && !s.predicted.proven)
                core.handoff('heavy');
            return;
        }
        if (!s.predicted && !core.startBurst())
            return;
        if (predictReflow({ type: 'backspace', count: 1 })) return;
        var row = s.predicted.line + s.predicted.tail;
        var edgeCol = rowEdge(row);
        var stop = edgeCol !== null ? edgeCol : s.predicted.floor;
        if (s.predicted.line.length <= stop) {
            if (s.predicted.proven || (edgeCol !== null && burstStartsInput())) {
                core.touchEdit();
                return;
            }
            var x = crossUpInfo();
            if (!x || (s.wrapStyle && s.wrapStyle.pull)) {
                core.handoff('heavy');
                return;
            }
            var rem = shiftIn();
            rebaseTo(x.row, x.col);
            s.predicted.tail = (rem + repeatSp(term.cols)).slice(0, term.cols - s.predicted.line.length);
            setEnd();
            s.predicted.dirty = true;
            s.predicted.sampled = false;
            s.predicted.mismatched = false;
            if (s.inputLen > 0)
                s.inputLen--;
            core.touchEdit();
            return;
        }
        if (reflowRisk(1)) {
            core.handoff('heavy');
            return;
        }
        s.predicted.line = s.predicted.line.slice(0, -1);
        s.predicted.end = Math.max(s.predicted.line.length, s.predicted.end - 1);
        s.predicted.walked = true;
        s.predicted.dirty = true;
        s.predicted.sampled = false;
        s.predicted.mismatched = false;
        if (s.inputLen > 0)
            s.inputLen--;
        core.touchEdit();
    }
    function predictWordBackspace() {
        if (core.burstDisplaced()) {
            core.handoff('heavy');
            return;
        }
        var b0 = term.buffer.active;
        var rowNow = s.predicted ? s.predicted.line + s.predicted.tail : (core.fullRow(b0.baseY + b0.cursorY) || '');
        if (s.inputLen <= 0 && rowEdge(rowNow) === null) {
            if (s.predicted && !s.predicted.draining && !s.predicted.proven)
                core.handoff('heavy');
            return;
        }
        if (!s.predicted && !core.startBurst())
            return;
        if (predictReflow({ type: 'word-backspace', count: 1 })) return;
        var row = s.predicted.line + s.predicted.tail;
        var edgeCol = rowEdge(row);
        var rem = shiftIn();
        var end0 = s.predicted.end, row0 = s.predicted.absRow;
        var k = 0, hops = 0, st = wordScan();
        for (;;) {
            var stop = moveStop(), from = s.predicted.line.length;
            var i = wordLeft(s.predicted.line, from, stop, st);
            k += from - i;
            commitLeft(i);
            if (st.landed || s.predicted.proven)
                break;
            var x = crossUpInfo();
            if (!x) {
                if (k === 0 && edgeCol === null && !s.predicted.proven) {
                    core.handoff('heavy');
                    return;
                }
                break;
            }
            if (s.wrapStyle && s.wrapStyle.pull) {
                core.handoff('heavy');
                return;
            }
            if (!seamJoins(x.sep, st))
                break;
            if (++hops > 4) {
                core.handoff('heavy');
                return;
            }
            k++;
            rebaseTo(x.row, x.col);
        }
        if (k <= 0) {
            if (s.predicted.proven || edgeCol !== null) {
                core.touchEdit();
                return;
            }
            core.handoff('heavy');
            return;
        }
        if (edgeCol === null && k > s.inputLen) {
            core.handoff('heavy');
            return;
        }
        if (reflowRisk(k)) {
            core.handoff('heavy');
            return;
        }
        s.predicted.tail = (rem + repeatSp(term.cols)).slice(0, term.cols - s.predicted.line.length);
        if (s.predicted.absRow === row0)
            s.predicted.end = Math.max(s.predicted.line.length, end0 - k);
        else
            setEnd();
        s.predicted.dirty = true;
        s.predicted.slowOp = true;
        s.predicted.sampled = false;
        s.predicted.mismatched = false;
        s.inputLen = Math.max(0, s.inputLen - k);
        core.touchEdit();
    }
    // Predict learned wrap shapes; unknown or unsafe geometry rides server echo.
    // `rest` is the part of the key's insert still to come after `ch`.
    function wrapStep(ch, rest) {
        var b = term.buffer.active;
        s.lastWrapAt = performance.now();
        core.trace('wrapstep', JSON.stringify(ch), 'len', s.predicted.line.length, 'atLen', s.wrapStyle ? s.wrapStyle.atLen : -1);
        s.predicted.wrapRow = s.predicted.absRow;
        s.predicted.wrapCol = s.predicted.line.length;
        s.predicted.wrapKept = null;
        var nr = s.predicted.absRow + 1, canDrop = layout.rowWithinPane(nr);
        if (s.wrapStyle && s.wrapStyle.pull) {
            var indent = s.wrapStyle.indent, word = '', restWord = '';
            var row0 = s.predicted.line + s.predicted.tail;
            var edge0 = rowEdge(row0);
            var wordFloor = edge0 !== null ? edge0 : s.predicted.floor;
            if (ch !== ' ') {
                word = core.lastToken(s.predicted.line, wordFloor);
                restWord = (s.predicted.tail.match(/^[^ ]*/) || [''])[0].replace(/ +$/, '');
                if (indent + word.length + 1 + restWord.length > s.wrapStyle.atLen) {
                    wrapRide(ch, rest);
                    return;
                }
            }
            else if (s.wrapStyle.spacePull) {
                word = core.lastToken(s.predicted.line, wordFloor);
                if (indent + word.length + 1 > s.wrapStyle.atLen) {
                    wrapRide(ch, rest);
                    return;
                }
            }
            var lead = leftChrome(row0, indent);
            var nl = lead + word + (ch === ' ' ? (word ? ' ' : '') : ch);
            var kept = s.predicted.line.slice(0, s.predicted.line.length - word.length);
            var cont = rowAfterWrap(nl + restWord, row0).slice(nl.length);
            var fe = frameEnd(s.predicted.absRow), room = roomBelow(fe), growDown;
            var paneRows = paneBottom() - layout.paneTop();
            var blankBelow = fe < 0 ? 0 : layout.rowsThroughPane(fe + 1);
            if (s.wrapStyle.down === null) {
                growDown = room && fe >= 0 && blankBelow < (paneRows >> 1);
                core.trace('wrapdir', 'resolved:' + (growDown ? 'down' : 'up'), 'fe:' + fe, 'blank:' + blankBelow);
            }
            else {
                growDown = s.wrapStyle.down && room;
            }
            core.trace('wrapdir', 'room:' + (room ? 1 : 0), 'down:' + (s.wrapStyle.down ? 1 : 0), 'fe:' + fe, 'blank:' + blankBelow);
            if (!s.wrapStyle.down && room && fe >= 0 && blankBelow * 2 >= paneRows) {
                wrapRide(ch, rest);
                return;
            }
            if (growDown && !canDrop) {
                wrapRide(ch, rest);
                return;
            }
            if (s.wrapStyle.lazy && ch !== ' ') {
                if (restWord || !growDown) {
                    wrapRide(ch, rest);
                    return;
                }
                s.boxShift = frameDown(s.predicted.absRow, fe);
                s.predicted.wrapKept = (s.predicted.line + ch).replace(/ +$/, '');
                s.edge = edgeAt(s.predicted.wrapRow, s.predicted.line.length, ch, ' ');
                s.predicted.pullPend = { fromRow: s.predicted.wrapRow, word: word + ch, kept: kept, lead: lead };
                dropBurst(nr, lead, indent, rowAfterWrap(lead, row0).slice(lead.length));
            }
            else if (growDown) {
                core.trace('wrappaint', 'down', 'row', s.predicted.absRow - b.baseY);
                s.boxShift = frameDown(s.predicted.absRow, fe);
                if (word)
                    s.edge = edgeAt(s.predicted.absRow, s.predicted.line.length - word.length, repeatSp(word.length), word);
                s.predicted.wrapKept = kept.replace(/ +$/, '');
                dropBurst(nr, nl, indent, cont);
            }
            else {
                core.trace('wrappaint', 'up', 'row', s.predicted.absRow - b.baseY);
                s.boxShift = frameUp(s.predicted.absRow, rowAfterWrap(kept, row0));
                s.predicted.line = nl;
                s.predicted.floor = indent;
                s.predicted.tail = cont;
                setEnd();
            }
        }
        else if (s.wrapStyle) {
            if (!canDrop) {
                wrapRide(ch, rest);
                return;
            }
            s.boxShift = null;
            s.edge = edgeAt(s.predicted.absRow, s.predicted.line.length, ch, ' ');
            var row = core.fullRow(nr);
            var left = paneLeft();
            dropBurst(nr, repeatSp(left), left, row !== null ? row.slice(left) : repeatSp(term.cols - left));
        }
        else {
            wrapRide(ch, rest);
            return;
        }
        s.predicted.proven = false;
        s.predicted.wrapped = true;
        s.predicted.wrapAt = performance.now();
        s.predicted.dirty = true;
        s.predicted.sampled = false;
        s.predicted.mismatched = false;
        s.inputLen++;
    }
    function pullStep(ch) {
        var pp = s.predicted.pullPend;
        s.predicted.pullPend = null;
        if (isLetter(ch)) {
            s.predicted.line = pp.lead + pp.word + ch;
            s.predicted.tail = rowAfterWrap(s.predicted.line, pp.lead + s.predicted.tail).slice(s.predicted.line.length);
            setEnd();
            s.predicted.wrapKept = pp.kept.replace(/ +$/, '');
            s.edge = edgeAt(pp.fromRow, pp.kept.length, repeatSp(pp.word.length), pp.word);
            s.predicted.dirty = true;
            s.inputLen++;
        }
        else if (ch === ' ') {
            s.inputLen++;
        }
        else {
            core.handoff('heavy');
            return;
        }
        s.predicted.sampled = false;
        s.predicted.mismatched = false;
        core.touchEdit();
    }
    // What the ride sent is fixed here, because learnWrap later rewrites `line` from the
    // grid: `sent` runs from the row start through the key's whole insert, `cut` ends the
    // trigger, `own` is the word a pull would carry off with it, and `hard` marks a wrap
    // that moves no word at all.
    function wrapRide(ch, rest) {
        core.trace('ride', JSON.stringify(ch), 'row', s.predicted.absRow - term.buffer.active.baseY, 'len', s.predicted.line.length);
        s.wrapPend = { row: s.predicted.absRow, col: s.predicted.line.length, at: performance.now(),
            word: core.lastToken(s.predicted.line, s.predicted.floor), line: s.predicted.line, trigger: ch,
            sent: s.predicted.line + ch + (rest || ''), cut: s.predicted.line.length + ch.length,
            own: core.lastToken(ch === ' ' ? s.predicted.line : s.predicted.line + ch, 0),
            hard: !!(s.wrapStyle && !s.wrapStyle.pull),
            moved: null, prevSeen: null, seenAt: 0 };
        core.handoff('heavy');
        s.rideQueue = { text: '', at: performance.now(), moved: null };
        core.armWrapLearn();
    }
    function softNewline(d) {
        if (d.indexOf('\r') === -1)
            return true;
        if (d.indexOf('\x1b[200~') !== -1)
            return true;
        if (/\x1b[\r\n]/.test(d))
            return true;
        var b = term.buffer.active;
        var row = s.predicted ? s.predicted.line : (core.fullRow(b.baseY + b.cursorY) || '').slice(0, b.cursorX);
        return row.slice(-1) === '\\';
    }
    function predict(command) {
        if (!core.enabled())
            return;
        if (command.type === 'newline') {
            core.submit();
            if (softNewline(command.data)) {
                core.handoff('heavy');
                return;
            }
            s.inputLen = 0;
            s.lineFresh = true;
            return;
        }
        if (!core.isSafe())
            return;
        if (core.holdActive() || (s.predicted && s.predicted.draining)) {
            if (s.rideQueue) {
                if (command.type === 'insert')
                    s.rideQueue.text += command.text;
                else
                    s.rideQueue = null;
            }
            return;
        }
        if (s.predicted && s.predicted.pullPend && command.type !== 'insert') {
            core.handoff('heavy');
            return;
        }
        if (s.pendingPull && command.type !== 'insert')
            s.pendingPull = null;
        if (command.type === 'backspace') {
            for (var k = 0; k < command.count; k++)
                predictBackspace();
            return;
        }
        if (command.type === 'word-backspace') {
            for (var w = 0; w < command.count; w++)
                predictWordBackspace();
            return;
        }
        if (command.type === 'move') {
            navigation.move(command.direction, command.count, command.word);
            return;
        }
        if (command.type === 'home') {
            navigation.home();
            return;
        }
        if (command.type === 'end') {
            navigation.end();
            return;
        }
        if (command.type === 'vertical') {
            navigation.vertical(command.direction, command.count);
            return;
        }
        if (command.type === 'kill-left') {
            predictKillLeft();
            return;
        }
        if (command.type === 'insert') {
            var d = command.text;
            if (core.burstDisplaced()) {
                core.handoff('heavy');
                return;
            }
            var wr = paneWrappedUnderUs();
            if (wr >= 0) {
                // This insert is sent although the model stops here, so the ride keeps it.
                wrapRide('', d);
                core.markWrapLanded(wr);
                return;
            }
            if (!s.predicted && !core.startBurst())
                return;
            if (predictReflow(command)) return;
            var limit = s.wrapStyle ? s.wrapStyle.atLen : paneRight() - MODEL.RIDE_PAD;
            for (var c = 0; c < d.length; c++) {
                if (s.predicted.pullPend) {
                    pullStep(d[c]);
                    if (!s.predicted || s.predicted.draining)
                        return;
                    continue;
                }
                var joined = s.predicted.line + s.predicted.tail;
                var content = textEnd(joined);
                if (content > s.predicted.line.length) {
                    var pull = s.wrapStyle && s.wrapStyle.pull;
                    var inLast = pull && s.predicted.tail.slice(0, content - s.predicted.line.length).replace(/ +$/, '').indexOf(' ') === -1;
                    if (content >= limit && (!pull || (inLast ? false : s.predicted.line.length >= limit))) {
                        core.handoff('heavy');
                        return;
                    }
                    if (content >= limit && inLast) {
                        wrapStep(d[c], d.slice(c + 1));
                        if (!s.predicted || s.predicted.draining)
                            return;
                        continue;
                    }
                }
                else if (s.predicted.line.length >= limit) {
                    wrapStep(d[c], d.slice(c + 1));
                    if (!s.predicted || s.predicted.draining)
                        return;
                    continue;
                }
                s.predicted.line += d[c];
                s.predicted.end++;
                s.predicted.dirty = true;
                s.inputLen++;
            }
            s.predicted.sampled = false;
            s.predicted.mismatched = false;
            core.touchEdit();
            return;
        }
        if (command.type === 'report')
            return;
        core.handoff('heavy');
    }
    return { predict: predict };
  }
  return { create: create };
})();
