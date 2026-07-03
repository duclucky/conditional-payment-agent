/**
 * Single self-contained HTML page (inline CSS/JS) for the Phase 4 dashboard. Kept as a template
 * string — not a file under a static/ dir — because the build script (`tsc`) has no asset-copy
 * step; a plain exported string works identically whether run via tsx or the compiled dist/.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Conditional Payment Agent — Dashboard</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #080b10;
    --surface: #0d1117;
    --border: #21262d;
    --text: #e6edf3;
    --text-muted: #7d8590;
    --accent-blue: #388bfd;
    --accent-green: #3fb950;
    --accent-yellow: #d29922;
    --accent-red: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    font-family: ui-monospace, "Cascadia Code", "Consolas", monospace;
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    line-height: 1.6;
  }

  .app-header {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--border);
    padding-bottom: 1.25rem;
    margin-bottom: 1.5rem;
  }
  .app-header h1 {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    font-size: 1.25rem;
    margin: 0;
  }
  .subtitle {
    margin: 0.4rem 0 0;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .live-badge {
    display: inline-flex; align-items: center; gap: 0.35rem;
    background: #0d2119; border: 1px solid #1a4731; border-radius: 999px;
    padding: 0.15rem 0.65rem; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.05em;
    color: var(--accent-green);
    vertical-align: middle; margin-left: 0.75rem;
  }
  .live-badge::before {
    content: '●'; animation: pulse 2s ease-in-out infinite;
  }

  h2 {
    font-size: 0.95rem; font-weight: 600;
    margin: 2rem 0 0.75rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
    color: var(--text);
  }

  a { color: var(--accent-blue); text-decoration: none; }
  a:hover { text-decoration: underline; }

  #identity {
    display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1rem;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 1rem 1.25rem; max-width: 900px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  }
  #identity .k { color: var(--text-muted); font-size: 0.82rem; padding-top: 0.1rem; }
  #identity .v { word-break: break-all; }

  button.copy {
    font: inherit; background: var(--border); color: var(--text); border: 1px solid #30363d;
    border-radius: 4px; padding: 0.05rem 0.5rem; margin-left: 0.5rem; cursor: pointer; font-size: 0.72rem;
    transition: background 0.15s ease;
  }
  button.copy:hover { background: #30363d; }

  table { border-collapse: collapse; width: 100%; max-width: 1200px; }
  thead { background: var(--surface); }
  th, td { text-align: left; padding: 0.55rem 0.75rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--text-muted); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
  tbody tr { transition: background 0.1s ease; }
  tbody tr:hover { background: #161b22; }
  tr.disabled td { opacity: 0.5; }

  #rules-body td[colspan] {
    text-align: center; color: var(--text-muted); padding: 2.5rem 1rem;
  }
  #rules-body td[colspan]::before {
    content: '◌  '; opacity: 0.6;
  }

  .pill {
    display: inline-block; padding: 0.1rem 0.6rem; border-radius: 999px; font-size: 0.72rem;
    font-weight: 500; letter-spacing: 0.02em;
    background: #0d2119; color: var(--accent-green); border: 1px solid #1a4731;
  }
  .pill.off { background: #2d1214; color: var(--accent-red); border-color: #4c1e21; }

  .toggle-label {
    display: inline-flex; align-items: center; gap: 0.4rem; cursor: pointer; position: relative;
  }
  .toggle-label input.rule-toggle {
    position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; padding: 0;
  }
  .toggle-label:hover .pill { filter: brightness(1.25); }

  .mono-dim { color: var(--text-muted); font-size: 0.85em; }

  .log-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-top: 2rem;
  }
  .log-header h2 { margin: 0; padding: 0; border-bottom: none; }
  #log-status {
    font-size: 0.72rem; color: var(--text-muted);
    background: var(--surface); border: 1px solid var(--border); border-radius: 999px;
    padding: 0.15rem 0.65rem;
  }

  #log-panel {
    background: #05070a; border: 1px solid var(--border); border-radius: 6px;
    padding: 0.85rem 1rem; height: 400px; overflow-y: auto; white-space: pre-wrap;
    max-width: 1200px; font-size: 0.8rem; margin: 0;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  }
  .log-line { padding: 0.15rem 0; }
  .log-line.warn { color: var(--accent-yellow); }
  .log-line.error { color: var(--accent-red); }
  .log-line .ts { color: #404854; }
  .log-line .scope { color: var(--accent-blue); }

  .app-footer {
    border-top: 1px solid var(--border);
    margin-top: 2.5rem;
    padding-top: 1rem;
  }
  .note { color: var(--text-muted); font-size: 0.78rem; margin: 0.5rem 0; max-width: 900px; }
  code { background: var(--surface); border: 1px solid var(--border); padding: 0.1rem 0.4rem; border-radius: 3px; }
</style>
</head>
<body>
  <header class="app-header">
    <h1>Conditional Payment Agent<span class="live-badge">LIVE</span></h1>
    <p class="subtitle">Unicity Testnet v2 · Track 01 — Autonomous Agents</p>
  </header>

  <div id="identity">Loading agent identity…</div>

  <p class="note">
    Reviewer test: send any amount to the nametag or direct address above from another Sphere
    wallet on <strong>testnet2</strong>, then watch the log below react within seconds. Cross-check
    the resulting transfer independently on the
    <a href="https://unicity.network" target="_blank" rel="noopener">Unicity Network Explorer</a>
    (paste the nametag / address / tx id there — no deep link is asserted here).
  </p>

  <h2>Rules</h2>
  <table id="rules-table">
    <thead>
      <tr>
        <th>On</th><th>Trigger</th><th>Action</th><th>Guards</th><th>Fired</th><th>Last fired</th><th>Cooldown</th>
      </tr>
    </thead>
    <tbody id="rules-body"><tr><td colspan="7">Loading…</td></tr></tbody>
  </table>

  <div class="log-header">
    <h2>Live activity log</h2>
    <span id="log-status">connecting…</span>
  </div>
  <pre id="log-panel"></pre>

  <footer class="app-footer">
    <p class="note">
      This dashboard only reads agent state and flips the enabled/disabled bit on existing rules —
      it cannot create rules, move funds, or reveal wallet secrets (mnemonic / oracle API key are
      never sent to this page).
    </p>
  </footer>

<script>
(function () {
  var ONE_UCT = 1000000000000000000n;

  function fmtAmount(raw) {
    try {
      var n = BigInt(raw);
      var whole = n / ONE_UCT;
      var frac = n % ONE_UCT;
      var fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
      var approx = whole.toString() + (fracStr ? '.' + fracStr : '') + ' UCT';
      return approx + ' (≈, assumes 18 decimals; raw=' + raw + ')';
    } catch (e) {
      return raw;
    }
  }

  function shortId(s, n) {
    if (!s) return '(none)';
    n = n || 10;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function describeTrigger(t) {
    if (t.type === 'onIncoming') {
      var from = t.fromSender ? 'from ' + esc(t.fromSender) : 'from any sender';
      var min = t.minIncoming ? ', min ' + fmtAmount(t.minIncoming) : '';
      return 'onIncoming — ' + from + min;
    }
    if (t.type === 'onBalanceAbove' || t.type === 'onBalanceBelow') {
      return t.type + ' ' + fmtAmount(t.threshold) + '<br><span class="mono-dim" title="' + esc(t.coinId) + '">coinId ' + esc(shortId(t.coinId, 14)) + '</span>';
    }
    if (t.type === 'onSchedule') {
      return 'onSchedule (cron: ' + esc(t.cron) + ') — <span class="mono-dim">NOT evaluated (TODO, see PHASE3_REPORT.md)</span>';
    }
    return esc(JSON.stringify(t));
  }

  function describeAction(a) {
    if (a.type === 'forward') {
      var amt = a.percent !== undefined ? a.percent + '%' : fmtAmount(a.fixedAmount) + ' (fixed)';
      var memo = a.memo ? ' <span class="mono-dim">memo: "' + esc(a.memo) + '"</span>' : '';
      return 'forward ' + amt + ' → ' + esc(a.to) + memo;
    }
    if (a.type === 'split') {
      return 'split: ' + a.splits.map(function (s) { return s.percent + '% → ' + esc(s.to); }).join(', ');
    }
    if (a.type === 'notify') {
      return 'notify ' + esc(a.to) + ': "' + esc(a.message) + '"';
    }
    return esc(JSON.stringify(a));
  }

  function describeGuards(g) {
    var parts = [];
    if (g.minAmount) parts.push('minAmount ' + fmtAmount(g.minAmount));
    if (g.maxTriggersPerHour !== undefined) parts.push('≤' + g.maxTriggersPerHour + '/hour');
    if (g.cooldownSeconds) parts.push('cooldown ' + g.cooldownSeconds + 's');
    if (g.excludeSenders && g.excludeSenders.length) parts.push(g.excludeSenders.length + ' excluded sender(s)');
    return parts.length ? parts.join(' · ') : '<span class="mono-dim">(none)</span>';
  }

  function renderIdentity(status) {
    var id = status.identity;
    var el = document.getElementById('identity');
    el.innerHTML =
      row('network', esc(status.network)) +
      row('nametag', id.nametag ? '@' + esc(id.nametag) : '<span class="mono-dim">(none registered)</span>', id.nametag ? '@' + id.nametag : '') +
      row('directAddress', esc(id.directAddress || '(unknown)'), id.directAddress || '') +
      row('chainPubkey', esc(id.chainPubkey || '(unknown)'), id.chainPubkey || '');
    function row(k, vHtml, copyVal) {
      var copyBtn = copyVal ? '<button class="copy" data-copy="' + esc(copyVal) + '">copy</button>' : '';
      return '<div class="k">' + k + '</div><div class="v">' + vHtml + copyBtn + '</div>';
    }
    el.querySelectorAll('button.copy').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var text = btn.getAttribute('data-copy');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            btn.textContent = 'copied!';
            setTimeout(function () { btn.textContent = 'copy'; }, 1200);
          }).catch(function () { btn.textContent = 'select & copy manually'; });
        }
      });
    });
  }

  function renderRules(status) {
    var body = document.getElementById('rules-body');
    if (!status.rules.length) {
      body.innerHTML = '<tr><td colspan="7">No rules configured.</td></tr>';
      return;
    }
    body.innerHTML = status.rules.map(function (r) {
      var cooldown = r.cooldownRemainingSeconds > 0 ? r.cooldownRemainingSeconds + 's remaining' : '<span class="mono-dim">ready</span>';
      var lastFired = r.lastFiredAt ? new Date(r.lastFiredAt).toLocaleString() : '<span class="mono-dim">never</span>';
      return '<tr class="' + (r.enabled ? '' : 'disabled') + '" data-rule-id="' + esc(r.id) + '">' +
        '<td><label class="toggle-label"><input type="checkbox" class="rule-toggle" ' + (r.enabled ? 'checked' : '') + ' /> ' +
          '<span class="pill ' + (r.enabled ? '' : 'off') + '">' + (r.enabled ? 'enabled' : 'disabled') + '</span></label></td>' +
        '<td>' + describeTrigger(r.trigger) + '</td>' +
        '<td>' + describeAction(r.action) + '</td>' +
        '<td>' + describeGuards(r.guards) + '</td>' +
        '<td>' + r.fireCount + '</td>' +
        '<td>' + lastFired + '</td>' +
        '<td>' + cooldown + '</td>' +
        '</tr>';
    }).join('');

    body.querySelectorAll('.rule-toggle').forEach(function (checkbox) {
      checkbox.addEventListener('change', function () {
        var tr = checkbox.closest('tr');
        var id = tr.getAttribute('data-rule-id');
        var enabled = checkbox.checked;
        checkbox.disabled = true;
        fetch('/api/rules/' + encodeURIComponent(id) + '/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: enabled }),
        }).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return refreshStatus();
        }).catch(function (err) {
          checkbox.checked = !enabled;
          alert('Failed to toggle rule: ' + err.message);
        }).finally(function () {
          checkbox.disabled = false;
        });
      });
    });
  }

  function refreshStatus() {
    return fetch('/api/status').then(function (res) { return res.json(); }).then(function (status) {
      renderIdentity(status);
      renderRules(status);
    }).catch(function (err) {
      document.getElementById('identity').textContent = 'Failed to load status: ' + err.message;
    });
  }

  refreshStatus();
  setInterval(refreshStatus, 2000);

  // --- Live log (SSE with manual reconnect so a dropped connection never silently stops updating) ---
  var logPanel = document.getElementById('log-panel');
  var logStatus = document.getElementById('log-status');
  var lastSeq = 0;
  var source = null;

  function appendLogEntry(entry) {
    lastSeq = Math.max(lastSeq, entry.seq);
    var atBottom = logPanel.scrollHeight - logPanel.scrollTop - logPanel.clientHeight < 40;
    var div = document.createElement('div');
    div.className = 'log-line ' + entry.level;
    div.innerHTML = '<span class="ts">' + new Date(entry.ts).toISOString() + '</span> <span class="scope">[' + esc(entry.scope) + ']</span> ' + esc(entry.message);
    logPanel.appendChild(div);
    while (logPanel.childNodes.length > 500) logPanel.removeChild(logPanel.firstChild);
    if (atBottom) logPanel.scrollTop = logPanel.scrollHeight;
  }

  function connectLogStream() {
    if (source) source.close();
    logStatus.textContent = 'connecting…';
    source = new EventSource('/api/log/stream?since=' + lastSeq);
    source.onopen = function () { logStatus.textContent = 'live'; };
    source.onmessage = function (ev) {
      try { appendLogEntry(JSON.parse(ev.data)); } catch (e) { /* ignore malformed frame */ }
    };
    source.onerror = function () {
      logStatus.textContent = 'disconnected — reconnecting…';
      source.close();
      setTimeout(connectLogStream, 2000);
    };
  }
  connectLogStream();
})();
</script>
</body>
</html>
`;
