// Browser clipboard and image-paste bridge for one terminal.
var EnvHavenConsoleClipboard = (function () {
  function create(deps) {
    var window = deps.window, navigator = window.navigator;
    var term = deps.term, termEl = deps.termEl;
    var pendingCopy = null;

    termEl.addEventListener('mouseup', function () {
      if (!deps.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) return;
      if (pendingCopy) { deps.timers.clearTimeout(pendingCopy.timer); pendingCopy.reject(); }
      var entry = {};
      var text = new Promise(function (resolve, reject) {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      entry.timer = deps.timers.setTimeout(function () {
        if (pendingCopy === entry) {
          pendingCopy = null;
          entry.reject();
        }
      }, 500);
      pendingCopy = entry;
      navigator.clipboard.write([new deps.ClipboardItem({ 'text/plain': text })]).catch(function () {});
    }, true);

    function write(text) {
      if (pendingCopy) {
        var entry = pendingCopy;
        pendingCopy = null;
        deps.timers.clearTimeout(entry.timer);
        entry.resolve(new deps.Blob([text], { type: 'text/plain' }));
      }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () {});
      if (deps.embedded) deps.toParent({ type: 'envhaven-console:clipboard', text: text });
    }

    term.parser.registerOscHandler(52, function (data) {
      var separator = data.indexOf(';');
      if (separator === -1) return true;
      var payload = data.slice(separator + 1);
      if (payload === '' || payload === '?') return true;
      try {
        var bytes = deps.Uint8Array.from(deps.atob(payload), function (char) { return char.charCodeAt(0); });
        write(new deps.TextDecoder().decode(bytes));
      } catch (error) { /* invalid base64 */ }
      return true;
    });

    termEl.addEventListener('contextmenu', function (event) {
      if (!term.hasSelection()) return;
      event.preventDefault();
      write(term.getSelection());
    });

    function imageExtension(type) {
      if (type === 'image/jpeg') return 'jpg';
      if (type === 'image/gif') return 'gif';
      if (type === 'image/webp') return 'webp';
      return 'png';
    }

    termEl.addEventListener('paste', function (event) {
      var clipboard = event.clipboardData || window.clipboardData;
      var items = clipboard && clipboard.items;
      if (!items) return;
      var image = null;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          image = items[i];
          break;
        }
      }
      if (!image || !deps.embedded) return;
      event.preventDefault();
      event.stopPropagation();
      var blob = image.getAsFile();
      if (!blob) return;
      deps.toParent({
        type: 'envhaven-console:paste-image',
        name: 'pasted-' + Date.now() + '.' + imageExtension(blob.type),
        blob: blob
      });
    }, true);

    return { write: write };
  }
  return { create: create };
})();
