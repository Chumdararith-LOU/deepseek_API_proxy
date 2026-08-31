import { sidebarHtml } from "./sidebar.ts";

export const networkHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DeepSeek Gateway — Network Debug</title>
  <link rel="stylesheet" href="/dashboard/static/shared.css">
  <link rel="stylesheet" href="/dashboard/static/network.css">


</head>
<body>

<div class="dashboard-layout">
  ${sidebarHtml("network")}
  <main class="main-content">

<div class="page-header">
  <h1>
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent)"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
    Network
    <span class="count-badge" id="entryCount">0</span>
  </h1>
</div>

<div class="controls">
  <label style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500">Filter</label>
  <select class="filter-select" id="methodFilter" onchange="onFilterChange()">
    <option value="">All Methods</option>
    <option value="GET">GET</option>
    <option value="POST">POST</option>
    <option value="PUT">PUT</option>
    <option value="PATCH">PATCH</option>
    <option value="DELETE">DELETE</option>
  </select>
  <select class="filter-select" id="statusFilter" onchange="onFilterChange()">
    <option value="">All Status</option>
    <option value="2xx">2xx Success</option>
    <option value="4xx">4xx Client Error</option>
    <option value="5xx">5xx Server Error</option>
  </select>
  <select class="filter-select" id="categoryFilter" onchange="onFilterChange()">
    <option value="">All Categories</option>
    <option value="chat">Chat</option>
    <option value="auth">Auth</option>
    <option value="models">Models</option>
    <option value="session-create">Session Create</option>
    <option value="session-delete">Session Delete</option>
    <option value="settings">Settings</option>
    <option value="other">Other</option>
  </select>
  <span class="entry-count" id="filteredCount"></span>
</div>

<div class="net-container" id="netContainer">
  <div class="empty-state" id="netEmpty" style="display:none">No network entries recorded yet</div>
  <div class="error-state" id="netError" style="display:none"></div>
</div>

  </main>
</div>


  <script src="/dashboard/static/shared.js"></script>
  <script src="/dashboard/static/network.js"></script>
</body>
</html>`;
