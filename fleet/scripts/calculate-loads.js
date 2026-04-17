function calculateLoads(exceptionEmployees, config) {
  const cap = config.epurse_cap;
  const subsidy = config.monthly_subsidy;
  const cycleMonth = new Date().toISOString().slice(0, 7);

  const results = [];

  for (const emp of exceptionEmployees) {
    if (emp.current_balance === null || emp.current_balance === undefined) continue;

    const capRoom = cap - emp.current_balance;
    let baseAmount = subsidy;
    let retroAmount = 0;

    if (emp.hris_status === 'retroactive') {
      retroAmount = subsidy * (config.retroactive_months || 1);
    }

    if (emp.hris_status === 'terminated' || emp.hris_status === 'leave') {
      results.push({
        employee_id: emp.employee_id,
        employee_name: emp.employee_name,
        card_csn: emp.card_csn,
        cycle_month: cycleMonth,
        base_amount: 0,
        retroactive_amount: 0,
        cap_room: capRoom,
        actual_load: 0,
        forfeited: 0,
        load_method: 'excluded',
        exclusion_reason: emp.hris_status,
      });
      continue;
    }

    const totalOwed = baseAmount + retroAmount;
    const actualLoad = Math.min(totalOwed, Math.max(0, capRoom));
    const forfeited = totalOwed - actualLoad;

    let loadMethod = 'excluded';
    if (actualLoad > 0) {
      // Check if it's a standard bulk amount
      if (actualLoad === 50 || actualLoad === 100) {
        loadMethod = 'bulk';
      } else {
        loadMethod = 'manual';
      }
    }

    const exclusionReason = actualLoad === 0 ? (capRoom <= 0 ? 'at_cap' : 'no_load_needed') : null;

    results.push({
      employee_id: emp.employee_id,
      employee_name: emp.employee_name,
      card_csn: emp.card_csn,
      cycle_month: cycleMonth,
      base_amount: baseAmount,
      retroactive_amount: retroAmount,
      cap_room: capRoom,
      actual_load: actualLoad,
      forfeited,
      load_method: actualLoad > 0 ? loadMethod : 'excluded',
      exclusion_reason: exclusionReason,
    });
  }

  return results;
}

module.exports = { calculateLoads };
