const express = require('express');
const router = express.Router();

router.get('/purchase-cards', (req, res) => {
  res.render('purchase-cards', {
    pageTitle: 'Purchase Cards',
    navActive: 'purchase-cards',
    employerName: req.employerName,
    username: req.session?.username,
  });
});

module.exports = router;
