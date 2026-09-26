// Login and connection status surfaces. This module owns their DOM and animation state;
// user actions leave through callbacks supplied by the composition root.
var EnvHavenConsoleStatus = (function () {
  function create(deps) {
    var window = deps.window, document = window.document, term = deps.term;
    var setTimeout = deps.timers.setTimeout, clearTimeout = deps.timers.clearTimeout;
    var setInterval = deps.timers.setInterval, clearInterval = deps.timers.clearInterval;
    var matchMedia = deps.matchMedia;
    var termEl = document.getElementById('term');
    var loginEl = document.getElementById('login');
    var errEl = document.getElementById('err');
    var pwEl = document.getElementById('password');
    var statusEl = document.getElementById('status');
    var statusWho = document.getElementById('statusWho');
    var statusMsg = document.getElementById('statusMsg');
    var statusBtn = document.getElementById('statusBtn');
    var statusSpin = document.getElementById('statusSpin');
    var statusLift = document.getElementById('statusLift');
    var SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    var LIFT = ['⠁', '⠂', '⠄', '⠈', '⠐', '⠠'];
    var spinTimer = 0, spinAt = 0, statusOn = false;
    var liftTimer = 0, liftAt = Math.floor(Math.random() * LIFT.length);

    statusWho.textContent = (deps.name || window.location.hostname || '').slice(0, 64);
    setTheme(deps.background, deps.foreground);

    function setTheme(background, foreground) {
      statusEl.style.background = background;
      if (foreground) statusEl.style.color = foreground;
      else statusEl.style.removeProperty('color');
    }

    function showLogin(message) {
      hideStatus();
      errEl.textContent = message || '';
      loginEl.classList.add('show');
      termEl.classList.add('hide');
      pwEl.focus();
    }

    function hideLogin() {
      loginEl.classList.remove('show');
      termEl.classList.remove('hide');
      deps.fit.fit();
      term.focus();
    }

    function stutter(lit) {
      if (lit) {
        liftAt = (liftAt + 1 + Math.floor(Math.random() * (LIFT.length - 1))) % LIFT.length;
        statusLift.textContent = LIFT[liftAt];
      }
      statusLift.classList.toggle('on', lit);
      liftTimer = setTimeout(function () { stutter(!lit); },
        lit ? 500 + Math.random() * 600 : 900 + Math.random() * 1500);
    }

    function stopStutter() {
      if (liftTimer) { clearTimeout(liftTimer); liftTimer = 0; }
      statusLift.textContent = '';
      statusLift.classList.remove('on');
    }

    function show(message, spinning) {
      statusMsg.textContent = message;
      statusBtn.classList.toggle('away', !!spinning);
      statusSpin.textContent = spinning ? SPIN[spinAt] : '⠿';
      statusSpin.classList.toggle('dim', !spinning);
      statusEl.classList.add('show');
      statusOn = true;
      if (spinTimer) { clearInterval(spinTimer); spinTimer = 0; }
      stopStutter();
      if (spinning) {
        spinTimer = setInterval(function () {
          spinAt = (spinAt + 1) % SPIN.length;
          statusSpin.textContent = SPIN[spinAt];
        }, 80);
      } else if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        stutter(true);
      }
    }

    function hideStatus() {
      if (spinTimer) { clearInterval(spinTimer); spinTimer = 0; }
      stopStutter();
      statusEl.classList.remove('show');
      statusOn = false;
    }

    function refuseInput(phase) {
      if (phase === 'connecting') show('connecting; input not sent', true);
      else if (phase === 'awaiting-frame') show('reattaching; input not sent', true);
      else show('input not sent; reconnect to continue', false);
    }

    statusBtn.addEventListener('click', function () { deps.onReconnect(); });
    document.getElementById('loginForm').addEventListener('submit', function (event) {
      event.preventDefault();
      var password = pwEl.value;
      deps.onLogin(password);
    });

    function loginAccepted() {
      pwEl.value = '';
    }

    function connected(refocus) {
      hideStatus();
      if (refocus) term.focus();
    }

    return {
      show: show, visible: function () { return statusOn; },
      showLogin: showLogin, hideLogin: hideLogin, loginAccepted: loginAccepted,
      refuseInput: refuseInput, connected: connected, setTheme: setTheme
    };
  }
  return { create: create };
})();
