const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'orca.db');

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
    CREATE TABLE IF NOT EXISTS cards (
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

    CREATE TRIGGER IF NOT EXISTS cards_updated_at AFTER UPDATE ON cards
    BEGIN UPDATE cards SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;

    CREATE TABLE IF NOT EXISTS participants (
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

    CREATE TRIGGER IF NOT EXISTS participants_updated_at AFTER UPDATE ON participants
    BEGIN UPDATE participants SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      order_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'Fulfilled',
      quantity INTEGER,
      access_type TEXT,
      total_amount REAL,
      payment_method TEXT DEFAULT 'Credit Card'
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      card_id INTEGER NOT NULL,
      product TEXT,
      amount REAL,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (card_id) REFERENCES cards(id)
    );

    CREATE TABLE IF NOT EXISTS autoloads (
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

    CREATE TRIGGER IF NOT EXISTS autoloads_updated_at AFTER UPDATE ON autoloads
    BEGIN UPDATE autoloads SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;

    CREATE TABLE IF NOT EXISTS bulk_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type TEXT NOT NULL,
      file_name TEXT,
      card_count INTEGER,
      status TEXT DEFAULT 'Processing',
      employer_id TEXT DEFAULT 'acme',
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS passes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL,
      product TEXT NOT NULL,
      status TEXT DEFAULT 'Active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (card_id) REFERENCES cards(id)
    );

    CREATE TRIGGER IF NOT EXISTS passes_updated_at AFTER UPDATE ON passes
    BEGIN UPDATE passes SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      username TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
