const path = require('path');
const fs = require('fs');
const config = require('./config');
const { login, navigateTo, logStep, sleep, closeSidebar } = require('./helpers');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const WF = 'onboarding';

// Helper: upload CSV on a bulk actions page — handles timing reliably
async function uploadBulkCSV(page, csvPath) {
  await page.waitForSelector('#csv-file', { state: 'attached', timeout: 10000 });
  await page.locator('#csv-file').setInputFiles(csvPath);
  await sleep(400);
  await page.waitForSelector('#upload-btn:not([disabled])', { timeout: 5000 });
  await page.click('#upload-btn');
  await page.waitForLoadState('networkidle');
  await sleep(500);
}

async function run(page, opts = {}) {
  const employerId = opts.employerId || 'acme';
  // ================================================================
  // Step 1 (script): Read enrollment data — 30 employees with existing cards
  // ================================================================
  await logStep(WF, 'Read Enrollment Data', 'script',
    'Loading existing card enrollment data...');

  const enrollPath = path.join(__dirname, '..', 'fleet', 'hris', 'existing_cards.csv');
  const enrollContent = fs.readFileSync(enrollPath, 'utf-8');
  const employees = parse(enrollContent, { columns: true, skip_empty_lines: true, trim: true });

  await logStep(WF, 'Enrollment Loaded', 'script',
    `${employees.length} employees with existing ORCA cards ready for onboarding`);

  const outputDir = path.join(__dirname, '..', 'fleet', 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // ================================================================
  // Step 1b (script): Generate add-cards CSV
  // ================================================================
  await logStep(WF, 'Generate Add Cards CSV', 'script',
    'Preparing card list for business account linkage...');

  const addCardsCsvPath = path.join(outputDir, 'add_cards.csv');
  const addCardsRows = employees.map(e => ({
    PrintedCardNumber: e.existing_card_csn,
    AccessType: 'Load Only'
  }));
  fs.writeFileSync(addCardsCsvPath, stringify(addCardsRows, { header: true }));

  await logStep(WF, 'Add Cards CSV Ready', 'script',
    `${employees.length} cards prepared for business account linkage (Load Only access)`);

  // ================================================================
  // Step 2 (browser): Bulk add cards to business account
  // ================================================================
  await logStep(WF, 'Add Cards to Account', 'browser', 'Logging into myORCA...');
  await login(page, employerId);

  await logStep(WF, 'Upload Card List', 'browser',
    'Navigating to Bulk Actions > Add Cards to Account...');

  await navigateTo(page, '/bulk-actions?type=add-cards');
  await sleep(600);
  await uploadBulkCSV(page, addCardsCsvPath);

  await logStep(WF, 'Review Cards', 'browser',
    `${employees.length} cards in review — submitting...`);

  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  await sleep(400);

  await logStep(WF, 'Cards Added', 'browser',
    `${employees.length} existing cards linked to Acme Corp business account (Load Only)`);

  // ================================================================
  // Step 3 (browser): Verify cards appeared in Manage Cards
  // ================================================================
  await logStep(WF, 'Verify Cards', 'browser',
    'Navigating to Manage Cards to confirm...');

  await navigateTo(page, '/manage-cards');
  await sleep(400);

  await page.selectOption('#search-by', 'card_number');
  await page.fill('#search-input', employees[0].existing_card_csn.slice(-8));
  await page.click('.search-btn');
  await sleep(500);

  const verifyRow = page.locator(`[data-csn="${employees[0].existing_card_csn}"]`);
  const found = await verifyRow.count() > 0;

  await logStep(WF, 'Cards Verified', 'browser',
    `Spot check: ${employees[0].employee_name}'s card ...${employees[0].existing_card_csn.slice(-4)} — ${found ? 'visible' : 'not found'}`);

  // ================================================================
  // Step 4 (script): Generate participant CSV
  // ================================================================
  await logStep(WF, 'Generate Participant CSV', 'script',
    'Mapping employees to cards for participant creation...');

  const participantCsvPath = path.join(outputDir, 'add_participants_existing.csv');
  const participantRows = employees.map(e => {
    const [firstName, ...lastParts] = e.employee_name.split(' ');
    const lastName = lastParts.join(' ');
    return {
      PrintedCardNumber: e.existing_card_csn,
      Identifier: e.existing_card_csn,
      FirstName: firstName,
      LastName: lastName,
      Email: e.email,
      GroupName: e.location
    };
  });
  fs.writeFileSync(participantCsvPath, stringify(participantRows, { header: true }));

  await logStep(WF, 'Participant CSV Ready', 'script',
    `${employees.length} employees mapped — Identifier = CSN per ORCA best practice`);

  // ================================================================
  // Step 5 (browser): Bulk upload participants
  // ================================================================
  await logStep(WF, 'Upload Participants', 'browser',
    'Navigating to Bulk Actions > Add Participants...');

  await navigateTo(page, '/bulk-actions?type=add-participants');
  await sleep(600);
  await uploadBulkCSV(page, participantCsvPath);

  await logStep(WF, 'Review Participants', 'browser',
    `${employees.length} rows — submitting...`);

  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  await sleep(400);

  await logStep(WF, 'Participants Created', 'browser',
    `${employees.length} participants linked to cards`);

  // ================================================================
  // Step 6 (browser): Verify participant job
  // ================================================================
  await logStep(WF, 'Verify Participant Job', 'browser', 'Checking Past Processes...');
  await navigateTo(page, '/bulk-actions/history');
  await sleep(500);

  const partJobStatus = await page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr');
    if (rows.length > 0) return rows[0].querySelectorAll('td')[4]?.textContent?.trim() || 'Unknown';
    return 'No jobs';
  });
  await logStep(WF, 'Participant Job Done', 'browser', `Status: ${partJobStatus}`);

  // ================================================================
  // Step 7 (script): Generate load CSV — 30 cards x $50
  // ================================================================
  await logStep(WF, 'Generate Load CSV', 'script',
    'Preparing card list for $50 e-purse load...');

  const loadCsvPath = path.join(outputDir, 'load_existing_50.csv');
  const loadRows = employees.map(e => ({ PrintedCardNumber: e.existing_card_csn }));
  fs.writeFileSync(loadCsvPath, stringify(loadRows, { header: true }));

  await logStep(WF, 'Load CSV Ready', 'script',
    `${employees.length} cards x $50 — single bulk job`);

  // ================================================================
  // Step 8 (browser): Bulk load e-purse $50
  // ================================================================
  await logStep(WF, 'Bulk Load E-Purse', 'browser',
    'Navigating to Bulk Actions > Add Money...');

  await navigateTo(page, '/bulk-actions?type=add-money');
  await sleep(800);
  await uploadBulkCSV(page, loadCsvPath);

  // Set amount to $50
  await page.evaluate(() => {
    const amountInput = document.getElementById('bulk-amount');
    if (amountInput) amountInput.value = '50';
    const submitAmount = document.getElementById('submit-amount');
    if (submitAmount) submitAmount.value = '50';
  });
  await sleep(300);

  await logStep(WF, 'Submit Load', 'browser',
    `${employees.length} cards x $50 — submitting...`);

  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  await sleep(400);

  await logStep(WF, 'Load Submitted', 'browser',
    `Bulk load complete: ${employees.length} cards x $50`);

  // ================================================================
  // Step 9 (browser): Verify load job
  // ================================================================
  await logStep(WF, 'Verify Load Job', 'browser', 'Checking Past Processes...');
  await navigateTo(page, '/bulk-actions/history');
  await sleep(500);

  const loadJobStatus = await page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr');
    if (rows.length > 0) return rows[0].querySelectorAll('td')[4]?.textContent?.trim() || 'Unknown';
    return 'No jobs';
  });
  await logStep(WF, 'Load Job Done', 'browser', `Status: ${loadJobStatus}`);

  // ================================================================
  // Step 9b (script): Record load_history — audit trail of $50 submitted
  // ================================================================
  const loadHistoryEntries = employees.map(e => ({
    employee_id: e.employee_id,
    employee_name: e.employee_name,
    card_csn: e.existing_card_csn,
    base_amount: 50,
    retroactive_amount: 0,
    submitted_amount: 50,
    load_method: 'bulk',
    status: 'submitted',
  }));

  await fetch(`${config.FLEET_API}/loads/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: loadHistoryEntries })
  });

  await logStep(WF, 'Load History Recorded', 'script',
    `${loadHistoryEntries.length} entries written to load_history (onboarding bulk $50)`);

  // ================================================================
  // Step 10 (script): Generate autoload CSV
  // ================================================================
  await logStep(WF, 'Generate Autoload CSV', 'script',
    'Preparing card list for autoload configuration...');

  const autoloadCsvPath = path.join(outputDir, 'autoload_existing.csv');
  fs.writeFileSync(autoloadCsvPath, stringify(loadRows, { header: true }));

  await logStep(WF, 'Autoload CSV Ready', 'script',
    `${employees.length} cards for bulk autoload creation`);

  // ================================================================
  // Step 11 (browser): Bulk configure autoloads
  // ================================================================
  await logStep(WF, 'Bulk Create Autoloads', 'browser',
    'Navigating to Bulk Actions > Create Autoloads...');

  await navigateTo(page, '/bulk-actions?type=create-autoloads');
  await sleep(800);
  await uploadBulkCSV(page, autoloadCsvPath);

  // Configure: time-based, day 1, $50
  await page.selectOption('#autoload-type-bulk', 'time');
  await page.selectOption('#autoload-day-bulk', '1');
  await page.fill('#autoload-amount-bulk', '50');
  await sleep(300);

  await page.evaluate(() => {
    document.getElementById('submit-autoload-type').value = document.getElementById('autoload-type-bulk').value;
    document.getElementById('submit-autoload-day').value = document.getElementById('autoload-day-bulk').value;
    document.getElementById('submit-autoload-amount').value = document.getElementById('autoload-amount-bulk').value;
    document.getElementById('submit-autoload-payment').value = document.getElementById('autoload-payment-bulk').value;
  });

  await logStep(WF, 'Submit Autoloads', 'browser',
    `${employees.length} cards — $50/mo, 1st of month — submitting...`);

  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  await sleep(400);

  await logStep(WF, 'Autoloads Created', 'browser',
    `Bulk autoload job complete: ${employees.length} cards configured`);

  // ================================================================
  // Step 12 (browser): Verify autoload job
  // ================================================================
  await logStep(WF, 'Verify Autoload Job', 'browser', 'Checking Past Processes...');
  await navigateTo(page, '/bulk-actions/history');
  await sleep(500);

  const autoJobStatus = await page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr');
    if (rows.length > 0) return rows[0].querySelectorAll('td')[4]?.textContent?.trim() || 'Unknown';
    return 'No jobs';
  });
  await logStep(WF, 'Autoload Job Done', 'browser', `Status: ${autoJobStatus}`);

  // ================================================================
  // Step 13 (script): Update Fleet roster — 30 new rows
  // ================================================================
  await logStep(WF, 'Update Roster', 'script',
    `Adding ${employees.length} employees to Fleet master roster...`);

  for (const emp of employees) {
    await fetch(`${config.FLEET_API}/roster/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_name: emp.employee_name,
        employee_id: emp.employee_id,
        email: emp.email,
        location: emp.location,
        program_type: 'Choice',
        card_csn: emp.existing_card_csn,
        access_level: 'Load Only',
        autoload_configured: 1,
        monthly_subsidy: 50.00,
        current_balance: null,
        status: 'Active'
      })
    });
  }

  await logStep(WF, 'Roster Updated', 'script',
    `${employees.length} employees added to master roster`);

  // ================================================================
  // Step 14 (script): Complete
  // ================================================================
  await logStep(WF, 'Onboarding Complete', 'script',
    `${employees.length} employees onboarded via existing cards. ` +
    `4 bulk actions: add cards, create participants, load $50, configure autoloads. ` +
    `Zero individual card clicks. Same-day activation. No shipping. No sorting.`);
}

module.exports = { run };
