const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { stringify } = require('csv-stringify/sync');

// Manage Cards list page
router.get('/manage-cards', (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page) || 1;
  const perPage = 10;
  const searchBy = req.query.searchBy || '';
  const searchVal = req.query.searchVal || '';

  const employerId = req.employerId || 'acme';
  let where = "WHERE c.on_business_account = 1 AND c.employer_id = ?";
  const params = [employerId];

  if (searchVal) {
    switch (searchBy) {
      case 'card_number':
        where += ' AND c.printed_card_number LIKE ?';
        params.push('%' + searchVal + '%');
        break;
      case 'last_name':
        where += ' AND p.last_name LIKE ?';
        params.push('%' + searchVal + '%');
        break;
      case 'group':
        where += ' AND c.group_name LIKE ?';
        params.push('%' + searchVal + '%');
        break;
      case 'status':
        where += ' AND c.status LIKE ?';
        params.push('%' + searchVal + '%');
        break;
      case 'fare_category':
        where += ' AND c.fare_category LIKE ?';
        params.push('%' + searchVal + '%');
        break;
      case 'card_type':
        where += ' AND c.card_type LIKE ?';
        params.push('%' + searchVal + '%');
        break;
    }
  }

  const countRow = db.prepare(`
    SELECT COUNT(*) as total FROM cards c LEFT JOIN participants p ON c.participant_id = p.id ${where}
  `).get(...params);
  const total = countRow.total;
  const totalPages = Math.ceil(total / perPage);
  const offset = (page - 1) * perPage;

  const cards = db.prepare(`
    SELECT c.*, p.identifier, p.first_name, p.last_name
    FROM cards c
    LEFT JOIN participants p ON c.participant_id = p.id
    ${where}
    ORDER BY c.id ASC
    LIMIT ? OFFSET ?
  `).all(...params, perPage, offset);

  res.render('manage-cards', {
    pageTitle: 'Manage Cards',
    navActive: 'manage-cards',
    employerName: req.employerName,
    username: req.session?.username,
    cards,
    currentPage: page,
    totalPages,
    searchBy,
    searchVal,
    searchActive: !!searchVal,
  });
});

// CSV export — NO balance column
router.get('/manage-cards/export', (req, res) => {
  const db = getDb();
  const cards = db.prepare(`
    SELECT c.printed_card_number, p.first_name, p.last_name, p.identifier,
      c.status as State, c.fare_category, c.fare_category as FareCategoryName,
      c.group_name, c.access_type, c.card_type, c.replaced_card_number,
      NULL as ReplacementDate
    FROM cards c
    LEFT JOIN participants p ON c.participant_id = p.id
    WHERE c.on_business_account = 1 AND c.employer_id = ?
    ORDER BY c.id ASC
  `).all(req.employerId || 'acme');

  const rows = cards.map(c => ({
    PrintedNumber: c.printed_card_number,
    FirstName: c.first_name || '',
    LastName: c.last_name || '',
    Identifier: c.identifier || '',
    State: c.State,
    FareCategory: c.fare_category,
    FareCategoryName: c.FareCategoryName,
    GroupName: c.group_name || '',
    Access: c.access_type,
    CardType: c.card_type,
    ReplacedCardPrintedNumber: c.replaced_card_number || '',
    ReplacementDate: ''
  }));

  const csv = stringify(rows, { header: true });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="manage_cards_export.csv"');
  res.send(csv);
});

// API: Look up card by CSN
router.get('/api/card-by-csn', (req, res) => {
  const db = getDb();
  const csn = req.query.csn;
  const card = db.prepare('SELECT id, printed_card_number, status FROM cards WHERE printed_card_number = ?').get(csn);
  if (!card) return res.status(404).json({ error: 'Not found' });
  res.json(card);
});

// API: Get single card detail (for sidebar)
router.get('/api/card/:id', (req, res) => {
  const db = getDb();
  const card = db.prepare(`
    SELECT c.*, p.identifier, p.first_name, p.last_name, p.email
    FROM cards c
    LEFT JOIN participants p ON c.participant_id = p.id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json(card);
});

// API: Card autoloads
router.get('/api/card/:id/autoloads', (req, res) => {
  const db = getDb();
  const autoloads = db.prepare('SELECT * FROM autoloads WHERE card_id = ? ORDER BY id').all(req.params.id);
  res.json(autoloads);
});

// API: Card passes
router.get('/api/card/:id/passes', (req, res) => {
  const db = getDb();
  const passes = db.prepare("SELECT * FROM passes WHERE card_id = ? AND status = 'Active' ORDER BY id").all(req.params.id);
  res.json(passes);
});

// API: Add pass to card
router.post('/api/card/:id/pass', (req, res) => {
  const db = getDb();
  const { product } = req.body;
  db.prepare('INSERT INTO passes (card_id, product, status) VALUES (?, ?, ?)')
    .run(req.params.id, product || 'Regional Business Passport', 'Active');
  res.json({ ok: true });
});

// API: Remove pass
router.post('/api/pass/:id/remove', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE passes SET status = 'Removed' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// API: Lock card
router.post('/api/card/:id/lock', (req, res) => {
  const db = getDb();
  const { reason } = req.body;
  db.prepare('UPDATE cards SET status = ?, lock_reason = ? WHERE id = ?').run('Locked', reason, req.params.id);
  // Pause autoloads
  db.prepare("UPDATE autoloads SET status = 'Paused' WHERE card_id = ? AND status = 'Active'").run(req.params.id);
  res.json({ ok: true });
});

// API: Unlock card
router.post('/api/card/:id/unlock', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE cards SET status = ?, lock_reason = NULL WHERE id = ?').run('Active', req.params.id);
  res.json({ ok: true });
});

// API: Remove card from business account
router.post('/api/card/:id/remove', (req, res) => {
  const db = getDb();
  // Strips passport products but keeps e-purse.
  db.prepare('UPDATE cards SET participant_id = NULL, group_name = NULL, on_business_account = 0 WHERE id = ?').run(req.params.id);
  // Remove autoloads
  db.prepare("UPDATE autoloads SET status = 'Removed' WHERE card_id = ?").run(req.params.id);
  // Strip passes (Passport product removed, e-purse stays)
  db.prepare("UPDATE passes SET status = 'Removed' WHERE card_id = ?").run(req.params.id);
  res.json({ ok: true });
});

// API: Transfer balance
router.post('/api/card/:id/transfer', (req, res) => {
  const db = getDb();
  const { target_id, amount } = req.body;
  const source = db.prepare('SELECT epurse_balance FROM cards WHERE id = ?').get(req.params.id);
  const target = db.prepare('SELECT epurse_balance FROM cards WHERE id = ?').get(target_id);
  if (!source || !target) return res.status(404).json({ error: 'Card not found' });

  const transferAmt = Math.min(amount, source.epurse_balance);
  db.prepare('UPDATE cards SET epurse_balance = epurse_balance - ? WHERE id = ?').run(transferAmt, req.params.id);
  db.prepare('UPDATE cards SET epurse_balance = MIN(epurse_balance + ?, 400) WHERE id = ?').run(transferAmt, target_id);
  res.json({ ok: true, transferred: transferAmt });
});

// API: Save autoload
router.post('/api/card/:id/autoload', (req, res) => {
  const db = getDb();
  const { type, trigger_day, trigger_balance, load_amount, payment_source } = req.body;
  db.prepare(`
    INSERT INTO autoloads (card_id, type, trigger_day, trigger_balance, load_amount, payment_source, status)
    VALUES (?, ?, ?, ?, ?, ?, 'Active')
  `).run(req.params.id, type, trigger_day, trigger_balance, load_amount, payment_source);
  res.json({ ok: true });
});

// API: Remove autoload
router.post('/api/autoload/:id/remove', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE autoloads SET status = 'Removed' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// API: Resume autoload
router.post('/api/autoload/:id/resume', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE autoloads SET status = 'Active' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// API: Pause autoload (explicit — independent of locking the card)
router.post('/api/autoload/:id/pause', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE autoloads SET status = 'Paused' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// API: Pause all active autoloads for a card (useful for bulk-like operations from Playwright)
router.post('/api/card/:id/autoloads/pause', (req, res) => {
  const db = getDb();
  const info = db.prepare("UPDATE autoloads SET status = 'Paused' WHERE card_id = ? AND status = 'Active'").run(req.params.id);
  res.json({ ok: true, paused: info.changes });
});

// API: Resume all paused autoloads for a card
router.post('/api/card/:id/autoloads/resume', (req, res) => {
  const db = getDb();
  const info = db.prepare("UPDATE autoloads SET status = 'Active' WHERE card_id = ? AND status = 'Paused'").run(req.params.id);
  res.json({ ok: true, resumed: info.changes });
});

// API: Cards for transfer dropdown
router.get('/api/cards-for-transfer', (req, res) => {
  const db = getDb();
  const exclude = req.query.exclude;
  const employerId = req.session?.employer_id || 'acme';
  const cards = db.prepare(`
    SELECT c.id, c.printed_card_number, p.first_name, p.last_name
    FROM cards c LEFT JOIN participants p ON c.participant_id = p.id
    WHERE c.status = 'Active' AND c.id != ? AND c.employer_id = ? AND c.on_business_account = 1
    ORDER BY c.id LIMIT 20
  `).all(exclude, employerId);
  res.json(cards);
});

module.exports = router;
