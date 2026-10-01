// Half-yearly cycles.
//
// The brief asked for "Quarterly / Half-Yearly / Annual nomination
// cycles" and the first build shipped two of the three. This adds the
// missing one.
//
// BOTH constraints move, not just the cycle's. A cycle offers the awards
// whose frequency matches it, so a half-yearly cycle with no half-yearly
// awards would open successfully and then show a manager an empty award
// picker — the kind of half-finished feature that looks like a bug in the
// eligibility engine rather than a gap in the master.
const KINDS = ['quarterly', 'half_yearly', 'annual'];

async function up(db) {
  await db.query(`ALTER TABLE rnr.cycles DROP CONSTRAINT IF EXISTS cycles_kind_check`);
  await db.query(
    `ALTER TABLE rnr.cycles ADD CONSTRAINT cycles_kind_check
       CHECK (kind IN (${KINDS.map((k) => `'${k}'`).join(',')}))`);

  await db.query(`ALTER TABLE rnr.awards DROP CONSTRAINT IF EXISTS awards_frequency_check`);
  await db.query(
    `ALTER TABLE rnr.awards ADD CONSTRAINT awards_frequency_check
       CHECK (frequency IN (${KINDS.map((k) => `'${k}'`).join(',')}))`);
}

module.exports = { up, KINDS };
