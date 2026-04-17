# Fleet ORCA Automation Demo

Browser automation for employer-managed ORCA card programs. Drives a mock `myorca.com` portal through the same workflows a real Fleet ops team runs each month — monthly e-purse cycles, balance audits, onboard/offboard lifecycle, autoload pause on termination. Two employer programs simulated across 300+ cards with 21+ edge cases.

## Run it

**Prerequisites:** Node 20+ and a Mac (tested on macOS 14+). Install Node with `brew install node` if you don't have it.

```bash
git clone https://github.com/transitv2/fleet-orca-demo.git
cd fleet-orca-demo
npm install     # downloads Chromium and seeds both databases
npm start       # boots mock-orca on :3000 and fleet-backend on :3001
```

Open **http://localhost:3001** and click **"Run Monthly Cycle (Acme)"**. A Chromium window opens and drives the mock portal for ~25 seconds while the dashboard streams every step.

## What to try

- **Run Monthly Cycle (Acme)** — full 250-card monthly load cycle in one click
- **Balance Audit > Quick (10 cards)** — on-demand verification mode, watch balances populate row-by-row
- Switch employer to **MTA** and click **Run Monthly Passport** — Passport program variant
- **Onboard New Card / Existing Card** — lifecycle workflows
- **Offboard** — lock, balance transfer, bulk remove
- **Reset** — restores both databases to seed state

## Architecture

```
Mock myORCA (Express:3000)  <--Playwright-->  Fleet Backend (Express:3001)
        SQLite (orca.db)                          SQLite (fleet.db)
                                                       |
                                                  Dashboard (SSE)
```

- `mock-orca/` — stand-in for `myorca.com`. Express + EJS, SQLite.
- `fleet/` — Fleet's backend + operator dashboard. Express, SQLite, SSE for live updates.
- `automation/` — Playwright workflow scripts. Spawned by the fleet backend when a workflow button is clicked.

Full architecture writeup in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Reset

- **In the dashboard:** click the Reset button
- **From the terminal:** stop the server and run `npm run reset`, then `npm start`

## Troubleshooting

- **Chromium doesn't open:** run `npx playwright install chromium` manually
- **Port conflict on 3000 or 3001:** something else is using the port. `lsof -i :3001` to find it, kill it, retry.
- **`npm install` fails on `better-sqlite3`:** ensure Xcode Command Line Tools are installed: `xcode-select --install`
- **Seeding error:** run `npm run seed` manually, then `npm start`
