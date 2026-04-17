const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { stringify } = require('csv-stringify/sync');

// Participants list
router.get('/participants', (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page) || 1;
  const perPage = 20;
  const searchBy = req.query.searchBy || '';
  const searchVal = req.query.searchVal || '';

  const employerId = req.employerId || 'acme';
  let where = 'WHERE c.employer_id = ?';
  const params = [employerId];

  if (searchVal) {
    switch (searchBy) {
      case 'first_name': where += ' AND p.first_name LIKE ?'; params.push('%' + searchVal + '%'); break;
      case 'last_name': where += ' AND p.last_name LIKE ?'; params.push('%' + searchVal + '%'); break;
      case 'card_number': where += ' AND c.printed_card_number LIKE ?'; params.push('%' + searchVal + '%'); break;
      case 'group': where += ' AND p.group_name LIKE ?'; params.push('%' + searchVal + '%'); break;
      case 'identifier': where += ' AND p.identifier LIKE ?'; params.push('%' + searchVal + '%'); break;
      case 'email': where += ' AND p.email LIKE ?'; params.push('%' + searchVal + '%'); break;
    }
  }

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM participants p LEFT JOIN cards c ON p.card_id = c.id ${where}`).get(...params);
  const total = countRow.total;
  const totalPages = Math.ceil(total / perPage);
  const offset = (page - 1) * perPage;

  const participants = db.prepare(`
    SELECT p.*, c.printed_card_number as card_number
    FROM participants p
    LEFT JOIN cards c ON p.card_id = c.id
    ${where}
    ORDER BY p.last_name, p.first_name
    LIMIT ? OFFSET ?
  `).all(...params, perPage, offset);

  // Unassigned cards for dropdown (same employer, on account)
  const unassignedCards = db.prepare(
    "SELECT id, printed_card_number FROM cards WHERE participant_id IS NULL AND status = 'Active' AND employer_id = ? AND on_business_account = 1 ORDER BY id"
  ).all(employerId);

  res.render('participants', {
    pageTitle: 'Participants',
    navActive: 'participants',
    employerName: req.employerName,
    username: req.session?.username,
    participants,
    currentPage: page,
    totalPages,
    searchActive: !!searchVal,
    unassignedCards,
  });
});

// Participants CSV export
router.get('/participants/export', (req, res) => {
  const db = getDb();
  const employerId = req.employerId || 'acme';
  const participants = db.prepare(`
    SELECT p.first_name, p.last_name, p.email, p.phone, p.group_name, p.identifier,
      c.printed_card_number
    FROM participants p
    LEFT JOIN cards c ON p.card_id = c.id
    WHERE c.employer_id = ?
    ORDER BY p.last_name, p.first_name
  `).all(employerId);

  const rows = participants.map(p => ({
    FirstName: p.first_name || '',
    LastName: p.last_name || '',
    Email: p.email || '',
    PhoneNumber: p.phone || '',
    GroupName: p.group_name || '',
    Identifier: p.identifier || '',
    PrintedCardNumber: p.printed_card_number || ''
  }));

  const csv = stringify(rows, { header: true });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="participants_export.csv"');
  res.send(csv);
});

// API: Get single participant
router.get('/api/participant/:id', (req, res) => {
  const db = getDb();
  const p = db.prepare(`
    SELECT p.*, c.printed_card_number as card_number
    FROM participants p LEFT JOIN cards c ON p.card_id = c.id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

// API: Create participant
router.post('/api/participant', (req, res) => {
  const db = getDb();
  const { first_name, last_name, email, identifier, card_id, group_name, phone } = req.body;

  // Check duplicate identifier
  const existing = db.prepare('SELECT id FROM participants WHERE identifier = ?').get(identifier);
  if (existing) return res.status(400).json({ error: 'Duplicate identifier', field: 'identifier' });

  const result = db.prepare(`
    INSERT INTO participants (identifier, first_name, last_name, email, phone, group_name, card_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(identifier, first_name, last_name, email, phone, group_name, card_id || null);

  // Link card
  if (card_id) {
    db.prepare('UPDATE cards SET participant_id = ?, group_name = ? WHERE id = ?')
      .run(result.lastInsertRowid, group_name, card_id);
  }

  res.json({ ok: true, id: result.lastInsertRowid });
});

// API: Update participant
router.post('/api/participant/:id', (req, res) => {
  const db = getDb();
  const { first_name, last_name, email, identifier, card_id, group_name, phone } = req.body;

  // Check duplicate identifier (excluding self)
  const existing = db.prepare('SELECT id FROM participants WHERE identifier = ? AND id != ?').get(identifier, req.params.id);
  if (existing) return res.status(400).json({ error: 'Duplicate identifier', field: 'identifier' });

  db.prepare(`
    UPDATE participants SET first_name=?, last_name=?, email=?, identifier=?, phone=?, group_name=?, card_id=?
    WHERE id=?
  `).run(first_name, last_name, email, identifier, phone, group_name, card_id || null, req.params.id);

  // Update card link
  if (card_id) {
    db.prepare('UPDATE cards SET participant_id = ?, group_name = ? WHERE id = ?')
      .run(req.params.id, group_name, card_id);
  }

  res.json({ ok: true });
});

// Delete participants
router.post('/participants/delete', (req, res) => {
  const db = getDb();
  let ids = req.body.delete_ids;
  if (!ids) return res.redirect('/participants');
  if (!Array.isArray(ids)) ids = [ids];

  for (const id of ids) {
    const p = db.prepare('SELECT card_id FROM participants WHERE id = ?').get(id);
    if (p && p.card_id) {
      db.prepare('UPDATE cards SET participant_id = NULL WHERE id = ?').run(p.card_id);
    }
    db.prepare('DELETE FROM participants WHERE id = ?').run(id);
  }
  res.redirect('/participants');
});

module.exports = router;
