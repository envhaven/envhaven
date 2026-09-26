// Managed parent-token bridge and self-host login/token exchange.
var EnvHavenConsoleAuth = (function () {
  function create(deps) {
    var window = deps.window, fetch = deps.fetch;
    var setTimeout = deps.timers.setTimeout, clearTimeout = deps.timers.clearTimeout;
    var parentOrigin = deps.parentOrigin;
    var embedded = !!parentOrigin;

    function fromParent(event) {
      return embedded && event.origin === parentOrigin && event.source === window.parent;
    }

    function toParent(message) {
      if (embedded) window.parent.postMessage(message, parentOrigin);
    }

    function requestTokenFromParent() {
      return new Promise(function (resolve, reject) {
        var done = false, tries = 0, timer = 0;
        function onMessage(event) {
          if (!fromParent(event)) return;
          if (!event.data || event.data.type !== 'envhaven-console:token' || typeof event.data.token !== 'string') return;
          done = true;
          cleanup();
          resolve(event.data.token);
        }
        function cleanup() {
          window.removeEventListener('message', onMessage);
          if (timer) clearTimeout(timer);
        }
        function ask() {
          if (done) return;
          if (tries++ >= 40) {
            cleanup();
            reject(new Error('no token from parent'));
            return;
          }
          toParent({ type: 'envhaven-console:token-request' });
          timer = setTimeout(ask, 300);
        }
        window.addEventListener('message', onMessage);
        ask();
      });
    }

    function getToken() {
      if (embedded) return requestTokenFromParent();
      return fetch('/__console/token').then(function (response) {
        if (response.status === 401) {
          deps.emit({ type: 'show-login', message: '' });
          return null;
        }
        if (!response.ok) throw new Error('token request failed: ' + response.status);
        return response.text();
      });
    }

    function login(password) {
      var body = new deps.URLSearchParams();
      body.set('password', password);
      fetch('/__console/login', { method: 'POST', body: body }).then(function (response) {
        if (response.status === 204) deps.emit({ type: 'login-accepted' });
        else if (response.status === 429) deps.emit({ type: 'show-login', message: 'Too many attempts. Wait a moment and try again.' });
        else deps.emit({ type: 'show-login', message: 'Invalid password.' });
      }).catch(function (error) {
        deps.emit({ type: 'show-login', message: String(error) });
      });
    }

    return {
      fromParent: fromParent, toParent: toParent,
      getToken: getToken, login: login
    };
  }
  return { create: create };
})();
