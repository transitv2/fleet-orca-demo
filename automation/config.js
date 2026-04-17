module.exports = {
  ORCA_URL: 'http://localhost:3000',
  FLEET_API: 'http://localhost:3001/api',
  CREDENTIALS: {
    username: 'fleet@acme.com',
    password: 'demo123'
  },
  EMPLOYERS: {
    acme: { username: 'fleet@acme.com', password: 'demo123', name: 'Acme Corp' },
    mta: { username: 'fleet@mta-transit.com', password: 'demo456', name: 'Metro Transit Authority' }
  },
  SLOW_MO: 300,
  SELECTORS: {
    // Login
    loginUsername: '#username',
    loginPassword: '#password',
    loginSubmit: '#login-btn',

    // Navigation
    navCards: '.nav-cards',
    navPurchase: '.nav-purchase',
    navParticipants: '.nav-participants',
    navBulk: '.nav-bulk',
    navOrders: '.nav-orders',

    // Manage Cards
    cardRow: '.card-row',
    cardCheckbox: '.card-checkbox',
    manageBtn: '#manage-btn',
    searchByDropdown: '#search-by',
    searchInput: '#search-input',
    searchBtn: '.search-btn',
    exportDropdown: '.dropdown',

    // Card Sidebar
    sidebarBalance: '#epurse-balance',
    sidebarPretax: '#pretax-balance',
    addMoneyBtn: '#add-money-btn',
    lockToggleBtn: '#lock-toggle-btn',
    autoloadToggleBtn: '#autoload-toggle-btn',

    // Lock modal
    lockReasonLost: '#lock-reason-lost',
    lockReasonBusiness: '#lock-reason-business',
    lockConfirm: '#lock-confirm',

    // Purchase
    purchaseQty: '#purchase-qty',
    purchaseAccess: '#purchase-access',

    // Cart
    placeOrderBtn: 'button[type="submit"]',

    // Bulk
    csvFileInput: '#csv-file',
    uploadBtn: '#upload-btn',
    submitAmount: '#submit-amount',
  }
};
