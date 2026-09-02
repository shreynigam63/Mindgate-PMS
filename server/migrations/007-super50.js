// 007 — Super 50 / High-Performer Watchlist (BR-6.5).
//
// RATING-SCALE MAPPING (same decision point as migrations/006-pip.js,
// applied consistently): the BRD phrases this rule in letter grades — "3
// consecutive A/A+ ratings, with the most recent cycle rated A+" — but the
// schema's rating_scale (migration 003) is numeric 1-5 with English labels;
// there is no letter grade anywhere in the product. Reading "A/A+" as the
// top two numeric values (4=Exceeds, 5=Outstanding) and "A+" specifically
// as the top value (5=Outstanding) is the closest mapping onto the scale
// that actually exists, and — like the PIP threshold — is a judgment call
// to confirm with the client HR team during UAT, not a hardcoded certainty.
//
// The flag is PERSISTED on core.employees (alongside the existing
// potential_rating/nine_box_cell write-back columns) rather than computed
// fresh on every read, because it is recomputed at the same moment those
// other fields are — at /publish, from that cycle's now-final history —
// and because Retention Alerts (next feature) needs to query "who is
// currently flagged" directly without re-deriving the 3-cycle rule itself.
// A lapse in the streak clears the flag: this is a "currently on the
// watchlist" flag, not a permanent badge — losing the streak removes an
// employee from active retention-alert consideration, which is correct
// (matches the BRD's "consistent top performers" framing).

module.exports.up = async (db) => {
  await db.query(`ALTER TABLE core.employees ADD COLUMN IF NOT EXISTS super50_flag boolean NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE core.employees ADD COLUMN IF NOT EXISTS super50_since timestamptz`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_employees_super50 ON core.employees(tenant_id, super50_flag) WHERE super50_flag`);
};
