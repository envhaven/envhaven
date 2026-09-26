// WebSocket lifecycle and wire protocol. No input is retained: a socket becomes writable
// only after its own authoritative predictor frame has been routed.
var EnvHavenConsoleTransport = (function () {
  function create(deps) {
    var MODEL = deps.model, term = deps.term, location = deps.location;
    var DATA = MODEL.FRAME.data, RESIZE = MODEL.FRAME.resize;
    var encoder = new deps.TextEncoder(), appDecoder = new deps.TextDecoder();
    var connection = MODEL.transportState();
    var socket = null, generation = 0, everConnected = false, postedReady = false;

    function transition(event) {
      var result = MODEL.reduceTransport(connection, event);
      connection = result.state;
      return result.effects;
    }

    function resetSession() {
      deps.emit({ type: 'prediction-disconnect' });
      deps.emit({ type: 'clear-link-underline' });
    }

    function connect() {
      if (connection.phase !== 'disconnected' || socket) return;
      transition({ type: 'connect' });
      var attempt = ++generation;
      if (everConnected || deps.statusVisible()) {
        deps.emit({ type: 'show-status', message: 'reconnecting', spinning: true });
      }
      deps.getToken().then(function (token) {
        if (attempt !== generation) return;
        if (!token) {
          transition({ type: 'socket-close' });
          resetSession();
          return;
        }
        deps.emit({ type: 'hide-login' });
        openSocket(token);
      }).catch(function (error) {
        if (attempt !== generation) return;
        transition({ type: 'socket-close' });
        resetSession();
        if (everConnected) deps.emit({ type: 'show-status', message: 'reconnect failed', spinning: false });
        else if (deps.embedded) deps.emit({ type: 'show-status', message: 'console unavailable', spinning: false });
        else deps.emit({ type: 'show-login', message: String(error) });
      });
    }

    function openSocket(token) {
      var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var url = protocol + '//' + location.host + '/__console?cols=' + term.cols + '&rows=' + term.rows;
      if (deps.echoEnabled) url += MODEL.predictQuery;
      if (deps.probeSession) url += '&probe=1&probeSession=' + encodeURIComponent(deps.probeSession);
      var current = deps.open(url, ['envhaven.console', token]);
      current.binaryType = 'arraybuffer';
      var decoder = new deps.TextDecoder();
      var readyAnnounced = false;
      socket = current;

      current.onopen = function () {
        if (socket !== current) return;
        transition({ type: 'socket-open', gateRequired: deps.echoEnabled });
        try {
          sendResize();
        } catch (error) {
          connectionFailed(current, 'connection failed');
        }
      };

      current.onmessage = function (event) {
        if (socket !== current) return;
        var bytes = new deps.Uint8Array(event.data);
        if (bytes[0] === DATA) {
          deps.emit({
            type: 'terminal-data',
            at: deps.clock.now(),
            text: decoder.decode(bytes.subarray(1), { stream: true })
          });
          transition({ type: 'data' });
          announceReady();
          return;
        }
        var gate = MODEL.decodePredictFrame(bytes, function (value) { return appDecoder.decode(value); });
        if (!gate) return;
        deps.emit({ type: 'prediction-gate', gate: gate });
        transition({ type: 'gate' });
        announceReady();
      };

      function announceReady() {
        if (readyAnnounced || connection.phase !== 'ready') return;
        readyAnnounced = true;
        var refocus = deps.statusVisible();
        everConnected = true;
        deps.emit({ type: 'transport-ready', refocus: refocus });
        if (deps.embedded && !postedReady) {
          postedReady = true;
          deps.emit({ type: 'parent-ready' });
        }
      }

      current.onclose = function () {
        if (socket !== current) return;
        socket = null;
        transition({ type: 'socket-close' });
        resetSession();
        deps.emit({ type: 'show-status', message: 'session disconnected', spinning: false });
      };
    }

    function connectionFailed(current, message) {
      if (socket !== current) return;
      socket = null;
      generation++;
      transition({ type: 'socket-close' });
      resetSession();
      try { current.close(); } catch (error) {}
      deps.emit({ type: 'show-status', message: message, spinning: false });
    }

    function frame(type, payload) {
      var out = new deps.Uint8Array(payload.length + 1);
      out[0] = type;
      out.set(payload, 1);
      return out;
    }

    function sendResize() {
      if (!socket || socket.readyState !== 1) return;
      socket.send(frame(RESIZE, encoder.encode(JSON.stringify({ cols: term.cols, rows: term.rows }))));
    }

    function sendInput(data) {
      var effects = transition({ type: 'input', data: data });
      var sent = false;
      for (var i = 0; i < effects.length; i++) {
        var effect = effects[i];
        if (effect.type === 'refuse-input') {
          deps.emit(effect);
          return false;
        }
        if (effect.type === 'send-input') {
          if (!socket || socket.readyState !== 1) {
            if (socket) connectionFailed(socket, 'connection failed');
            else {
              transition({ type: 'socket-close' });
              resetSession();
              deps.emit({ type: 'show-status', message: 'session disconnected', spinning: false });
            }
            return false;
          }
          try {
            socket.send(frame(DATA, encoder.encode(effect.data)));
            sent = true;
          } catch (error) {
            connectionFailed(socket, 'connection failed');
            return false;
          }
        } else if (effect.type === 'predict-input' && sent) {
          deps.emit(effect);
        }
      }
      return sent;
    }

    return {
      connect: connect, sendInput: sendInput, sendResize: sendResize,
      isReady: function () { return connection.phase === 'ready'; }
    };
  }
  return { create: create };
})();
