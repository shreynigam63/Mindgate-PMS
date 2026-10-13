// When a cycle's 9-box was last published (13 Oct review). Until now a
// cycle counted as published whenever it sat at publish or closed with
// placement rows on file, so a cycle rolled back to calibration and moved
// on to publish again showed the OLD boxes as published — and locked its
// settings — before anybody had pressed Publish a second time.
//
// Set by publish; cleared when the cycle is rolled back before publish.
async function up(db) {
  await db.query(`ALTER TABLE pms.cycles ADD COLUMN IF NOT EXISTS nine_box_published_at timestamptz`);
  // Cycles published under 089, before this column existed.
  await db.query(
    `UPDATE pms.cycles c SET nine_box_published_at = p.at
       FROM (SELECT cycle_id, max(placed_at) AS at FROM pms.nine_box_placements GROUP BY cycle_id) p
      WHERE p.cycle_id = c.id AND c.phase IN ('publish','closed') AND c.nine_box_published_at IS NULL`);
}
module.exports = { up };
