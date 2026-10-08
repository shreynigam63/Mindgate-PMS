// The RnR Dashboard and My Nominations pages — off, 8 Oct.
//
// Both showed the same company-wide screen: every nominee, with department
// and nominator, to any signed-in person who typed the address (neither was
// ever in a menu). Asked for: "it should not be visible currently, in
// future if we want we will allow this display access."
//
// The server now refuses the company-wide list without rnr_view_all, a
// permission no role holds by default; the frontend routes are behind
// SHOW_RNR_DASHBOARD; and 078 no longer seeds these rows. This deletes the
// rows already there, so the page list /me returns agrees.
//
// To open it again: grant rnr_view_all to the roles that should see it,
// put the two rows back, and turn the switch on.

const REMOVED = ['/rnr/dashboard', '/rnr/my-nominations'];

async function up(db) {
  await db.query(`DELETE FROM core.page_permission WHERE route = ANY($1::text[])`, [REMOVED]);
}

module.exports = { up, REMOVED };
