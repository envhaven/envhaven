// Browser clipboard and image-paste bridge for one terminal.
//
// OSC 52 lets anything that writes to this terminal set the clipboard: tmux's own copy, which
// is why it stays on, but also any program in the shell, or a file someone cats. So no write is
// silent and none is unbounded. Embedded, the dashboard holds the clipboard and announces every
// write handed to it; top-level, this page announces its own once the browser has taken it,
// and says so plainly when the browser refused the write or gives the page no clipboard at
// all, as it does over plain HTTP. A write over MAX_COPY_BYTES is refused, and the refusal is
// announced here in both modes, because the dashboard never hears of it.
var EnvHavenConsoleClipboard = (function () {
  // A megabyte of text is a long tmux selection; anything larger is refused rather than pasted
  // somewhere by surprise. MAX_PAYLOAD is the same bound in base64 characters, checked before
  // anything is decoded.
  var MAX_COPY_BYTES = 1 << 20;
  var MAX_PAYLOAD = Math.ceil(MAX_COPY_BYTES / 3) * 4;
  var NOTICE_MS = 2500;

  function create(deps) {
    var window = deps.window, navigator = window.navigator;
    var term = deps.term, termEl = deps.termEl;
    var noticeEl = window.document.getElementById('clipNotice');
    var noticeTimer = 0;
    var pendingCopy = null;

    function notice(text) {
      noticeEl.textContent = text;
      noticeEl.classList.add('show');
      if (noticeTimer) deps.timers.clearTimeout(noticeTimer);
      noticeTimer = deps.timers.setTimeout(function () {
        noticeTimer = 0;
        noticeEl.classList.remove('show');
      }, NOTICE_MS);
    }

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
      // write() announces the copy once this write or its own has landed. The catch keeps a
      // write that never gets its text from reporting an unhandled rejection.
      entry.written = navigator.clipboard.write([new deps.ClipboardItem({ 'text/plain': text })]);
      entry.written.catch(function () {});
    }, true);

    function write(text) {
      var writes = [];
      if (pendingCopy) {
        var entry = pendingCopy;
        pendingCopy = null;
        deps.timers.clearTimeout(entry.timer);
        entry.resolve(new deps.Blob([text], { type: 'text/plain' }));
        writes.push(entry.written);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) writes.push(navigator.clipboard.writeText(text));
      if (deps.embedded) {
        writes.forEach(function (written) { written.catch(function () {}); });
        deps.toParent({ type: 'envhaven-console:clipboard', text: text });
        return;
      }
      if (!writes.length) {
        notice('Clipboard left unchanged: ' + (window.isSecureContext ? 'this browser gives the page no clipboard' : 'the browser allows the clipboard only over HTTPS'));
        return;
      }
      // Any of the writes landing is the copy landing; it is lost only when every one is refused.
      var pending = writes.length, landed = false;
      writes.forEach(function (written) {
        written.then(function () {
          if (landed) return;
          landed = true;
          notice('Terminal copied ' + text.length.toLocaleString() + (text.length === 1 ? ' character' : ' characters') + ' to the clipboard');
        }, function () {
          if (--pending === 0 && !landed) notice('Clipboard left unchanged: the browser refused the write');
        });
      });
    }

    function refuse(bytes) {
      if (pendingCopy) {
        var entry = pendingCopy;
        pendingCopy = null;
        deps.timers.clearTimeout(entry.timer);
        entry.reject();
      }
      notice('Clipboard left unchanged: the terminal tried to copy ' + (bytes / MAX_COPY_BYTES).toFixed(1) + ' MB, over the 1 MB limit');
    }

    term.parser.registerOscHandler(52, function (data) {
      var separator = data.indexOf(';');
      if (separator === -1) return true;
      var payload = data.slice(separator + 1);
      if (payload === '' || payload === '?') return true;
      if (payload.length > MAX_PAYLOAD) {
        refuse(payload.length / 4 * 3);
        return true;
      }
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
