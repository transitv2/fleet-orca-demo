const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { getDb } = require('../db');

const upload = multer({ dest: '/tmp/orca-uploads/' });

// In-memory store for bulk job records (avoids cookie-session 4KB limit)
const bulkDataStore = {};

// Bulk Actions page
router.get('/bulk-actions', (req, res) => {
  const actionType = req.query.type || 'add-participants';
  res.render('bulk-actions', {
    pageTitle: 'Bulk Actions',
    navActive: 'bulk',
    employerName: req.employerName,
    username: req.session?.username,
    actionType,
  });
});

// Upload CSV
router.post('/bulk-actions/upload', upload.single('file'), (req, res) => {
  const db = getDb();
  const actionType = req.body.action_type;
  const fs = require('fs');
  const fileContent = fs.readFileSync(req.file.path, 'utf-8');

  let records;
  try {
    records = parse(fileContent, { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).send('Invalid CSV');
  }

  // Create bulk job (with employer_id from session)
  const employerId = req.session?.employer_id || 'acme';
  const job = db.prepare(`
    INSERT INTO bulk_jobs (job_type, file_name, card_count, status, employer_id)
    VALUES (?, ?, ?, 'Processing', ?)
  `).run(actionType, req.file.originalname, records.length, employerId);

  const jobId = job.lastInsertRowid;

  // Store parsed data in memory (not session — avoids cookie size limits)
  bulkDataStore[jobId] = records;

  // Validate rows
  const rows = records.map(row => {
    const validated = { ...row };
    if (actionType === 'Add Participants') {
      if (!row.PrintedCardNumber || !row.Identifier) {
        validated._valid = false;
        validated._error = 'Missing required field (PrintedCardNumber or Identifier)';
      } else {
        const card = db.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(row.PrintedCardNumber);
        if (!card) {
          validated._valid = false;
          validated._error = 'Card not found: ' + row.PrintedCardNumber;
        } else {
          validated._valid = true;
        }
      }
    } else if (actionType === 'Add Cards to Account') {
      const csn = row.PrintedCardNumber;
      if (!csn) {
        validated._valid = false;
        validated._error = 'Missing PrintedCardNumber';
      } else {
        const card = db.prepare('SELECT id, status FROM cards WHERE printed_card_number = ?').get(csn);
        if (!card) {
          validated._valid = false;
          validated._error = 'Card not found in ORCA system';
        } else if (card.status !== 'Active') {
          validated._valid = false;
          validated._error = 'Card is not Active: ' + card.status;
        } else {
          validated._valid = true;
        }
      }
    } else if (actionType === 'Add Money/Passes' || actionType === 'Lock Cards' || actionType === 'Unlock Cards' ||
               actionType === 'Create Autoloads' || actionType === 'Create Passes' || actionType === 'Remove Cards') {
      const csn = row.PrintedCardNumber;
      if (!csn) {
        validated._valid = false;
        validated._error = 'Missing PrintedCardNumber';
      } else {
        const card = db.prepare('SELECT id, status FROM cards WHERE printed_card_number = ?').get(csn);
        if (!card) {
          validated._valid = false;
          validated._error = 'Card not found';
        } else {
          validated._valid = true;
        }
      }
    } else {
      validated._valid = true;
    }
    return validated;
  });

  const jobRecord = db.prepare('SELECT * FROM bulk_jobs WHERE id = ?').get(jobId);
  res.render('bulk-review', {
    pageTitle: 'Review Data',
    navActive: 'bulk',
    employerName: req.employerName,
    username: req.session?.username,
    job: jobRecord,
    rows,
  });
});

// Submit bulk action
router.post('/bulk-actions/submit/:jobId', (req, res) => {
  const db = getDb();
  const jobId = req.params.jobId;
  const job = db.prepare('SELECT * FROM bulk_jobs WHERE id = ?').get(jobId);
  if (!job) return res.redirect('/bulk-actions');

  const records = bulkDataStore[jobId] || [];

  if (job.job_type === 'Add Cards to Account') {
    for (const row of records) {
      const csn = row.PrintedCardNumber;
      const accessType = row.AccessType || 'Load Only';
      const card = db.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(csn);
      if (!card) continue;
      db.prepare('UPDATE cards SET on_business_account = 1, access_type = ? WHERE id = ?').run(accessType, card.id);
    }
  } else if (job.job_type === 'Add Participants') {
    for (const row of records) {
      const csn = row.PrintedCardNumber;
      const card = db.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(csn);
      if (!card) continue;

      const identifier = row.Identifier || csn;
      const existing = db.prepare('SELECT id FROM participants WHERE identifier = ?').get(identifier);
      if (existing) continue;

      const result = db.prepare(`
        INSERT INTO participants (identifier, first_name, last_name, email, group_name, card_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(identifier, row.FirstName || '', row.LastName || '', row.Email || '', row.GroupName || '', card.id);

      db.prepare('UPDATE cards SET participant_id = ?, group_name = ? WHERE id = ?')
        .run(result.lastInsertRowid, row.GroupName || null, card.id);
    }
  } else if (job.job_type === 'Add Money/Passes') {
    const amount = parseFloat(req.body.amount) || 50;
    for (const row of records) {
      const csn = row.PrintedCardNumber;
      const card = db.prepare('SELECT id, epurse_balance FROM cards WHERE printed_card_number = ?').get(csn);
      if (!card) continue;
      const newBal = Math.min(card.epurse_balance + amount, 400);
      db.prepare('UPDATE cards SET epurse_balance = ? WHERE id = ?').run(newBal, card.id);
    }
  } else if (job.job_type === 'Lock Cards') {
    for (const row of records) {
      const csn = row.PrintedCardNumber;
      db.prepare("UPDATE cards SET status = 'Locked', lock_reason = 'Business Exclusive' WHERE printed_card_number = ?").run(csn);
    }
  } else if (job.job_type === 'Unlock Cards') {
    for (const row of records) {
      const csn = row.PrintedCardNumber;
      db.prepare("UPDATE cards SET status = 'Active', lock_reason = NULL WHERE printed_card_number = ?").run(csn);
    }
  } else if (job.job_type === 'Create Passes') {
    for (const row of records) {
      const csn = row.PrintedCardNumber;
      const card = db.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(csn);
      if (!card) continue;
      db.prepare("UPDATE passes SET status = 'Removed' WHERE card_id = ? AND product = 'Regional Business Passport' AND status = 'Active'").run(card.id);
      db.prepare("INSERT INTO passes (card_id, product, status) VALUES (?, 'Regional Business Passport', 'Active')").run(card.id);
    }
  } else if (job.job_type === 'Remove Cards') {
    for (const row of records) {
      const csn = row.PrintedCardNumber;
      const card = db.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(csn);
      if (!card) continue;
      db.prepare('UPDATE cards SET participant_id = NULL, group_name = NULL, on_business_account = 0 WHERE id = ?').run(card.id);
      db.prepare("UPDATE autoloads SET status = 'Removed' WHERE card_id = ?").run(card.id);
      db.prepare("UPDATE passes SET status = 'Removed' WHERE card_id = ?").run(card.id);
    }
  } else if (job.job_type === 'Create Autoloads') {
    const alType = req.body.autoload_type || 'time';
    const alDay = parseInt(req.body.autoload_day) || 1;
    const alThreshold = req.body.autoload_threshold ? parseFloat(req.body.autoload_threshold) : null;
    const alAmount = parseFloat(req.body.autoload_amount) || 50;
    const alPayment = req.body.autoload_payment || 'Primary Credit Card';

    for (const row of records) {
      const csn = row.PrintedCardNumber;
      const card = db.prepare('SELECT id FROM cards WHERE printed_card_number = ?').get(csn);
      if (!card) continue;

      db.prepare("UPDATE autoloads SET status = 'Removed' WHERE card_id = ? AND status IN ('Active', 'Paused')").run(card.id);

      db.prepare(`
        INSERT INTO autoloads (card_id, type, trigger_day, trigger_balance, load_amount, payment_source, status)
        VALUES (?, ?, ?, ?, ?, ?, 'Active')
      `).run(card.id, alType, alType === 'time' ? alDay : null, alType === 'threshold' ? alThreshold : null, alAmount, alPayment);
    }
  }

  // Mark job completed
  db.prepare("UPDATE bulk_jobs SET status = 'Completed', completed_at = datetime('now') WHERE id = ?").run(jobId);

  // Clean up stored data
  delete bulkDataStore[jobId];

  res.redirect('/bulk-actions/history');
});

// Past Processes
router.get('/bulk-actions/history', (req, res) => {
  const db = getDb();
  const employerId = req.employerId || 'acme';
  const jobs = db.prepare('SELECT * FROM bulk_jobs WHERE employer_id = ? ORDER BY submitted_at DESC').all(employerId);
  res.render('bulk-history', {
    pageTitle: 'Past Processes',
    navActive: 'bulk',
    employerName: req.employerName,
    username: req.session?.username,
    jobs,
  });
});

module.exports = router;
