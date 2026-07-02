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
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: ui-monospace, "Cascadia Code", "Consolas", monospace;
    margin: 0; padding: 1.25rem 1.5rem 3rem;
    background: #0f1115; color: #e6e6e6;
    font-size: 14px; line-height: 1.5;
  }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; color: #9fb4c7; }
  a { color: #6cb6ff; }
  #identity {
    display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 0.75rem;
    background: #171a21; border: 1px solid #262b36; border-radius: 8px;
    padding: 0.75rem 1rem; max-width: 900px;
  }
  #identity .k { color: #8a93a3; }
  #identity .v { word-break: break-all; }
  button.copy {
    font: inherit; background: #262b36; color: #cfd6e2; border: 1px solid #333a48;
    border-radius: 4px; padding: 0 0.4rem; margin-left: 0.4rem; cursor: pointer; font-size: 0.75rem;
  }
  button.copy:hover { background: #333a48; }
  table { border-collapse: collapse; width: 100%; max-width: 1100px; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #262b36; vertical-align: top; }
  th { color: #8a93a3; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
  tr.disabled td { opacity: 0.5; }
  .pill {
    display: inline-block; padding: 0.05rem 0.5rem; border-radius: 999px; font-size: 0.75rem;
    background: #22303c; color: #7fd0a8; border: 1px solid #2c4536;
  }
  .pill.off { background: #302222; color: #d08a7f; border-color: #452c2c; }
  .mono-dim { color: #8a93a3; font-size: 0.85em; }
  .toggle-label { display: inline-flex; align-items: center; gap: 0.4rem; cursor: pointer; }
  #log-panel {
    background: #05070a; border: 1px solid #262b36; border-radius: 8px;
    padding: 0.75rem 1rem; height: 340px; overflow-y: auto; white-space: pre-wrap;
    max-width: 1100px; font-size: 0.82rem; margin: 0;
  }
  .log-line { }
  .log-line.warn { color: #e0c46c; }
  .log-line.error { color: #e08f8f; }
  .log-line .ts { color: #566072; }
  .log-line .scope { color: #6cb6ff; }
  #log-status { font-size: 0.78rem; color: #8a93a3; margin-bottom: 0.35rem; }
  .note { color: #8a93a3; font-size: 0.85em; margin-top: 0.5rem; max-width: 900px; }
  code { background: #1c2028; padding: 0 0.3rem; border-radius: 3px; }
</style>
</head>
<body>
  <h1>Conditional Payment Agent — Dashboard</h1>

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

  <h2>Live activity log</h2>
  <div id="log-status">connecting…</div>
  <pre id="log-panel"></pre>

  <p class="note">
    This dashboard only reads agent state and flips the enabled/disabled bit on existing rules —
    it cannot create rules, move funds, or reveal wallet secrets (mnemonic / oracle API key are
    never sent to this page).
  </p>

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
