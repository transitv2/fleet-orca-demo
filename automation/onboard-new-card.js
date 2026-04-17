const path = require('path');
const fs = require('fs');
const config = require('./config');
const { login, navigateTo, logStep, sleep, closeSidebar } = require('./helpers');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const WF = 'onboarding';

async function run(page, opts = {}) {
  const employerId = opts.employerId || 'acme';

  // ================================================================
  // Step 1 (script): Process HRIS — insert new hires as pending_onboard
  // ================================================================
  await logStep(WF, 'Process HRIS', 'script', 'Identifying new hires from HRIS feed...');

  const hrisRes = await fetch(`${config.FLEET_API}/hris/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employer_id: employerId })
  });
  const actions = await hrisRes.json();
  const newHires = actions.new_hires;

  if (!newHires.length) {
    await logStep(WF, 'No New Hires', 'script', 'No new hires found in HRIS feed');
    return;
  }

  // Insert each new hire into Fleet DB with status=pending_onboard, card_csn=NULL
  for (const hire of newHires) {
    await fetch(`${config.FLEET_API}/roster/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_name: hire.employee_name,
        employee_id: hire.employee_id,
        email: hire.email,
        location: hire.location,
        program_type: hire.product_type || 'Choice',
        card_csn: null,
        access_level: null,
        autoload_configured: 0,
        monthly_subsidy: 50.00,
        current_balance: null,
        status: 'pending_onboard',
        onboard_date: null,
        employer_id: employerId
      })
    });
  }

  await logStep(WF, 'New Hires Registered', 'script',
    `${newHires.length} employees added to Fleet roster as pending_onboard: ` +
    `${newHires.map(h => h.employee_name).join(', ')}`);

  // ================================================================
  // Step 2 (browser): Login > Purchase Cards > qty, Load Only, $50 > Checkout
  // ================================================================
  await logStep(WF, 'Navigate to Purchase', 'browser', 'Logging into myORCA...');
  await login(page, employerId);
  await navigateTo(page, '/purchase-cards');
  await sleep(300);

  await logStep(WF, 'Configure Order', 'browser',
    `Ordering ${newHires.length} cards, Load Only, $50 e-purse each`);

  await page.fill('#purchase-qty', String(newHires.length));
  await page.selectOption('#purchase-access', 'Load Only');
  await sleep(300);

  await page.click('button:has-text("ADD MONEY / PASS")');
  await sleep(400);
  await page.click('.money-preset:has-text("$50")');
  await sleep(200);
  await page.click('button:has-text("ADD TO CARD ORDER")');
  await sleep(300);

  await logStep(WF, 'Checkout', 'browser', 'Adding to cart and placing order...');
  await page.click('button:has-text("ADD TO CART")');
  await page.waitForURL('**/cart');
  await sleep(400);

  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  await sleep(500);

  await logStep(WF, 'Order Placed', 'browser',
    `${newHires.length} cards purchased with $50 e-purse. Order confirmed.`);

  // ================================================================
  // Step 3 (browser): Order History > find order > View Details > Export CSV
  // ================================================================
  await logStep(WF, 'Export Order CSV', 'browser',
    'Navigating to Administration > Order History...');

  await navigateTo(page, '/order-history');
  await sleep(400);

  const expandBtn = page.locator('.expand-btn').first();
  if (await expandBtn.count() > 0) {
    await expandBtn.click();
    await sleep(400);
  }

  const viewDetailsBtn = page.locator('a:has-text("View order details")').first();
  if (await viewDetailsBtn.count() > 0) {
    await viewDetailsBtn.click();
    await page.waitForLoadState('networkidle');
    await sleep(400);
  }

  const detailUrl = page.url();
  const orderIdMatch = detailUrl.match(/order-history\/(\d+)/);
  const orderId = orderIdMatch ? orderIdMatch[1] : null;

  const outputDir = path.join(__dirname, '..', 'fleet', 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const exportPath = path.join(outputDir, 'order_export.csv');

  if (orderId) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate((oid) => {
        const link = document.querySelector(`a[href="/order-history/${oid}/export?format=csv"]`);
        if (link) link.click();
      }, orderId)
    ]);
    await download.saveAs(exportPath);
  } else {
    const csvContent = await page.evaluate(async () => {
      const links = document.querySelectorAll('a[href*="/export?format=csv"]');
      if (links.length > 0) return await (await fetch(links[0].href)).text();
      return null;
    });
    if (csvContent) fs.writeFileSync(exportPath, csvContent);
  }

  const exportContent = fs.readFileSync(exportPath, 'utf-8');
  const exportLines = exportContent.trim().split('\n');
  await logStep(WF, 'Order CSV Exported', 'browser',
    `Downloaded ${exportLines.length - 1} new card serial numbers`);

  // ================================================================
  // Step 4 (script): Query Fleet DB for pending employees, merge with CSNs
  // ================================================================
  await logStep(WF, 'Merge CSNs with Roster', 'script',
    'Querying Fleet DB for pending_onboard employees...');

  // Get pending employees from Fleet DB (filter by employer)
  const pendingRes = await fetch(`${config.FLEET_API}/roster/pending?employer_id=${employerId}`);
  const pendingEmployees = await pendingRes.json();

  // Get CSNs from order export
  const orderRecords = parse(exportContent, { columns: true, skip_empty_lines: true, trim: true });
  const csns = orderRecords.map(r => r.PrintedCardNumber).filter(Boolean).sort();

  await logStep(WF, 'Data Sources Ready', 'script',
    `Fleet DB: ${pendingEmployees.length} pending employees. Order export: ${csns.length} new CSNs.`);

  // Assign CSNs to employees and generate participant CSV
  const participants = [];
  for (let i = 0; i < Math.min(csns.length, pendingEmployees.length); i++) {
    const csn = csns[i];
    const emp = pendingEmployees[i];
    const [firstName, ...lastParts] = emp.employee_name.split(' ');
    const lastName = lastParts.join(' ');

    participants.push({
      PrintedCardNumber: csn,
      Identifier: csn,
      FirstName: firstName,
      LastName: lastName,
      Email: emp.email,
      GroupName: emp.location,
      _employee_id: emp.employee_id, // internal reference
      _employee_name: emp.employee_name
    });

    // Update Fleet DB: assign CSN to this employee, transition to 'onboarding'
    await fetch(`${config.FLEET_API}/roster/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_id: emp.employee_id,
        updates: { card_csn: csn, identifier: csn, status: 'onboarding' }
      })
    });
  }

  // Write participant CSV
  const participantCsvPath = path.join(outputDir, 'add_participants.csv');
  const csvRows = participants.map(p => ({
    PrintedCardNumber: p.PrintedCardNumber,
    Identifier: p.Identifier,
    FirstName: p.FirstName,
    LastName: p.LastName,
    Email: p.Email,
    GroupName: p.GroupName
  }));
  fs.writeFileSync(participantCsvPath, stringify(csvRows, { header: true }));

  await logStep(WF, 'CSN Assignment Complete', 'script',
    `${participants.length} employees paired with cards. Roster updated: pending_onboard → onboarding. Participant CSV generated.`);

  // ================================================================
  // Step 5 (browser): Bulk Actions > Add Participants > upload > submit
  // ================================================================
  await logStep(WF, 'Upload Participants', 'browser',
    'Navigating to Bulk Actions > Add Participants...');

  await navigateTo(page, '/bulk-actions?type=add-participants');
  await sleep(600);
  await page.waitForSelector('#csv-file', { state: 'attached', timeout: 10000 });
  await page.locator('#csv-file').setInputFiles(participantCsvPath);
  await sleep(400);
  await page.waitForSelector('#upload-btn:not([disabled])', { timeout: 5000 });
  await page.click('#upload-btn');
  await page.waitForLoadState('networkidle');
  await sleep(500);

  await logStep(WF, 'Review Participants', 'browser',
    `${participants.length} rows validated — submitting...`);

  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  await sleep(400);

  await logStep(WF, 'Participants Created', 'browser',
    `${participants.length} employees associated to cards in myORCA`);

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
  // Step 7 (script): Generate autoload CSV
  // ================================================================
  await logStep(WF, 'Generate Autoload CSV', 'script',
    'Preparing card list for bulk autoload creation...');

  const autoloadCsvPath = path.join(outputDir, 'autoload_cards.csv');
  const autoloadRows = participants.map(p => ({ PrintedCardNumber: p.PrintedCardNumber }));
  fs.writeFileSync(autoloadCsvPath, stringify(autoloadRows, { header: true }));

  await logStep(WF, 'Autoload CSV Ready', 'script',
    `${participants.length} cards ready for bulk autoload configuration`);

  // ================================================================
  // Step 8 (browser): Bulk Actions > Create Autoloads > configure > submit
  // ================================================================
  await logStep(WF, 'Bulk Create Autoloads', 'browser',
    'Navigating to Bulk Actions > Create Autoloads...');

  await navigateTo(page, '/bulk-actions?type=create-autoloads');
  await sleep(600);
  await page.waitForSelector('#csv-file', { state: 'attached', timeout: 10000 });
  await page.locator('#csv-file').setInputFiles(autoloadCsvPath);
  await sleep(400);
  await page.waitForSelector('#upload-btn:not([disabled])', { timeout: 5000 });
  await page.click('#upload-btn');
  await page.waitForLoadState('networkidle');
  await sleep(500);

  await logStep(WF, 'Configure Autoloads', 'browser',
    `${participants.length} cards in review. Setting time-based, day 1, $50/mo...`);

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

  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  await sleep(400);

  await logStep(WF, 'Autoloads Submitted', 'browser',
    `Bulk autoload: ${participants.length} cards — $50/mo on the 1st`);

  // ================================================================
  // Step 9 (browser): Verify autoload job
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
  // Step 10 (script): Finalize roster — pending_onboard/onboarding → Active
  // ================================================================
  await logStep(WF, 'Finalize Roster', 'script',
    'Updating Fleet roster: onboarding → Active with card data...');

  for (const p of participants) {
    await fetch(`${config.FLEET_API}/roster/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_id: p._employee_id,
        updates: {
          access_level: 'Load Only',
          autoload_configured: 1,
          current_balance: 50.00,
          status: 'Active',
          onboard_date: new Date().toISOString().slice(0, 10)
        }
      })
    });
  }

  await logStep(WF, 'Roster Finalized', 'script',
    `${participants.length} employees: onboarding → Active. Cards assigned, autoloads set, balance $50.`);

  // ================================================================
  // Step 10b (script): Record load_history — $50 preloaded at card purchase
  // ================================================================
  const loadHistoryEntries = participants.map(p => ({
    employee_id: p._employee_id,
    employee_name: p._employee_name,
    card_csn: p.PrintedCardNumber,
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
    `${loadHistoryEntries.length} entries written to load_history (new-card preload $50)`);

  // ================================================================
  // Step 11 (script): Generate employer roster CSV
  // ================================================================
  await logStep(WF, 'Generate Employer Roster', 'script',
    'Creating employer distribution roster sorted by CSN...');

  const rosterRows = participants.map(p => ({
    PrintedCardNumber: p.PrintedCardNumber,
    EmployeeName: p.FirstName + ' ' + p.LastName,
    Email: p.Email,
    Group: p.GroupName
  }));
  const rosterCsv = stringify(rosterRows, { header: true });
  fs.writeFileSync(path.join(outputDir, 'employer_roster.csv'), rosterCsv);

  await logStep(WF, 'Employer Roster Generated', 'script',
    `Sorted by CSN for physical card distribution. ${participants.length} cards.`);

  // ================================================================
  // Step 12: Complete
  // ================================================================
  await logStep(WF, 'Onboarding Complete', 'script',
    `${newHires.length} new hires onboarded. Flow: HRIS → pending_onboard → purchase → ` +
    `CSN merge → participants (bulk) → autoloads (bulk) → Active. ` +
    `Cards ship in 5-7 business days. Employer roster sorted by CSN.`);
}

module.exports = { run };
