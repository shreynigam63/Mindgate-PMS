// 044 — Department on the Career Pathing Matrix.
//
// Asked for on 23 Sep with the filled-in template attached: Department as
// the first column of the career transitions sheet. A ladder is not
// company-wide in a business with 1,400 people across ~230 departments —
// "Executive → Senior Executive" means a different thing in Sales and in
// Infrastructure, and the two need different competencies and different
// time-in-role expectations.
//
// NULLABLE, and null means "every department", for two reasons. Every
// transition already on file was written without a department and must
// keep applying to everyone — backfilling them with a guess would quietly
// narrow a live matrix. And a genuinely company-wide ladder rung stays
// expressible, which is the common case for a small tenant.
//
// The same shape the KRA library uses for its shelves (company-wide row
// or department row, most specific wins), on purpose: HR has learnt that
// rule once already and a second, different one is a second thing to get
// wrong.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE people.career_transitions
                    ADD COLUMN IF NOT EXISTS department text`);
  // Matching reads (tenant, department, from_role) on every career-path
  // view an employee opens, so the department joins the index rather than
  // being filtered out after the fact.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_career_transitions_dept
                    ON people.career_transitions(tenant_id, lower(btrim(coalesce(department,''))), lower(btrim(from_role)))`);
};
