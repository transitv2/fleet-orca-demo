const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { stringify } = require('csv-stringify/sync');

// Order History list — filter by employer via order_items → cards
router.get('/order-history', (req, res) => {
  const db = getDb();
  const employerId = req.employerId || 'acme';
  // Orders linked to at least one card from this employer
  const orders = db.prepare(`
    SELECT DISTINCT o.* FROM orders o
    JOIN order_items oi ON o.id = oi.order_id
    JOIN cards c ON oi.card_id = c.id
    WHERE c.employer_id = ?
    ORDER BY o.order_date DESC
  `).all(employerId);
  res.render('order-history', {
    pageTitle: 'Order History',
    navActive: 'orders',
    employerName: req.employerName,
    username: req.session?.username,
    orders,
  });
});

// Order Detail
router.get('/order-history/:id', (req, res) => {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.redirect('/order-history');

  const items = db.prepare(`
    SELECT oi.*, c.printed_card_number
    FROM order_items oi
    JOIN cards c ON oi.card_id = c.id
    WHERE oi.order_id = ?
    ORDER BY c.printed_card_number, oi.id
  `).all(req.params.id);

  res.render('order-detail', {
    pageTitle: 'Order Details',
    navActive: 'orders',
    employerName: req.employerName,
    username: req.session?.username,
    order,
    items,
  });
});

// Order CSV Export — fixed columns, most fields blank for new orders
router.get('/order-history/:id/export', (req, res) => {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('Order not found');

  // Get unique cards in this order
  const cards = db.prepare(`
    SELECT DISTINCT c.printed_card_number, p.first_name, p.last_name, p.identifier,
      c.status, c.fare_category, c.group_name, c.access_type, c.card_type,
      c.replaced_card_number
    FROM order_items oi
    JOIN cards c ON oi.card_id = c.id
    LEFT JOIN participants p ON c.participant_id = p.id
    WHERE oi.order_id = ?
    ORDER BY c.printed_card_number
  `).all(req.params.id);

  const rows = cards.map(c => ({
    PrintedCardNumber: c.printed_card_number,
    FirstName: c.first_name || '',
    LastName: c.last_name || '',
    Identifier: c.identifier || '',
    State: c.status || '',
    FareCategory: c.fare_category || '',
    FareCategoryName: c.fare_category || '',
    GroupName: c.group_name || '',
    Access: c.access_type || '',
    CardType: c.card_type || '',
    ReplacedCardPrintedNumber: c.replaced_card_number || '',
    ReplacementDate: ''
  }));

  const csv = stringify(rows, { header: true });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="order_${order.order_number}.csv"`);
  res.send(csv);
});

module.exports = router;
