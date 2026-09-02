// 015 — Cycle description field.
//
// FOUND MISSING while replacing the "New cycle" flow's three sequential
// prompt() dialogs with a proper in-page modal (per a direct design
// request, with a mockup): the mockup includes an optional "Description"
// field, but pms.cycles (migration 003) never had anywhere to store one.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.cycles ADD COLUMN IF NOT EXISTS description text`);
};
