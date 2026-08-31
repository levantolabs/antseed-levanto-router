/**
 * Self-contained HTML for `GET /_antseed/routing-decisions/dashboard` --
 * opened in the user's default browser from the desktop app's Profile pill
 * (see apps/desktop/src/main/ipc/payments.ts's `payments:open-savings-page`).
 *
 * Deliberately NOT added to apps/payments' web SPA: that app's own App.tsx
 * states plainly "The portal dashboard is retired -- every view lives in the
 * desktop app (or the CLI). This page exists only for the actions that need
 * an external wallet signature." A read-only sessions/metrics view needs no
 * wallet signature, so it doesn't belong there. This route reuses the same
 * user-facing mechanism (a localhost page opened via shell.openExternal) on
 * the buyer-proxy's own already-running, already-unauthenticated control
 * plane instead, which already serves the JSON this page reads
 * (`/_antseed/routing-decisions`, same origin, no new server or auth needed).
 */
export const ROUTING_SAVINGS_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Auto-routing savings</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body {
    font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    max-width: 900px;
    margin: 0 auto;
    padding: 32px 20px 64px;
    color: #1a1a1a;
    background: #fff;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e6e6; background: #16171a; }
    .card { background: #1f2023 !important; border-color: #303136 !important; }
    th { color: #9a9ba0 !important; border-color: #303136 !important; }
    td { border-color: #26272b !important; }
    tr:hover td { background: #202124 !important; }
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: #767680; margin: 0 0 24px; font-size: 13px; }
  .stats { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .card {
    flex: 1 1 160px;
    background: #f7f7f8;
    border: 1px solid #e5e5e7;
    border-radius: 10px;
    padding: 14px 16px;
  }
  .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: #767680; margin-bottom: 4px; }
  .card .value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 24px; font-size: 13px; color: #767680; }
  .toolbar select {
    font: inherit; font-size: 13px; padding: 5px 8px; border-radius: 7px;
    border: 1px solid #d0d0d5; background: #fff; color: #1a1a1a;
  }
  .back { display: inline-block; margin-bottom: 14px; font-size: 13px; color: #4a7fd6; cursor: pointer; text-decoration: none; }
  .back:hover { text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; color: #767680; font-weight: 400; padding: 0 10px 8px; border-bottom: 1px solid #e5e5e7; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td { padding: 9px 10px; border-bottom: 1px solid #eee; }
  tr[data-session] { cursor: pointer; }
  tr:hover td { background: #fafafa; }
  .empty, .error { color: #767680; padding: 40px 0; text-align: center; }
  .error { color: #c0392b; }
  h2 { font-size: 15px; margin: 0 0 12px; }
</style>
</head>
<body>
<h1>Auto-routing savings</h1>
<p class="subtitle">Every session routed through your model router, with savings vs. retail pricing.</p>
<div class="toolbar">
  <label for="baseline-select">Comparing against</label>
  <select id="baseline-select"></select>
</div>
<div id="stats" class="stats"></div>
<div id="content"></div>
<script>
(function () {
  function fmtUsd(n) {
    if (!isFinite(n) || n <= 0) return '$0';
    if (n < 0.01) return '<$0.01';
    if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
    return '$' + n.toFixed(2);
  }
  function fmtDate(ms) {
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function computeSavings(rows, baselineModel) {
    var actualUsd = 0, baselineUsd = 0, models = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row.actualModel) continue;
      var baseline = row.baselinePrices && row.baselinePrices[baselineModel];
      if (!baseline) continue;
      var fresh = Math.max(0, (row.actualPromptTokens || 0) - (row.actualCachedTokens || 0));
      var cached = row.actualCachedTokens || 0;
      var output = row.actualCompletionTokens || 0;
      if (fresh === 0 && cached === 0 && output === 0) continue;
      var cachedPrice = baseline.cachedInUsdPerM != null ? baseline.cachedInUsdPerM : baseline.inUsdPerM;
      var rowBaseline = (fresh * baseline.inUsdPerM + cached * cachedPrice + output * baseline.outUsdPerM) / 1000000;
      if (rowBaseline <= 0) continue;
      baselineUsd += rowBaseline;
      actualUsd += row.actualUsdcPaid || 0;
      models[row.actualModel] = true;
    }
    if (baselineUsd <= 0) return null;
    return { actualUsd: actualUsd, baselineUsd: baselineUsd, savedUsd: Math.max(0, baselineUsd - actualUsd) };
  }
  function allBaselineModels(rows) {
    var counts = {};
    rows.forEach(function (row) {
      Object.keys(row.baselinePrices || {}).forEach(function (key) {
        counts[key] = (counts[key] || 0) + 1;
      });
    });
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
  }
  function groupBySession(rows) {
    var byKey = {};
    rows.forEach(function (row) {
      if (!row.conversationKey) return;
      (byKey[row.conversationKey] = byKey[row.conversationKey] || []).push(row);
    });
    return Object.keys(byKey).map(function (key) {
      var sessionRows = byKey[key].sort(function (a, b) { return a.atMs - b.atMs; });
      var lastActiveAt = Math.max.apply(null, sessionRows.map(function (r) { return r.atMs; }));
      return { conversationKey: key, rows: sessionRows, turnCount: sessionRows.length, lastActiveAt: lastActiveAt };
    }).sort(function (a, b) { return b.lastActiveAt - a.lastActiveAt; });
  }
  var STORAGE_KEY = 'antseed-dashboard-baseline';
  var allRows = [];
  var currentBaseline = null;

  function renderStats(rows, baselineModel) {
    var now = Date.now();
    var sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    var recentRows = rows.filter(function (r) { return r.atMs >= sevenDaysAgo; });
    var allTime = computeSavings(rows, baselineModel) || { savedUsd: 0 };
    var last7d = computeSavings(recentRows, baselineModel) || { savedUsd: 0 };
    var sessions = groupBySession(rows);
    document.getElementById('stats').innerHTML =
      '<div class="card"><div class="label">Saved, past 7 days</div><div class="value">' + fmtUsd(last7d.savedUsd) + '</div></div>' +
      '<div class="card"><div class="label">Saved, all time</div><div class="value">' + fmtUsd(allTime.savedUsd) + '</div></div>' +
      '<div class="card"><div class="label">Sessions</div><div class="value">' + sessions.length + '</div></div>' +
      '<div class="card"><div class="label">Routed turns</div><div class="value">' + rows.length + '</div></div>';
  }
  function renderSessionList() {
    renderStats(allRows, currentBaseline);
    var sessions = groupBySession(allRows);
    var html = '<table><thead><tr>' +
      '<th>Session</th><th>Last active</th><th class="num">Turns</th><th class="num">Saved</th>' +
      '</tr></thead><tbody>';
    sessions.forEach(function (session) {
      var savings = computeSavings(session.rows, currentBaseline);
      html += '<tr data-session="' + session.conversationKey + '">' +
        '<td>' + session.conversationKey.slice(0, 18) + '&hellip;</td>' +
        '<td>' + fmtDate(session.lastActiveAt) + '</td>' +
        '<td class="num">' + session.turnCount + '</td>' +
        '<td class="num">' + (savings ? fmtUsd(savings.savedUsd) : '&mdash;') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('content').innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('tr[data-session]'), function (tr) {
      tr.addEventListener('click', function () { renderSessionDetail(tr.getAttribute('data-session')); });
    });
  }
  function renderSessionDetail(conversationKey) {
    var rows = allRows.filter(function (r) { return r.conversationKey === conversationKey; }).sort(function (a, b) { return a.atMs - b.atMs; });
    var savings = computeSavings(rows, currentBaseline);
    renderStats(rows, currentBaseline);
    var html = '<a class="back" id="back-link">&larr; All sessions</a>' +
      '<h2>' + conversationKey.slice(0, 24) + '&hellip; &mdash; ' + rows.length + ' turn' + (rows.length === 1 ? '' : 's') +
      (savings ? ', saved ' + fmtUsd(savings.savedUsd) : '') + '</h2>' +
      '<table><thead><tr><th>Time</th><th>Model</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Saved</th></tr></thead><tbody>';
    rows.forEach(function (row) {
      var rowSavings = computeSavings([row], currentBaseline);
      var tokens = (row.actualPromptTokens || 0) + (row.actualCompletionTokens || 0);
      html += '<tr>' +
        '<td>' + fmtDate(row.atMs) + '</td>' +
        '<td>' + (row.actualModel || '&mdash;') + '</td>' +
        '<td class="num">' + tokens + '</td>' +
        '<td class="num">' + fmtUsd(row.actualUsdcPaid || 0) + '</td>' +
        '<td class="num">' + (rowSavings ? fmtUsd(rowSavings.savedUsd) : '&mdash;') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('content').innerHTML = html;
    document.getElementById('back-link').addEventListener('click', renderSessionList);
  }
  function populateBaselineSelect(rows) {
    var select = document.getElementById('baseline-select');
    var models = allBaselineModels(rows);
    var stored = localStorage.getItem(STORAGE_KEY);
    currentBaseline = (stored && models.indexOf(stored) !== -1) ? stored : models[0];
    select.innerHTML = models.map(function (m) {
      return '<option value="' + m + '"' + (m === currentBaseline ? ' selected' : '') + '>' + m + '</option>';
    }).join('');
    select.addEventListener('change', function () {
      currentBaseline = select.value;
      localStorage.setItem(STORAGE_KEY, currentBaseline);
      renderSessionList();
    });
  }
  function render(rows) {
    allRows = rows;
    if (!rows.length) {
      document.getElementById('stats').innerHTML = '';
      document.getElementById('content').innerHTML = '<p class="empty">No auto-routed sessions yet.</p>';
      document.querySelector('.toolbar').style.display = 'none';
      return;
    }
    populateBaselineSelect(rows);
    renderSessionList();
  }
  fetch('/_antseed/routing-decisions')
    .then(function (res) { return res.json(); })
    .then(function (body) { render((body && body.rows) || []); })
    .catch(function (err) {
      document.getElementById('content').innerHTML = '<p class="error">Could not load routing data: ' + (err && err.message ? err.message : err) + '</p>';
    });
})();
</script>
</body>
</html>
`;
