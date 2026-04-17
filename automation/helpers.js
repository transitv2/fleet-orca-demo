const config = require('./config');

async function login(page, employerId) {
  const creds = config.EMPLOYERS[employerId] || config.CREDENTIALS;
  const username = creds.username;
  const password = creds.password;
  await page.goto(`${config.ORCA_URL}/login`);
  await page.fill(config.SELECTORS.loginUsername, username);
  await page.fill(config.SELECTORS.loginPassword, password);
  await page.click(config.SELECTORS.loginSubmit);
  await page.waitForURL('**/manage-cards');
}

async function navigateTo(page, path) {
  await page.goto(`${config.ORCA_URL}${path}`);
  await page.waitForLoadState('networkidle');
}

async function logStep(workflow, stepName, stepType, detail, status) {
  await fetch(`${config.FLEET_API}/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow,
      step_name: stepName,
      step_type: stepType,
      detail,
      status: status || 'completed'
    })
  });
}

async function requestApproval(workflow, summary) {
  await fetch(`${config.FLEET_API}/approve/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow, summary })
  });

  // Poll until approved
  while (true) {
    const res = await fetch(`${config.FLEET_API}/approve/status`);
    const data = await res.json();
    if (data.approved) return;
    await new Promise(r => setTimeout(r, 500));
  }
}

async function updateBalance(cardCsn, balance) {
  await fetch(`${config.FLEET_API}/roster/update-balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ card_csn: cardCsn, balance })
  });
}

async function updateRosterField(employeeId, updates) {
  await fetch(`${config.FLEET_API}/roster/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: employeeId, updates })
  });
}

// Close sidebar reliably via JS (avoids viewport/click issues)
async function closeSidebar(page) {
  await page.evaluate(() => {
    document.getElementById('sidebar-overlay')?.classList.remove('open');
    document.getElementById('card-sidebar')?.classList.remove('open');
  });
  await page.waitForTimeout(300);
  // Uncheck all checkboxes and disable manage button
  await page.evaluate(() => {
    document.querySelectorAll('.card-checkbox').forEach(cb => cb.checked = false);
    const btn = document.getElementById('manage-btn');
    if (btn) btn.disabled = true;
  });
}

async function readSidebarBalance(page, csn) {
  // Search for card by number
  await page.selectOption(config.SELECTORS.searchByDropdown, 'card_number');
  await page.fill(config.SELECTORS.searchInput, csn.slice(-8));
  await page.click(config.SELECTORS.searchBtn);
  await page.waitForTimeout(500);

  // Click on the card row
  const row = page.locator(`[data-csn="${csn}"]`);
  if (await row.count() === 0) return null;

  // Check the checkbox
  await row.locator('.card-checkbox').check();
  await page.waitForTimeout(300);

  // Click MANAGE
  await page.click(config.SELECTORS.manageBtn);
  await page.waitForSelector(config.SELECTORS.sidebarBalance, { timeout: 5000 });
  await page.waitForTimeout(400);

  // Read balance
  const balanceText = await page.textContent(config.SELECTORS.sidebarBalance);
  const balance = parseFloat(balanceText.replace('$', ''));

  // Close sidebar
  await closeSidebar(page);

  // Clear search
  await page.fill(config.SELECTORS.searchInput, '');

  return balance;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Upload a CSV file on a Bulk Actions page (page must already be at /bulk-actions?type=...)
async function uploadBulkCSV(page, csvPath) {
  await page.waitForSelector('#csv-file', { state: 'attached', timeout: 10000 });
  await page.locator('#csv-file').setInputFiles(csvPath);
  await sleep(400);
  await page.waitForSelector('#upload-btn:not([disabled])', { timeout: 5000 });
  await page.click('#upload-btn');
  await page.waitForLoadState('networkidle');
  await sleep(500);
}

// Pause/resume autoloads for a list of CSNs via browser context (uses authenticated session)
// Uses the /api/card/:id/autoloads/pause endpoint which affects all Active autoloads on a card
async function pauseAutoloadsByCSN(page, csns) {
  let pausedCount = 0;
  for (const csn of csns) {
    const result = await page.evaluate(async (cardCsn) => {
      const cards = await (await fetch('/api/card-by-csn?csn=' + cardCsn)).json();
      if (!cards.id) return { ok: false, reason: 'card not found' };
      const res = await fetch('/api/card/' + cards.id + '/autoloads/pause', { method: 'POST' });
      return await res.json();
    }, csn);
    if (result.ok && result.paused > 0) pausedCount++;
  }
  return pausedCount;
}

async function resumeAutoloadsByCSN(page, csns) {
  let resumedCount = 0;
  for (const csn of csns) {
    const result = await page.evaluate(async (cardCsn) => {
      const cards = await (await fetch('/api/card-by-csn?csn=' + cardCsn)).json();
      if (!cards.id) return { ok: false, reason: 'card not found' };
      const res = await fetch('/api/card/' + cards.id + '/autoloads/resume', { method: 'POST' });
      return await res.json();
    }, csn);
    if (result.ok && result.resumed > 0) resumedCount++;
  }
  return resumedCount;
}

module.exports = {
  login,
  navigateTo,
  logStep,
  requestApproval,
  updateBalance,
  updateRosterField,
  closeSidebar,
  readSidebarBalance,
  uploadBulkCSV,
  pauseAutoloadsByCSN,
  resumeAutoloadsByCSN,
  sleep
};
