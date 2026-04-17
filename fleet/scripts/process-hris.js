const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');

function processHRIS(feedPath, rosterMap) {
  const feedContent = fs.readFileSync(feedPath, 'utf-8');
  const records = parse(feedContent, { columns: true, skip_empty_lines: true, trim: true });

  const actions = {
    new_hires: [],
    terminated: [],
    leave: [],
    return_from_leave: [],
    retroactive: [],
    active: [],
    active_no_autoload: []
  };

  for (const rec of records) {
    const rosterEntry = rosterMap ? rosterMap[rec.employee_id] : null;

    switch (rec.status) {
      case 'new_hire':
        actions.new_hires.push(rec);
        break;
      case 'terminated':
        actions.terminated.push(rec);
        break;
      case 'leave':
        actions.leave.push(rec);
        break;
      case 'return_from_leave':
        actions.return_from_leave.push(rec);
        break;
      case 'retroactive':
        actions.retroactive.push(rec);
        break;
      case 'active':
        if (rosterEntry && !rosterEntry.autoload_configured) {
          actions.active_no_autoload.push({ ...rec, roster: rosterEntry });
        } else {
          actions.active.push(rec);
        }
        break;
    }
  }

  return actions;
}

module.exports = { processHRIS };
