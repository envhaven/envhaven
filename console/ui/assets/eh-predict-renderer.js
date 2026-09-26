// Prediction renderer. It receives frozen view data and owns only DOM/style state.
var EnvHavenConsoleRenderer = (function () {
  function create(deps) {
    var MODEL = deps.model, term = deps.term, termEl = deps.termEl;
    var document = deps.document, getComputedStyle = deps.getComputedStyle;
    var requestAnimationFrame = deps.requestAnimationFrame, performance = deps.clock;
    var theme = deps.theme, connected = deps.connected;
    var style = deps.style.create({
        model: MODEL, term: term, termEl: termEl,
        getComputedStyle: getComputedStyle, theme: theme
    });
    var view = Object.freeze({
        enabled: false, app: '', top: 0, bottom: 0, left: 0, right: 0,
        predicted: null, edge: null, boxShift: null, lastEditAt: 0
    });
    var inputFg = '', inkAt = null;

    function paneTop() { return Math.max(0, Math.min(view.top || 0, term.rows)); }
    function paneBottom() { return Math.max(paneTop(), view.bottom > 0 ? Math.min(view.bottom, term.rows) : term.rows); }
    function paneLeft() { return Math.max(0, Math.min(view.left || 0, term.cols)); }
    function paneRight() { return Math.max(paneLeft(), view.right > 0 ? Math.min(view.right, term.cols) : term.cols); }
    function fullRow(absRow) {
        var b = term.buffer.active, relative = absRow - b.baseY;
        if (relative < paneTop() || relative >= paneBottom()) return null;
        var line = b.getLine(absRow);
        var row = line ? line.translateToString(false, 0, term.cols) : '';
        if (row.length !== term.cols) return null;
        return new Array(paneLeft() + 1).join(' ') + row.slice(paneLeft(), paneRight()) +
            new Array(term.cols - paneRight() + 1).join(' ');
    }
    function repeatSp(n) { return new Array(Math.max(0, n) + 1).join(' '); }
    var geometry = MODEL.createGeometry({
        cols: function () { return term.cols; },
        rows: function () { return term.rows; },
        baseY: function () { return term.buffer.active.baseY; },
        paneTop: paneTop, paneBottom: paneBottom, paneLeft: paneLeft, paneRight: paneRight,
        row: fullRow
    });

    function newScreenLayer(z) {
        var screen = termEl.querySelector('.xterm-screen');
        if (!screen)
            return null;
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
            if (c && c.width)
                return [c.width, c.height];
        }
        catch (e) { /* fall through */ }
        var screen = termEl.querySelector('.xterm-screen');
        return screen ? [screen.clientWidth / term.cols, screen.clientHeight / term.rows] : [9, 17];
    }
    function refreshStyle() {
        style.refresh();
        forgetInk();
    }
    function rowBackground(vrow) { return style.rowBackground(vrow); }
    function rowForeground(vrow) { return style.rowForeground(vrow, view.app, inputFg); }
    function forgetInk() { inputFg = ''; inkAt = null; }
    function cellFg(vrow, col) { return style.cellForeground(vrow, col); }
    function learnInk() {
        if (!inkAt)
            return;
        var ink = cellFg(inkAt.row - term.buffer.active.baseY, inkAt.col);
        inkAt = null;
        if (!ink || ink === inputFg)
            return;
        inputFg = ink;
        if (view.predicted)
            render(view);
    }
    // Hover underline for merged OSC 8 links: one hairline per text run, in its own
    // overlay layer (below the predictor's) using the same exact cell geometry, so
    // indent and padding cells inside the link's rectangular range stay bare.
    var linkLayer = null;
    function clearLinkUnderline() {
        if (linkLayer)
            linkLayer.textContent = '';
    }
    function paintLinkUnderline(rects) {
        if (!style.ready())
            refreshStyle(); // same seed render() uses: the hairline colour has one owner
        if (!linkLayer || !linkLayer.isConnected) {
            linkLayer = newScreenLayer(9);
            if (!linkLayer)
                return;
        }
        clearLinkUnderline();
        var dims = cellDims(), cw = dims[0], ch = dims[1];
        rects.forEach(function (r) {
            var u = document.createElement('div');
            u.style.cssText = 'position:absolute;height:1px;background:' + (style.foreground() || '#ffffff');
            u.style.left = (r.x0 - 1) * cw + 'px';
            u.style.top = (r.y - 1) * ch + (ch - 1) + 'px';
            u.style.width = (r.x1 - r.x0 + 1) * cw + 'px';
            linkLayer.appendChild(u);
        });
    }
    var predOverlay = null; // the single z-index:10 layer that holds all optimistic drawing
    function overlay() {
        if (predOverlay && predOverlay.isConnected)
            return predOverlay;
        predOverlay = newScreenLayer(10);
        if (!predOverlay)
            return null;
        glyphLine = coverLine = tailLine = reflowLine = cursorCover = predCursor = edgeLine = boxLine = wipeLine = null; // children of a replaced overlay are detached; rebuild them
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
            if (w)
                return cw - w;
        }
        catch (e) { /* fall through */ }
        var span = termEl.querySelector('.xterm-rows span[style*="letter-spacing"]');
        return span && span.style.letterSpacing ? parseFloat(span.style.letterSpacing) : 0;
    }
    // Whether the application has hidden the caret (DECTCEM, ESC[?25l). xterm stops
    // painting .xterm-cursor when this is set, so we must not draw our predicted block
    // over it either. Fails toward drawing if the internal shape ever moves.
    function cursorHidden() {
        try {
            return term._core._coreService.isCursorHidden;
        }
        catch (e) {
            return false;
        }
    }
    // ── One renderer for the whole optimistic view ────────────────────────────
    // Predicted glyphs, delete covers, and the cursor are ALL rebuilt from
    // `predicted.line` by render(), laid out by the browser's own text engine so every
    // glyph lands on the exact pixel xterm will use (no per-cell arithmetic, no
    // settle-drift). We never touch the authoritative grid or the real cursor: as the
    // server's echo catches up, the divergence point moves right and each rebuild lets
    // the real glyphs beneath show through.
    var glyphLine = null, coverLine = null, tailLine = null, reflowLine = null, cursorCover = null, predCursor = null, edgeLine = null, boxLine = null, wipeLine = null;
    var owningNow = false;
    var reflowClones = null;
    var lastMeasureS = null, lastMeasureGx = 0; // cache the cursor's measured x by predicted text
    var CURSOR_GRACE = 250; // keep owning the cursor this long after the last keystroke,
    // so a burst of edits never hands it back mid-stream (no flicker)
    function lineCss(top, cw, ch, z) {
        return 'position:absolute;left:0;top:' + top + 'px;white-space:pre;line-height:' + ch +
            'px;font-family:' + style.fontFamily() + ';font-size:' + style.fontSize() +
            ';letter-spacing:' + exactLetterSpacing(cw) + 'px;z-index:' + z;
    }
    // We own the cursor only while actively editing — an edit burst still open, or
    // within a short grace of the last keystroke. Outside that window we release to
    // xterm's real cursor, so blink, focus, and cursor-hide (DECTCEM) stay xterm's job
    // and we never fight it during plain output. Gate state is deliberately NOT
    // consulted here: it gates what may ENTER the burst (predict) and a server
    // "unsafe" clears the burst, so an open burst is always safe to show;
    // hiding it at the local newline disarm would un-paint a submitted line's tail
    // while its echo is still in flight.
    function owning() {
        return view.enabled && connected() &&
            (view.predicted !== null || (performance.now() - view.lastEditAt) < CURSOR_GRACE);
    }
    function releaseCursor() {
        reflowClones = null;
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
        if (owningNow) {
            owningNow = false;
            termEl.classList.remove('eh-hide-cursor');
        }
        lastMeasureS = null; // drop the cached x; cell width may differ next session (resize)
    }
    function render(nextView) {
        if (nextView) view = nextView;
        var ov = overlay();
        if (!ov)
            return;
        if (!style.ready())
            refreshStyle();
        // The background of the cell the REAL cursor sits on, kept current whether we are
        // drawing or not. Both cursor rules in the page's CSS read it: the one that
        // neutralises xterm's cursor while we own it, and the blink override that runs when
        // we do not. Set before the ownership check for that second reader, since the blink
        // is exactly what happens once we have released. Cheap enough for every repaint —
        // rowBackground caches by class list, so a settled screen costs one row scan.
        termEl.style.setProperty('--eh-cell-bg', rowBackground(term.buffer.active.cursorY));
        if (!owning()) {
            releaseCursor();
            return;
        }
        var dm = cellDims(), cw = dm[0], ch = dm[1];
        var b = term.buffer.active, gridAbs = b.baseY + b.cursorY;
        ov.style.clipPath = 'inset(' + (geometry.paneTop() * ch) + 'px ' +
            ((term.cols - geometry.paneRight()) * cw) + 'px ' +
            ((term.rows - geometry.paneBottom()) * ch) + 'px ' +
            (geometry.paneLeft() * cw) + 'px)';
        // A burst deliberately off the grid cursor's row — rebased below by a
        // predicted hard wrap, or above by a predicted cross-row move — paints at
        // the burst's own row, with the model's length as the diff anchor (the stale
        // grid cursor column means nothing on another row, and no cover applies
        // there). Everything else — including a draining burst — paints at the grid
        // cursor as before, so a burst on another row for any OTHER reason still
        // degrades to just the block.
        var stacked = view.predicted && !view.predicted.draining && view.predicted.offGrid &&
            view.predicted.absRow !== gridAbs &&
            geometry.rowWithinPane(view.predicted.absRow);
        var absRow = stacked ? view.predicted.absRow : gridAbs;
        var cursorX = stacked ? Math.min(view.predicted.line.length, geometry.paneRight() - 1) : b.cursorX;
        var line = b.getLine(absRow);
        var paneRow = line ? fullRow(absRow) : null;
        var base = paneRow ? paneRow.slice(0, cursorX) : ''; // pane-isolated grid content, cols [0, cursorX)
        // The predicted text up to the cursor. A burst on another row (the line scrolled
        // under us) draws nothing extra: text = base degrades to just the block cursor.
        var text = view.predicted && view.predicted.absRow === absRow ? view.predicted.line : base;
        // First column where the prediction diverges from the grid: everything to its
        // left is already correct on screen, so draw nothing there.
        var div = 0, m = Math.min(text.length, base.length);
        while (div < m && text.charCodeAt(div) === base.charCodeAt(div))
            div++;
        var fg = text.slice(div); // predicted new glyphs to paint (inserts / overwrites)
        if (!glyphLine) {
            glyphLine = document.createElement('div');
            coverLine = document.createElement('div');
            predCursor = document.createElement('div');
            ov.appendChild(glyphLine);
            ov.appendChild(coverLine);
            ov.appendChild(predCursor);
        }
        var top = (absRow - b.baseY) * ch;
        // Every opaque layer on this row sits on the background the APPLICATION drew, sampled
        // where our first paint lands. Falls back to the terminal's own where the app drew none.
        var rowBg = rowBackground(absRow - b.baseY);
        // Its ink, from the same row and by the same rule — see rowForeground.
        var rowFg = rowForeground(absRow - b.baseY);
        // Cover (z-index 1, behind the glyphs): of the grid cells between the predicted
        // cursor and the real one, paint out ONLY those whose expected char (the tail)
        // differs from what the grid shows — glyphs the model deleted, awaiting their
        // erase echo. Cells the cursor merely stepped left over still hold their
        // content and must stay visible. Same flow as the grid => each cover is exactly
        // as wide as the glyph it hides, so no sliver escapes.
        var coverFrom = Math.max(div, text.length), anyCover = false;
        if (cursorX > coverFrom) {
            coverLine.style.cssText = lineCss(top, cw, ch, 1);
            coverLine.textContent = '';
            var cpre = document.createElement('span');
            cpre.style.color = 'transparent';
            cpre.textContent = base.slice(0, coverFrom);
            coverLine.appendChild(cpre);
            for (var j = coverFrom, runStart = coverFrom, hideRun = null; j <= cursorX; j++) {
                var hide = j < cursorX &&
                    !(view.predicted && view.predicted.absRow === absRow && view.predicted.tail[j - text.length] === base[j]);
                if (hideRun === null) {
                    hideRun = hide;
                    runStart = j;
                    continue;
                }
                if (j < cursorX && hide === hideRun)
                    continue;
                var cspan = document.createElement('span');
                cspan.textContent = base.slice(runStart, j);
                if (hideRun) {
                    cspan.style.color = rowBg;
                    cspan.style.background = rowBg;
                    anyCover = true;
                }
                else {
                    cspan.style.color = 'transparent';
                }
                coverLine.appendChild(cspan);
                hideRun = hide;
                runStart = j;
            }
        }
        else if (view.predicted && view.predicted.absRow === absRow && !view.predicted.matched) {
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
            var gEnd = text.length, gCell = null;
            while (line && gEnd < geometry.paneRight()) {
                gCell = line.getCell(gEnd, gCell || undefined); // reused cell: one alloc, not one per column
                if (!gCell || (!gCell.isDim() && gCell.isFgDefault()))
                    break;
                gEnd++;
            }
            if (gEnd > text.length) {
                coverLine.style.cssText = lineCss(top, cw, ch, 1);
                coverLine.textContent = '';
                // The predicted text itself is the spacer: exactly as many columns as the run
                // has to skip, and drawn transparent so the glyph layer above still shows.
                var gpad = document.createElement('span');
                gpad.style.color = 'transparent';
                gpad.textContent = text;
                var ghide = document.createElement('span');
                ghide.style.color = rowBg;
                ghide.style.background = rowBg;
                ghide.textContent = line.translateToString(false, text.length, gEnd);
                coverLine.appendChild(gpad);
                coverLine.appendChild(ghide);
                anyCover = true;
            }
        }
        coverLine.style.display = anyCover ? 'block' : 'none';
        // An app-drawn inverse caret is ordinary grid content, so hiding xterm's
        // cursor decoration cannot remove it. Restore its cell on the REAL row,
        // independently of which direction or row the predicted cursor moved to.
        // Keep this below edit paint so a shifted suffix still wins on that cell.
        if (cursorCover) cursorCover.style.display = 'none';
        if (view.predicted && (absRow !== gridAbs || text.length !== b.cursorX)) {
            var sourceLine = b.getLine(gridAbs), sourceRow = fullRow(gridAbs);
            var sourceCell = sourceLine && sourceLine.getCell(b.cursorX);
            if (sourceRow !== null && sourceCell && sourceCell.isInverse()) {
                if (!cursorCover) {
                    cursorCover = document.createElement('div');
                    cursorCover.className = 'eh-cursor-cover';
                    ov.appendChild(cursorCover);
                }
                cursorCover.style.cssText = lineCss(b.cursorY * ch, cw, ch, 1);
                cursorCover.textContent = '';
                var sourcePrefix = document.createElement('span'), sourceGlyph = document.createElement('span');
                sourcePrefix.style.color = 'transparent';
                sourcePrefix.textContent = sourceRow.slice(0, b.cursorX);
                sourceGlyph.style.color = rowForeground(b.cursorY);
                sourceGlyph.style.background = rowBackground(b.cursorY);
                sourceGlyph.textContent = sourceCell.getChars() || ' ';
                cursorCover.appendChild(sourcePrefix);
                cursorCover.appendChild(sourceGlyph);
                cursorCover.style.display = 'block';
            }
        }
        // Glyphs (z-index 2, on top): transparent prefix so the run flows onto the right
        // columns, then the predicted characters in the foreground colour on a SOLID
        // background — a doomed grid glyph beneath (erase echo still in flight) must not
        // show through and overlap the prediction drawn over its cell.
        glyphLine.style.cssText = lineCss(top, cw, ch, 2);
        glyphLine.textContent = '';
        var gpre = document.createElement('span');
        gpre.style.color = 'transparent';
        gpre.textContent = text.slice(0, div);
        var gvis = document.createElement('span');
        gvis.style.color = rowFg;
        gvis.style.background = rowBg;
        gvis.textContent = fg;
        // Named so a check can read the colour of a PREDICTED glyph specifically. The overlay
        // also holds cover runs painted in the background and an inverted cursor block, and a
        // check picking through it by style picked one of those instead — which is how the
        // first version of draftink managed to compare two different cells.
        gvis.className = 'eh-ink';
        glyphLine.appendChild(gpre);
        glyphLine.appendChild(gvis);
        glyphLine.style.display = 'block';
        // Mid-line edits shift the suffix too. Paint only its differing span;
        // leave matching, application-styled cells and the row's chrome alone.
        if (tailLine) tailLine.style.display = 'none';
        var draft = view.predicted;
        if (draft && draft.absRow === absRow && draft.dirty && draft.end > text.length && paneRow) {
            var tailEnd = Math.min(geometry.paneRight(), Math.max(draft.end, MODEL.textEnd(paneRow)));
            var expected = (draft.tail + repeatSp(term.cols)).slice(0, tailEnd - text.length);
            var actual = paneRow.slice(text.length, tailEnd), first = 0, last = expected.length;
            while (first < last && expected[first] === actual[first]) first++;
            while (last > first && expected[last - 1] === actual[last - 1]) last--;
            if (first < last) {
                if (!tailLine) {
                    tailLine = document.createElement('div');
                    tailLine.className = 'eh-tail';
                    ov.appendChild(tailLine);
                }
                tailLine.style.cssText = lineCss(top, cw, ch, 2);
                tailLine.textContent = '';
                var tpre = document.createElement('span'), tvis = document.createElement('span');
                tpre.style.color = 'transparent';
                tpre.textContent = text + expected.slice(0, first);
                tvis.style.color = rowFg;
                tvis.style.background = rowBg;
                tvis.textContent = expected.slice(first, last);
                tailLine.appendChild(tpre);
                tailLine.appendChild(tvis);
                tailLine.style.display = 'block';
            }
        }
        // Reflow owns every changed draft row, including rows emptied by a deletion.
        // Matching cells retain their application styling, just like the local suffix.
        if (reflowLine) { reflowLine.textContent = ''; reflowLine.style.display = 'none'; }
        if (draft && draft.reflow && !draft.draining) {
            if (!reflowLine) {
                reflowLine = document.createElement('div');
                reflowLine.className = 'eh-reflow';
                ov.appendChild(reflowLine);
            }
            draft.reflow.paint.forEach(function (row) {
                var actual = fullRow(row.row);
                // Vacated space belongs to the application again as soon as it
                // redraws it (for example, moving a status message above the box).
                if (actual === null || row.chrome || (row.clear && actual !== row.was)) return;
                var first = geometry.paneLeft(), last = geometry.paneRight();
                while (first < last && row.text[first] === actual[first]) first++;
                while (last > first && row.text[last - 1] === actual[last - 1]) last--;
                if (first === last) return;
                var el = document.createElement('div'), pad = document.createElement('span'), ink = document.createElement('span');
                el.style.cssText = lineCss((row.row - b.baseY) * ch, cw, ch, 2);
                pad.style.color = 'transparent';
                pad.textContent = row.text.slice(0, first);
                ink.style.color = rowForeground(row.row - b.baseY);
                ink.style.background = rowBackground(row.row - b.baseY);
                ink.textContent = row.text.slice(first, last);
                el.appendChild(pad);
                el.appendChild(ink);
                reflowLine.appendChild(el);
            });
            reflowLine.style.display = 'block';
        }
        // Cursor (z-index 3): an OPAQUE block at the predicted column = the right edge of
        // the whole predicted line, showing the char it sits on in inverse video like a
        // real block cursor. Opaque so a half-deleted glyph can never show through it.
        // Its x is the flowed width of `text`, cached by that text so identical predicted
        // content does not force a layout read every frame. Suppressed when the application
        // itself hid the caret (DECTCEM), so we never draw a block where xterm shows none.
        if (cursorHidden()) {
            predCursor.style.display = 'none';
        }
        else {
            var gx;
            if (text === lastMeasureS) {
                gx = lastMeasureGx;
            }
            else {
                var screen = termEl.querySelector('.xterm-screen');
                gx = glyphLine.getBoundingClientRect().right - screen.getBoundingClientRect().left;
                lastMeasureS = text;
                lastMeasureGx = gx;
            }
            predCursor.style.cssText = 'position:absolute;pointer-events:none;z-index:3;left:' + gx + 'px;top:' + top +
                'px;width:' + cw + 'px;height:' + ch + 'px;background:' + rowFg + ';color:' + rowBg +
                ';font-family:' + style.fontFamily() + ';font-size:' + style.fontSize() +
                ';line-height:' + ch + 'px;white-space:pre';
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
            // text.length is the block's column in both cases — it is what gx was measured from —
            // so the read needs no separate branch for a burst that owns the row.
            predCursor.textContent = (view.predicted && view.predicted.absRow === absRow &&
                (view.predicted.dirty || (!view.predicted.matched && view.predicted.tail.trim()))
                    ? ''
                    : line && line.translateToString(false, text.length, text.length + 1)) || '';
            predCursor.style.display = 'block';
        }
        // The hard-wrap edge glyph: the one char the wrap left on the pre-wrap row's
        // last column, painted until its echo lands (reconcile retires it).
        if (view.edge && geometry.rowWithinPane(view.edge.absRow) && geometry.colWithinPane(view.edge.col)) {
            if (!edgeLine) {
                edgeLine = document.createElement('div');
                ov.appendChild(edgeLine);
            }
            edgeLine.style.cssText = lineCss((view.edge.absRow - b.baseY) * ch, cw, ch, 2);
            edgeLine.textContent = '';
            var epre = document.createElement('span');
            epre.style.color = 'transparent';
            epre.textContent = (fullRow(view.edge.absRow) || repeatSp(term.cols)).slice(0, view.edge.col);
            var ech = document.createElement('span');
            ech.style.color = rowForeground(view.edge.absRow - b.baseY);
            ech.style.background = rowBackground(view.edge.absRow - b.baseY); // the edge glyph's own row
            ech.textContent = view.edge.text;
            edgeLine.appendChild(epre);
            edgeLine.appendChild(ech);
            edgeLine.style.display = 'block';
        }
        else if (edgeLine) {
            edgeLine.style.display = 'none';
        }
        // The composer rows the wrap moved. Each is drawn from a CLONE of xterm's own
        // rendered row, so the rule's colour and the hint's highlights come along with
        // no palette arithmetic; the wrapper restores the font metrics the row inherited
        // from .xterm-rows. Rows landing outside the viewport are simply dropped — that
        // is exactly what the app does to the hint row when the box grows downward.
        var xrows = termEl.querySelector('.xterm-rows');
        if (!(draft && draft.reflow)) reflowClones = null;
        else if (!reflowClones && xrows) {
            reflowClones = {};
            for (var source = draft.reflow.chromeFrom; source >= 0 && source <= draft.reflow.chromeTo; source++) {
                var sourceElement = xrows.children[source - b.baseY];
                if (sourceElement) reflowClones[source] = sourceElement.cloneNode(true);
            }
        }
        if (view.boxShift && xrows) {
            if (!boxLine) {
                boxLine = document.createElement('div');
                ov.appendChild(boxLine);
            }
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
            var rcs = getComputedStyle(xrows), dstTop = view.boxShift.from + view.boxShift.delta - b.baseY;
            var painted = (view.boxShift.to - view.boxShift.from + 1) + (view.boxShift.text !== null ? 1 : 0);
            var clipped = Math.min(painted, geometry.rowsThroughPane(view.boxShift.from + view.boxShift.delta));
            boxLine.style.cssText = 'position:absolute;left:0;top:' + (dstTop * ch) + 'px;z-index:1' +
                ';height:' + (clipped * ch) + 'px;overflow:hidden;background:' + rowBackground(Math.max(0, dstTop)) +
                ';font-family:' + rcs.fontFamily + ';font-size:' + rcs.fontSize +
                ';line-height:' + rcs.lineHeight + ';white-space:pre';
            var fr, vi, srcEl, cloneEl, cur, ci;
            for (fr = view.boxShift.from; fr <= view.boxShift.to; fr++) {
                vi = fr - b.baseY;
                if (!geometry.rowWithinPane(fr))
                    continue;
                srcEl = reflowClones && reflowClones[fr] || xrows.children[vi];
                if (!srcEl)
                    continue;
                cloneEl = srcEl.cloneNode(true); // colours ride on the clone
                // xterm's CURSOR styling rides on it too, and under `.xterm-rows` it now
                // applies: the block-cursor rule is scoped there exactly like the colour is.
                // Neither frame builder puts the cursor's own row inside this range, but the clone is
                // taken at PAINT time and the cursor moves between the two, so a moved row can
                // arrive carrying a second block cursor into the overlay. Drop the marker
                // classes; the cell keeps its text and its palette.
                cur = cloneEl.querySelectorAll('.xterm-cursor');
                for (ci = 0; ci < cur.length; ci++) {
                    cur[ci].classList.remove('xterm-cursor', 'xterm-cursor-block', 'xterm-cursor-blink', 'xterm-cursor-bar', 'xterm-cursor-underline', 'xterm-cursor-outline');
                }
                boxLine.appendChild(cloneEl);
            }
            // The pre-wrap row's kept text, on the row it rose to — the one moved row we
            // draw ourselves, because its content changed (the wrapped word left it).
            if (view.boxShift.text !== null) {
                var keptEl = document.createElement('div');
                keptEl.style.cssText = 'color:' + rowForeground(view.boxShift.textRow - b.baseY) +
                    ';letter-spacing:' + exactLetterSpacing(cw) + 'px';
                keptEl.textContent = view.boxShift.text;
                boxLine.appendChild(keptEl);
            }
            boxLine.style.display = 'block';
        }
        else if (boxLine) {
            boxLine.style.display = 'none';
        }
        // Growing downward, the burst row IS the old bottom rule: blank whatever the
        // predicted text does not cover, or the rest of the rule shows through beside it.
        if (view.boxShift && view.boxShift.wipeRow >= 0 && geometry.rowWithinPane(view.boxShift.wipeRow)) {
            if (!wipeLine) {
                wipeLine = document.createElement('div');
                ov.appendChild(wipeLine);
            }
            wipeLine.style.cssText = 'position:absolute;left:0;z-index:1;background:' +
                rowBackground(view.boxShift.wipeRow - b.baseY) +
                ';top:' + ((view.boxShift.wipeRow - b.baseY) * ch) + 'px;height:' + ch + 'px;width:100%';
            wipeLine.style.display = 'block';
        }
        else if (wipeLine) {
            wipeLine.style.display = 'none';
        }
        if (!owningNow) {
            owningNow = true;
            termEl.classList.add('eh-hide-cursor');
        }
    }
    function queueInk(row, col) {
      if (!inkAt) requestAnimationFrame(learnInk);
      inkAt = { row: row, col: col };
    }
    function inputForeground() { return inputFg; }
    function owningState() { return owningNow; }
    return {
      cursorGrace: CURSOR_GRACE, render: render,
      refreshStyle: refreshStyle, forgetInk: forgetInk,
      clearLinkUnderline: clearLinkUnderline, paintLinkUnderline: paintLinkUnderline,
      queueInk: queueInk, inputForeground: inputForeground, cellForeground: cellFg,
      owning: owningState
    };
  }
  return { create: create };
})();
