# Fleet ORCA Automation — Architecture, Demo Talking Points, and Production Path

## 1. The Problem We Are Solving

ORCA's business portal (`myorca.com`) has **no public API** for employer fleet management. Employers running transit benefit programs must operate the system through a human-facing web UI: log in, click into bulk actions, upload CSVs, click into individual cards to read balances, and so on. This works for a 10-employee company. It does not work for an HR team managing 250+ employees across hire/leave/return/termination cycles every month.

Fleet's value proposition is to operate that portal **as a service** — taking the employer's HRIS as input and producing the right ORCA portal actions as output, with full auditability, idempotent re-runs, and exception handling for the 21+ edge cases that the portal itself does not surface.

Because there is no API, **everything Fleet does is browser automation**. That single constraint shapes the entire architecture.

---

## 2. System Architecture

### 2.1 The Three Processes

The system runs as **three independent processes** that communicate over HTTP and the file system:

```
┌────────────────────────────────────────────────────────────────────────┐
│                          USER (Operator)                               │
│            Browser at http://localhost:3001 (Dashboard)                │
└────────────────────────────────────────────────────────────────────────┘
              │                                      ▲
              │ click "Run Monthly"                  │ SSE stream
              │ POST /api/run/monthly                │ (logs, updates)
              ▼                                      │
┌────────────────────────────────────────────────────────────────────────┐
│  FLEET BACKEND  (Express, port 3001)                                   │
│  ─────────────────────────────────────                                 │
│  • Roster + load_history + automation_log + audit_runs (SQLite)        │
│  • SSE broadcaster (/api/events)                                       │
│  • Workflow trigger endpoint (forks orchestrator)                      │
│  • HRIS classifier (process-hris.js)                                   │
│  • Read-only proxy into orca.db for the dashboard "god view"           │
└────────────────────────────────────────────────────────────────────────┘
              │                                      ▲
              │ fork() child_process                 │ HTTP
              ▼                                      │ (logStep, updateRoster)
┌────────────────────────────────────────────────────────────────────────┐
│  AUTOMATION ORCHESTRATOR  (Node + Playwright, ephemeral child)         │
│  ───────────────────────────────────────────────────────────           │
│  • Launches a visible Chromium window                                  │
│  • Loads the workflow script (monthly-cycle.js, onboard-existing.js…)  │
│  • Drives the mock-orca portal UI via Playwright selectors             │
│  • Pulls roster/HRIS from Fleet, pushes log entries back via HTTP      │
└────────────────────────────────────────────────────────────────────────┘
              │ Playwright drives a real browser
              ▼
┌────────────────────────────────────────────────────────────────────────┐
│  MOCK myORCA PORTAL  (Express + EJS, port 3000)                        │
│  ─────────────────────────────────────────────────                     │
│  • Login → session cookie scoped per employer                          │
│  • Manage Cards / Purchase / Cart / Bulk Actions / Past Processes      │
│  • cards / participants / autoloads / orders / bulk_jobs (SQLite)      │
│  • Pretends to be the real ORCA — same screens, same CSV columns,      │
│    same bulk-job lifecycle (Processing → Completed)                    │
└────────────────────────────────────────────────────────────────────────┘
```

The mock portal is a faithful enough stand-in that the **same Playwright scripts** would work against the real `myorca.com` with selector substitutions. The whole point of building the mock was to demo the automation without depending on a live ORCA business account.

### 2.2 Why Three Processes (and not one)

This separation is intentional and maps to how the production system would split:

| Process | What it represents in production |
|---|---|
| **Fleet backend** | Fleet's SaaS API and operator console |
| **Orchestrator + Playwright** | The headless worker fleet that drives myORCA |
| **Mock myORCA** | The real `myorca.com` (replaced by the real site in prod) |

Keeping the orchestrator in a forked child process means a workflow crash, browser hang, or Playwright OOM kills only that worker — the operator dashboard stays up and can launch the next run. This is the same fault-isolation pattern Fleet would need across many concurrent employer workflows in production.

### 2.3 Data Stores

Two SQLite databases. **They are deliberately separate** and never share a connection:

**`mock-orca/orca.db`** — the portal's view of the world. What ORCA actually knows.
- `cards` — 19-digit CSN, status, lock_reason, access_type, **`epurse_balance`**, on_business_account, employer_id
- `participants` — linked to cards via card_id (identifier = CSN per ORCA best practice)
- `orders` + `order_items` — purchase history; CSV export format matches real ORCA
- `autoloads` — Time-based or Threshold-based, status = Active / Paused / Removed
- `passes` — Regional Business Passport records
- `bulk_jobs` — Past Processes history with job_type, status, employer_id

**`fleet/fleet.db`** — Fleet's view of the employer. What Fleet derived, decided, and submitted.
- `roster` — master employee list per employer; `card_csn`, `autoload_configured`, `has_passport_verified`, status, `current_balance` (NULL until an audit populates it), `monthly_subsidy`, `onboard_date`, `offboard_date`
- `load_history` — per-cycle audit trail: who was submitted for what amount, method (`bulk` / `manual` / `excluded`), `exclusion_reason`
- `automation_log` — every workflow step (script / browser / approval), streamed to the dashboard via SSE
- `employer_config` — per-employer program settings (`monthly_subsidy`, `epurse_cap`, `balance_transfer_policy`, ORCA credentials)
- `audit_runs` + `audit_results` — Balance Audit history and per-card scrape results

The split mirrors a real-world boundary: ORCA owns the source of truth for the cards; Fleet owns the source of truth for the program. Fleet only ever **submits intentions** and **scrapes occasional ground truth** to compare.

### 2.4 Communication Patterns

| Hop | Mechanism | Why |
|---|---|---|
| Operator → Fleet backend | HTTP (REST + SSE) | Standard browser dashboard |
| Fleet backend → Orchestrator | `child_process.fork()` | Isolation; child crashes don't kill parent |
| Orchestrator → Fleet backend | HTTP (POST `/api/log`, `/api/roster/update`, etc.) | Same way the production worker would talk to the SaaS API |
| Orchestrator → mock myORCA | Playwright (real Chromium driving a real DOM) | Identical to how it would drive the real `myorca.com` |
| Fleet backend → orca.db | Read-only better-sqlite3 connection | Dashboard "god view" — shows what the portal knows that bulk exports do not surface |

**Real-time updates** flow back to the dashboard over **Server-Sent Events** (`/api/events`). One stream, many event types: `log`, `roster_update`, `roster_add`, `load_history_update`, `approval_required`, `approval_resolved`, `workflow_start`, `workflow_complete`, `audit_progress`, `audit_complete`, `file_generated`, `reset`.

**Approval gates** are a polling pattern: the orchestrator hits `POST /api/approve/request` with a summary, then polls `GET /api/approve/status` every 500 ms until `approved=true`. The dashboard renders an inline Approve button when the SSE `approval_required` event arrives. This is how a human stays in the loop on irreversible actions like balance reclaim.

---

## 3. The Two Workflow Modes (the Design Insight)

Without API access, you have two fundamentally different things you can do against the portal: you can **submit** (cheap, blind) or you can **scrape** (slow, accurate). Fleet's design treats those as separate tools with separate jobs.

### 3.1 Monthly Cycle — "Submit and Trust"

The monthly cycle **does not scrape any card balances**. It downloads one CSV (the card export), classifies every employee from HRIS status + the `autoload_configured` flag in Fleet's roster, builds two bulk CSVs (`bulk_50.csv`, `bulk_100.csv`), uploads them through the portal's Bulk Add Money flow, and submits.

Cap math is delegated to ORCA. ORCA enforces the $400 e-purse cap silently; if Fleet submits $50 to a card already at $390, ORCA accepts $10 worth and discards the rest. Fleet doesn't try to predict that — it logs `submitted_amount=50` and moves on.

**~25 seconds for 250 cards.** Compare to the alternative — clicking into 250 sidebars to read each balance first — which would be 15+ minutes of brittle clicks per cycle.

The summary the employer sees is honest about the tradeoff: it reports **projected** spend, not actual. Actuals are produced by the audit, on demand.

### 3.2 Balance Audit — "Verify When Needed"

When the employer asks "did all our autoloads run last cycle?" or "how many cards are at cap?", Fleet runs an audit. The audit selects a prioritized sample (flagged cards + recent loads + random fill), opens each card's sidebar in the portal, scrapes the e-purse balance, and writes it to `roster.current_balance` and `audit_results`. Sizes: 10 / 20 / 50 / all.

A full 250-card audit takes ~12 minutes. Quick (10 cards) is ~30 seconds. The dashboard's roster table updates row-by-row as Playwright moves through cards — at-cap rows flash red, near-cap yellow, negatives surface immediately.

The audit answers: *what is actually true on ORCA right now?* The cycle answers: *what should we submit this month?* Two tools, same portal, different jobs.

### 3.3 Onboard / Offboard — Lifecycle Workflows

- **Onboard New Card (Choice)** — 12 steps: HRIS new-hire feed → bulk Purchase Cards → wait for order → CSV export → Add Participants bulk → Create Autoloads bulk → roster finalize. ~2 min for 5 hires.
- **Onboard Existing Card (Choice)** — 14 steps, *all bulk*: 30 employees onboarded same-day via Add Cards → Add Participants → Add Money $50 → Create Autoloads. The fast path when employees bring a personal ORCA card.
- **Offboard (Choice)** — Lock card → scrape balance → optional human-approved balance transfer (if `balance_transfer_policy='reclaim'`) → bulk Remove Cards → mark roster `Inactive` with `offboard_date`.
- **Passport variants** — analogous flows for the unlimited-ride Passport program (MTA employer). Passport is always-on; no autoloads, no monthly load math.

Every workflow writes to `load_history` (audit trail of what hit ORCA) and to `automation_log` (step-by-step record streamed to the operator).

---

## 4. The Edge Cases (Why This Is Hard)

The real value is not the happy path — it is the 21 cases the portal does not flag. Selected from the Acme 250-card dataset:

| Category | Count | What Fleet does |
|---|---|---|
| Standard autoload-covered | 200 | Nothing (autoload runs itself) |
| No-autoload standard load | 12 | Bulk $50 |
| No-autoload near cap ($1–$15 room) | 4 | Submit anyway; ORCA absorbs the overage; audit detects |
| No-autoload at cap ($400) | 2 | Excluded from loads (`load_method='excluded'`) |
| Retroactive (no autoload) | 2 | Bulk $100 (current + missed month) |
| Retroactive (has autoload) | 2 | Bulk $50 *extra* (autoload covers base) |
| Terminated, already locked | 3 | Verify lock + queue offboard |
| Terminated, not yet locked | 4 | Lock + **pause autoload** (the money-leak fix) + queue offboard |
| Going on leave (has autoload) | 2 | Lock + **pause autoload** |
| Return from leave (paused autoload) | 2 | Unlock + **resume autoload** |
| Replaced card pair | 4 pairs | Update roster old CSN → new CSN |
| Duplicate active cards (same name) | 3 sets | Flag + pause primary autoload pending resolution |
| Hidden negative balance | 2 | **Invisible to Fleet** until audit — surface in employer report |
| Missing email | 1 | Flag for employer |
| New hires | 10 | Queue for onboard workflow |

---

## 5. Why This Stack Today (Demo Choices)

Every choice in the current stack was made for **demo velocity** and **interview legibility**, not production. Calling them out explicitly:

| Choice | Why we made it for the demo | What it costs in production |
|---|---|---|
| **SQLite (better-sqlite3)** | Zero-setup, file-based, runs on any laptop | Single-writer; no concurrent workflows; no replication |
| **Express + EJS** | Trivial server-rendered portal; no build step | No type safety; no hot reload; verbose route handlers |
| **Vanilla JS dashboard** | One file, no build chain, easy to read in an interview | No reactive state; manual DOM patching; no testing |
| **Playwright headed Chromium** | The visual is the demo — operator can *see* the automation | Real production needs headless; one Chromium per worker is heavy |
| **`child_process.fork()` orchestrator** | Simplest possible isolation; runs locally | No queue, no retry, no observability across workers |
| **SSE (no auth)** | Zero-config real-time updates to the dashboard | No backpressure; broadcast-to-all; trivially DoS-able |
| **Polling for approval gates** | Works without persistent state on the worker | Inefficient; 500 ms latency; no timeout |
| **Cookie session in mock-orca** | Faster than building proper OIDC for a demo | N/A — this is the *mocked* portal, not a Fleet component |
| **Synchronous workflow scripts** | Linear, readable, easy to interview | No checkpointing; a crash 80% through means redo from scratch |
| **No tests** | Demo-only code; throwaway | Obviously |

None of those are wrong choices for an interview demo. **They are deliberate trades**, and being able to articulate the trade is part of the pitch.

---

## 6. Production Gaps (What's Missing)

Grouped by severity. These are the things that would have to be true before a real customer's monthly cycle ran on this code.

### 6.1 Correctness & Safety

- **No idempotency keys.** If a workflow crashes after submitting a bulk job but before recording `load_history`, a retry would double-load. Production needs deterministic workflow IDs and write-ahead intent records.
- **No optimistic concurrency on roster updates.** Two workflows touching the same employee race silently. Need versioned writes.
- **No reconciliation between `load_history` and ORCA's `bulk_jobs`.** Today we trust that "bulk job submitted" = "money landed". A reconciliation job should diff Fleet's `load_history` against ORCA's actual processed amounts and flag discrepancies.
- **Autoload pause/resume is "fire and forget."** No verification that the pause stuck. Need a follow-up read of the autoload status.
- **Approval gates have no timeout.** A workflow waiting on human approval will poll forever.
- **Bulk CSV uploads are not validated against the file before submitting.** ORCA's bulk validator catches errors after upload — Fleet should pre-validate.
- **No replay protection.** Re-running the monthly cycle on the same day re-submits everything.

### 6.2 Observability

- **`automation_log` is the only audit trail.** No structured tracing, no per-workflow spans, no error aggregation. A failed run requires reading SQLite by hand.
- **No metrics.** Cycle duration, autoload-pause hit rate, audit cap-out percentage — none are emitted as time series.
- **No alerting.** A workflow can crash silently if the operator isn't watching the dashboard.
- **Browser screenshots and traces are not captured.** Playwright supports `tracing.start()` / video recording — we capture neither, so post-mortem on a portal change is blind.
- **No health checks.** Servers will run wedged forever if mock-orca's DB locks up.

### 6.3 Multi-Tenancy & Scale

- **One ORCA account per process.** The current scripts assume a single login at a time. Real Fleet has hundreds of employer accounts and would need per-tenant credential vaulting plus a worker pool.
- **No queue.** Workflows are launched on click, no scheduling, no concurrency limits, no priority.
- **No tenant isolation in storage.** Single SQLite file holds all employers — fine for two demo tenants, fatal at scale.
- **Credentials are in `automation/config.js` as plain strings.** Needs a secrets manager (AWS Secrets Manager / HashiCorp Vault) and per-tenant key wrapping.
- **No rate limiting against ORCA.** Production must respect ORCA's actual rate limits and back off on portal errors.

### 6.4 Resilience

- **No checkpointing.** A 12-minute audit that crashes at minute 11 starts over from card 1.
- **No retry on transient portal errors.** A timeout in Playwright kills the workflow.
- **Browser leaks on uncaught exceptions.** The orchestrator catches the error but a hung Chromium can survive in some failure modes.
- **No circuit breaker on ORCA degradation.** If `myorca.com` is slow, every active workflow piles up.
- **No DR for SQLite.** A corrupt `fleet.db` is unrecoverable without a backup, and we don't take backups.

### 6.5 Security

- **No authentication on the Fleet dashboard or API.** The whole `/api/*` surface is open to anyone who can reach port 3001.
- **CORS is wildcarded** (`Access-Control-Allow-Origin: *`).
- **SSE has no auth and no per-tenant filtering** — every connected client sees every event.
- **No input validation** on most POST endpoints. `/api/roster/update` accepts arbitrary `updates` keys and writes them straight into SQL via a column allowlist that lives in user space.
- **No audit log for operator actions** (who clicked Approve? When?).
- **Credentials in plaintext in `config.js`.**
- **Stored XSS surface in the dashboard** — log entries render `step_name` and `detail` via `innerHTML` without sanitization. (See `fleet/dashboard/app.js:79`.)
- **Mock portal session secret is hardcoded** (`'orca-demo-secret-key'`).

### 6.6 Operational

- **No deploy story.** It's `node start.js` on a laptop.
- **No CI/CD.**
- **No environment separation** (dev / staging / prod).
- **No infrastructure-as-code.**
- **No customer onboarding flow.** Adding a new employer means hand-editing seed data.
- **No billing, no usage metering.**

### 6.7 Product Surface Missing for a Real Operator

- No employer portal (employers see Fleet's results how, today?).
- No employee notifications ("your card was loaded $50").
- No reporting / export beyond the per-cycle CSVs in `fleet/output/`.
- No support workflow / ticketing integration.
- No HRIS connectors (Workday, BambooHR, Rippling, ADP) — today HRIS is a CSV file in `fleet/hris/`.

---

## 7. The Production Tech Stack — What We Would Shift

Mapping each demo choice to the production replacement, with the reasoning.

### 7.1 Storage

| Today | Production | Why |
|---|---|---|
| SQLite (single file, single writer) | **PostgreSQL** (managed: AWS RDS or Neon) | Multi-writer, replication, point-in-time recovery, JSON column for flexible per-employer config |
| Local filesystem for `fleet/output/*.csv` | **S3** (versioned bucket, lifecycle to Glacier after 90 days) | Audit retention, cross-region durability |
| Synchronous DB writes | **Outbox pattern** (write event row in same txn, async publish) | Reliable event delivery to downstream systems without 2PC |
| No cache | **Redis** (Upstash or ElastiCache) for hot roster lookups, rate-limit counters, idempotency keys | The orchestrator hits roster constantly; reads should be sub-ms |

### 7.2 Workflow Execution

| Today | Production | Why |
|---|---|---|
| `child_process.fork()` per click | **Temporal** (or Inngest for a smaller stack) | Durable workflows: checkpoint after every step, automatic retries with backoff, replay-from-failure, visibility UI included. The entire monthly-cycle.js becomes a Temporal workflow with each `logStep` becoming an Activity. |
| Headed Chromium via Playwright on the operator's machine | **Headless Playwright on a dedicated worker pool** (Browserbase / a custom Fargate cluster of 4-vCPU containers) | Concurrency, isolation, restart on hang. Browserbase specifically gives you per-tenant browser sessions, recordings, and persistent contexts out of the box. |
| Scripts call `fetch(FLEET_API/...)` | **gRPC or tRPC** between worker and Fleet API | Type-safe; one source of truth for the API surface |
| Approval gates via polling | **Temporal Signals** (or webhook + DB write) | Push-based, no polling, supports timeouts and timer-based escalation |

The Temporal substitution is the highest-impact change. It replaces "synchronous Node script with try/catch" with "durable function whose state survives crashes and can be replayed for debugging" — which is *the* requirement when each workflow is touching real money and real cards.

### 7.3 API / Backend

| Today | Production | Why |
|---|---|---|
| Express + vanilla JS routes | **Next.js (App Router) on Vercel** or **NestJS on Fargate** | Type-safe API routes, server actions, edge functions for low-latency reads |
| TypeScript: none | **TypeScript everywhere** with shared schemas (Zod) for runtime validation | Catch the `updates: { arbitrary_key }` class of bug at compile time |
| Auth: none | **Clerk** or **Auth0** for operator login + RBAC; **Stytch** if employer-facing | Don't roll session management twice |
| Per-request DB connection caching | **Prisma** or **Drizzle** ORM with connection pooling (PgBouncer) | Connection lifecycle handled correctly without inode bugs (cf. our recent debugging) |

### 7.4 Frontend (Dashboard)

| Today | Production | Why |
|---|---|---|
| Vanilla JS + manual DOM patching | **Next.js + React + TanStack Query** | Reactive state, optimistic updates, caching, devtools |
| EJS layout file | **shadcn/ui + Tailwind** | Existing component library; we already have UI UX Pro Max plugin available for design tokens |
| SSE via raw `EventSource` | **WebSocket via Pusher/Ably** or **Server-Sent Events with auth + per-tenant channels** | SSE is fine, but production needs auth on the stream and per-employer filtering |
| `innerHTML` log rendering (XSS!) | **React + DOMPurify** (or just JSX, which auto-escapes) | The dashboard XSS today is one untrusted log entry away from compromise |

### 7.5 Observability

| Today | Production | Why |
|---|---|---|
| Console logs + `automation_log` table | **OpenTelemetry → Datadog** (or Honeycomb) | Distributed traces across Fleet API, worker, and the portal calls |
| No metrics | **Prometheus-compatible metrics** (cycle duration, pause hit rate, audit cap-outs as gauges) | The product KPIs become dashboard panels |
| No errors | **Sentry** for both Fleet API and the worker | Cluster-and-suppress on portal-side flakes |
| No browser session capture | **Playwright tracing.start() + video** uploaded to S3 per workflow run | Post-mortem on portal markup changes is a screen recording, not a guess |
| No alerts | **PagerDuty integration on cycle-failure rate** | Real customers, real pages |

### 7.6 Infrastructure

| Today | Production | Why |
|---|---|---|
| Two `node` processes on a laptop | **Vercel** for the Fleet web/API; **Fargate or Fly.io machines** for the Playwright workers (browsers don't fit the serverless cold-start model) | Right tool per workload |
| Manual `node seed.js` | **Terraform-managed RDS + Migrations via Drizzle Kit** | Schema changes are reviewed PRs |
| No CI | **GitHub Actions** running typecheck, test, Playwright integration suite, and deploy | Standard |
| No environments | **Preview deploys per PR** (Vercel does this for free), staging, prod | Standard |
| No secrets | **Doppler or AWS Secrets Manager**; per-tenant ORCA credentials encrypted with envelope encryption (KMS) | Required for SOC2 |

### 7.7 Integrations

| Today | Production | Why |
|---|---|---|
| HRIS = CSV in `fleet/hris/feed.csv` | **Merge.dev** (or **Finch**) HRIS unified API | One integration, every HRIS — Workday, BambooHR, Rippling, ADP, Gusto, etc. |
| No notifications | **Resend / Postmark** for transactional email; **Twilio** for SMS | Employee load notifications, employer summary emails |
| No billing | **Stripe** subscriptions per employer, metered usage for audits | Standard SaaS billing |
| No support | **Linear** for engineering, **Intercom** or **Plain** for customer support, with workflow event hooks | Customer reports a "card not loaded" issue → ticket auto-attaches the relevant `automation_log` rows |

### 7.8 The "Don't Change This" List

A few things in the demo are actually production-correct and should survive the rewrite:

- **The two-mode design** (cycle = submit-and-trust, audit = scrape-on-demand). That's a product insight, not a tech choice.
- **Bulk-everywhere principle.** Whenever ORCA exposes a bulk endpoint, use it. Individual sidebar clicks are reserved for audit and offboard balance scrapes.
- **Roster as Fleet's source of truth** for `autoload_configured`, `monthly_subsidy`, `program_type`. The portal is never authoritative for *intent* — only for *state*.
- **The `load_method` enum** (`bulk` / `manual` / `excluded` with reason) is a clean schema.
- **Approval gates as first-class workflow primitives** for irreversible actions (balance reclaim, bulk Remove Cards).
- **Mock portal as a permanent test fixture.** Even in production, an in-memory mock that mirrors ORCA's contract is the only way to write reliable integration tests without hitting `myorca.com`.

---

## 8. Scheduled Execution and Regression Auditing

The production system has no operator dashboard. Every workflow runs on a schedule, and a dedicated Playwright auditor runs alongside it to catch portal changes before they break a real cycle.

### 8.1 Scheduler-Driven Workflows

The demo's click-to-run model is an interview artifact. In production, workflows are triggered by events and schedules, not buttons:

| Workflow | Trigger | Schedule |
|---|---|---|
| Monthly cycle (Choice) | Cron | 1st business day of month |
| Monthly cycle (Passport) | Cron | 1st business day of month |
| Onboard new hires | HRIS webhook (new employee event) | Event-driven, batched daily |
| Offboard terminations | HRIS webhook (termination event) | Event-driven, batched daily |
| Balance audit | Cron | Weekly sample (10 cards), monthly full |

Temporal schedules (or GitHub Actions cron for a simpler stack) replace the dashboard's workflow buttons. Approval gates shift from an inline dashboard button to async notifications — Slack message or email with an approve link, plus a configurable timeout that auto-escalates to a manager if no response within N hours.

The "dashboard" that remains is a read-only audit log: a web view of `automation_log` and `load_history` that employers and Fleet ops can query after the fact. It doesn't control anything.

### 8.2 Playwright Regression Auditor

Browser automation's core risk is silent portal changes. ORCA ships a UI update, a selector breaks, and the monthly cycle fails mid-run — or worse, submits to the wrong field. The regression auditor exists to catch this before it matters.

**What it does:**

A standalone Playwright test suite runs on a recurring schedule (daily or weekly) against the real `myorca.com` using a dedicated test employer account. It exercises every interaction path Fleet depends on:

- Login flow and session handling
- Manage Cards page structure: card rows, sidebar, balance element (`#epurse-balance`), search
- Bulk Actions upload flow: file input, type selector, submit, Past Processes confirmation
- Purchase Cards flow: quantity, access type, cart, order completion
- CSV export download: card export link and file format
- Participants page structure

**What it checks:**

Each test asserts that the expected selectors exist, that interactions produce the expected DOM state, and that bulk job processing completes. It does not assert on specific data — it asserts on page structure and interaction contracts.

**What happens on failure:**

A selector miss or interaction failure triggers an alert (PagerDuty / Slack). The alert includes which selector broke, a screenshot of the current page state, and a Playwright trace file. Fleet's on-call engineer updates the selector in `automation/config.js`, runs the auditor again to verify, and deploys before the next scheduled cycle.

**Why this is the highest-leverage investment:**

Every other production risk (DB corruption, workflow crash, network timeout) has standard mitigations. Portal markup changes are the one risk unique to browser automation, and they're guaranteed to happen — ORCA will update their UI. The auditor turns a "cycle failed at 3 AM and we found out at 9 AM" into a "selector drift detected Tuesday, fixed Wednesday, cycle runs Friday."

---

## 9. Concrete Migration Order (If We Were Greenlit Tomorrow)

Phased, each phase shippable on its own:

1. **TypeScript + Postgres + Drizzle** — keep Express, just add types and swap the DB. Removes the inode-orphan class of bug entirely.
2. **Temporal for one workflow (monthly-cycle)** — prove durable workflows on the highest-value path. Gives us replay-from-failure for the cycle that touches the most money.
3. **Headless Playwright on a Browserbase worker pool** — one tenant at a time can run in production, others stay on local.
4. **Auth + per-tenant isolation** — Clerk on the dashboard, encrypted credentials per employer, tenant-scoped queries everywhere.
5. **Eliminate the dashboard — run everything on a scheduler.** The operator dashboard is a demo artifact. In production, monthly cycles and onboard/offboard workflows run on cron (Temporal schedules or a simple GitHub Actions cron), triggered by HRIS change events, not button clicks. Approval gates become async notifications (Slack/email) with a timeout-based auto-escalation. The "dashboard" becomes a read-only audit log, not a control plane.
6. **Playwright regression auditor on a schedule.** A dedicated Playwright test suite runs on a recurring schedule (daily or weekly) against the real `myorca.com` to verify that Fleet's selectors, bulk upload flows, and page structure haven't changed. If ORCA ships a UI update that breaks a selector, the auditor catches it before the next monthly cycle runs — not during it. This is the cheapest insurance against the core risk of browser automation: silent portal changes.
7. **Merge.dev HRIS connector** — replace the CSV input with real HRIS pulls for one design partner.
8. **Observability + alerting + on-call rotation** — the moment we have one real customer's cycle running in prod.

