const express = require('express');
const path = require('path');
const cookieSession = require('cookie-session');
const { initDb } = require('./db');

const app = express();
const PORT = 3000;

// Initialize database
initDb();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieSession({
  name: 'orca_session',
  keys: ['orca-demo-secret-key'],
  maxAge: 24 * 60 * 60 * 1000
}));

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Layout helper — render view inside layout
const origRender = app.response.render;
app.response.render = function(view, options, callback) {
  const self = this;
  if (view === 'login') {
    // Login page has its own full layout
    return origRender.call(self, view, options, callback);
  }
  const opts = options || {};
  self.app.render(view, opts, (err, body) => {
    if (err) return callback ? callback(err) : self.status(500).send(err.message);
    const layoutOpts = { ...opts, body };
    origRender.call(self, 'layout', layoutOpts, callback);
  });
};

// Routes
const { router: authRouter, requireAuth } = require('./routes/auth');
app.use(authRouter);

// Auth check for all pages except login and API
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/logout' || req.path.startsWith('/api/') || req.path.endsWith('.css')) {
    return next();
  }
  if (!req.session || !req.session.loggedIn) {
    return res.redirect('/login');
  }
  // Set employer_id for protected routes
  req.employerId = req.session.employer_id || 'acme';
  req.employerName = req.session.employer_name || 'Acme Corp';
  next();
});

app.use(require('./routes/cards'));
app.use(require('./routes/purchase'));
app.use(require('./routes/cart'));
app.use(require('./routes/orders'));
app.use(require('./routes/participants'));
app.use(require('./routes/bulk'));

// Root redirect
app.get('/', (req, res) => res.redirect('/manage-cards'));

app.listen(PORT, () => {
  console.log(`Mock myORCA server running on http://localhost:${PORT}`);
});

module.exports = app;
