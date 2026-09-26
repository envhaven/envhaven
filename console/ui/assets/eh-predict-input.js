// Pure terminal-input decoder. It submits named commands rather than predictor state.
var EnvHavenConsoleInput = (function () {
  var INSERT_RE = /^[\x20-\x7e\u00a1-\u024f\u0370-\u03ff\u0400-\u04ff\u1e00-\u1eff]+$/;

  function decode(data) {
    if (data.indexOf('\r') !== -1 || data.indexOf('\n') !== -1) return { type: 'newline', data: data };
    if (/^[\x08\x7f]+$/.test(data)) return { type: 'backspace', count: data.length };
    if (/^(?:\x17|\x1b[\x08\x7f])+$/.test(data)) return { type: 'word-backspace', count: data.match(/\x17|\x1b[\x08\x7f]/g).length };
    if (/^(?:\x1b\[D|\x1bOD)+$/.test(data)) return { type: 'move', direction: -1, count: data.length / 3, word: false };
    if (/^(?:\x1b\[C|\x1bOC)+$/.test(data)) return { type: 'move', direction: 1, count: data.length / 3, word: false };
    if (/^(?:\x1bb|\x1b\[1;5D)+$/.test(data)) return { type: 'move', direction: -1, count: data.match(/\x1bb|\x1b\[1;5D/g).length, word: true };
    if (/^(?:\x1bf|\x1b\[1;5C)+$/.test(data)) return { type: 'move', direction: 1, count: data.match(/\x1bf|\x1b\[1;5C/g).length, word: true };
    if (/^(?:\x01|\x1b\[H|\x1bOH|\x1b\[1~)+$/.test(data)) return { type: 'home' };
    if (/^(?:\x05|\x1b\[F|\x1bOF|\x1b\[4~)+$/.test(data)) return { type: 'end' };
    if (/^(?:\x1b\[A|\x1bOA)+$/.test(data)) return { type: 'vertical', direction: -1, count: data.length / 3 };
    if (/^(?:\x1b\[B|\x1bOB)+$/.test(data)) return { type: 'vertical', direction: 1, count: data.length / 3 };
    if (/^\x15+$/.test(data)) return { type: 'kill-left' };
    if (INSERT_RE.test(data)) return { type: 'insert', text: data };
    if (/^(?:\x1b\[I|\x1b\[O|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[\d+;\d+R|\x1b\[\?\d+(?:;\d+)*[cu]|\x1b\[>\d+(?:;\d+)*c)+$/.test(data)) return { type: 'report' };
    return { type: 'handoff' };
  }

  return { decode: decode };
})();
