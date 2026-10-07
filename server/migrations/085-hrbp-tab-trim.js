// Nine pages off the HRBP tab — asked for on 7 Oct: "HRBP tab where points
// like cycles, HOD, career pathing matrix, settings, super 50, engagement
// surveys, 9 box grid, closure letters, increment simulation needs to be
// removed."
//
// The menu entries and routes went in the same change (App.jsx), and 069
// no longer seeds these rows on boot. This deletes the rows already
// there, so the page list /me returns, the sidebar and the direct-URL
// guard all agree that an HRBP does not have these pages. HR's own copies
// (/admin/...) are untouched.
//
// Run once per database by the migration runner; nothing to ensure at
// boot, because nothing re-creates the rows any more.

const REMOVED = [
  '/hrbp/cycles',
  '/hrbp/department-heads',
  '/hrbp/career-transitions',
  '/hrbp/settings',
  '/hrbp/watchlist',
  '/hrbp/engagement',
  '/hrbp/nine-box',
  '/hrbp/closure-letters',
  '/hrbp/increments',
];

async function up(db) {
  await db.query(`DELETE FROM core.page_permission WHERE route = ANY($1::text[])`, [REMOVED]);
}

module.exports = { up, REMOVED };
