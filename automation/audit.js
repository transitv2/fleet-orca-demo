const path = require('path');
const fs = require('fs');
const config = require('./config');
const { login, navigateTo, logStep, sleep, closeSidebar } = require('./helpers');

const WF = 'audit';

async function run(page, opts = {}) {
  const employerId = opts.employerId || 'acme';
  const count = opts.auditCount || '10';

  // ================================================================
  // Step 1 (script): Request audit — get list of cards to scrape
  // ================================================================
  await logStep(WF, 'Start Audit', 'script',
    `Requesting ${count === 'all' ? 'full' : count + '-card'} balance audit for ${employerId.toUpperCase()}...`);

  const startRes = await fetch(`${config.FLEET_API}/audit/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count, employer_id: employerId })
  });
  const { audit_id, cards_to_scrape } = await startRes.json();

  await logStep(WF, 'Audit Plan', 'script',
    `Audit #${audit_id}: ${cards_to_scrape.length} cards selected (prioritized: flagged + recent loads + random fill)`);

  // ================================================================
  // Step 2 (browser): Login and navigate
  // ================================================================
  await logStep(WF, 'Login', 'browser', 'Logging into myORCA...');
  await login(page, employerId);
  await navigateTo(page, '/manage-cards');
  await sleep(400);

  // ================================================================
  // Step 3 (browser): Scrape each card's balance + passport state
  // ================================================================
  await logStep(WF, 'Scraping Begins', 'browser',
    `Navigating card-by-card. Estimated time: ${Math.round(cards_to_scrape.length * 4 / 60)} min for ${cards_to_scrape.length} cards.`);

  const isPassport = employerId === 'mta';
  let scrapedCount = 0;

  for (const target of cards_to_scrape) {
    const csn = target.csn;
    const name = target.name;
    const csnShort = '...' + csn.slice(-4);

    // Search
    await page.selectOption('#search-by', 'card_number');
    await page.fill('#search-input', csn.slice(-8));
    await page.click('.search-btn');
    await sleep(400);

    const row = page.locator(`[data-csn="${csn}"]`);
    let balance = null;
    let passportLoaded = null;

    if (await row.count() > 0) {
      await row.locator('.card-checkbox').check();
      await sleep(200);
      await page.click('#manage-btn');

      try {
        await page.waitForSelector('#epurse-balance', { timeout: 5000 });
        await sleep(300);

        const balText = await page.textContent('#epurse-balance');
        balance = parseFloat(balText.replace('$', ''));

        // For Passport employers, check the Passes tab
        if (isPassport) {
          await page.click('.tab:has-text("PASSES")');
          await sleep(400);
          passportLoaded = await page.evaluate(() => {
            const list = document.getElementById('passes-list');
            return list ? list.querySelectorAll('.autoload-item').length > 0 : false;
          });
        }

        await closeSidebar(page);
      } catch (e) {
        balance = null;
      }
    }

    scrapedCount++;

    // Determine status indicator for log
    let icon = '✓';
    let flag = 'healthy';
    if (balance === null) { icon = '?'; flag = 'error'; }
    else if (balance < 0) { icon = '🔴'; flag = 'negative'; }
    else if (balance >= 400) { icon = '⚠'; flag = 'at_cap'; }
    else if (balance >= 385) { icon = '⚠'; flag = 'near_cap'; }

    const balStr = balance !== null ? '$' + balance.toFixed(2) : 'N/A';
    await logStep(WF, 'Audit Progress', 'browser',
      `${scrapedCount}/${cards_to_scrape.length} — ${csnShort} (${name}) — ${balStr} ${icon} ${flag}` +
      (isPassport ? ` | Passport: ${passportLoaded ? 'ACTIVE' : 'MISSING'}` : ''));

    // POST result
    if (balance !== null) {
      await fetch(`${config.FLEET_API}/audit/${audit_id}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_csn: csn,
          employee_name: name,
          balance,
          passport_loaded: passportLoaded
        })
      });
    }

    await sleep(100);
  }

  // ================================================================
  // Step 4 (script): Complete audit + generate summary
  // ================================================================
  await logStep(WF, 'Audit Complete', 'script',
    `${scrapedCount} cards scraped. Generating reconciliation report...`);

  const completeRes = await fetch(`${config.FLEET_API}/audit/${audit_id}/complete`, { method: 'POST' });
  const { summary } = await completeRes.json();

  // Fetch full audit with results
  const auditRes = await fetch(`${config.FLEET_API}/audit/${audit_id}`);
  const audit = await auditRes.json();

  const atCapCards = audit.results.filter(r => r.status_flag === 'at_cap');
  const nearCapCards = audit.results.filter(r => r.status_flag === 'near_cap');
  const negativeCards = audit.results.filter(r => r.status_flag === 'negative');
  const healthyCount = audit.results.filter(r => r.status_flag === 'healthy').length;

  // Extrapolate to full roster
  const rosterRes = await fetch(`${config.FLEET_API}/roster?employer_id=${employerId}`);
  const roster = await rosterRes.json();
  const totalOnAccount = roster.filter(r => r.card_csn && r.status === 'Active').length;

  const capPct = (audit.results.length > 0 ? atCapCards.length / audit.results.length : 0);
  const negPct = (audit.results.length > 0 ? negativeCards.length / audit.results.length : 0);
  const estimatedCapLoss = totalOnAccount * capPct * 25; // rough avg cap-out loss
  const estimatedNegativeCards = Math.round(totalOnAccount * negPct);

  // Emit summary as a log event
  const lines = [
    '════════════════════════════════════════════════',
    `AUDIT COMPLETE — ${scrapedCount} cards scraped`,
    '════════════════════════════════════════════════',
    `RESULTS: ${healthyCount} healthy, ${atCapCards.length} at cap, ${nearCapCards.length} near cap, ${negativeCards.length} negative`,
    `SPEND: projected $${summary.projected_spend.toFixed(2)}, actual est. $${summary.actual_spend.toFixed(2)}`,
    atCapCards.length > 0 ? `AT CAP: ${atCapCards.map(r => r.employee_name + ' $' + r.balance.toFixed(2)).join(', ')}` : '',
    negativeCards.length > 0 ? `NEGATIVE: ${negativeCards.map(r => r.employee_name + ' $' + r.balance.toFixed(2)).join(', ')}` : '',
    count !== 'all' ? `EXTRAPOLATED (${totalOnAccount} cards): est. $${estimatedCapLoss.toFixed(2)} cap loss, ~${estimatedNegativeCards} negative balances` : '',
    'RECOMMEND: investigate negatives; run Full Audit if sample shows issues.'
  ].filter(Boolean);

  for (const line of lines) {
    await logStep(WF, 'Audit Report', 'script', line);
  }
}

module.exports = { run };
