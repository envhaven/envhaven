// xterm style sampling for prediction overlays. This owner caches only rendered style
// facts; predictor state and overlay DOM remain outside this module.
var EnvHavenConsoleStyle = (function () {
  function create(deps) {
    var MODEL = deps.model, term = deps.term, termEl = deps.termEl;
    var getComputedStyle = deps.getComputedStyle, theme = deps.theme;
    var foreground = '', fontFamily = '', fontSize = '', background = '';
    var bgCache = Object.create(null), fgCache = Object.create(null);
    var CHROME_RUN = /xterm-cursor|xterm-decoration/;

    function opaque(value) {
      return value && value !== 'transparent' && !/^rgba\([^)]*,\s*0(\.0+)?\)$/.test(value) ? value : '';
    }
    function refresh() {
      var rows = termEl.querySelector('.xterm-rows');
      var computed = rows ? getComputedStyle(rows) : null;
      foreground = (term.options.theme && term.options.theme.foreground) ||
        (computed && computed.color) || '#ffffff';
      fontFamily = (computed && computed.fontFamily) || 'monospace';
      fontSize = (computed && computed.fontSize) || '13px';
      background = theme.background();
      bgCache = Object.create(null);
      fgCache = Object.create(null);
      var colors = term._core && term._core._themeService && term._core._themeService.colors;
      if (colors && colors.cursor && colors.cursorAccent) {
        termEl.style.setProperty('--eh-cursor-bg', colors.cursor.css);
        termEl.style.setProperty('--eh-cursor-fg', colors.cursorAccent.css);
      }
    }
    function spanBackground(span) {
      if (span.style.backgroundColor) return opaque(span.style.backgroundColor);
      var key = span.className;
      if (!(key in bgCache)) bgCache[key] = opaque(getComputedStyle(span).backgroundColor);
      return bgCache[key];
    }
    function spanForeground(span) {
      if (span.style.color) return span.style.color;
      var key = span.className;
      if (!(key in fgCache)) fgCache[key] = getComputedStyle(span).color;
      return fgCache[key];
    }
    // The widest non-chrome run represents the row rather than its cursor or decoration.
    function rowStyle(vrow) {
      var rows = termEl.querySelector('.xterm-rows');
      var element = rows && rows.children[vrow];
      var result = { bg: '', ink: '' }, bgLength = -1, inkLength = -1;
      if (!element) return result;
      for (var index = 0; index < element.children.length; index++) {
        var span = element.children[index];
        if (CHROME_RUN.test(span.className)) continue;
        var length = (span.textContent || '').length;
        if (length > bgLength) {
          bgLength = length;
          result.bg = spanBackground(span);
        }
        if (length > inkLength && !/xterm-dim/.test(span.className)) {
          inkLength = length;
          result.ink = spanForeground(span);
        }
      }
      return result;
    }
    function rowBackground(vrow) { return rowStyle(vrow).bg || background; }
    function rowForeground(vrow, app, learned) {
      if (learned) return learned;
      var tui = MODEL.tuiRow(app);
      if (tui && tui.coldFg) return tui.coldFg;
      var sampled = rowStyle(vrow);
      return sampled.bg ? (sampled.ink || foreground) : foreground;
    }
    function cellForeground(vrow, col) {
      var rows = termEl.querySelector('.xterm-rows');
      var element = rows && rows.children[vrow];
      if (!element || col < 0) return '';
      var offset = 0;
      for (var index = 0; index < element.children.length; index++) {
        var span = element.children[index], text = span.textContent || '';
        var chrome = CHROME_RUN.test(span.className);
        if (col < offset + text.length) {
          return !chrome && /\S/.test(text.charAt(col - offset)) ? spanForeground(span) : '';
        }
        offset += text.length;
      }
      return '';
    }
    function ready() { return !!foreground; }
    function foregroundColor() { return foreground; }
    function currentFontFamily() { return fontFamily; }
    function currentFontSize() { return fontSize; }
    return {
      refresh: refresh, ready: ready,
      foreground: foregroundColor, fontFamily: currentFontFamily, fontSize: currentFontSize,
      rowBackground: rowBackground, rowForeground: rowForeground,
      cellForeground: cellForeground
    };
  }
  return { create: create };
})();
