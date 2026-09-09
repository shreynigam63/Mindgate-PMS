// 033 — KRA library, keyed on designation.
//
// WHAT THIS IS FOR. The bulk importer that already exists is keyed on
// employee_email: HR names a person and pushes rows straight onto their
// sheet. That is assignment, and it scales with headcount — forty Senior
// Software Engineers means forty blocks of rows saying much the same
// thing, re-typed every cycle.
//
// This is the other shape of the same idea: HR publishes a shelf of
// suggested KRAs ONCE per designation, and every employee holding that
// designation picks the ones that apply to them. One upload covers the
// forty, and it is still there next year.
//
// The two coexist deliberately. Assignment can say "this person, these
// KRAs" in a way a library never can, and the library can offer a choice
// in a way assignment never can.
//
// DELIBERATELY NOT SCOPED TO A CYCLE. A library is reference data about
// roles, not about a year. Tying it to a cycle would mean re-uploading
// every shelf each time HR opens a new one, which is most of the work
// this is meant to remove. Rows a person picks are COPIED onto their
// sheet (pms.kras), so revising the library mid-cycle cannot rewrite a
// KRA somebody has already agreed with their manager.
//
// SUGGESTED WEIGHT IS A SUGGESTION, AND THE SHELF IS EXPECTED TO
// OVER-TOTAL. A designation offering seven KRAs worth 105 between them is
// the normal, healthy case — it is a menu, and the employee picks a
// hundred points' worth. So nothing here enforces a total of 100; the
// existing rule still applies where it belongs, at submit time on the
// person's own sheet.
//
// HOW A RE-UPLOAD BEHAVES. Uploading replaces every row for the
// designations present in the file and leaves all other designations
// untouched, so Engineering can be corrected without disturbing Sales.
// That is why there is no unique constraint and no ON CONFLICT: the
// commit is a delete-then-insert per designation inside one transaction,
// which is both simpler to reason about and the only way to express "this
// designation now has exactly these six KRAs, and the seventh is gone".
module.exports.up = async (db) => {
  await db.query(`CREATE SCHEMA IF NOT EXISTS pms`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.kra_library (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL,
    designation      text NOT NULL,
    category         text,
    title            text NOT NULL,
    measures         text,
    description      text,
    suggested_weight numeric(6,2),
    sort_order       integer NOT NULL DEFAULT 0,
    uploaded_by      text,
    uploaded_at      timestamptz NOT NULL DEFAULT now()
  )`);

  // CREATE TABLE IF NOT EXISTS silently does nothing when the table is
  // already there, so every column is also ensured individually — a
  // half-applied earlier run must be able to complete on the next boot.
  for (const [col, type] of [
    ['tenant_id', 'uuid'], ['designation', 'text'], ['category', 'text'],
    ['title', 'text'], ['measures', 'text'], ['description', 'text'],
    ['suggested_weight', 'numeric(6,2)'], ['sort_order', 'integer'],
    ['uploaded_by', 'text'], ['uploaded_at', 'timestamptz'],
  ]) {
    await db.query(`ALTER TABLE pms.kra_library ADD COLUMN IF NOT EXISTS ${col} ${type}`);
  }

  // The one query this table exists to answer: "what is on the shelf for
  // this person's designation". Matched on lower(btrim(...)) because the
  // designation on an employee record and the one typed into a
  // spreadsheet will differ by case and stray spaces — and a shelf that
  // silently fails to match is indistinguishable, to the employee, from
  // a shelf that is empty.
  await db.query(`CREATE INDEX IF NOT EXISTS kra_library_designation_idx
    ON pms.kra_library (tenant_id, lower(btrim(designation)), sort_order)`);
};
