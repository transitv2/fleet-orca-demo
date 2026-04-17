const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Reset existing databases in-place (DROP all tables) instead of unlinking the
// file. Unlinking orphans the inode for any process that still holds the file
// open (mock-orca/server.js, fleet/server.js read-only proxy), which causes
// silent divergence: writes from the running server land in the orphaned inode
// while the dashboard reads the new file. Dropping tables in-place preserves
// the inode so every open handle sees the reseeded state immediately.
const orcaDbPath = path.join(__dirname, 'mock-orca', 'orca.db');
const fleetDbPath = path.join(__dirname, 'fleet', 'fleet.db');

function dropAllTables(dbPath) {
  if (!fs.existsSync(dbPath)) return;
  const tmp = new Database(dbPath);
  tmp.pragma('foreign_keys = OFF');
  const tables = tmp.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const t of tables) tmp.exec(`DROP TABLE IF EXISTS "${t.name}"`);
  const triggers = tmp.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name NOT LIKE 'sqlite_%'").all();
  for (const t of triggers) tmp.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
  tmp.close();
}
dropAllTables(orcaDbPath);
dropAllTables(fleetDbPath);

// Clean output directory
const outputDir = path.join(__dirname, 'fleet', 'output');
fs.mkdirSync(outputDir, { recursive: true });
for (const f of fs.readdirSync(outputDir)) {
  fs.unlinkSync(path.join(outputDir, f));
}

// ============================================================
// ORCA DATABASE
// ============================================================
const orcaDb = new Database(orcaDbPath);
orcaDb.pragma('journal_mode = WAL');
orcaDb.pragma('foreign_keys = ON');

orcaDb.exec(`
  CREATE TABLE cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printed_card_number TEXT UNIQUE NOT NULL,
    manufacturing_number TEXT,
    participant_id INTEGER,
    status TEXT DEFAULT 'Active',
    lock_reason TEXT,
    access_type TEXT DEFAULT 'Load Only',
    fare_category TEXT DEFAULT 'Adult',
    card_type TEXT DEFAULT 'Physical',
    epurse_balance REAL DEFAULT 0.00,
    pretax_balance REAL DEFAULT 0.00,
    replaced_card_number TEXT,
    group_name TEXT,
    on_business_account INTEGER DEFAULT 1,
    employer_id TEXT DEFAULT 'acme',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (participant_id) REFERENCES participants(id)
  );

  CREATE TRIGGER cards_updated_at AFTER UPDATE ON cards
  BEGIN UPDATE cards SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;

  CREATE TABLE participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier TEXT UNIQUE NOT NULL,
    first_name TEXT,
    last_name TEXT,
    email TEXT,
    phone TEXT,
    group_name TEXT,
    card_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (card_id) REFERENCES cards(id)
  );

  CREATE TRIGGER participants_updated_at AFTER UPDATE ON participants
  BEGIN UPDATE participants SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;

  CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE NOT NULL,
    order_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'Fulfilled',
    quantity INTEGER,
    access_type TEXT,
    total_amount REAL,
    payment_method TEXT DEFAULT 'Credit Card'
  );

  CREATE TABLE order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    card_id INTEGER NOT NULL,
    product TEXT,
    amount REAL,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (card_id) REFERENCES cards(id)
  );

  CREATE TABLE autoloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    trigger_day INTEGER,
    trigger_balance REAL,
    load_amount REAL NOT NULL,
    payment_source TEXT DEFAULT 'Primary Credit Card',
    status TEXT DEFAULT 'Active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (card_id) REFERENCES cards(id)
  );

  CREATE TRIGGER autoloads_updated_at AFTER UPDATE ON autoloads
  BEGIN UPDATE autoloads SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;

  CREATE TABLE bulk_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type TEXT NOT NULL,
    file_name TEXT,
    card_count INTEGER,
    status TEXT DEFAULT 'Processing',
    employer_id TEXT DEFAULT 'acme',
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE passes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    product TEXT NOT NULL,
    status TEXT DEFAULT 'Active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (card_id) REFERENCES cards(id)
  );

  CREATE TRIGGER passes_updated_at AFTER UPDATE ON passes
  BEGIN UPDATE passes SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
`);

// ---- Insert Cards ----
// Cards are inserted WITHOUT participant_id first. We link after participants are created.

const insertCard = orcaDb.prepare(`
  INSERT INTO cards (printed_card_number, manufacturing_number, status, lock_reason, access_type,
    fare_category, card_type, epurse_balance, pretax_balance, replaced_card_number, group_name, on_business_account, employer_id)
  VALUES (?, ?, ?, ?, ?, 'Adult', 'Physical', ?, 0.00, ?, ?, ?, ?)
`);

// ============================================================
// Standard Active Cards (200) — auto-generated with realistic names
// ============================================================
const ACME_NAMES = [
  'Aaron Bennett','Abigail Clark','Adam Fischer','Adriana Vega','Aidan Murphy','Alex Russo','Alicia Moore','Allison Brooks',
  'Alonzo Reed','Amber Price','Amelia Ross','Anders Berg','Angela Lopez','Anna Romero','Antonio Rivera','April Jenkins',
  'Ariana Cole','Ashton Hill','Audrey Stone','Austin Ward','Ava Bailey','Barbara Shaw','Beatrice Webb','Ben Hughes',
  'Benjamin Park','Bianca Long','Blake Hunter','Brandon Foster','Brayden Scott','Brenda Peters','Brendan Vasquez','Bridget Carr',
  'Brooke Harper','Bruce Warren','Bryan Kennedy','Caleb Wheeler','Camila Bishop','Cameron Ortiz','Carl Sullivan','Caroline Black',
  'Carter Morgan','Catalina Perez','Catherine Dean','Cedric Owens','Celeste Lynch','Chad Warner','Charlotte Hayes','Chelsea Barnes',
  'Chloe Day','Christian Banks','Cindy Tran','Clara Dixon','Clark Fields','Claudia Burns','Clinton Alvarez','Colin Gardner',
  'Connor Walsh','Courtney Dean','Craig Meyer','Crystal Holt','Curtis Hicks','Cynthia Todd','Dakota Pratt','Damien Rose',
  'Danielle Chase','Darius Moss','Dawn Briggs','Dean Mills','Denise Cox','Derek Lang','Devin Flores','Dominic Price',
  'Dorothy Fisher','Douglas Reese','Drew Chapman','Dylan Graves','Eleanor Frost','Elena Bauer','Elijah Bates','Elise Cruz',
  'Ellen Stafford','Elliot Sharp','Emerson Pope','Emilio Snyder','Emma Patel','Ethan Hart','Eugene Wade','Evangeline Kim',
  'Evelyn Rios','Ezra Holmes','Felix Burton','Fernando Silva','Fiona Chan','Finn Dalton','Frances Lowe','Frank Woods',
  'Gabriel Nash','Gabriella Lane','Gavin Boyd','Genevieve Hale','George Sims','Georgia Todd','Gianna Conway','Giovanni Cross',
  'Gloria Horn','Grace Valdez','Grant Decker','Gregory Hale','Hailey Knox','Haley Brewer','Hannah Fox','Harold Reyes',
  'Harrison Ball','Hazel Estes','Heather Prince','Hector Vance','Helen Frye','Henry Chan','Holly Kramer','Hope Doyle',
  'Hudson Park','Hunter Powell','Ian Morales','Ingrid Craig','Irene Baxter','Isaac Webster','Isabel Haynes','Ivan Soto',
  'Jack Holloway','Jackson Nash','Jacob Bryant','Jada Wallace','Jade Sandoval','Jake Rhodes','James Noble','Jamie Marsh',
  'Jane Walters','Jared Finch','Jasmine Hall','Jason Lam','Jay Whitney','Jayden Pope','Jenna Drake','Jeremy Chan',
  'Jerome Fuller','Jillian Glenn','Joanna Rivas','Jocelyn Hess','Joel Bradford','Jonah Pike','Jordan Lake','Joshua Fields',
  'Josie Simmons','Journey Blake','Judith Hines','Judy Barker','Julia Cho','Julian Ortega','June Spencer','Justin Lamb',
  'Kai Anderson','Kaitlyn Dow','Karen Burke','Katherine Daly','Kayla Rosen','Keith Prince','Kenneth Yates','Khalid Wise',
  'Kimberly Allen','Kira Holden','Kyle Burch','Lana Flynn','Larry Quinn','Laura Stein','Leah Barrera','Leon Beck',
  'Leona Gage','Levi Ortiz','Liam Benson','Lila Mercer','Lily Duke','Lincoln Vogel','Linda Rush','Logan Mosley',
  'Lola Chan','Lorenzo Knox','Louis Lawson','Lucas Hardy','Lucy Hawkins','Luke Ferris','Luna Rowe','Madeline Pacheco',
  'Madison Tate','Maggie Clay','Malcolm Bond','Maria Cruz','Mariah Fisher','Marie Briggs','Mark Stafford','Martin Rojas','Mason Kelly'
];
// We need exactly 200; the list above has 200+. Trim to first 200.

const GROUPS = ['HQ', 'Bellevue', 'Redmond', 'Tacoma'];

const standardCards = [];
for (let i = 0; i < 200; i++) {
  const csn = '98400102500' + String(10001 + i).padStart(5, '0');
  const name = ACME_NAMES[i];
  const bal = Math.round(Math.random() * 35000) / 100; // $0.00 to $350.00
  const grp = GROUPS[i % GROUPS.length];
  standardCards.push({ csn, name, bal, grp });
}

// ============================================================
// No-Autoload Exception Cards (12) — needs standard $50 load
// ============================================================
const noAutoloadCards = [
  { csn: '9840010250010201', name: 'Kevin Cho',        bal: 75.00,  grp: 'Bellevue' },
  { csn: '9840010250010202', name: 'Sam Okafor',       bal: 275.00, grp: 'Bellevue' },
  { csn: '9840010250010203', name: 'Elena Dragomir',   bal: 0.00,   grp: 'HQ' },
  { csn: '9840010250010204', name: 'Raj Kapoor',       bal: 0.00,   grp: 'Redmond' },  // missing email
  { csn: '9840010250010205', name: 'Nora Eriksson',    bal: 125.00, grp: 'Tacoma' },
  { csn: '9840010250010206', name: 'Andre Novak',      bal: 310.00, grp: 'HQ' },
  { csn: '9840010250010207', name: 'Diana Osei',       bal: 200.00, grp: 'Bellevue' },
  { csn: '9840010250010208', name: 'Liam Chandra',     bal: 88.00,  grp: 'Redmond' },
  { csn: '9840010250010209', name: 'Rosa Gutierrez',   bal: 155.00, grp: 'Tacoma' },
  { csn: '9840010250010210', name: 'Tariq Hassan',     bal: 60.00,  grp: 'HQ' },
  { csn: '9840010250010211', name: 'Mei Tanaka',       bal: 340.00, grp: 'Bellevue' },
  { csn: '9840010250010212', name: 'Victor Okafor',    bal: 45.00,  grp: 'Redmond' },
];

// ============================================================
// No-Autoload Near/At Cap (6) — partial or zero loads
// ============================================================
const nearCapCards = [
  { csn: '9840010250010213', name: 'Sandra Volkov',    bal: 385.00, grp: 'HQ' },
  { csn: '9840010250010214', name: 'Tanya Volkov',     bal: 370.00, grp: 'HQ' },
  { csn: '9840010250010215', name: 'Kai Lindgren',     bal: 399.00, grp: 'Bellevue' },
  { csn: '9840010250010216', name: 'Marco Bianchi',    bal: 395.00, grp: 'Tacoma' },
  { csn: '9840010250010217', name: 'Lisa Nguyen',      bal: 400.00, grp: 'Bellevue' },
  { csn: '9840010250010218', name: 'Ingrid Larsson',   bal: 400.00, grp: 'Redmond' },
];

// ============================================================
// Retroactive (4)
// ============================================================
const retroactiveCards = [
  { csn: '9840010250010219', name: 'Greg Hoffman',     bal: 190.00, grp: 'Bellevue' },
  { csn: '9840010250010220', name: 'Amara Diallo',     bal: 250.00, grp: 'HQ' },
  { csn: '9840010250010221', name: 'Hana Yoshida',     bal: 350.00, grp: 'Tacoma' },
  { csn: '9840010250010222', name: 'Erik Johansson',   bal: 380.00, grp: 'Redmond' },
];

// ============================================================
// Terminated — Already Locked (3)
// ============================================================
const terminatedLockedCards = [
  { csn: '9840010250010223', name: 'David Park',       bal: 50.00, grp: 'HQ',      lockReason: 'Business Exclusive' },
  { csn: '9840010250010224', name: 'Carlos Mendez',    bal: 25.00, grp: 'Bellevue', lockReason: 'Lost' },
  { csn: '9840010250010225', name: 'Sarah Mitchell',   bal: 0.00,  grp: 'Redmond', lockReason: 'Business Exclusive' },
];

// ============================================================
// Terminated — Not Yet Locked (4)
// ============================================================
const terminatedActiveCards = [
  { csn: '9840010250010226', name: "James O'Connor",   bal: 120.00, grp: 'Tacoma' },
  { csn: '9840010250010227', name: 'Priya Nair',       bal: 0.00,   grp: 'HQ' },
  { csn: '9840010250010228', name: 'Lucas Ferreira',   bal: 75.50,  grp: 'Bellevue' },
  { csn: '9840010250010229', name: 'Nina Petrovic',    bal: 400.00, grp: 'Redmond' },
];

// ============================================================
// Going On Leave (3) — cards 230, 231 have autoloads; 232 doesn't
// ============================================================
const leaveCards = [
  { csn: '9840010250010230', name: 'Olga Svensson',    bal: 180.00, grp: 'HQ',       hasAutoload: true },
  { csn: '9840010250010231', name: 'Julia Moreno',     bal: 95.00,  grp: 'Bellevue', hasAutoload: true },
  { csn: '9840010250010232', name: 'Chen Wei',         bal: 60.00,  grp: 'Tacoma',   hasAutoload: false },
];

// ============================================================
// Returning From Leave (3) — currently Locked; 233/234 have paused autoloads; 235 doesn't
// ============================================================
const returnCards = [
  { csn: '9840010250010233', name: 'Maria Silva',      bal: 80.00,  grp: 'HQ',       hasAutoload: true,  autoloadStatus: 'Paused' },
  { csn: '9840010250010234', name: 'Emma Larsen',      bal: 200.00, grp: 'Bellevue', hasAutoload: true,  autoloadStatus: 'Paused' },
  { csn: '9840010250010235', name: 'Kenji Watanabe',   bal: 0.00,   grp: 'Redmond',  hasAutoload: false },
];

// ============================================================
// Replaced Card Pairs (4 pairs = 8 cards) — old card Replaced, new card Active with ReplacedCardPrintedNumber
// ============================================================
const replacedPairs = [
  // { oldCsn, newCsn, name, newBal, grp }
  { oldCsn: '9840010250010236', newCsn: '9840010250010237', name: 'Jake Morrison',  newBal: 100.00, grp: 'HQ' },
  { oldCsn: '9840010250010238', newCsn: '9840010250010239', name: 'Aiko Suzuki',    newBal: 150.00, grp: 'Bellevue' },
  { oldCsn: '9840010250010240', newCsn: '9840010250010241', name: 'Omar Abdulahi',  newBal: 75.00,  grp: 'Tacoma' },
  { oldCsn: '9840010250010242', newCsn: '9840010250010243', name: 'Leila Mahmoud',  newBal: 220.00, grp: 'Redmond' },
];

// ============================================================
// Duplicate Active Cards (3 sets = 6 cards) — same name on 2 Active cards, different groups
// ============================================================
const duplicateSets = [
  // { csnA, csnB, name, balA, balB, grpA, grpB, autoloadA (true=active), autoloadB (false) }
  { csnA: '9840010250010244', csnB: '9840010250010245', name: 'Aisha Ibrahim', balA: 200.00, balB: 150.00, grpA: 'HQ',      grpB: 'Bellevue' },
  { csnA: '9840010250010246', csnB: '9840010250010247', name: 'Tomás Herrera', balA: 90.00,  balB: 60.00,  grpA: 'Tacoma',  grpB: 'HQ' },
  { csnA: '9840010250010248', csnB: '9840010250010249', name: 'Zara Khan',     balA: 300.00, balB: 110.00, grpA: 'Redmond', grpB: 'Bellevue' },
];

// ============================================================
// Negative Balance (hidden) (2) — autoloaded cards Fleet can't see are negative
// ============================================================
const negativeBalanceCards = [
  { csn: '9840010250010250', name: 'Yuki Tanaka',  bal: -5.00,   grp: 'Bellevue' },
  { csn: '9840010250010251', name: 'Damian Osei',  bal: -12.75,  grp: 'HQ' },
];

// Off-account card (kept for legacy)
const offAccountCard = { csn: '9840010250010900', name: 'Legacy Off-Account', bal: 0.00, grp: null };

// Unassigned inventory
const unassignedCards = [
  { csn: '9840010250010901', bal: 0.00 },
  { csn: '9840010250010902', bal: 0.00 },
];

let mfgNum = 1001;

// Insert 200 standard cards (Active, autoload on)
for (const c of standardCards) {
  insertCard.run(c.csn, `MFG-${mfgNum++}`, 'Active', null, 'Load Only', c.bal, null, c.grp, 1, 'acme');
}

// Insert 12 no-autoload cards (Active)
for (const c of noAutoloadCards) {
  insertCard.run(c.csn, `MFG-${mfgNum++}`, 'Active', null, 'Load Only', c.bal, null, c.grp, 1, 'acme');
}

// Insert 6 near/at cap cards (Active)
for (const c of nearCapCards) {
  insertCard.run(c.csn, `MFG-${mfgNum++}`, 'Active', null, 'Load Only', c.bal, null, c.grp, 1, 'acme');
}

// Insert 4 retroactive cards (Active)
for (const c of retroactiveCards) {
  insertCard.run(c.csn, `MFG-${mfgNum++}`, 'Active', null, 'Load Only', c.bal, null, c.grp, 1, 'acme');
}

// Insert 3 terminated locked cards (Locked)
for (const c of terminatedLockedCards) {
  insertCard.run(c.csn, `MFG-${mfgNum++}`, 'Locked', c.lockReason, 'Load Only', c.bal, null, c.grp, 1, 'acme');
}

// Insert 4 terminated not-yet-locked cards (Active)
for (const c of terminatedActiveCards) {
  insertCard.run(c.csn, `MFG-${mfgNum++}`, 'Active', null, 'Load Only', c.bal, null, c.grp, 1, 'acme');
}

// Insert 3 going-on-leave cards (Active)
for (const c of leaveCards) {
  insertCard.run(c.csn, `MFG-${mfgNum++}`, 'Active', null, 'Load Only', c.bal, null, c.grp, 1, 'acme');
}

// Insert 3 returning-from-leave cards (Locked — currently on leave)
for (const c of returnCards) {
  insertCard.run(c.csn, `MFG-${mfgNum++}`, 'Locked', 'Business Exclusive', 'Load Only', c.bal, null, c.grp, 1, 'acme');
}

// Insert 8 replaced card pairs (4 Replaced + 4 Active with ReplacedCardPrintedNumber)
for (const pair of replacedPairs) {
  insertCard.run(pair.oldCsn, `MFG-${mfgNum++}`, 'Replaced', null, 'Load Only', 0.00, null, pair.grp, 1, 'acme');
  insertCard.run(pair.newCsn, `MFG-${mfgNum++}`, 'Active', null, 'Load Only', pair.newBal, pair.oldCsn, pair.grp, 1, 'acme');
}

// Insert 6 duplicate active cards (3 sets of 2)
for (const dup of duplicateSets) {
  insertCard.run(dup.csnA, `MFG-${mfgNum++}`, 'Active', null, 'Load Only', dup.balA, null, dup.grpA, 1, 'acme');
  insertCard.run(dup.csnB, `MFG-${mfgNum++}`, 'Active', null, 'Load Only', dup.balB, null, dup.grpB, 1, 'acme');
}

// Insert 2 negative balance cards (Active with hidden negative balance)
for (const c of negativeBalanceCards) {
  insertCard.run(c.csn, `MFG-${mfgNum++}`, 'Active', null, 'Load Only', c.bal, null, c.grp, 1, 'acme');
}

// Off-account card (legacy placeholder, kept for historical compatibility)
insertCard.run(offAccountCard.csn, `MFG-${mfgNum++}`, 'Active', null, 'Full Access', offAccountCard.bal, null, null, 0, 'acme');

// Unassigned inventory
for (const c of unassignedCards) {
  insertCard.run(c.csn, `MFG-${mfgNum++}`, 'Active', null, 'Load Only', c.bal, null, null, 1, 'acme');
}

// ---- 30 Existing Employee Cards (NOT on business account) ----
const existingEmployeeCards = [
  { csn: '9840010250012001', name: 'Fatima Al-Rashid',  bal: 30.00 },
  { csn: '9840010250012002', name: 'Victor Okafor',     bal: 15.00 },
  { csn: '9840010250012003', name: 'Nina Petrovic',     bal: 0.00 },
  { csn: '9840010250012004', name: 'Liam Chandra',      bal: 85.00 },
  { csn: '9840010250012005', name: 'Rosa Gutierrez',    bal: 120.00 },
  { csn: '9840010250012006', name: 'Andre Novak',       bal: 45.00 },
  { csn: '9840010250012007', name: 'Mei Tanaka',        bal: 200.00 },
  { csn: '9840010250012008', name: 'Olga Svensson',     bal: 10.00 },
  { csn: '9840010250012009', name: 'Tariq Hassan',      bal: 60.00 },
  { csn: '9840010250012010', name: 'Julia Moreno',      bal: 0.00 },
  { csn: '9840010250012011', name: 'Kenji Watanabe',    bal: 175.00 },
  { csn: '9840010250012012', name: 'Anya Kowalczyk',    bal: 95.00 },
  { csn: '9840010250012013', name: 'Damian Osei',       bal: 50.00 },
  { csn: '9840010250012014', name: 'Ingrid Larsson',    bal: 140.00 },
  { csn: '9840010250012015', name: 'Ravi Deshmukh',     bal: 0.00 },
  { csn: '9840010250012016', name: 'Sofia Andersson',   bal: 220.00 },
  { csn: '9840010250012017', name: 'Marco Bianchi',     bal: 35.00 },
  { csn: '9840010250012018', name: 'Chen Wei',          bal: 165.00 },
  { csn: '9840010250012019', name: 'Amara Diallo',      bal: 75.00 },
  { csn: '9840010250012020', name: 'Erik Johansson',    bal: 110.00 },
  { csn: '9840010250012021', name: 'Priya Nair',        bal: 0.00 },
  { csn: '9840010250012022', name: 'Lucas Ferreira',    bal: 190.00 },
  { csn: '9840010250012023', name: 'Hana Yoshida',      bal: 55.00 },
  { csn: '9840010250012024', name: 'Omar Abdulahi',     bal: 80.00 },
  { csn: '9840010250012025', name: 'Zara Khan',         bal: 130.00 },
  { csn: '9840010250012026', name: 'Ivan Volkov',       bal: 25.00 },
  { csn: '9840010250012027', name: 'Leila Mahmoud',     bal: 100.00 },
  { csn: '9840010250012028', name: 'Tomas Herrera',     bal: 150.00 },
  { csn: '9840010250012029', name: 'Aiko Suzuki',       bal: 40.00 },
  { csn: '9840010250012030', name: 'Nadia Popov',       bal: 70.00 },
];

for (const c of existingEmployeeCards) {
  insertCard.run(c.csn, `MFG-${mfgNum++}`, 'Active', null, 'Load Only', c.bal, null, null, 0, 'acme');
}

// ============================================================
// MTA (Metro Transit Authority) - Passport Program - 22 Cards
// ============================================================

const mtaStandardCards = [
  { csn: '9840010250021001', name: 'Angela Torres',      bal: 0.00,   grp: 'Downtown', hasPassport: true },
  { csn: '9840010250021002', name: 'Robert Chang',       bal: 0.00,   grp: 'Downtown', hasPassport: true },
  { csn: '9840010250021003', name: 'Michelle Okafor',    bal: 0.00,   grp: 'Downtown', hasPassport: true },
  { csn: '9840010250021004', name: 'Steven Nakamura',    bal: 0.00,   grp: 'Eastside', hasPassport: true },
  { csn: '9840010250021005', name: 'Patricia Johansson', bal: 0.00,   grp: 'Eastside', hasPassport: true },
  { csn: '9840010250021006', name: 'William Patel',      bal: 0.00,   grp: 'Downtown', hasPassport: true },
  { csn: '9840010250021007', name: 'Jennifer Schmidt',   bal: 0.00,   grp: 'Eastside', hasPassport: true },
  { csn: '9840010250021008', name: 'David Kowalski',     bal: 0.00,   grp: 'Downtown', hasPassport: true },
  { csn: '9840010250021009', name: 'Linda Hassan',       bal: 0.00,   grp: 'Eastside', hasPassport: true },
  { csn: '9840010250021010', name: 'Richard Svensson',   bal: 0.00,   grp: 'Downtown', hasPassport: true },
  { csn: '9840010250021011', name: 'Karen Morales',      bal: 0.00,   grp: 'Eastside', hasPassport: true },
  { csn: '9840010250021012', name: 'Daniel Fitzgerald',  bal: 0.00,   grp: 'Downtown', hasPassport: true },
];

const mtaEdgeCards = [
  { csn: '9840010250021013', name: 'Carlos Rivera',     bal: -12.50, grp: 'Downtown', status: 'Active',   lockReason: null,                hasPassport: false }, // MISSING PASSPORT
  { csn: '9840010250021014', name: 'Yuki Tanaka',       bal: -3.75,  grp: 'Eastside', status: 'Active',   lockReason: null,                hasPassport: false }, // MISSING PASSPORT
  { csn: '9840010250021015', name: 'Sarah Mitchell',    bal: 0.00,   grp: 'Downtown', status: 'Locked',   lockReason: 'Business Exclusive', hasPassport: true },  // TERMINATED
  { csn: '9840010250021016', name: "James O'Connor",    bal: 0.00,   grp: 'Eastside', status: 'Active',   lockReason: null,                hasPassport: true },  // TERMINATED (not locked)
  { csn: '9840010250021017', name: 'Emma Larsen',       bal: 0.00,   grp: 'Downtown', status: 'Locked',   lockReason: 'Business Exclusive', hasPassport: true },  // ON LEAVE
  { csn: '9840010250021018', name: 'Marco DiStefano',   bal: 0.00,   grp: 'Eastside', status: 'Active',   lockReason: null,                hasPassport: true },  // WORKSITE TRANSFER
  { csn: '9840010250021019', name: 'Aisha Mohammed',    bal: 0.00,   grp: 'Downtown', status: 'Replaced', lockReason: null,                hasPassport: false, replaced: null },
  { csn: '9840010250021020', name: 'Aisha Mohammed',    bal: 0.00,   grp: 'Downtown', status: 'Active',   lockReason: null,                hasPassport: true,  replaced: '9840010250021019' },
];

const mtaUnassignedCards = [
  { csn: '9840010250021021' },
  { csn: '9840010250021022' },
];

// Insert MTA standard cards (Full Access)
for (const c of mtaStandardCards) {
  insertCard.run(c.csn, `MFG-${mfgNum++}`, 'Active', null, 'Full Access', c.bal, null, c.grp, 1, 'mta');
}

// Insert MTA edge case cards
for (const c of mtaEdgeCards) {
  insertCard.run(c.csn, `MFG-${mfgNum++}`, c.status, c.lockReason, 'Full Access', c.bal, c.replaced || null, c.grp, 1, 'mta');
}

// MTA unassigned inventory
for (const c of mtaUnassignedCards) {
  insertCard.run(c.csn, `MFG-${mfgNum++}`, 'Active', null, 'Full Access', 0.00, null, null, 1, 'mta');
}

// Insert Passport passes for MTA cards that have them
const insertPass = orcaDb.prepare(`
  INSERT INTO passes (card_id, product, status) VALUES (?, 'Regional Business Passport', 'Active')
`);

const allMtaCards = [...mtaStandardCards, ...mtaEdgeCards];
for (const c of allMtaCards) {
  if (c.hasPassport && c.status !== 'Replaced') {
    const card = orcaDb.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(c.csn);
    if (card) insertPass.run(card.id);
  }
}

// ---- Insert Participants ----
// One per assigned card (exclude replaced old card #38, off-account #42, unassigned #43-44)
const insertParticipant = orcaDb.prepare(`
  INSERT INTO participants (identifier, first_name, last_name, email, phone, group_name, card_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// Build unified list of Acme assigned cards for participant creation
// Note: replaced-old cards and unassigned inventory are skipped (no participants)
function makeEmail(name) {
  if (name === 'Raj Kapoor') return null; // Raj Kapoor has no email (edge case)
  const parts = name.split(' ');
  const first = parts[0].toLowerCase().replace(/[^a-z]/g, '');
  const last = parts.slice(1).join('').toLowerCase().replace(/[^a-z]/g, '');
  return `${first[0]}${last}@acme.com`;
}

function insertParticipantForCard(csn, name, grp) {
  const card = orcaDb.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(csn);
  if (!card) return;
  const parts = name.split(' ');
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ');
  const email = makeEmail(name);
  const result = insertParticipant.run(csn, firstName, lastName, email, null, grp, card.id);
  orcaDb.prepare('UPDATE cards SET participant_id = ? WHERE id = ?').run(result.lastInsertRowid, card.id);
}

// 200 standard
for (const c of standardCards) insertParticipantForCard(c.csn, c.name, c.grp);
// 12 no-autoload
for (const c of noAutoloadCards) insertParticipantForCard(c.csn, c.name, c.grp);
// 6 near-cap
for (const c of nearCapCards) insertParticipantForCard(c.csn, c.name, c.grp);
// 4 retroactive
for (const c of retroactiveCards) insertParticipantForCard(c.csn, c.name, c.grp);
// 3 terminated locked
for (const c of terminatedLockedCards) insertParticipantForCard(c.csn, c.name, c.grp);
// 4 terminated active
for (const c of terminatedActiveCards) insertParticipantForCard(c.csn, c.name, c.grp);
// 3 leave
for (const c of leaveCards) insertParticipantForCard(c.csn, c.name, c.grp);
// 3 return from leave
for (const c of returnCards) insertParticipantForCard(c.csn, c.name, c.grp);
// Replaced pairs: only NEW card gets a participant (old is Replaced, no participant)
for (const pair of replacedPairs) insertParticipantForCard(pair.newCsn, pair.name, pair.grp);
// Duplicate sets: both cards get participants with unique identifiers (CSN-based)
for (const dup of duplicateSets) {
  insertParticipantForCard(dup.csnA, dup.name, dup.grpA);
  insertParticipantForCard(dup.csnB, dup.name, dup.grpB);
}
// Negative balance hidden
for (const c of negativeBalanceCards) insertParticipantForCard(c.csn, c.name, c.grp);

// MTA Participants (skip Aisha replaced old card ...1019)
const mtaEmailMap = {
  'Angela Torres': 'atorres@mta.gov', 'Robert Chang': 'rchang@mta.gov', 'Michelle Okafor': 'mokafor@mta.gov',
  'Steven Nakamura': 'snakamura@mta.gov', 'Patricia Johansson': 'pjohansson@mta.gov', 'William Patel': 'wpatel@mta.gov',
  'Jennifer Schmidt': 'jschmidt@mta.gov', 'David Kowalski': 'dkowalski@mta.gov', 'Linda Hassan': 'lhassan@mta.gov',
  'Richard Svensson': 'rsvensson@mta.gov', 'Karen Morales': 'kmorales@mta.gov', 'Daniel Fitzgerald': 'dfitzgerald@mta.gov',
  'Carlos Rivera': 'crivera@mta.gov', 'Yuki Tanaka': 'ytanaka@mta.gov', 'Sarah Mitchell': 'smitchell@mta.gov',
  "James O'Connor": 'joconnor@mta.gov', 'Emma Larsen': 'elarsen@mta.gov', 'Marco DiStefano': 'mdistefano@mta.gov',
  'Aisha Mohammed': 'amohammed@mta.gov',
};

for (const c of allMtaCards) {
  // Skip the replaced old card
  if (c.csn === '9840010250021019') continue;

  const [firstName, ...lastParts] = c.name.split(' ');
  const lastName = lastParts.join(' ');
  const card = orcaDb.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(c.csn);
  const email = mtaEmailMap[c.name] || null;

  const participantResult = insertParticipant.run(c.csn, firstName, lastName, email, null, c.grp, card.id);
  orcaDb.prepare('UPDATE cards SET participant_id = ? WHERE id = ?').run(participantResult.lastInsertRowid, card.id);
}

// ---- Insert Autoloads ----
const insertAutoload = orcaDb.prepare(`
  INSERT INTO autoloads (card_id, type, trigger_day, trigger_balance, load_amount, payment_source, status)
  VALUES (?, 'time', 1, NULL, 50.00, 'Primary Credit Card', ?)
`);

// Active autoloads for 200 standard cards
for (const c of standardCards) {
  const card = orcaDb.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(c.csn);
  insertAutoload.run(card.id, 'Active');
}

// Going-on-leave cards 230, 231 have Active autoloads; 232 does not
const card230 = orcaDb.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get('9840010250010230');
const card231 = orcaDb.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get('9840010250010231');
insertAutoload.run(card230.id, 'Active');
insertAutoload.run(card231.id, 'Active');

// Return-from-leave cards 233, 234 have Paused autoloads; 235 has none
const card233 = orcaDb.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get('9840010250010233');
const card234 = orcaDb.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get('9840010250010234');
insertAutoload.run(card233.id, 'Paused');
insertAutoload.run(card234.id, 'Paused');

// Terminated-locked card 223 (David Park) has paused autoload; 224, 225 do not
const card223 = orcaDb.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get('9840010250010223');
insertAutoload.run(card223.id, 'Paused');

// Replaced-pair NEW cards (237, 239, 241, 243) have Active autoloads
for (const pair of replacedPairs) {
  const newCard = orcaDb.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(pair.newCsn);
  insertAutoload.run(newCard.id, 'Active');
}

// Duplicate "primary" cards (A) have Active autoloads; B cards do not
for (const dup of duplicateSets) {
  const primaryCard = orcaDb.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(dup.csnA);
  insertAutoload.run(primaryCard.id, 'Active');
}

// Negative balance hidden cards (250, 251) have Active autoloads — that's why Fleet doesn't scrape them
for (const c of negativeBalanceCards) {
  const card = orcaDb.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(c.csn);
  insertAutoload.run(card.id, 'Active');
}

// Terminated-not-yet-locked cards 226, 228, 229 have Active autoloads (THE MONEY LEAK RISK)
// Card 227 (Priya Nair) has no autoload — nothing to pause
for (const csn of ['9840010250010226', '9840010250010228', '9840010250010229']) {
  const card = orcaDb.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(csn);
  insertAutoload.run(card.id, 'Active');
}

// Retroactive cards 221 (Hana Yoshida), 222 (Erik Johansson) have Active autoloads
// Fleet only needs to add $50 extra (autoload handles the base $50)
// Cards 219, 220 (Greg Hoffman, Amara Diallo) have no autoload — Fleet must load full $100
for (const csn of ['9840010250010221', '9840010250010222']) {
  const card = orcaDb.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(csn);
  insertAutoload.run(card.id, 'Active');
}

// ---- Insert Historical Order ----
orcaDb.prepare(`
  INSERT INTO orders (order_number, order_date, status, quantity, access_type, total_amount, payment_method)
  VALUES ('ON202603-001234', '2026-03-15', 'Fulfilled', 251, 'Load Only', 753.00, 'Credit Card')
`).run();

const order = orcaDb.prepare('SELECT id FROM orders WHERE order_number = ?').get('ON202603-001234');
const insertOrderItem = orcaDb.prepare(`
  INSERT INTO order_items (order_id, card_id, product, amount) VALUES (?, ?, 'Adult ORCA Card', 3.00)
`);

// Link all Acme business-account cards (on_business_account = 1) to the historical order
const allBusinessCards = orcaDb.prepare(
  "SELECT id FROM cards WHERE employer_id = 'acme' AND on_business_account = 1 AND printed_card_number NOT IN ('9840010250010901','9840010250010902')"
).all();
for (const card of allBusinessCards) {
  insertOrderItem.run(order.id, card.id);
}

// ---- Historical MTA Order ----
orcaDb.prepare(`
  INSERT INTO orders (order_number, order_date, status, quantity, access_type, total_amount, payment_method)
  VALUES ('ON202602-009876', '2026-02-10', 'Fulfilled', 22, 'Full Access', 66.00, 'Credit Card')
`).run();

const mtaOrder = orcaDb.prepare('SELECT id FROM orders WHERE order_number = ?').get('ON202602-009876');
const allMtaBusinessCards = orcaDb.prepare("SELECT id FROM cards WHERE employer_id = 'mta'").all();
for (const card of allMtaBusinessCards) {
  insertOrderItem.run(mtaOrder.id, card.id);
}

// ---- Insert Historical Bulk Jobs ----
orcaDb.prepare(`
  INSERT INTO bulk_jobs (job_type, file_name, card_count, status, employer_id, submitted_at, completed_at)
  VALUES ('Add Participants', 'initial_participants.csv', 40, 'Completed', 'acme', '2026-03-15 10:00:00', '2026-03-15 10:01:00')
`).run();

orcaDb.prepare(`
  INSERT INTO bulk_jobs (job_type, file_name, card_count, status, employer_id, submitted_at, completed_at)
  VALUES ('Add Participants', 'mta_initial.csv', 19, 'Completed', 'mta', '2026-02-10 11:00:00', '2026-02-10 11:02:00')
`).run();

console.log(`ORCA DB seeded: ${orcaDb.prepare('SELECT COUNT(*) as c FROM cards').get().c} cards, ` +
  `${orcaDb.prepare('SELECT COUNT(*) as c FROM participants').get().c} participants, ` +
  `${orcaDb.prepare('SELECT COUNT(*) as c FROM autoloads').get().c} autoloads`);

orcaDb.close();

// ============================================================
// FLEET DATABASE
// ============================================================
const fleetDb = new Database(fleetDbPath);
fleetDb.pragma('journal_mode = WAL');
fleetDb.pragma('foreign_keys = ON');

fleetDb.exec(`
  CREATE TABLE roster (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_name TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    email TEXT,
    location TEXT,
    program_type TEXT NOT NULL,
    card_csn TEXT,
    identifier TEXT,
    access_level TEXT,
    autoload_configured INTEGER DEFAULT 0,
    monthly_subsidy REAL DEFAULT 50.00,
    current_balance REAL,
    balance_updated_at DATETIME,
    has_passport_verified INTEGER DEFAULT 0,
    employer_id TEXT DEFAULT 'acme',
    status TEXT DEFAULT 'Active',
    onboard_date DATE,
    offboard_date DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TRIGGER roster_updated_at AFTER UPDATE ON roster
  BEGIN UPDATE roster SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;

  CREATE TABLE load_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    employee_name TEXT,
    card_csn TEXT NOT NULL,
    cycle_month TEXT NOT NULL,
    base_amount REAL,
    retroactive_amount REAL DEFAULT 0,
    submitted_amount REAL,
    load_method TEXT,
    exclusion_reason TEXT,
    status TEXT DEFAULT 'submitted',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TRIGGER load_history_updated_at AFTER UPDATE ON load_history
  BEGIN UPDATE load_history SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;

  CREATE TABLE automation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow TEXT NOT NULL,
    step_name TEXT NOT NULL,
    step_type TEXT NOT NULL,
    detail TEXT,
    status TEXT DEFAULT 'running',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE employer_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employer_id TEXT NOT NULL DEFAULT 'acme',
    employer_name TEXT NOT NULL,
    program_type TEXT NOT NULL,
    monthly_subsidy REAL DEFAULT 50.00,
    epurse_cap REAL DEFAULT 400.00,
    retroactive_months INTEGER DEFAULT 1,
    balance_transfer_policy TEXT DEFAULT 'reclaim',
    orca_username TEXT,
    orca_password TEXT
  );

  CREATE TABLE audit_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employer_id TEXT DEFAULT 'acme',
    count_requested TEXT,
    cards_scraped INTEGER DEFAULT 0,
    cards_total INTEGER,
    healthy_count INTEGER DEFAULT 0,
    at_cap_count INTEGER DEFAULT 0,
    negative_balance_count INTEGER DEFAULT 0,
    near_cap_count INTEGER DEFAULT 0,
    projected_spend REAL DEFAULT 0,
    actual_spend REAL DEFAULT 0,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    status TEXT DEFAULT 'running'
  );

  CREATE TABLE audit_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_id INTEGER,
    card_csn TEXT,
    employee_name TEXT,
    balance REAL,
    passport_loaded INTEGER,
    status_flag TEXT,
    scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (audit_id) REFERENCES audit_runs(id)
  );
`);

// ---- Employer Configs ----
fleetDb.prepare(`
  INSERT INTO employer_config (employer_id, employer_name, program_type, monthly_subsidy, epurse_cap, retroactive_months,
    balance_transfer_policy, orca_username, orca_password)
  VALUES ('acme', 'Acme Corp', 'Choice', 50.00, 400.00, 1, 'reclaim', 'fleet@acme.com', 'demo123')
`).run();

fleetDb.prepare(`
  INSERT INTO employer_config (employer_id, employer_name, program_type, monthly_subsidy, epurse_cap, retroactive_months,
    balance_transfer_policy, orca_username, orca_password)
  VALUES ('mta', 'Metro Transit Authority', 'Passport', 0.00, 400.00, 0, 'reclaim', 'fleet@mta-transit.com', 'demo456')
`).run();

// ---- Fleet Roster ----
// current_balance = NULL for ALL (Fleet doesn't know balances until scraping)
const insertRoster = fleetDb.prepare(`
  INSERT INTO roster (employee_name, employee_id, email, location, program_type, card_csn, identifier,
    access_level, autoload_configured, monthly_subsidy, current_balance, balance_updated_at,
    has_passport_verified, employer_id, status, onboard_date)
  VALUES (?, ?, ?, ?, 'Choice', ?, ?, 'Load Only', ?, 50.00, NULL, NULL, 0, 'acme', ?, '2026-03-15')
`);

const rosterEntries = [];

// 200 standard employees (EMP-0001 to EMP-0200) — autoload=1
for (let i = 0; i < 200; i++) {
  const sc = standardCards[i];
  rosterEntries.push({
    name: sc.name, id: 'EMP-' + String(i + 1).padStart(4, '0'),
    email: makeEmail(sc.name), loc: sc.grp, csn: sc.csn, auto: 1, status: 'Active'
  });
}

// 12 no-autoload (EMP-0201 to EMP-0212) — autoload=0, all Active
noAutoloadCards.forEach((c, i) => {
  rosterEntries.push({
    name: c.name, id: 'EMP-' + String(201 + i).padStart(4, '0'),
    email: makeEmail(c.name), loc: c.grp, csn: c.csn, auto: 0, status: 'Active'
  });
});

// 6 no-autoload near/at cap (EMP-0213 to EMP-0218) — autoload=0, Active
nearCapCards.forEach((c, i) => {
  rosterEntries.push({
    name: c.name, id: 'EMP-' + String(213 + i).padStart(4, '0'),
    email: makeEmail(c.name), loc: c.grp, csn: c.csn, auto: 0, status: 'Active'
  });
});

// 4 retroactive (EMP-0219 to EMP-0222) — 219, 220 no autoload; 221, 222 have autoload
// With autoload: Fleet loads only $50 extra (autoload handles base $50)
// Without autoload: Fleet loads full $100
retroactiveCards.forEach((c, i) => {
  const hasAutoload = (i >= 2); // 221 (Hana), 222 (Erik) have autoload
  rosterEntries.push({
    name: c.name, id: 'EMP-' + String(219 + i).padStart(4, '0'),
    email: makeEmail(c.name), loc: c.grp, csn: c.csn, auto: hasAutoload ? 1 : 0, status: 'Active'
  });
});

// 3 terminated-already-locked (EMP-0223 to EMP-0225) — Active in Fleet (HRIS will flip them)
// David Park (223) has paused autoload; others have no autoload
terminatedLockedCards.forEach((c, i) => {
  const hasAutoload = (i === 0); // Only David Park (223) has autoload
  rosterEntries.push({
    name: c.name, id: 'EMP-' + String(223 + i).padStart(4, '0'),
    email: makeEmail(c.name), loc: c.grp, csn: c.csn, auto: hasAutoload ? 1 : 0, status: 'Active'
  });
});

// 4 terminated-not-yet-locked (EMP-0226 to EMP-0229) — Active in Fleet (HRIS will flip)
// Cards 226, 228, 229 have Active autoloads (money leak risk). Card 227 has none.
terminatedActiveCards.forEach((c, i) => {
  const csnSuffix = c.csn.slice(-4);
  const hasAutoload = (csnSuffix === '0226' || csnSuffix === '0228' || csnSuffix === '0229');
  rosterEntries.push({
    name: c.name, id: 'EMP-' + String(226 + i).padStart(4, '0'),
    email: makeEmail(c.name), loc: c.grp, csn: c.csn, auto: hasAutoload ? 1 : 0, status: 'Active'
  });
});

// 3 going-on-leave (EMP-0230 to EMP-0232) — Active in Fleet roster (HRIS flips), autoload varies
leaveCards.forEach((c, i) => {
  rosterEntries.push({
    name: c.name, id: 'EMP-' + String(230 + i).padStart(4, '0'),
    email: makeEmail(c.name), loc: c.grp, csn: c.csn, auto: c.hasAutoload ? 1 : 0, status: 'Active'
  });
});

// 3 returning-from-leave (EMP-0233 to EMP-0235) — status='Leave' in Fleet (HRIS says return)
returnCards.forEach((c, i) => {
  rosterEntries.push({
    name: c.name, id: 'EMP-' + String(233 + i).padStart(4, '0'),
    email: makeEmail(c.name), loc: c.grp, csn: c.csn, auto: c.hasAutoload ? 1 : 0, status: 'Leave'
  });
});

// 4 replaced pairs — 4 roster entries, each pointing to the OLD CSN (Fleet discovers replacement)
// EMP-0236 to EMP-0239
replacedPairs.forEach((pair, i) => {
  rosterEntries.push({
    name: pair.name, id: 'EMP-' + String(236 + i).padStart(4, '0'),
    email: makeEmail(pair.name), loc: pair.grp, csn: pair.oldCsn, auto: 1, status: 'Active'
  });
});

// 3 duplicate primary (EMP-0240 to EMP-0242) — points to card A
duplicateSets.forEach((dup, i) => {
  rosterEntries.push({
    name: dup.name, id: 'EMP-' + String(240 + i).padStart(4, '0'),
    email: makeEmail(dup.name), loc: dup.grpA, csn: dup.csnA, auto: 1, status: 'Active'
  });
});

// 2 negative balance hidden (EMP-0243, EMP-0244) — autoload=1 (that's why Fleet doesn't scrape)
negativeBalanceCards.forEach((c, i) => {
  rosterEntries.push({
    name: c.name, id: 'EMP-' + String(243 + i).padStart(4, '0'),
    email: makeEmail(c.name), loc: c.grp, csn: c.csn, auto: 1, status: 'Active'
  });
});

for (const r of rosterEntries) {
  insertRoster.run(r.name, r.id, r.email, r.loc, r.csn, r.csn, r.auto, r.status);
}

// ---- MTA Roster (Passport — 18 entries) ----
const insertMtaRoster = fleetDb.prepare(`
  INSERT INTO roster (employee_name, employee_id, email, location, program_type, card_csn, identifier,
    access_level, autoload_configured, monthly_subsidy, current_balance, balance_updated_at,
    has_passport_verified, employer_id, status, onboard_date)
  VALUES (?, ?, ?, ?, 'Passport', ?, ?, 'Full Access', 0, 0.00, NULL, NULL, ?, 'mta', ?, '2026-02-10')
`);

const mtaRosterEntries = [
  { name: 'Angela Torres',      id: 'MTA-1001', email: 'atorres@mta.gov',     loc: 'Downtown', csn: '9840010250021001', passport: 1, status: 'Active' },
  { name: 'Robert Chang',       id: 'MTA-1002', email: 'rchang@mta.gov',      loc: 'Downtown', csn: '9840010250021002', passport: 1, status: 'Active' },
  { name: 'Michelle Okafor',    id: 'MTA-1003', email: 'mokafor@mta.gov',     loc: 'Downtown', csn: '9840010250021003', passport: 1, status: 'Active' },
  { name: 'Steven Nakamura',    id: 'MTA-1004', email: 'snakamura@mta.gov',   loc: 'Eastside', csn: '9840010250021004', passport: 1, status: 'Active' },
  { name: 'Patricia Johansson', id: 'MTA-1005', email: 'pjohansson@mta.gov',  loc: 'Eastside', csn: '9840010250021005', passport: 1, status: 'Active' },
  { name: 'William Patel',      id: 'MTA-1006', email: 'wpatel@mta.gov',      loc: 'Downtown', csn: '9840010250021006', passport: 1, status: 'Active' },
  { name: 'Jennifer Schmidt',   id: 'MTA-1007', email: 'jschmidt@mta.gov',    loc: 'Eastside', csn: '9840010250021007', passport: 1, status: 'Active' },
  { name: 'David Kowalski',     id: 'MTA-1008', email: 'dkowalski@mta.gov',   loc: 'Downtown', csn: '9840010250021008', passport: 1, status: 'Active' },
  { name: 'Linda Hassan',       id: 'MTA-1009', email: 'lhassan@mta.gov',     loc: 'Eastside', csn: '9840010250021009', passport: 1, status: 'Active' },
  { name: 'Richard Svensson',   id: 'MTA-1010', email: 'rsvensson@mta.gov',   loc: 'Downtown', csn: '9840010250021010', passport: 1, status: 'Active' },
  { name: 'Karen Morales',      id: 'MTA-1011', email: 'kmorales@mta.gov',    loc: 'Eastside', csn: '9840010250021011', passport: 1, status: 'Active' },
  { name: 'Daniel Fitzgerald',  id: 'MTA-1012', email: 'dfitzgerald@mta.gov', loc: 'Downtown', csn: '9840010250021012', passport: 1, status: 'Active' },
  // Passport NOT verified — these are the "missing Passport" edge cases Fleet tracks
  { name: 'Carlos Rivera',      id: 'MTA-1013', email: 'crivera@mta.gov',     loc: 'Downtown', csn: '9840010250021013', passport: 0, status: 'Active' },
  { name: 'Yuki Tanaka',        id: 'MTA-1014', email: 'ytanaka@mta.gov',     loc: 'Eastside', csn: '9840010250021014', passport: 0, status: 'Active' },
  // Status exceptions
  { name: 'Sarah Mitchell',     id: 'MTA-1015', email: 'smitchell@mta.gov',   loc: 'Downtown', csn: '9840010250021015', passport: 1, status: 'Active' },
  { name: "James O'Connor",     id: 'MTA-1016', email: 'joconnor@mta.gov',    loc: 'Eastside', csn: '9840010250021016', passport: 1, status: 'Active' },
  { name: 'Emma Larsen',        id: 'MTA-1017', email: 'elarsen@mta.gov',     loc: 'Downtown', csn: '9840010250021017', passport: 1, status: 'Leave' },
  { name: 'Marco DiStefano',    id: 'MTA-1018', email: 'mdistefano@mta.gov',  loc: 'Eastside', csn: '9840010250021018', passport: 1, status: 'Active' },
];

for (const r of mtaRosterEntries) {
  insertMtaRoster.run(r.name, r.id, r.email, r.loc, r.csn, r.csn, r.passport, r.status);
}

console.log(`Fleet DB seeded: ${fleetDb.prepare('SELECT COUNT(*) as c FROM roster').get().c} roster entries, ` +
  `${fleetDb.prepare('SELECT COUNT(*) as c FROM employer_config').get().c} employer configs`);

fleetDb.close();

console.log('\nSeed complete. Both databases ready.');
