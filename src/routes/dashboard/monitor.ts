import { sidebarHtml } from "./sidebar.ts";

export const monitorHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DeepSeek Gateway — Monitor</title>
  <link rel="stylesheet" href="/dashboard/static/shared.css">
  <link rel="stylesheet" href="/dashboard/static/overview.css">
  <link rel="stylesheet" href="/dashboard/static/monitor.css">

</head>
<body>

<div class="dashboard-layout">
  ${sidebarHtml("monitor")}
  <main class="main-content">
    <div class="page-header">
      <h1>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent)"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        Monitor
      </h1>
      <div class="page-header-right">
        <span class="badge badge-accent" id="entryCountBadge">— entries</span>
      </div>
    </div>

    <!-- KPI Grid -->
    <div class="monitor-kpi-grid" id="kpiGrid">
      <div class="kpi-card"><span class="kpi-label">Total Requests</span><span class="kpi-value" id="kpiTotalReqs">—</span><span class="kpi-sub" id="kpiTotalReqsSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Success</span><span class="kpi-value" id="kpiSuccess">—</span><span class="kpi-sub" id="kpiSuccessSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Errors</span><span class="kpi-value" id="kpiErrors">—</span><span class="kpi-sub" id="kpiErrorsSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Avg Latency</span><span class="kpi-value" id="kpiAvgLat">—</span><span class="kpi-sub" id="kpiAvgLatSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">P95 Latency</span><span class="kpi-value" id="kpiP95Lat">—</span><span class="kpi-sub" id="kpiP95LatSub"></span></div>
      <div class="kpi-card"><span class="kpi-label">Median</span><span class="kpi-value" id="kpiMedianLat">—</span><span class="kpi-sub" id="kpiMedianLatSub"></span></div>
    </div>

    <!-- Mode Comparison -->
    <div class="panel">
      <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Mode Comparison</span><span class="panel-chevron">▼</span></div>
      <div class="panel-body open">
        <div class="panel-content">
          <div class="mode-comparison" id="modeComparison">
            <div class="mode-card">
              <h3><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> Streaming</h3>
              <div class="mode-stats">
                <div class="mode-stat"><div class="mode-stat-value" id="modeStrReqs">—</div><div class="mode-stat-label">Requests</div></div>
                <div class="mode-stat"><div class="mode-stat-value" id="modeStrErrors">—</div><div class="mode-stat-label">Errors</div></div>
                <div class="mode-stat"><div class="mode-stat-value" id="modeStrLat">—</div><div class="mode-stat-label">Avg Latency</div></div>
              </div>
              <div class="mode-bar-row">
                <span class="mode-bar-label">Success</span>
                <div class="mode-bar-track"><div class="mode-bar-fill success" id="modeStrBar" style="width:0%"></div></div>
                <span class="mode-bar-num" id="modeStrPct">0%</span>
              </div>
            </div>
            <div class="mode-card">
              <h3><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/></svg> Non-Streaming</h3>
              <div class="mode-stats">
                <div class="mode-stat"><div class="mode-stat-value" id="modeNsReqs">—</div><div class="mode-stat-label">Requests</div></div>
                <div class="mode-stat"><div class="mode-stat-value" id="modeNsErrors">—</div><div class="mode-stat-label">Errors</div></div>
                <div class="mode-stat"><div class="mode-stat-value" id="modeNsLat">—</div><div class="mode-stat-label">Avg Latency</div></div>
              </div>
              <div class="mode-bar-row">
                <span class="mode-bar-label">Success</span>
                <div class="mode-bar-track"><div class="mode-bar-fill success" id="modeNsBar" style="width:0%"></div></div>
                <span class="mode-bar-num" id="modeNsPct">0%</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Per-Account Monitoring Table -->
    <div class="panel">
      <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Per-Account Metrics</span><span class="panel-chevron">▼</span></div>
      <div class="panel-body open">
        <div class="panel-content">
          <div class="monitor-info-row">
            <span id="timeRange">Collecting data...</span>
          </div>
          <div class="monitor-table-wrap" id="acctTableWrap">
            <div class="empty-monitor" id="emptyMonitor">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
              <h3>No monitoring data yet</h3>
              <p>Data appears here once accounts start responding to requests.<br>Each request is recorded with its latency, mode, and success status.</p>
            </div>
            <table class="monitor-table" id="monitorTable" style="display:none">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Total</th>
                  <th>Success</th>
                  <th>Errors</th>
                  <th>Rate</th>
                  <th>Avg Lat</th>
                  <th>P95</th>
                  <th>Median</th>
                  <th>Modes</th>
                  <th>Recent Errors</th>
                </tr>
              </thead>
              <tbody id="monitorBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- Error Summary -->
    <div class="panel">
      <div class="panel-header open" onclick="togglePanel(this)"><span class="panel-title">Top Errors</span><span class="panel-chevron">▼</span></div>
      <div class="panel-body open">
        <div class="panel-content">
          <div id="errorSummaryContainer">
            <div class="empty-state" id="errorSummaryEmpty">No errors recorded</div>
            <ul class="error-list" id="errorSummaryList" style="display:none"></ul>
          </div>
        </div>
      </div>
    </div>

  </main>
</div>

  <script src="/dashboard/static/shared.js"></script>
  <script src="/dashboard/static/monitor.js"></script>
</body>
</html>`;
