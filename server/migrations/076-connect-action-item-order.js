// Action items keep the order they were typed in.
//
// The list was ordered by created_at, which looks like an order and is
// not one: every item on a connect is inserted inside the same
// transaction, and now() is the TRANSACTION's timestamp, so they all
// share it to the microsecond. With the sort column tied, Postgres is
// free to return them in any order — and an UPDATE rewrites the row,
// which in practice moves it, so ticking one item reorders the list
// under the person who ticked it.
//
// Nothing about that is visible in a passing test on a fresh row: the
// two orders agree until something is updated. It surfaced as a test
// asserting that a toggled item stays done, which failed because
// action_items[0] was a different item by then.
async function up(db) {
  await db.query(`ALTER TABLE pms.connect_action_items
    ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0`);
  // Existing rows: keep whatever order they have now, made explicit.
  await db.query(`
    WITH ranked AS (
      SELECT id, row_number() OVER (PARTITION BY connect_id ORDER BY created_at, id) AS n
        FROM pms.connect_action_items)
    UPDATE pms.connect_action_items ai SET sort_order = ranked.n
      FROM ranked WHERE ranked.id = ai.id AND ai.sort_order = 0`);
}
module.exports = { up };
