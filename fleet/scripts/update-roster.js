function updateRoster(db, updates) {
  for (const update of updates) {
    if (update.type === 'balance') {
      db.prepare(`
        UPDATE roster SET current_balance = ?, balance_updated_at = datetime('now')
        WHERE card_csn = ?
      `).run(update.balance, update.card_csn);
    } else if (update.type === 'status') {
      db.prepare('UPDATE roster SET status = ? WHERE employee_id = ?')
        .run(update.status, update.employee_id);
    } else if (update.type === 'offboard') {
      db.prepare(`
        UPDATE roster SET status = 'Inactive', offboard_date = date('now')
        WHERE employee_id = ?
      `).run(update.employee_id);
    } else if (update.type === 'card_csn') {
      db.prepare('UPDATE roster SET card_csn = ?, identifier = ? WHERE employee_id = ?')
        .run(update.new_csn, update.new_csn, update.employee_id);
    } else if (update.type === 'autoload') {
      db.prepare('UPDATE roster SET autoload_configured = ? WHERE employee_id = ?')
        .run(update.configured ? 1 : 0, update.employee_id);
    }
  }
}

module.exports = { updateRoster };
