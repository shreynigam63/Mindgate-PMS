// MoM: an AI draft for a MoM that is already published (15 Oct: "I don't
// see the option of creating the MoM using AI" — on a published MoM, the
// transcript upload was gone).
//
// The draft cannot be written into a published MoM: nothing may change
// there until the organiser saves. So it waits on the transcript row as a
// suggestion; the editor opens with it, and Save changes makes it the MoM.
//   suggestion_status   processing | ready | failed | used | discarded
async function up(db) {
  await db.query(`ALTER TABLE pms.mom_transcripts ADD COLUMN IF NOT EXISTS suggestion jsonb`);
  await db.query(`ALTER TABLE pms.mom_transcripts ADD COLUMN IF NOT EXISTS suggestion_status text`);
  await db.query(`ALTER TABLE pms.mom_transcripts ADD COLUMN IF NOT EXISTS suggestion_error text`);
  await db.query(`ALTER TABLE pms.mom_transcripts ADD COLUMN IF NOT EXISTS suggestion_at timestamptz`);
  await db.query(`ALTER TABLE pms.mom_transcripts DROP CONSTRAINT IF EXISTS mom_transcripts_suggestion_status_check`);
  await db.query(`ALTER TABLE pms.mom_transcripts ADD CONSTRAINT mom_transcripts_suggestion_status_check
    CHECK (suggestion_status IS NULL OR suggestion_status IN ('processing','ready','failed','used','discarded'))`);
}

module.exports = { up };
