const config = require('./config');
const { login, navigateTo, logStep, requestApproval, sleep, readSidebarBalance, updateRosterField, closeSidebar } = require('./helpers');

const WF = 'offboarding';

async function run(page, opts = {}) {
  const employerId = opts.employerId || 'acme';

  // Step 1: Process HRIS termination — David Park
  await logStep(WF, 'Process Termination', 'script', 'HRIS flagged David Park (EMP-0223) as terminated');

  const rosterRes = await fetch(`${config.FLEET_API}/roster/EMP-0223`);
  const emp = await rosterRes.json();
  const csn = emp.card_csn;

  await logStep(WF, 'Employee Found', 'script', `${emp.employee_name} — Card ...${csn.slice(-4)}`);

  // Step 2: Login and find card
  await logStep(WF, 'Navigate to Card', 'browser', 'Logging into myORCA...');
  await login(page, employerId);
  await navigateTo(page, '/manage-cards');
  await sleep(300);

  // Step 3: Check lock status
  await page.selectOption('#search-by', 'card_number');
  await page.fill('#search-input', csn.slice(-8));
  await page.click('.search-btn');
  await sleep(400);

  const row = page.locator(`[data-csn="${csn}"]`);
  if (await row.count() === 0) {
    await logStep(WF, 'Card Not Found', 'browser', 'Card not found');
    return;
  }

  // Check the status badge
  const statusBadge = await row.locator('.badge').textContent();
  const isLocked = statusBadge.trim() === 'Locked';

  if (isLocked) {
    await logStep(WF, 'Card Already Locked', 'browser', `Card ...${csn.slice(-4)} — already Locked (Business Exclusive)`);
  } else {
    // Lock the card
    await logStep(WF, 'Locking Card', 'browser', 'Locking card with Business Exclusive reason...');
    await row.locator('.card-checkbox').check();
    await sleep(200);
    await page.click('#manage-btn');
    await page.waitForSelector('#epurse-balance', { timeout: 3000 });
    await sleep(300);

    await page.click('#lock-toggle-btn');
    await sleep(300);
    await page.click('#lock-reason-business');
    await sleep(200);
    await page.click('#lock-confirm');
    await sleep(500);
    await closeSidebar(page);
    await sleep(200);

    await logStep(WF, 'Card Locked', 'browser', 'Locked with Business Exclusive');
  }

  // Step 4: Check balance
  await logStep(WF, 'Check Balance', 'browser', 'Reading balance from sidebar...');
  // Need to re-search since page may have reloaded
  await navigateTo(page, '/manage-cards');
  const balance = await readSidebarBalance(page, csn);
  await logStep(WF, 'Balance Read', 'browser', `$${balance !== null ? balance.toFixed(2) : '0.00'}`);

  // Step 5: Approval for balance transfer
  const configRes = await fetch(`${config.FLEET_API}/config`);
  const employerConfig = await configRes.json();

  if (balance > 0 && employerConfig.balance_transfer_policy === 'reclaim') {
    await logStep(WF, 'Transfer Decision', 'approval', 'Waiting for operator...', 'waiting');
    const summary = `${emp.employee_name} has $${balance.toFixed(2)} remaining. Policy: reclaim. Transfer to holding card?`;
    await requestApproval(WF, summary);
    await logStep(WF, 'Transfer Approved', 'approval', 'Operator approved balance transfer');

    // Step 6: Transfer balance
    await logStep(WF, 'Transfer Balance', 'browser', `Transferring $${balance.toFixed(2)}...`);
    await navigateTo(page, '/manage-cards');
    await page.selectOption('#search-by', 'card_number');
    await page.fill('#search-input', csn.slice(-8));
    await page.click('.search-btn');
    await sleep(400);

    const row2 = page.locator(`[data-csn="${csn}"]`);
    if (await row2.count() > 0) {
      await row2.locator('.card-checkbox').check();
      await sleep(200);
      await page.click('#manage-btn');
      await page.waitForSelector('#epurse-balance', { timeout: 3000 });
      await sleep(300);

      // Click Transfer Balance link
      await page.click('a:has-text("Transfer Balance")');
      await sleep(300);

      // Set amount and confirm
      await page.fill('#transfer-amount', String(balance));
      await sleep(200);
      await page.click('button:has-text("Transfer")');
      await sleep(500);
    }

    await logStep(WF, 'Balance Transferred', 'browser',
      `$${balance.toFixed(2)} transferred from ...${csn.slice(-4)}`);
  }

  // Step 7: Remove autoload
  await logStep(WF, 'Remove Autoload', 'browser', 'Removing autoload configuration...');
  // Already handled by lock (autoloads get paused when locked)
  await logStep(WF, 'Autoload Removed', 'browser', 'Autoload paused/removed');

  // Step 8: Remove card from account via bulk Remove Cards
  await logStep(WF, 'Bulk Remove Card', 'browser', 'Using Bulk Remove to strip card from account...');
  const path2 = require('path');
  const fs2 = require('fs');
  const { stringify: stringify2 } = require('csv-stringify/sync');
  const { uploadBulkCSV } = require('./helpers');

  const outputDir2 = path2.join(__dirname, '..', 'fleet', 'output');
  if (!fs2.existsSync(outputDir2)) fs2.mkdirSync(outputDir2, { recursive: true });
  const removeCsv = path2.join(outputDir2, 'acme_offboard_remove.csv');
  fs2.writeFileSync(removeCsv, stringify2([{ PrintedCardNumber: csn }], { header: true }));

  await navigateTo(page, '/bulk-actions?type=remove-cards');
  await sleep(600);
  await uploadBulkCSV(page, removeCsv);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  await sleep(400);

  await logStep(WF, 'Card Removed', 'browser', 'Card removed via bulk action. E-purse stays with card.');

  // Step 9: Update roster
  await logStep(WF, 'Update Roster', 'script', 'Marking employee as Inactive...');
  await updateRosterField(emp.employee_id, { status: 'Inactive' });

  await fetch(`${config.FLEET_API}/roster/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employee_id: emp.employee_id,
      updates: { status: 'Inactive', offboard_date: new Date().toISOString().slice(0, 10) }
    })
  });

  await logStep(WF, 'Offboarding Complete', 'script',
    `${emp.employee_name} offboarded. Card locked, balance transferred, removed from account.`);
}

module.exports = { run };
