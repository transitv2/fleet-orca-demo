const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

// GET cart
router.get('/cart', (req, res) => {
  const cart = req.session.cart || [];
  let cartTotal = 0;
  const cartItems = cart.map(item => {
    cartTotal += item.total;
    return item;
  });

  res.render('cart', {
    pageTitle: 'Shopping Cart',
    navActive: '',
    employerName: req.employerName,
    username: req.session?.username,
    cartItems,
    cartTotal,
  });
});

// Add money to cart (from manage cards sidebar)
router.post('/cart/add', (req, res) => {
  const { card_id, amount, type } = req.body;
  if (!req.session.cart) req.session.cart = [];
  const db = getDb();
  const card = db.prepare('SELECT printed_card_number FROM cards WHERE id = ?').get(card_id);

  req.session.cart.push({
    type: 'add_money',
    card_id,
    card_csn: card ? card.printed_card_number : '',
    description: 'Add Money — Card ...' + (card ? card.printed_card_number.slice(-8) : ''),
    products: ['E-purse $' + parseFloat(amount).toFixed(2)],
    total: parseFloat(amount),
  });
  res.json({ ok: true });
});

// Add purchase to cart (from purchase cards page)
router.post('/cart/add-purchase', (req, res) => {
  const { quantity, access_type, money_amount, pass } = req.body;
  if (!req.session.cart) req.session.cart = [];

  const qty = parseInt(quantity) || 1;
  const cardFee = 3.00;
  let perCardProducts = [];
  let perCardTotal = cardFee;

  if (money_amount) {
    perCardProducts.push('E-purse $' + parseFloat(money_amount).toFixed(2));
    perCardTotal += parseFloat(money_amount);
  }
  if (pass) {
    perCardProducts.push(pass);
  }

  req.session.cart.push({
    type: 'purchase',
    quantity: qty,
    access_type,
    money_amount: money_amount || null,
    pass: pass || null,
    description: qty + 'x Adult ORCA Card - BA (' + access_type + ')',
    products: [qty + 'x Card fee $' + cardFee.toFixed(2), ...perCardProducts.map(p => qty + 'x ' + p)],
    total: perCardTotal * qty,
  });
  res.json({ ok: true });
});

// Checkout
router.post('/cart/checkout', (req, res) => {
  const db = getDb();
  const cart = req.session.cart || [];
  if (!cart.length) return res.redirect('/cart');

  const pretax = req.body.pretax === '1';
  const paymentMethod = req.body.payment_method || 'Credit Card';

  let totalAmount = 0;
  let totalQty = 0;
  const allCardIds = [];

  for (const item of cart) {
    totalAmount += item.total;

    if (item.type === 'purchase') {
      // Create new card records
      const qty = item.quantity;
      totalQty += qty;

      const employerId = req.session?.employer_id || 'acme';
      for (let i = 0; i < qty; i++) {
        // Generate random CSN: 984001025 + 10 random digits
        const randomDigits = Math.floor(Math.random() * 10000000000).toString().padStart(10, '0');
        const csn = '984001025' + randomDigits;
        const mfg = 'MFG-' + (2000 + Math.floor(Math.random() * 9000));

        const result = db.prepare(`
          INSERT INTO cards (printed_card_number, manufacturing_number, status, access_type, epurse_balance, pretax_balance, employer_id, on_business_account)
          VALUES (?, ?, 'Active', ?, ?, ?, ?, 1)
        `).run(csn, mfg, item.access_type, item.money_amount || 0, pretax ? (item.money_amount || 0) : 0, employerId);

        const newCardId = result.lastInsertRowid;

        // If Passport was purchased, create pass record
        if (item.pass && item.pass.includes('Passport')) {
          db.prepare('INSERT INTO passes (card_id, product, status) VALUES (?, ?, ?)')
            .run(newCardId, item.pass, 'Active');
        }

        allCardIds.push({ id: newCardId, money: item.money_amount, pass: item.pass });
      }
    } else if (item.type === 'add_money') {
      // Add money to existing card
      totalQty += 1;
      const cap = 400;
      db.prepare('UPDATE cards SET epurse_balance = MIN(epurse_balance + ?, ?) WHERE id = ?')
        .run(item.total, cap, item.card_id);
      if (pretax) {
        db.prepare('UPDATE cards SET pretax_balance = pretax_balance + ? WHERE id = ?')
          .run(item.total, item.card_id);
      }
      allCardIds.push({ id: item.card_id, money: item.total, pass: null });
    }
  }

  // Create order
  const now = new Date();
  const orderNum = 'ON' + now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') +
    '-' + String(Math.floor(Math.random() * 900000) + 100000);

  const orderResult = db.prepare(`
    INSERT INTO orders (order_number, status, quantity, access_type, total_amount, payment_method)
    VALUES (?, 'Fulfilled', ?, ?, ?, ?)
  `).run(orderNum, totalQty, cart[0]?.access_type || 'Load Only', totalAmount, paymentMethod);

  // Create order items
  for (const ci of allCardIds) {
    if (ci.money) {
      db.prepare('INSERT INTO order_items (order_id, card_id, product, amount) VALUES (?, ?, ?, ?)')
        .run(orderResult.lastInsertRowid, ci.id, 'E-purse $' + parseFloat(ci.money).toFixed(2), ci.money);
    }
    // Card fee item
    db.prepare('INSERT INTO order_items (order_id, card_id, product, amount) VALUES (?, ?, ?, ?)')
      .run(orderResult.lastInsertRowid, ci.id, 'Adult ORCA Card', 3.00);
    if (ci.pass) {
      db.prepare('INSERT INTO order_items (order_id, card_id, product, amount) VALUES (?, ?, ?, ?)')
        .run(orderResult.lastInsertRowid, ci.id, ci.pass, 0);
    }
  }

  // Clear cart
  req.session.cart = [];
  res.redirect('/order-history/' + orderResult.lastInsertRowid);
});

module.exports = router;
