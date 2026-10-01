// Technical skills, named by tier.
//
// Asked for: "Add explicit text/dropdown boxes for Primary, Secondary,
// Tertiary, and Basic technical skills rather than free-form selection."
//
// This is a different thing from what the competency framework already
// holds, which is a PROFICIENCY (1–5) against each competency HR
// defined. That answers "how good are you at this", for a fixed list.
// It does not answer "what is your main skill", and the two are not
// interchangeable: a developer rated Advanced on four technical
// competencies has still not said which one is their primary.
//
// Four columns on the assessment rather than a side table, because there
// is exactly one answer per tier per cycle and the assessment is already
// the thing that gets submitted, locked, reopened and reviewed by the
// manager. A side table would have needed all four of those behaviours
// rebuilt around it for no gain.
//
// Basic is deliberately the one that can hold several, comma separated —
// "what else can you do" has more than one answer, while primary by
// definition has one. The form says so.

const COLUMNS = ['tech_primary', 'tech_secondary', 'tech_tertiary', 'tech_basic'];

async function up(db) {
  for (const c of COLUMNS) {
    await db.query(`ALTER TABLE pms.competency_assessments ADD COLUMN IF NOT EXISTS ${c} text`);
  }
}

module.exports = { up, COLUMNS };
