const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'fleet.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS roster (
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

    CREATE TRIGGER IF NOT EXISTS roster_updated_at AFTER UPDATE ON roster
    BEGIN UPDATE roster SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;

    CREATE TABLE IF NOT EXISTS load_history (
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

    CREATE TRIGGER IF NOT EXISTS load_history_updated_at AFTER UPDATE ON load_history
    BEGIN UPDATE load_history SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;

    CREATE TABLE IF NOT EXISTS automation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow TEXT NOT NULL,
      step_name TEXT NOT NULL,
      step_type TEXT NOT NULL,
      detail TEXT,
      status TEXT DEFAULT 'running',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS employer_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employer_name TEXT NOT NULL,
      program_type TEXT NOT NULL,
      monthly_subsidy REAL DEFAULT 50.00,
      epurse_cap REAL DEFAULT 400.00,
      retroactive_months INTEGER DEFAULT 1,
      balance_transfer_policy TEXT DEFAULT 'reclaim',
      orca_username TEXT,
      orca_password TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_runs (
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

    CREATE TABLE IF NOT EXISTS audit_results (
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

  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, initDb, closeDb, DB_PATH };
