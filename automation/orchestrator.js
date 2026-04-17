const { chromium } = require('playwright');
const path = require('path');
const config = require('./config');

const scriptName = process.argv[2];
const employerId = process.argv[3] || 'acme';
const auditCount = process.argv[4] || null; // for audit.js

if (!scriptName) {
  console.error('Usage: node orchestrator.js <script-name> [employer_id] [audit_count]');
  process.exit(1);
}

const scriptPath = path.join(__dirname, scriptName);

async function main() {
  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      slowMo: config.SLOW_MO,
      args: ['--window-size=900,700', '--window-position=50,50']
    });

    const context = await browser.newContext({
      viewport: { width: 880, height: 660 }
    });

    const page = await context.newPage();

    const workflow = require(scriptPath);
    await workflow.run(page, { employerId, auditCount });

    console.log('Workflow completed successfully');
  } catch (error) {
    console.error('Workflow error:', error.message);
    try {
      await fetch(`${config.FLEET_API}/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow: scriptName.replace('.js', ''),
          step_name: 'Error',
          step_type: 'script',
          detail: error.message,
          status: 'failed'
        })
      });
    } catch (e) { /* ignore */ }
  } finally {
    if (browser) await browser.close();
  }
}

main();
