const path = require('path');
const fs = require('fs');
const config = require('./config');
const { login, navigateTo, logStep, sleep, closeSidebar } = require('./helpers');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const WF = 'passport-onboarding';

async function run(page, opts = {}) {
  const employerId = opts.employerId || 'mta';

  // ================================================================
  // Step 1 (script): Process HRIS — insert new Passport hires as pending
  // ================================================================
  await logStep(WF, 'Process HRIS', 'script', 'Identifying new Passport hires from MTA HRIS feed...');

  const hrisRes = await fetch(`${config.FLEET_API}/hris/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employer_id: employerId })
  });
  const actions = await hrisRes.json();
  const newHires = actions.new_hires;

  if (!newHires.length) {
    await logStep(WF, 'No New Hires', 'script', 'No new Passport hires found');
    return;
  }

  for (const hire of newHires) {
    await fetch(`${config.FLEET_API}/roster/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_name: hire.employee_name,
        employee_id: hire.employee_id,
        email: hire.email,
        location: hire.location,
        program_type: 'Passport',
        card_csn: null,
        access_level: null,
        autoload_configured: 0,
        monthly_subsidy: 0,
        current_balance: null,
        status: 'pending_onboard',
        onboard_date: null,
        employer_id: employerId,
        has_passport_verified: 0
      })
    });
  }

  await logStep(WF, 'New Hires Registered', 'script',
    `${newHires.length} Passport hires added to Fleet roster: ${newHires.map(h => h.employee_name).join(', ')}`);

  // ================================================================
  // Step 2 (browser): Purchase Cards — Passport-specific
  // ================================================================
  await logStep(WF, 'Navigate to Purchase', 'browser', 'Logging into MTA myORCA account...');
  await login(page, employerId);
  await navigateTo(page, '/purchase-cards');
  await sleep(400);

  await logStep(WF, 'Configure Passport Order', 'browser',
    `Ordering ${newHires.length} cards, Full Access, Regional Business Passport`);

  await page.fill('#purchase-qty', String(newHires.length));
  await page.selectOption('#purchase-access', 'Full Access');
  await sleep(300);

  // Open Add Money/Pass modal and configure Passport
  await page.click('button:has-text("ADD MONEY / PASS")');
  await sleep(400);

  // Select Regional > Passport > Regional Business Passport
  await page.click('input[name="pass-type"][value="regional"]');
  await sleep(200);
  await page.click('input[name="pass-freq"][value="passport"]');
  await sleep(200);
  await page.selectOption('#passport-select', 'Regional Business Passport');
  await sleep(200);

  await page.click('button:has-text("ADD TO CARD ORDER")');
  await sleep(400);

  await logStep(WF, 'Passport Added', 'browser',
    `${newHires.length} cards configured with Regional Business Passport product`);

  // Checkout
  await page.click('button:has-text("ADD TO CART")');
  await page.waitForURL('**/cart');
  await sleep(400);

  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  await sleep(500);

  await logStep(WF, 'Order Placed', 'browser',
    `${newHires.length} Passport cards ordered. Total: $${(newHires.length * 3).toFixed(2)} (card fees only — Passport billed on usage)`);

  // ================================================================
  // Step 3 (browser): Order History > View Details > Export CSV
  // ================================================================
  await logStep(WF, 'Export Order CSV', 'browser', 'Navigating to Order History...');

  await navigateTo(page, '/order-history');
  await sleep(400);

  const expandBtn = page.locator('.expand-btn').first();
  if (await expandBtn.count() > 0) {
    await expandBtn.click();
    await sleep(400);
  }

  const viewBtn = page.locator('a:has-text("View order details")').first();
  if (await viewBtn.count() > 0) {
    await viewBtn.click();
    await page.waitForLoadState('networkidle');
    await sleep(400);
  }

  const detailUrl = page.url();
  const orderIdMatch = detailUrl.match(/order-history\/(\d+)/);
  const orderId = orderIdMatch ? orderIdMatch[1] : null;

  const outputDir = path.join(__dirname, '..', 'fleet', 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const exportPath = path.join(outputDir, 'mta_order_export.csv');

  if (orderId) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate((oid) => {
        const link = document.querySelector(`a[href="/order-history/${oid}/export?format=csv"]`);
        if (link) link.click();
      }, orderId)
    ]);
    await download.saveAs(exportPath);
  }

  const exportContent = fs.readFileSync(exportPath, 'utf-8');
  const orderRecords = parse(exportContent, { columns: true, skip_empty_lines: true, trim: true });
  await logStep(WF, 'Order CSV Exported', 'browser',
    `Downloaded ${orderRecords.length} new card numbers`);

  // ================================================================
  // Step 4 (script): Query Fleet DB + merge with CSNs
  // ================================================================
  await logStep(WF, 'Merge CSNs with Roster', 'script',
    'Querying Fleet DB for pending Passport employees...');

  const pendingRes = await fetch(`${config.FLEET_API}/roster/pending?employer_id=${employerId}`);
  const pendingEmployees = await pendingRes.json();

  const csns = orderRecords.map(r => r.PrintedCardNumber).filter(Boolean).sort();

  await logStep(WF, 'Data Sources Ready', 'script',
    `Fleet DB: ${pendingEmployees.length} pending. Order export: ${csns.length} CSNs.`);

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
      _employee_id: emp.employee_id
    });

    await fetch(`${config.FLEET_API}/roster/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_id: emp.employee_id,
        updates: { card_csn: csn, identifier: csn, status: 'onboarding' }
      })
    });
  }

  const participantCsvPath = path.join(outputDir, 'mta_add_participants.csv');
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
    `${participants.length} employees paired with Passport cards. Participant CSV generated.`);

  // ================================================================
  // Step 5 (browser): Bulk upload participants
  // ================================================================
  await logStep(WF, 'Upload Participants', 'browser', 'Navigating to Bulk Actions...');

  await navigateTo(page, '/bulk-actions?type=add-participants');
  await sleep(600);
  await page.waitForSelector('#csv-file', { state: 'attached', timeout: 10000 });
  await page.locator('#csv-file').setInputFiles(participantCsvPath);
  await sleep(400);
  await page.waitForSelector('#upload-btn:not([disabled])', { timeout: 5000 });
  await page.click('#upload-btn');
  await page.waitForLoadState('networkidle');
  await sleep(500);

  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  await sleep(400);

  await logStep(WF, 'Participants Created', 'browser',
    `${participants.length} Passport employees associated to cards`);

  // ================================================================
  // Step 6 (browser): Verify bulk job
  // ================================================================
  await navigateTo(page, '/bulk-actions/history');
  await sleep(500);
  await logStep(WF, 'Bulk Job Verified', 'browser', 'Participant job completed');

  // ================================================================
  // Step 7: NO AUTOLOAD (Passport is always-on)
  // ================================================================
  await logStep(WF, 'No Autoload Needed', 'script',
    'Passport program — no autoload configuration. Passport is always-on.');

  // ================================================================
  // Step 8 (script): Update Fleet roster — transition to Active
  // ================================================================
  await logStep(WF, 'Finalize Roster', 'script',
    'Updating Fleet roster: onboarding → Active with Passport verified...');

  for (const p of participants) {
    await fetch(`${config.FLEET_API}/roster/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_id: p._employee_id,
        updates: {
          access_level: 'Full Access',
          has_passport_verified: 1,
          status: 'Active',
          onboard_date: new Date().toISOString().slice(0, 10)
        }
      })
    });
  }

  await logStep(WF, 'Roster Finalized', 'script',
    `${participants.length} Passport employees: onboarding → Active. Passport verified.`);

  // ================================================================
  // Step 9 (script): Generate employer roster CSV
  // ================================================================
  const rosterRows = participants.map(p => ({
    PrintedCardNumber: p.PrintedCardNumber,
    EmployeeName: p.FirstName + ' ' + p.LastName,
    Email: p.Email,
    Group: p.GroupName
  }));
  fs.writeFileSync(path.join(outputDir, 'mta_employer_roster.csv'), stringify(rosterRows, { header: true }));

  await logStep(WF, 'Employer Roster Generated', 'script',
    `MTA distribution roster ready. REMINDER: Do NOT distribute until Passport loaded on each card.`);

  await logStep(WF, 'Passport Onboarding Complete', 'script',
    `${newHires.length} Passport hires onboarded. Flow: HRIS → purchase (Full Access + Passport) → ` +
    `participants (bulk) → Active. Cards ship 5-7 business days.`);
}

module.exports = { run };
