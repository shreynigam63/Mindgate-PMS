// 025 — KRA category (the client sheet's "Parameters" column).
//
// The KRA goal sheets in use carry a Parameters column that groups every
// KRA under a balanced-scorecard heading — Financial, Project / Process,
// Customer, People. It is a real part of how these sheets are read: the
// column is filled once per group and left blank down the rest of the
// group, so the grouping is the structure of the document, not decoration.
//
// pms.kras had nowhere to put it, so adopting those sheets as the import
// template would have meant dropping it on the floor. Stored rather than
// discarded so KRA lists can be grouped the way the source sheet groups
// them, and so an AI draft can be organised by category as well as by KRA.
//
// Nullable and additive: every KRA created through the app's own forms
// (which have no category field) keeps working unchanged, and existing
// rows stay exactly as they are.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.kras ADD COLUMN IF NOT EXISTS category text`);
};
