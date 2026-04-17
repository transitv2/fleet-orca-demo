const path = require('path');
const fs = require('fs');
const config = require('./config');
const { login, navigateTo, logStep, sleep } = require('./helpers');
const { stringify } = require('csv-stringify/sync');

const WF = 'passport-offboarding';

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

  // Step 1: Process HRIS
  await logStep(WF, 'Process Termination', 'script', 'Checking MTA HRIS for terminations...');

  const hrisRes = await fetch(`${config.FLEET_API}/hris/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employer_id: employerId })
  });
  const actions = await hrisRes.json();
  const terminated = actions.terminated;

  if (!terminated.length) {
    await logStep(WF, 'No Terminations', 'script', 'No Passport terminations found');
    return;
  }

  const rosterRes = await fetch(`${config.FLEET_API}/roster?employer_id=${employerId}`);
  const roster = await rosterRes.json();

  const offboards = terminated.map(t => {
    const emp = roster.find(r => r.employee_id === t.employee_id);
    return emp ? { employee_id: emp.employee_id, employee_name: emp.employee_name, card_csn: emp.card_csn } : null;
  }).filter(Boolean);

  await logStep(WF, 'Terminations Identified', 'script',
    `${offboards.length} Passport employees to offboard: ${offboards.map(o => o.employee_name).join(', ')}`);

  // Step 2: Generate offboard CSV
  const outputDir = path.join(__dirname, '..', 'fleet', 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const offboardCsvPath = path.join(outputDir, 'mta_offboard.csv');
  fs.writeFileSync(offboardCsvPath, stringify(offboards.map(o => ({ PrintedCardNumber: o.card_csn })), { header: true }));

  await logStep(WF, 'Offboard CSV Ready', 'script', `${offboards.length} cards in CSV`);

  // Step 3: Login
  await logStep(WF, 'Login', 'browser', 'Logging into MTA myORCA...');
  await login(page, employerId);
  await sleep(300);

  // Step 4: Bulk lock
  await logStep(WF, 'Bulk Lock', 'browser', 'Bulk Actions > Lock Cards...');
  await navigateTo(page, '/bulk-actions?type=lock');
  await sleep(600);
  await uploadBulkCSV(page, offboardCsvPath);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  await sleep(400);
  await logStep(WF, 'Cards Locked', 'browser', `${offboards.length} cards locked (Business Exclusive)`);

  // Step 5: Bulk remove
  await logStep(WF, 'Bulk Remove', 'browser', 'Bulk Actions > Remove Cards...');
  await navigateTo(page, '/bulk-actions?type=remove-cards');
  await sleep(600);
  await uploadBulkCSV(page, offboardCsvPath);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  await sleep(400);
  await logStep(WF, 'Cards Removed', 'browser',
    `${offboards.length} cards removed. Passport stripped. E-purse stays with card.`);

  // Step 6: Update Fleet roster
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

  await logStep(WF, 'Offboarding Complete', 'script',
    `${offboards.length} Passport employees offboarded via bulk actions. Zero individual card clicks.`);
}

module.exports = { run };
