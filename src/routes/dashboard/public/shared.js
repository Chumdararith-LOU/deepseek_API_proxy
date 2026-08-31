/* ── Helpers ── */
function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}
function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}
function authHeaders() {
  return window.API_KEY ? { Authorization: 'Bearer ' + window.API_KEY } : {};
}
function fmtTime(ts) {
  if (!ts) return '—';
  var d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  var h = d.getHours(),
    m = d.getMinutes(),
    s = d.getSeconds();
  var ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + ' ' + ampm;
}
function fmtDuration(seconds) {
  if (seconds == null || seconds < 0) return '—';
  var d = Math.floor(seconds / 86400);
  var h = Math.floor((seconds % 86400) / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  var parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h > 0) parts.push(h + 'h');
  if (m > 0) parts.push(m + 'm');
  if (parts.length === 0 || s > 0) parts.push(s + 's');
  return parts.join(' ');
}
function togglePanel(header) {
  header.classList.toggle('open');
  var body = header.nextElementSibling;
  if (body) body.classList.toggle('open');
}
async function apiFetch(url) {
  try {
    var res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function createPoller(fn, baseInterval) {
  var timer = null,
    failures = 0,
    running = false;
  function tick() {
    if (!running) return;
    try {
      var r = fn();
      if (r && typeof r.then === 'function') {
        r.then(
          function () {
            failures = 0;
            schedule();
          },
          function () {
            failures++;
            schedule();
          },
        );
        return;
      }
      failures = 0;
    } catch {
      failures++;
    }
    schedule();
  }
  function schedule() {
    if (!running) return;
    var delay = Math.min(baseInterval * Math.pow(2, Math.min(failures, 3)), baseInterval * 8);
    timer = setTimeout(tick, delay);
  }
  function stop() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function start() {
    if (!running) {
      running = true;
      failures = 0;
      tick();
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });
  start();
  return { start: start, stop: stop };
}

/* ── Dark Mode ── */
function applyDarkMode(enabled) {
  var html = document.documentElement;
  var label = document.getElementById('dmLabel');
  var sw = document.getElementById('dmSwitch');
  var moon = document.getElementById('dmMoon');
  var sun = document.getElementById('dmSun');
  if (enabled) {
    html.classList.add('dark-mode');
    if (label) label.textContent = 'Dark';
    if (moon) moon.style.display = '';
    if (sun) sun.style.display = 'none';
    if (sw) sw.classList.add('active');
  } else {
    html.classList.remove('dark-mode');
    if (label) label.textContent = 'Light';
    if (moon) moon.style.display = 'none';
    if (sun) sun.style.display = '';
    if (sw) sw.classList.remove('active');
  }
}

async function toggleDarkMode() {
  var next = !document.documentElement.classList.contains('dark-mode');
  applyDarkMode(next);
  try {
    await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + window.API_KEY },
      body: JSON.stringify({ DARK_MODE: String(next) }),
    });
  } catch (e) {
    console.error('Failed to save dark mode preference:', e);
  }
}

/* Apply dark mode on load */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    applyDarkMode(window.DARK_MODE);
  });
} else {
  applyDarkMode(window.DARK_MODE);
}
