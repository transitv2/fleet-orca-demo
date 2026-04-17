const { stringify } = require('csv-stringify/sync');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');

function generateParticipantCSV(orderExportPath, hrisNewHires, outputPath) {
  // Read order export to get PrintedCardNumbers
  const orderContent = fs.readFileSync(orderExportPath, 'utf-8');
  const orderRecords = parse(orderContent, { columns: true, skip_empty_lines: true, trim: true });

  // Extract card numbers from order export
  const cardNumbers = orderRecords.map(r => r.PrintedCardNumber).filter(Boolean);

  // Match new hires to card numbers (arbitrary assignment, sorted by CSN)
  cardNumbers.sort();

  const participants = [];
  for (let i = 0; i < Math.min(cardNumbers.length, hrisNewHires.length); i++) {
    const csn = cardNumbers[i];
    const hire = hrisNewHires[i];
    const [firstName, ...lastParts] = hire.employee_name.split(' ');
    const lastName = lastParts.join(' ');

    participants.push({
      PrintedCardNumber: csn,
      Identifier: csn,
      FirstName: firstName,
      LastName: lastName,
      Email: hire.email,
      GroupName: hire.location
    });
  }

  // Sort by CSN ascending
  participants.sort((a, b) => a.PrintedCardNumber.localeCompare(b.PrintedCardNumber));

  const csv = stringify(participants, { header: true });
  fs.writeFileSync(outputPath, csv);

  return participants;
}

module.exports = { generateParticipantCSV };
