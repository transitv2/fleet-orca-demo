const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { initDb, getDb } = require('./db');

const app = express();
const PORT = 3001;

// Initialize Fleet database
initDb();

// Open myORCA database read-only for proxy endpoints
const orcaDbPath = path.join(__dirname, '..', 'mock-orca', 'orca.db');
let orcaDb;
function getOrcaDb() {
  if (!orcaDb) {
    orcaDb = new Database(orcaDbPath, { readonly: true });
  }
  return orcaDb;
}

// Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve dashboard
app.use(express.static(path.join(__dirname, 'dashboard')));

// SSE clients
const sseClients = new Set();
let workflowActive = false;
let approvalPending = false;
let approvalApproved = false;
let approvalSummary = '';

function sendSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

// SSE endpoint
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ============================================================
// FLEET API ENDPOINTS
// ============================================================

// Roster (optionally filtered by employer)
app.get('/api/roster', (req, res) => {
  const db = getDb();
  const employerId = req.query.employer_id;
  const roster = employerId
    ? db.prepare('SELECT * FROM roster WHERE employer_id = ? ORDER BY employee_name').all(employerId)
    : db.prepare('SELECT * FROM roster ORDER BY employer_id, employee_name').all();
  res.json(roster);
});

// Employers list
app.get('/api/employers', (req, res) => {
  const db = getDb();
  const employers = db.prepare('SELECT * FROM employer_config ORDER BY employer_name').all();
  res.json(employers);
});

// Pending onboard employees (must be before :employeeId route)
app.get('/api/roster/pending', (req, res) => {
  const db = getDb();
  const employerId = req.query.employer_id;
  const pending = employerId
    ? db.prepare("SELECT * FROM roster WHERE status = 'pending_onboard' AND card_csn IS NULL AND employer_id = ? ORDER BY id").all(employerId)
    : db.prepare("SELECT * FROM roster WHERE status = 'pending_onboard' AND card_csn IS NULL ORDER BY id").all();
  res.json(pending);
});

app.get('/api/roster/:employeeId', (req, res) => {
  const db = getDb();
  const emp = db.prepare('SELECT * FROM roster WHERE employee_id = ?').get(req.params.employeeId);
  if (!emp) return res.status(404).json({ error: 'Not found' });
  res.json(emp);
});

// Employer Config (filtered by employer_id if provided)
app.get('/api/config', (req, res) => {
  const db = getDb();
  const employerId = req.query.employer_id;
  const config = employerId
    ? db.prepare('SELECT * FROM employer_config WHERE employer_id = ?').get(employerId)
    : db.prepare('SELECT * FROM employer_config LIMIT 1').get();
  res.json(config);
});

// Process HRIS (employer-aware — uses correct feed file)
app.post('/api/hris/process', (req, res) => {
  const { parse } = require('csv-parse/sync');
  const employerId = req.body?.employer_id || 'acme';
  const feedFile = employerId === 'mta' ? 'mta_feed.csv' : 'feed.csv';
  const feedPath = path.join(__dirname, 'hris', feedFile);

  if (!fs.existsSync(feedPath)) {
    return res.status(404).json({ error: 'HRIS feed not found for employer: ' + employerId });
  }

  const feedContent = fs.readFileSync(feedPath, 'utf-8');
  const records = parse(feedContent, { columns: true, skip_empty_lines: true, trim: true });

  const db = getDb();
  const roster = db.prepare('SELECT * FROM roster WHERE employer_id = ?').all(employerId);
  const rosterMap = {};
  for (const r of roster) rosterMap[r.employee_id] = r;

  const actions = {
    new_hires: [],
    terminated: [],
    leave: [],
    return_from_leave: [],
    retroactive: [],
    worksite_transfer: [],
    active: [],
    active_no_autoload: [],
    missing_passport: [] // Passport-specific
  };

  for (const rec of records) {
    switch (rec.status) {
      case 'new_hire':
        actions.new_hires.push(rec);
        break;
      case 'terminated':
        actions.terminated.push(rec);
        break;
      case 'leave':
        actions.leave.push(rec);
        break;
      case 'return_from_leave':
        actions.return_from_leave.push(rec);
        break;
      case 'retroactive':
        actions.retroactive.push(rec);
        break;
      case 'worksite_transfer':
        actions.worksite_transfer.push(rec);
        break;
      case 'active': {
        const rosterEntry = rosterMap[rec.employee_id];
        if (rosterEntry) {
          // Passport-specific: check has_passport_verified
          if (rec.product_type === 'Passport' && !rosterEntry.has_passport_verified) {
            actions.missing_passport.push({ ...rec, roster: rosterEntry });
          } else if (rec.product_type === 'Choice' && !rosterEntry.autoload_configured) {
            actions.active_no_autoload.push({ ...rec, roster: rosterEntry });
          } else {
            actions.active.push(rec);
          }
        } else {
          actions.active.push(rec);
        }
        break;
      }
    }
  }

  res.json(actions);
});

// Calculate loads
app.post('/api/loads/calculate', (req, res) => {
  const db = getDb();
  const employerId = req.body?.employer_id || 'acme';
  const config = db.prepare('SELECT * FROM employer_config WHERE employer_id = ?').get(employerId)
    || db.prepare('SELECT * FROM employer_config LIMIT 1').get();
  const roster = db.prepare('SELECT * FROM roster WHERE employer_id = ?').all(employerId);
  const cap = config.epurse_cap;
  const subsidy = config.monthly_subsidy;
  const cycleMonth = new Date().toISOString().slice(0, 7);

  // Load HRIS once
  const feedPath = path.join(__dirname, 'hris', employerId === 'mta' ? 'mta_feed.csv' : 'feed.csv');
  const { parse } = require('csv-parse/sync');
  const hrisRecords = fs.existsSync(feedPath)
    ? parse(fs.readFileSync(feedPath, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true })
    : [];
  const hrisMap = {};
  for (const rec of hrisRecords) hrisMap[rec.employee_id] = rec;

  const results = [];

  for (const emp of roster) {
    if (!emp.card_csn) continue;

    const hrisEntry = hrisMap[emp.employee_id];
    const hrisStatus = hrisEntry ? hrisEntry.status : null;

    // Include in calc if: no autoload, OR retroactive (regardless of autoload), OR terminated/leave
    const isRetroactive = hrisStatus === 'retroactive';
    const isTerminated = hrisStatus === 'terminated';
    const isLeave = hrisStatus === 'leave';
    const isException = !emp.autoload_configured || isRetroactive || isTerminated || isLeave;

    if (!isException) continue;

    const balance = emp.current_balance;
    if (balance === null && (isRetroactive || !emp.autoload_configured)) continue; // Need balance to compute cap math

    const capRoom = balance !== null ? cap - balance : cap;

    // Terminated / Leave → excluded from loads
    if (isTerminated || isLeave) {
      results.push({
        employee_id: emp.employee_id,
        employee_name: emp.employee_name,
        card_csn: emp.card_csn,
        cycle_month: cycleMonth,
        base_amount: 0,
        retroactive_amount: 0,
        cap_room: capRoom,
        actual_load: 0,
        forfeited: 0,
        load_method: 'excluded',
        exclusion_reason: isTerminated ? 'terminated' : 'on_leave',
      });
      continue;
    }

    // Determine base + retro amounts based on autoload status
    let baseAmount = emp.autoload_configured ? 0 : subsidy; // Autoload handles base
    let retroAmount = isRetroactive ? subsidy * (config.retroactive_months || 1) : 0;

    const totalOwed = baseAmount + retroAmount;
    const actualLoad = Math.min(totalOwed, Math.max(0, capRoom));
    const forfeited = totalOwed - actualLoad;

    let loadMethod = 'excluded';
    if (actualLoad > 0) {
      loadMethod = (actualLoad === 50 || actualLoad === 100) ? 'bulk' : 'manual';
    }
    const exclusionReason = actualLoad === 0 ? (capRoom <= 0 ? 'at_cap' : 'no_load_needed') : null;

    results.push({
      employee_id: emp.employee_id,
      employee_name: emp.employee_name,
      card_csn: emp.card_csn,
      cycle_month: cycleMonth,
      base_amount: baseAmount,
      retroactive_amount: retroAmount,
      cap_room: capRoom,
      actual_load: actualLoad,
      forfeited,
      load_method: actualLoad > 0 ? loadMethod : 'excluded',
      exclusion_reason: exclusionReason,
    });
  }

  // Store in load_history
  const insert = db.prepare(`
    INSERT INTO load_history (employee_id, card_csn, cycle_month, base_amount, retroactive_amount,
      cap_room, actual_load, forfeited, load_method, exclusion_reason, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `);

  for (const r of results) {
    insert.run(r.employee_id, r.card_csn, r.cycle_month, r.base_amount, r.retroactive_amount,
      r.cap_room, r.actual_load, r.forfeited, r.load_method, r.exclusion_reason);
  }

  res.json(results);
});

// Generate CSV files
app.post('/api/loads/generate-csv', (req, res) => {
  const db = getDb();
  const cycleMonth = new Date().toISOString().slice(0, 7);
  const loads = db.prepare("SELECT * FROM load_history WHERE cycle_month = ? AND status = 'pending'").all(cycleMonth);

  const { stringify } = require('csv-stringify/sync');
  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // Group by amount for bulk CSVs
  const bulkGroups = {};
  const manualLoads = [];
  const excluded = [];

  for (const load of loads) {
    if (load.load_method === 'excluded') {
      excluded.push({ employee_id: load.employee_id, card_csn: load.card_csn, reason: load.exclusion_reason });
    } else if (load.load_method === 'bulk') {
      const amt = load.actual_load;
      if (!bulkGroups[amt]) bulkGroups[amt] = [];
      bulkGroups[amt].push(load.card_csn);
    } else if (load.load_method === 'manual') {
      manualLoads.push({ card_csn: load.card_csn, amount: load.actual_load, employee_id: load.employee_id });
    }
  }

  const files = [];

  // Write bulk CSVs
  for (const [amount, csns] of Object.entries(bulkGroups)) {
    const filename = `bulk_${amount}.csv`;
    const csv = stringify(csns.map(csn => ({ PrintedCardNumber: csn })), { header: true });
    fs.writeFileSync(path.join(outputDir, filename), csv);
    files.push({ filename, rows: csns.length, type: 'bulk', amount: parseFloat(amount) });
  }

  // Write manual loads
  if (manualLoads.length) {
    fs.writeFileSync(path.join(outputDir, 'manual_loads.json'), JSON.stringify(manualLoads, null, 2));
    files.push({ filename: 'manual_loads.json', rows: manualLoads.length, type: 'manual' });
  }

  // Write excluded
  if (excluded.length) {
    fs.writeFileSync(path.join(outputDir, 'excluded.json'), JSON.stringify(excluded, null, 2));
    files.push({ filename: 'excluded.json', rows: excluded.length, type: 'excluded' });
  }

  res.json({ files, bulkGroups, manualLoads, excluded });
});

// Record load_history entries (called from monthly cycle — no scraping, just submitted amounts)
app.post('/api/loads/record', (req, res) => {
  const db = getDb();
  const { entries } = req.body;
  const cycleMonth = new Date().toISOString().slice(0, 7);

  const insert = db.prepare(`
    INSERT INTO load_history (employee_id, employee_name, card_csn, cycle_month,
      base_amount, retroactive_amount, submitted_amount, load_method, exclusion_reason, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(rows => {
    for (const r of rows) {
      insert.run(
        r.employee_id || '',
        r.employee_name || '',
        r.card_csn,
        cycleMonth,
        r.base_amount || 0,
        r.retroactive_amount || 0,
        r.submitted_amount || 0,
        r.load_method,
        r.exclusion_reason || null,
        r.status || 'submitted'
      );
    }
  });

  insertMany(entries || []);
  sendSSE({ type: 'load_history_update', data: { count: (entries || []).length } });
  res.json({ ok: true, count: (entries || []).length });
});

// Summary — reads the employer_summary.json written by the monthly workflow
app.get('/api/loads/summary', (req, res) => {
  const outputDir = path.join(__dirname, 'output');
  const summaryPath = path.join(outputDir, 'employer_summary.json');
  if (!fs.existsSync(summaryPath)) {
    return res.json({ total_projected_spend: 0, note: 'No summary yet — run a monthly cycle' });
  }
  try {
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
    res.json(summary);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Log automation step
app.post('/api/log', (req, res) => {
  const db = getDb();
  const { workflow, step_name, step_type, detail, status } = req.body;
  db.prepare(`
    INSERT INTO automation_log (workflow, step_name, step_type, detail, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(workflow, step_name, step_type, detail, status || 'completed');

  sendSSE({ type: 'log', data: { workflow, step_name, step_type, detail, status: status || 'completed' } });
  res.json({ ok: true });
});

// Approval
app.post('/api/approve', (req, res) => {
  approvalApproved = true;
  approvalPending = false;
  sendSSE({ type: 'approval_resolved', data: { approved: true } });
  res.json({ ok: true });
});

app.get('/api/approve/status', (req, res) => {
  res.json({ pending: approvalPending, approved: approvalApproved, summary: approvalSummary });
});

app.post('/api/approve/request', (req, res) => {
  approvalPending = true;
  approvalApproved = false;
  approvalSummary = req.body.summary || '';
  sendSSE({ type: 'approval_required', data: { summary: approvalSummary, workflow: req.body.workflow } });
  res.json({ ok: true });
});

// Update roster balance (from Playwright scraping)
app.post('/api/roster/update-balance', (req, res) => {
  const db = getDb();
  const { card_csn, balance } = req.body;
  db.prepare(`
    UPDATE roster SET current_balance = ?, balance_updated_at = datetime('now')
    WHERE card_csn = ?
  `).run(balance, card_csn);

  sendSSE({ type: 'roster_update', data: { card_csn, field: 'current_balance', value: balance } });
  res.json({ ok: true });
});

// Update roster field
app.post('/api/roster/update', (req, res) => {
  const db = getDb();
  const { employee_id, updates } = req.body;
  for (const [field, value] of Object.entries(updates)) {
    db.prepare(`UPDATE roster SET ${field} = ? WHERE employee_id = ?`).run(value, employee_id);
  }
  sendSSE({ type: 'roster_update', data: { employee_id, updates } });
  res.json({ ok: true });
});

// Add roster entry
app.post('/api/roster/add', (req, res) => {
  const db = getDb();
  const r = req.body;
  db.prepare(`
    INSERT INTO roster (employee_name, employee_id, email, location, program_type, card_csn, identifier,
      access_level, autoload_configured, monthly_subsidy, current_balance,
      has_passport_verified, employer_id, status, onboard_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.employee_name, r.employee_id, r.email, r.location, r.program_type || 'Choice',
    r.card_csn || null, r.card_csn || null, r.access_level || null, r.autoload_configured || 0,
    r.monthly_subsidy || 50.00, r.current_balance || null,
    r.has_passport_verified || 0, r.employer_id || 'acme',
    r.status || 'Active',
    r.onboard_date || new Date().toISOString().slice(0, 10));
  sendSSE({ type: 'roster_add', data: r });
  res.json({ ok: true });
});


// Reset
app.post('/api/reset', (req, res) => {
  const { execSync } = require('child_process');
  try {
    // Close database connections
    const db = getDb();
    db.close();
    if (orcaDb) { orcaDb.close(); orcaDb = null; }

    // Re-run seed
    execSync('node seed.js', { cwd: path.join(__dirname, '..'), stdio: 'pipe' });

    // Re-initialize
    require('./db').closeDb();
    initDb();

    // Clear output
    const outputDir = path.join(__dirname, 'output');
    if (fs.existsSync(outputDir)) {
      for (const f of fs.readdirSync(outputDir)) {
        fs.unlinkSync(path.join(outputDir, f));
      }
    }

    approvalPending = false;
    approvalApproved = false;
    workflowActive = false;

    sendSSE({ type: 'reset', data: {} });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Output files
app.get('/api/output', (req, res) => {
  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) return res.json([]);
  const files = fs.readdirSync(outputDir).map(f => {
    const stat = fs.statSync(path.join(outputDir, f));
    const content = fs.readFileSync(path.join(outputDir, f), 'utf-8');
    const lines = content.trim().split('\n');
    return { filename: f, size: stat.size, rows: lines.length - (f.endsWith('.csv') ? 1 : 0), preview: lines.slice(0, 6).join('\n') };
  });
  res.json(files);
});

app.get('/api/output/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'output', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  const content = fs.readFileSync(filePath, 'utf-8');
  res.type(req.params.filename.endsWith('.csv') ? 'text/csv' : 'application/json').send(content);
});

// ============================================================
// RAW DATABASE VIEWS (for dashboard Database tabs)
// ============================================================

// myORCA DB proxy
app.get('/api/orca-db/cards', (req, res) => {
  try { res.json(getOrcaDb().prepare('SELECT * FROM cards ORDER BY id').all()); }
  catch (e) { res.json([]); }
});
app.get('/api/orca-db/participants', (req, res) => {
  try { res.json(getOrcaDb().prepare('SELECT * FROM participants ORDER BY id').all()); }
  catch (e) { res.json([]); }
});
app.get('/api/orca-db/orders', (req, res) => {
  try {
    const orders = getOrcaDb().prepare('SELECT * FROM orders ORDER BY id DESC').all();
    const items = getOrcaDb().prepare('SELECT oi.*, c.printed_card_number FROM order_items oi JOIN cards c ON oi.card_id = c.id ORDER BY oi.id').all();
    res.json({ orders, items });
  } catch (e) { res.json({ orders: [], items: [] }); }
});
app.get('/api/orca-db/autoloads', (req, res) => {
  try { res.json(getOrcaDb().prepare('SELECT a.*, c.printed_card_number FROM autoloads a JOIN cards c ON a.card_id = c.id ORDER BY a.id').all()); }
  catch (e) { res.json([]); }
});
app.get('/api/orca-db/bulk-jobs', (req, res) => {
  try { res.json(getOrcaDb().prepare('SELECT * FROM bulk_jobs ORDER BY id DESC').all()); }
  catch (e) { res.json([]); }
});

// Fleet DB views
app.get('/api/fleet-db/roster', (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM roster ORDER BY id').all());
});
app.get('/api/fleet-db/load-history', (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM load_history ORDER BY id DESC').all());
});
app.get('/api/fleet-db/automation-log', (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM automation_log ORDER BY id DESC').all());
});

// ============================================================
// BALANCE AUDIT
// ============================================================

app.post('/api/audit/start', (req, res) => {
  const db = getDb();
  const count = req.body?.count || 10;
  const employerId = req.body?.employer_id || 'acme';

  // Get all cards on this employer's business account
  const orca = getOrcaDb();
  const allCards = orca.prepare(`
    SELECT c.printed_card_number, p.first_name, p.last_name
    FROM cards c LEFT JOIN participants p ON c.participant_id = p.id
    WHERE c.employer_id = ? AND c.on_business_account = 1 AND c.status = 'Active'
    ORDER BY c.id
  `).all(employerId);

  // Prioritized selection: flagged cards first, then recent loads, then random
  const flagsPath = path.join(__dirname, 'output', 'flags.json');
  const loadsPath = path.join(__dirname, 'output', 'bulk_50.csv');
  const loads100Path = path.join(__dirname, 'output', 'bulk_100.csv');

  let priorityCsns = new Set();
  if (fs.existsSync(flagsPath)) {
    try {
      const flags = JSON.parse(fs.readFileSync(flagsPath, 'utf-8'));
      // Flags with CSNs: duplicate_cards has them nested
      for (const f of flags) {
        if (f.cards) for (const c of f.cards) priorityCsns.add(c.csn);
      }
    } catch (e) {}
  }
  // Add bulk load cards
  for (const filepath of [loadsPath, loads100Path]) {
    if (fs.existsSync(filepath)) {
      const lines = fs.readFileSync(filepath, 'utf-8').trim().split('\n').slice(1);
      for (const line of lines) {
        if (line.trim()) priorityCsns.add(line.trim());
      }
    }
  }

  // Build selection
  let selected;
  if (count === 'all') {
    selected = allCards;
  } else {
    const n = parseInt(count);
    const priority = allCards.filter(c => priorityCsns.has(c.printed_card_number));
    const nonPriority = allCards.filter(c => !priorityCsns.has(c.printed_card_number));

    // Shuffle non-priority
    const shuffled = [...nonPriority].sort(() => Math.random() - 0.5);

    selected = [...priority.slice(0, n), ...shuffled.slice(0, Math.max(0, n - priority.length))];
  }

  const cardList = selected.map(c => ({
    csn: c.printed_card_number,
    name: c.first_name ? c.first_name + ' ' + c.last_name : 'Unassigned'
  }));

  // Create audit run
  const result = db.prepare(`
    INSERT INTO audit_runs (employer_id, count_requested, cards_total, status)
    VALUES (?, ?, ?, 'running')
  `).run(employerId, String(count), cardList.length);

  res.json({ audit_id: result.lastInsertRowid, cards_to_scrape: cardList });
});

app.post('/api/audit/:auditId/result', (req, res) => {
  const db = getDb();
  const { card_csn, balance, passport_loaded, employee_name } = req.body;
  const auditId = req.params.auditId;

  // Determine status
  let statusFlag = 'healthy';
  if (balance < 0) statusFlag = 'negative';
  else if (balance >= 400) statusFlag = 'at_cap';
  else if (balance >= 385) statusFlag = 'near_cap';

  db.prepare(`
    INSERT INTO audit_results (audit_id, card_csn, employee_name, balance, passport_loaded, status_flag)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(auditId, card_csn, employee_name || '', balance, passport_loaded == null ? null : (passport_loaded ? 1 : 0), statusFlag);

  // Update roster balance
  db.prepare(`
    UPDATE roster SET current_balance = ?, balance_updated_at = datetime('now') WHERE card_csn = ?
  `).run(balance, card_csn);

  // Update audit run counters
  const update = {
    healthy_count: statusFlag === 'healthy' ? 1 : 0,
    at_cap_count: statusFlag === 'at_cap' ? 1 : 0,
    negative_balance_count: statusFlag === 'negative' ? 1 : 0,
    near_cap_count: statusFlag === 'near_cap' ? 1 : 0,
  };
  db.prepare(`
    UPDATE audit_runs
    SET cards_scraped = cards_scraped + 1,
        healthy_count = healthy_count + ?,
        at_cap_count = at_cap_count + ?,
        negative_balance_count = negative_balance_count + ?,
        near_cap_count = near_cap_count + ?
    WHERE id = ?
  `).run(update.healthy_count, update.at_cap_count, update.negative_balance_count, update.near_cap_count, auditId);

  sendSSE({ type: 'audit_progress', data: { audit_id: auditId, card_csn, balance, status_flag: statusFlag } });
  sendSSE({ type: 'roster_update', data: { card_csn, field: 'current_balance', value: balance } });

  res.json({ ok: true });
});

app.post('/api/audit/:auditId/complete', (req, res) => {
  const db = getDb();
  const auditId = req.params.auditId;

  // Compute spend reconciliation from audit results
  const audit = db.prepare('SELECT * FROM audit_runs WHERE id = ?').get(auditId);
  const results = db.prepare('SELECT * FROM audit_results WHERE audit_id = ?').all(auditId);

  const projected = audit.cards_scraped * 50;
  // Very rough "actual" estimate: healthy cards full load, at-cap cards partial, negative cards zero
  const actual = results.reduce((sum, r) => {
    if (r.status_flag === 'healthy' || r.status_flag === 'near_cap') return sum + 50;
    if (r.status_flag === 'at_cap') return sum + Math.max(0, 50 - Math.abs(400 - r.balance));
    if (r.status_flag === 'negative') return sum; // autoload failed
    return sum + 50;
  }, 0);

  db.prepare(`
    UPDATE audit_runs SET status = 'complete', completed_at = datetime('now'),
      projected_spend = ?, actual_spend = ? WHERE id = ?
  `).run(projected, actual, auditId);

  const finalAudit = db.prepare('SELECT * FROM audit_runs WHERE id = ?').get(auditId);
  sendSSE({ type: 'audit_complete', data: { audit_id: auditId, summary: finalAudit } });

  res.json({ ok: true, summary: finalAudit });
});

// Latest audit (must come BEFORE :auditId route)
app.get('/api/audit/latest', (req, res) => {
  const db = getDb();
  const employerId = req.query.employer_id;
  const query = employerId
    ? db.prepare("SELECT * FROM audit_runs WHERE employer_id = ? AND status = 'complete' ORDER BY id DESC LIMIT 1").get(employerId)
    : db.prepare("SELECT * FROM audit_runs WHERE status = 'complete' ORDER BY id DESC LIMIT 1").get();
  if (!query) return res.json(null);
  const results = db.prepare('SELECT * FROM audit_results WHERE audit_id = ? ORDER BY scraped_at').all(query.id);
  res.json({ ...query, results });
});

app.get('/api/audit/:auditId', (req, res) => {
  const db = getDb();
  const audit = db.prepare('SELECT * FROM audit_runs WHERE id = ?').get(req.params.auditId);
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const results = db.prepare('SELECT * FROM audit_results WHERE audit_id = ? ORDER BY scraped_at').all(req.params.auditId);
  res.json({ ...audit, results });
});

// ============================================================
// WORKFLOW TRIGGERS
// ============================================================

app.post('/api/run/:workflow', (req, res) => {
  const workflow = req.params.workflow;
  const validWorkflows = [
    'onboard-new', 'onboard-existing', 'monthly', 'offboard',
    'passport-onboard-new', 'passport-monthly', 'passport-offboard',
    'audit-10', 'audit-20', 'audit-50', 'audit-all'
  ];
  if (!validWorkflows.includes(workflow)) return res.status(400).json({ error: 'Invalid workflow' });

  workflowActive = true;
  approvalPending = false;
  approvalApproved = false;

  const employerId = req.body?.employer_id || (workflow.startsWith('passport') ? 'mta' : 'acme');

  sendSSE({ type: 'workflow_start', data: { workflow, employer_id: employerId } });

  // Launch orchestrator in background
  const { fork } = require('child_process');
  const scriptMap = {
    'onboard-new': 'onboard-new-card.js',
    'onboard-existing': 'onboard-existing.js',
    'monthly': 'monthly-cycle.js',
    'offboard': 'offboard.js',
    'passport-onboard-new': 'passport-onboard-new.js',
    'passport-monthly': 'passport-monthly.js',
    'passport-offboard': 'passport-offboard.js',
    'audit-10': 'audit.js',
    'audit-20': 'audit.js',
    'audit-50': 'audit.js',
    'audit-all': 'audit.js'
  };

  const auditCount = workflow === 'audit-all' ? 'all' : (workflow.startsWith('audit-') ? workflow.slice(6) : null);

  try {
    const args = [scriptMap[workflow], employerId];
    if (auditCount) args.push(auditCount);
    const child = fork(path.join(__dirname, '..', 'automation', 'orchestrator.js'), args, {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });

    child.on('exit', (code) => {
      workflowActive = false;
      sendSSE({ type: 'workflow_complete', data: { workflow, exitCode: code } });
    });

    child.on('error', (err) => {
      workflowActive = false;
      sendSSE({ type: 'log', data: { workflow, step_name: 'Error', step_type: 'script', detail: err.message, status: 'failed' } });
      sendSSE({ type: 'workflow_complete', data: { workflow, exitCode: 1 } });
    });
  } catch (err) {
    workflowActive = false;
    sendSSE({ type: 'log', data: { workflow, step_name: 'Launch Error', step_type: 'script', detail: err.message, status: 'failed' } });
    return res.status(500).json({ error: err.message });
  }

  res.json({ ok: true, workflow });
});

app.get('/api/workflow/status', (req, res) => {
  res.json({ active: workflowActive });
});

app.listen(PORT, () => {
  console.log(`Fleet backend running on http://localhost:${PORT}`);
});

module.exports = app;
