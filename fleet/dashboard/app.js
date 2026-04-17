const API = 'http://localhost:3001/api';
let pollInterval = null;
let workflowRunning = false;
let previousOrcaData = {};
let previousFleetData = {};
let currentEmployer = 'acme';

function switchEmployer() {
  currentEmployer = document.getElementById('employer-select').value;
  refreshRoster();
  refreshSummary();
}

// ============================================================
// SSE Connection
// ============================================================
const sse = new EventSource(API + '/events');

sse.onmessage = function(event) {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'log':
      appendLog(msg.data);
      break;
    case 'roster_update':
      refreshRoster();
      break;
    case 'roster_add':
      refreshRoster();
      break;
    case 'load_history_update':
      loadFleetTable('load-history');
      break;
    case 'approval_required':
      showApproval(msg.data);
      break;
    case 'approval_resolved':
      hideApproval();
      break;
    case 'workflow_start':
      workflowRunning = true;
      document.getElementById('workflow-status').textContent = 'Running: ' + msg.data.workflow;
      startPolling();
      break;
    case 'workflow_complete':
      workflowRunning = false;
      document.getElementById('workflow-status').textContent = 'Complete';
      stopPolling();
      showComplete(msg.data.workflow);
      refreshAll();
      break;
    case 'file_generated':
      refreshCSVs();
      break;
    case 'reset':
      clearLog();
      refreshAll();
      document.getElementById('workflow-status').textContent = 'Reset';
      break;
  }
};

// ============================================================
// Log Panel
// ============================================================
function appendLog(data) {
  const container = document.getElementById('log-entries');
  // Remove placeholder
  const placeholder = container.querySelector('p');
  if (placeholder) placeholder.remove();

  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const tagClass = (data.step_type || '').toLowerCase();
  const time = new Date().toLocaleTimeString();

  entry.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-tag ${tagClass}">${(data.step_type || '').toUpperCase()}</span>
    <span class="log-text"><strong>${data.step_name || ''}</strong> ${data.detail || ''}</span>
  `;

  container.appendChild(entry);

  // Auto-scroll
  const body = document.getElementById('log-body');
  body.scrollTop = body.scrollHeight;
}

function clearLog() {
  const container = document.getElementById('log-entries');
  container.innerHTML = '<p style="color:#484f58;padding:8px;">Waiting for workflow...</p>';
}

function showApproval(data) {
  const container = document.getElementById('log-entries');
  const banner = document.createElement('div');
  banner.className = 'approval-banner';
  banner.id = 'approval-banner';
  banner.innerHTML = `
    <p>${data.summary || 'Approval required'}</p>
    <button class="ctrl-btn primary" onclick="approveAction()">Approve</button>
  `;
  container.appendChild(banner);
  document.getElementById('log-body').scrollTop = document.getElementById('log-body').scrollHeight;
}

function hideApproval() {
  const banner = document.getElementById('approval-banner');
  if (banner) banner.remove();
}

function showComplete(workflow) {
  const container = document.getElementById('log-entries');
  const banner = document.createElement('div');
  banner.className = 'complete-banner';
  banner.textContent = `Workflow "${workflow}" complete`;
  container.appendChild(banner);
  document.getElementById('log-body').scrollTop = document.getElementById('log-body').scrollHeight;
}

// ============================================================
// Controls
// ============================================================
async function runWorkflow(name) {
  if (workflowRunning) return alert('A workflow is already running');
  clearLog();
  document.getElementById('summary-container').innerHTML = '';

  // Auto-select employer based on workflow
  const employerId = name.startsWith('passport') ? 'mta' : 'acme';
  // Sync the dropdown
  document.getElementById('employer-select').value = employerId;
  currentEmployer = employerId;
  refreshRoster();

  appendLog({ step_name: 'Starting', step_type: 'script', detail: 'Launching workflow: ' + name + ' (' + employerId + ')...' });
  document.getElementById('workflow-status').textContent = 'Starting: ' + name;
  try {
    const res = await fetch(API + '/run/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employer_id: employerId })
    });
    const data = await res.json();
    if (!res.ok) {
      appendLog({ step_name: 'Error', step_type: 'script', detail: data.error || 'Failed to start workflow' });
    } else {
      appendLog({ step_name: 'Launched', step_type: 'script', detail: 'Playwright browser opening for ' + employerId + '...' });
    }
  } catch (err) {
    appendLog({ step_name: 'Error', step_type: 'script', detail: 'Network error: ' + err.message });
  }
}

async function approveAction() {
  await fetch(API + '/approve', { method: 'POST' });
  hideApproval();
  appendLog({ step_name: 'Approved', step_type: 'approval', detail: 'Operator approved' });
}

async function resetDemo() {
  workflowRunning = false;
  stopPolling();
  await fetch(API + '/reset', { method: 'POST' });
  document.getElementById('orca-iframe').src = 'http://localhost:3000';
  refreshAll();
}

// ============================================================
// Tab Switching
// ============================================================
function switchLeftTab(tab, el) {
  document.querySelectorAll('#left-body > div').forEach(d => d.style.display = 'none');
  document.querySelectorAll('.panel:first-of-type .panel-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');

  if (tab === 'portal') {
    document.getElementById('left-portal').style.display = 'block';
  } else {
    document.getElementById('left-orca-db').style.display = 'block';
    loadOrcaTable('cards');
  }
}

function switchRightTab(tab, el) {
  document.querySelectorAll('#right-body > div').forEach(d => d.style.display = 'none');
  const tabs = document.querySelectorAll('.panel:nth-of-type(2) .panel-tab');
  tabs.forEach(t => t.classList.remove('active'));
  el.classList.add('active');

  if (tab === 'roster') {
    document.getElementById('right-roster').style.display = 'block';
    refreshRoster();
  } else if (tab === 'fleet-db') {
    document.getElementById('right-fleet-db').style.display = 'block';
    loadFleetTable('roster');
  } else if (tab === 'csvs') {
    document.getElementById('right-csvs').style.display = 'block';
    refreshCSVs();
  }
}

// ============================================================
// Data Loading
// ============================================================
async function loadOrcaTable(table, btn) {
  if (btn) {
    document.querySelectorAll('#left-orca-db .sub-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
  }
  try {
    const res = await fetch(API + '/orca-db/' + table);
    let data = await res.json();
    if (table === 'orders') data = data.orders || data;
    renderDbTable('orca-table-container', data, 'orca-' + table);
  } catch (e) { console.error(e); }
}

async function loadFleetTable(table, btn) {
  if (btn) {
    document.querySelectorAll('#right-fleet-db .sub-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
  }
  try {
    const res = await fetch(API + '/fleet-db/' + table);
    const data = await res.json();
    renderDbTable('fleet-table-container', data, 'fleet-' + table);
  } catch (e) { console.error(e); }
}

function renderDbTable(containerId, rows, cacheKey) {
  const container = document.getElementById(containerId);
  if (!rows || !rows.length) {
    container.innerHTML = '<p style="color:#484f58;padding:12px;">No data</p>';
    return;
  }

  const prevData = cacheKey.startsWith('orca') ? previousOrcaData : previousFleetData;
  const prevRows = prevData[cacheKey] || [];

  const cols = Object.keys(rows[0]);
  let html = '<table class="db-table"><thead><tr>';
  for (const col of cols) html += '<th>' + col + '</th>';
  html += '</tr></thead><tbody>';

  for (let i = 0; i < rows.length; i++) {
    html += '<tr>';
    for (const col of cols) {
      const val = rows[i][col];
      const prevRow = prevRows[i];
      const changed = prevRow && prevRow[col] !== val;
      const cls = changed ? ' class="changed"' : '';
      const display = val === null || val === undefined ? '<span class="null-val">NULL</span>' : escapeHtml(String(val));
      html += `<td${cls}>${display}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  container.innerHTML = html;

  if (cacheKey.startsWith('orca')) previousOrcaData[cacheKey] = rows;
  else previousFleetData[cacheKey] = rows;
}

async function refreshRoster() {
  try {
    const res = await fetch(API + '/roster?employer_id=' + currentEmployer);
    const roster = await res.json();
    const container = document.getElementById('roster-container');
    const isPassport = currentEmployer === 'mta';

    let html = '<table class="roster-table"><thead><tr>';
    html += '<th>Name</th><th>ID</th><th>Card CSN</th><th>Balance</th>';
    if (isPassport) {
      html += '<th>Passport</th>';
    } else {
      html += '<th>Subsidy</th><th>Autoload</th>';
    }
    html += '<th>Location</th><th>Status</th>';
    html += '</tr></thead><tbody>';

    for (const r of roster) {
      const statusClass = r.status === 'Active' ? 'active' : (r.status === 'Leave' ? 'leave' : 'inactive');
      const balance = r.current_balance !== null ? '$' + parseFloat(r.current_balance).toFixed(2) : '<span class="null-val">NULL</span>';
      html += `<tr>
        <td>${escapeHtml(r.employee_name)}</td>
        <td>${r.employee_id}</td>
        <td style="font-family:monospace;font-size:11px;">${r.card_csn ? '...' + r.card_csn.slice(-4) : ''}</td>
        <td>${balance}</td>`;
      if (isPassport) {
        html += `<td>${r.has_passport_verified ? '&#10003;' : '<span style="color:#f85149;">&#10007; MISSING</span>'}</td>`;
      } else {
        html += `<td>$${parseFloat(r.monthly_subsidy).toFixed(2)}</td>`;
        html += `<td>${r.autoload_configured ? '&#10003;' : '&#10007;'}</td>`;
      }
      html += `<td>${r.location || ''}</td>
        <td><span class="badge-sm badge-${statusClass}">${r.status}</span></td>
      </tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (e) { console.error(e); }
}

async function refreshCSVs() {
  try {
    const res = await fetch(API + '/output');
    const files = await res.json();
    const container = document.getElementById('csv-container');

    if (!files.length) {
      container.innerHTML = '<p style="color:#8b949e;padding:20px;">No files generated yet.</p>';
      return;
    }

    let html = '';
    for (const f of files) {
      html += `<div class="csv-file">
        <div class="csv-header" onclick="toggleCsvPreview('csv-${f.filename}')">
          <span class="csv-filename">${f.filename}</span>
          <span class="csv-meta">${f.rows} rows &middot; ${f.size} bytes</span>
        </div>
        <pre class="csv-preview" id="csv-${f.filename}">${escapeHtml(f.preview)}</pre>
      </div>`;
    }
    container.innerHTML = html;
  } catch (e) { console.error(e); }
}

function toggleCsvPreview(id) {
  document.getElementById(id).classList.toggle('open');
}

async function refreshSummary() {
  try {
    const res = await fetch(API + '/loads/summary');
    const s = await res.json();
    if (!s || !s.employer) return;

    const container = document.getElementById('summary-container');
    const pausedBd = s.autoloads_paused_breakdown || {};
    container.innerHTML = `
      <div class="summary-card">
        <h3>${s.employer} — ${s.cycle}</h3>
        <div class="summary-grid">
          <div class="summary-item"><label>Total Projected</label><span class="green">$${(s.total_projected_spend||0).toFixed(2)}</span></div>
          <div class="summary-item"><label>Autoload ×${s.autoload_covered_cards||0}</label><span>$${(s.autoload_projected||0).toFixed(2)}</span></div>
          <div class="summary-item"><label>Exception Loads</label><span>$${(s.exception_projected||0).toFixed(2)}</span></div>
          <div class="summary-item"><label>Bulk $50 / $100</label><span>${s.exception_bulk_50_cards||0} / ${s.exception_bulk_100_cards||0}</span></div>
          <div class="summary-item"><label>Autoloads Paused</label><span class="red">${s.autoloads_paused||0} ($${s.money_saved_from_pauses||0}/mo saved)</span></div>
          <div class="summary-item"><label>Autoloads Resumed</label><span class="green">${s.autoloads_resumed||0}</span></div>
          <div class="summary-item"><label>Offboard Queue</label><span>${s.offboard_queued||0}</span></div>
          <div class="summary-item"><label>Onboard Queue</label><span>${s.onboard_queued||0}</span></div>
          <div class="summary-item"><label>Flags</label><span>${(s.flags||[]).length}</span></div>
        </div>
        ${s.note ? '<p style="margin-top:10px;font-size:11px;color:#8b949e;">' + s.note + '</p>' : ''}
      </div>
    `;
  } catch (e) { /* no summary yet */ }
}

// ============================================================
// Polling
// ============================================================
function startPolling() {
  stopPolling();
  pollInterval = setInterval(() => {
    // Refresh whichever views are visible
    const leftDb = document.getElementById('left-orca-db');
    if (leftDb.style.display !== 'none') {
      const activeTab = document.querySelector('#left-orca-db .sub-tab.active');
      if (activeTab) loadOrcaTable(activeTab.textContent.replace('_', '-'));
    }
    const rightRoster = document.getElementById('right-roster');
    if (rightRoster.style.display !== 'none') refreshRoster();
    const rightDb = document.getElementById('right-fleet-db');
    if (rightDb.style.display !== 'none') {
      const activeTab = document.querySelector('#right-fleet-db .sub-tab.active');
      if (activeTab) loadFleetTable(activeTab.textContent.replace('_', '-'));
    }
    const rightCsv = document.getElementById('right-csvs');
    if (rightCsv.style.display !== 'none') refreshCSVs();
    refreshSummary();
  }, 2000);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

function refreshAll() {
  refreshRoster();
  refreshCSVs();
  refreshSummary();
  loadFleetTable('load-history');
}

// ============================================================
// Utils
// ============================================================
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Initial load
refreshRoster();
