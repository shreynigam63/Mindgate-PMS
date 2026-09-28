// Two changes to the Mid-Year form, both asked for on 28 Sep on
// screenshots of it.
//
//   1. "About you as shown in screenshot is not needed."
//   2. "Yes/No option for team capability, description box should be
//      available on if case 'Yes' is selected, in case of 'No' below
//      description boxes should vanish."
//
// WHY THE SECOND ONE IS A COLUMN AND NOT AN `if`. The obvious
// implementation is for the page to look for a question called "Are
// you handling Team?" and hide the five below it. That breaks the
// moment HR rewords the question — which they are explicitly allowed
// to do, this whole form being table-driven — and it breaks silently,
// leaving five boxes on screen for people with no team. So the
// dependency is stored: a question names the question it depends on
// and the answer that reveals it.
//
// DEACTIVATED, NOT DELETED, for "About you". Ten answers already exist
// on the PoC, and a DELETE cascades to them. Nobody asked for anybody's
// answers to be destroyed — they asked for two boxes to stop appearing,
// and active=false does exactly that: assemble() drops inactive
// questions, and a section with no live questions left drops with them.
// It is also reversible by one UPDATE if this turns out to be wrong.

async function up(db) {
  await db.query(`
    ALTER TABLE pms.review_form_questions
      ADD COLUMN IF NOT EXISTS depends_on uuid REFERENCES pms.review_form_questions(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS depends_value text`);

  // ---- 1. retire "About you" -----------------------------------------
  // Scoped by form_key AND title. Another tenant is free to have made
  // their own section called something similar on another form; this
  // only touches the one seeded by 061.
  await db.query(`
    UPDATE pms.review_form_questions q SET active=false, updated_at=now()
      FROM pms.review_form_sections s
     WHERE s.id = q.section_id AND s.form_key='midyear' AND s.title='About you'`);
  await db.query(`
    UPDATE pms.review_form_sections SET active=false, updated_at=now()
     WHERE form_key='midyear' AND title='About you'`);

  // ---- 2. the team questions hang off the Yes/No ----------------------
  // The gate is found by its KIND within its section rather than by its
  // wording: it is the one yes_no question in "Team & Capability
  // Building". That survives a rewording of the gate itself, which is
  // the failure this whole design is avoiding.
  const gates = (await db.query(`
    SELECT q.id, q.tenant_id, q.section_id
      FROM pms.review_form_questions q
      JOIN pms.review_form_sections s ON s.id = q.section_id
     WHERE s.form_key='midyear' AND s.title='Team & Capability Building'
       AND q.kind='yes_no' AND q.active`)).rows;

  for (const g of gates) {
    // Everything else in that section, revealed only by "yes". Set by
    // sort_order, not by label, so a reworded question still hangs off
    // the gate.
    await db.query(`
      UPDATE pms.review_form_questions
         SET depends_on=$1, depends_value='yes', updated_at=now()
       WHERE tenant_id=$2 AND section_id=$3 AND id <> $1`,
      [g.id, g.tenant_id, g.section_id]);
  }
}

module.exports = { up };
