const path = require('path');
const fs = require('fs');
const config = require('./config');
const { login, navigateTo, logStep, requestApproval, sleep } = require('./helpers');
const { stringify } = require('csv-stringify/sync');

const WF = 'passport-monthly';

// Bulk upload helper
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
  const employerId = opts.employerId || 'mta';

  // ================================================================
  // Step 1 (browser): Download card export
  // ================================================================
  await logStep(WF, 'Download Card Export', 'browser', 'Logging into MTA myORCA...');
  await login(page, employerId);
  await sleep(300);
  await navigateTo(page, '/manage-cards');
  await sleep(400);

  const outputDir = path.join(__dirname, '..', 'fleet', 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const exportPath = path.join(outputDir, 'mta_card_export.csv');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => {
      const link = document.querySelector('a[href="/manage-cards/export?format=csv"]');
      if (link) link.click();
    })
  ]);
  await download.saveAs(exportPath);

  await logStep(WF, 'Card Export Downloaded', 'browser', 'MTA card export CSV saved');

  // ================================================================
  // Step 2 (script): Process HRIS + cross-reference with Fleet roster
  // ================================================================
  await logStep(WF, 'Process HRIS', 'script',
    'Cross-referencing card export, HRIS, and Fleet roster (no sidebar scraping needed — Fleet tracks Passport state)...');

  const hrisRes = await fetch(`${config.FLEET_API}/hris/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employer_id: employerId })
  });
  const actions = await hrisRes.json();

  const detail = `${actions.active.length} standard, ${actions.new_hires.length} new hires, ` +
    `${actions.terminated.length} terminated, ${actions.return_from_leave.length} returning, ` +
    `${(actions.worksite_transfer || []).length} transfers, ${actions.missing_passport.length} MISSING PASSPORT (CRITICAL)`;
  await logStep(WF, 'Classification Complete', 'script', detail);

  // ================================================================
  // Step 3 (script): Build action plan from Fleet's own data
  // ================================================================
  await logStep(WF, 'Building Action Plan', 'script',
    'Fleet has_passport_verified flag identifies cards needing Passport. No scraping required.');

  const rosterRes = await fetch(`${config.FLEET_API}/roster?employer_id=${employerId}`);
  const roster = await rosterRes.json();

  // Cards that need Passport loaded (from Fleet's own tracking)
  const passportLoads = actions.missing_passport.map(a => ({
    employee_id: a.employee_id,
    employee_name: a.employee_name,
    card_csn: a.roster.card_csn
  }));

  // Cards to offboard
  const offboards = actions.terminated.map(t => {
    const emp = roster.find(r => r.employee_id === t.employee_id);
    return emp ? { employee_id: emp.employee_id, employee_name: emp.employee_name, card_csn: emp.card_csn } : null;
  }).filter(Boolean);

  // Cards to unlock (returning from leave)
  const unlocks = actions.return_from_leave.map(r => {
    const emp = roster.find(x => x.employee_id === r.employee_id);
    return emp ? { employee_id: emp.employee_id, employee_name: emp.employee_name, card_csn: emp.card_csn } : null;
  }).filter(Boolean);

  const plan = `${passportLoads.length} Passport loads (bulk), ${offboards.length} offboards (bulk lock + bulk remove), ` +
    `${unlocks.length} unlocks (bulk), ${(actions.worksite_transfer || []).length} transfers (roster)`;
  await logStep(WF, 'Action Plan Ready', 'script', plan);

  // ================================================================
  // Step 4 (approval): Operator review
  // ================================================================
  await logStep(WF, 'Awaiting Approval', 'approval', 'Waiting for operator...', 'waiting');

  const summary = `MTA Monthly Audit: ` +
    `${passportLoads.length} CRITICAL Passport fixes (${passportLoads.map(p => p.employee_name).join(', ')}). ` +
    `${offboards.length} offboards, ${unlocks.length} unlocks, ${(actions.worksite_transfer||[]).length} transfers. Approve?`;

  await requestApproval(WF, summary);
  await logStep(WF, 'Approved', 'approval', 'Operator approved MTA audit actions');

  // ================================================================
  // Step 5 (browser): Bulk load missing Passport products
  // ================================================================
  if (passportLoads.length > 0) {
    await logStep(WF, 'Generate Passport CSV', 'script',
      `Creating bulk CSV for ${passportLoads.length} cards missing Passport...`);

    const passportCsvPath = path.join(outputDir, 'mta_fix_passport.csv');
    const passportRows = passportLoads.map(p => ({ PrintedCardNumber: p.card_csn }));
    fs.writeFileSync(passportCsvPath, stringify(passportRows, { header: true }));

    await logStep(WF, 'Bulk Create Passes', 'browser',
      'Navigating to Bulk Actions > Create Passes...');

    await navigateTo(page, '/bulk-actions?type=create-passes');
    await sleep(600);
    await uploadBulkCSV(page, passportCsvPath);

    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
    await sleep(400);

    await logStep(WF, 'Passports Loaded', 'browser',
      `Bulk Passport job complete: ${passportLoads.length} cards now have Regional Business Passport active`);

    // Also bulk-load $20 e-purse on these cards to cover any accrued negative balance from rides without Passport
    await logStep(WF, 'Cover Negative Balances', 'script',
      'Bulk loading $20 e-purse (pre-tax) to cover negatives on previously missing-Passport cards...');

    const coverCsvPath = path.join(outputDir, 'mta_cover_negatives.csv');
    fs.writeFileSync(coverCsvPath, stringify(passportRows, { header: true }));

    await navigateTo(page, '/bulk-actions?type=add-money');
    await sleep(600);
    await uploadBulkCSV(page, coverCsvPath);

    await page.evaluate(() => {
      const amountInput = document.getElementById('bulk-amount');
      if (amountInput) amountInput.value = '20';
      const submitAmount = document.getElementById('submit-amount');
      if (submitAmount) submitAmount.value = '20';
    });
    await sleep(300);

    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
    await sleep(400);

    await logStep(WF, 'Negatives Covered', 'browser',
      `Bulk e-purse load: ${passportLoads.length} cards x $20 (covers negative balances)`);

    // Update Fleet roster: has_passport_verified = 1
    for (const pl of passportLoads) {
      await fetch(`${config.FLEET_API}/roster/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_id: pl.employee_id,
          updates: { has_passport_verified: 1 }
        })
      });
    }
  }

  // ================================================================
  // Step 6 (browser): Bulk unlock returning from leave
  // ================================================================
  if (unlocks.length > 0) {
    await logStep(WF, 'Generate Unlock CSV', 'script',
      `Creating bulk CSV for ${unlocks.length} cards returning from leave...`);

    const unlockCsvPath = path.join(outputDir, 'mta_unlock.csv');
    const unlockRows = unlocks.map(u => ({ PrintedCardNumber: u.card_csn }));
    fs.writeFileSync(unlockCsvPath, stringify(unlockRows, { header: true }));

    await logStep(WF, 'Bulk Unlock', 'browser', 'Navigating to Bulk Actions > Unlock Cards...');

    await navigateTo(page, '/bulk-actions?type=unlock');
    await sleep(600);
    await uploadBulkCSV(page, unlockCsvPath);

    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
    await sleep(400);

    await logStep(WF, 'Cards Unlocked', 'browser',
      `Bulk unlock: ${unlocks.length} cards. ${unlocks.map(u => u.employee_name).join(', ')} returned from leave.`);

    for (const u of unlocks) {
      await fetch(`${config.FLEET_API}/roster/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_id: u.employee_id,
          updates: { status: 'Active' }
        })
      });
    }
  }

  // ================================================================
  // Step 7 (browser): Bulk offboard — lock then remove
  // ================================================================
  if (offboards.length > 0) {
    await logStep(WF, 'Generate Offboard CSV', 'script',
      `Creating bulk CSV for ${offboards.length} terminated employees...`);

    const offboardCsvPath = path.join(outputDir, 'mta_offboard.csv');
    const offboardRows = offboards.map(o => ({ PrintedCardNumber: o.card_csn }));
    fs.writeFileSync(offboardCsvPath, stringify(offboardRows, { header: true }));

    // Step 7a: Bulk lock (Business Exclusive)
    await logStep(WF, 'Bulk Lock', 'browser', 'Navigating to Bulk Actions > Lock Cards...');
    await navigateTo(page, '/bulk-actions?type=lock');
    await sleep(600);
    await uploadBulkCSV(page, offboardCsvPath);

    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
    await sleep(400);

    await logStep(WF, 'Cards Locked', 'browser',
      `Bulk lock: ${offboards.length} cards locked with Business Exclusive`);

    // Step 7b: Bulk remove from account
    await logStep(WF, 'Bulk Remove', 'browser', 'Navigating to Bulk Actions > Remove Cards...');
    await navigateTo(page, '/bulk-actions?type=remove-cards');
    await sleep(600);
    await uploadBulkCSV(page, offboardCsvPath);

    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
    await sleep(400);

    await logStep(WF, 'Cards Removed', 'browser',
      `Bulk remove: ${offboards.length} cards removed from account. Passport stripped. E-purse stays.`);

    for (const o of offboards) {
      await fetch(`${config.FLEET_API}/roster/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_id: o.employee_id,
          updates: { status: 'Inactive', offboard_date: new Date().toISOString().slice(0, 10) }
        })
      });
    }
  }

  // ================================================================
  // Step 8 (script): Worksite transfers (roster only — no myORCA action needed)
  // ================================================================
  for (const tr of (actions.worksite_transfer || [])) {
    await fetch(`${config.FLEET_API}/roster/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_id: tr.employee_id,
        updates: { location: tr.location }
      })
    });
    await logStep(WF, 'Worksite Transfer', 'script',
      `${tr.employee_name}: transferred to ${tr.location}. Pricing tier tracking updated.`);
  }

  // ================================================================
  // Step 9 (script): Generate employer report
  // ================================================================
  const finalRoster = await (await fetch(`${config.FLEET_API}/roster?employer_id=${employerId}`)).json();
  const activeCount = finalRoster.filter(r => r.status === 'Active').length;
  const downtown = finalRoster.filter(r => r.status === 'Active' && r.location === 'Downtown').length;
  const eastside = finalRoster.filter(r => r.status === 'Active' && r.location === 'Eastside').length;
  const passportVerified = finalRoster.filter(r => r.has_passport_verified && r.status === 'Active').length;

  const summaryReport = {
    employer: 'Metro Transit Authority',
    cycle: new Date().toISOString().slice(0, 7),
    active_headcount: activeCount,
    by_worksite: { Downtown: downtown, Eastside: eastside },
    passport_verified: passportVerified,
    passport_fixes: passportLoads.length,
    offboards: offboards.length,
    unlocks: unlocks.length,
    transfers: (actions.worksite_transfer || []).length,
    billing_tier: activeCount < 500 ? 'Area Passport' : 'Per-Trip Passport',
  };

  fs.writeFileSync(
    path.join(outputDir, 'mta_monthly_report.json'),
    JSON.stringify(summaryReport, null, 2)
  );

  await logStep(WF, 'MTA Audit Complete', 'script',
    `${activeCount} active (Downtown: ${downtown}, Eastside: ${eastside}). ` +
    `Passport verified: ${passportVerified}/${activeCount}. ${passportLoads.length} fixes, ` +
    `${offboards.length} offboards, ${unlocks.length} unlocks, ${(actions.worksite_transfer||[]).length} transfers. ` +
    `Billing: ${summaryReport.billing_tier}. All bulk actions — zero individual card clicks.`);
}

module.exports = { run };
