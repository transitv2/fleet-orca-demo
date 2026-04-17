function generateSummary(loadResults) {
  const summary = {
    cycle_month: new Date().toISOString().slice(0, 7),
    total_cards: loadResults.length,
    loaded: loadResults.filter(l => l.actual_load > 0).length,
    excluded: loadResults.filter(l => l.load_method === 'excluded').length,
    total_spend: loadResults.reduce((sum, l) => sum + (l.actual_load || 0), 0),
    total_forfeited: loadResults.reduce((sum, l) => sum + (l.forfeited || 0), 0),
    bulk_loads: loadResults.filter(l => l.load_method === 'bulk').length,
    manual_loads: loadResults.filter(l => l.load_method === 'manual').length,
    exclusion_breakdown: {},
    load_details: loadResults.map(l => ({
      employee: l.employee_name,
      card: l.card_csn ? '...' + l.card_csn.slice(-4) : '',
      amount: l.actual_load,
      method: l.load_method,
      reason: l.exclusion_reason || '',
      forfeited: l.forfeited
    }))
  };

  for (const l of loadResults.filter(l => l.load_method === 'excluded')) {
    const reason = l.exclusion_reason || 'unknown';
    summary.exclusion_breakdown[reason] = (summary.exclusion_breakdown[reason] || 0) + 1;
  }

  return summary;
}

module.exports = { generateSummary };
