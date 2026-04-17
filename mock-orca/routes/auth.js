const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

const CREDENTIALS = {
  'fleet@acme.com': { password: 'demo123', employer_id: 'acme', employer_name: 'Acme Corp' },
  'fleet@mta-transit.com': { password: 'demo456', employer_id: 'mta', employer_name: 'Metro Transit Authority' },
};

router.get('/login', (req, res) => {
  if (req.session && req.session.username) return res.redirect('/manage-cards');
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const creds = CREDENTIALS[username];
  if (creds && creds.password === password) {
    req.session.username = username;
    req.session.loggedIn = true;
    req.session.employer_id = creds.employer_id;
    req.session.employer_name = creds.employer_name;
    return res.redirect('/manage-cards');
  }
  res.render('login', { error: 'Invalid credentials' });
});

router.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// Auth middleware — sets req.employerId from session
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) {
    req.employerId = req.session.employer_id || 'acme';
    return next();
  }
  if (req.path.startsWith('/api/')) return next();
  res.redirect('/login');
}

module.exports = { router, requireAuth, CREDENTIALS };
