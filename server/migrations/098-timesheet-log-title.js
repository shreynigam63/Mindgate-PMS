// Timesheets: the Log Title column, kept (22 Oct).
//
// "In download template log title should be use as KRA title and KRA
// coverage will be mapped accordingly instead of item used as KRA
// coverage." The Zoho export has always carried a Log Title column (D);
// the client's exports leave it empty, and the parser did not read it.
// From now on it holds the KRA the log counts towards, so it is stored
// with the log and KRA coverage reads it (timesheet-kra-match.js).
//
// Nullable, no backfill: every log loaded before today has no Log Title,
// and KRA coverage places those by the item, exactly as before.
async function up(db) {
  await db.query(`ALTER TABLE pms.timesheet_entries ADD COLUMN IF NOT EXISTS log_title text`);
}

module.exports = { up };
