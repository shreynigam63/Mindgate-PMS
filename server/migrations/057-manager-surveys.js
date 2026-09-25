// Engagement phase 4: a survey ABOUT somebody else.
//
// Asked for on 25 Sep: "BUT — YOU SHOULD ALSO SURVEY THE MANAGER. This
// is critical. If you only ask employees, your PMS will capture
// perception, but not the manager's assessment."
//
// Every survey until now was answered by an invited employee about
// themselves, and the whole schema says so: one invitation per person
// per survey, enforced by the primary key (survey_id, employee_id). A
// manager with four new joiners needs four invitations to one survey —
// same manager, four different subjects — so that key has to go.
//
// What changes:
//
//   audience_kind          'self' is everything that exists today.
//                          'manager_about_reportee' means the audience
//                          rule selects the people being ASSESSED, and
//                          the invitation goes to each one's manager.
//
//   subject_employee_id    on the invitation and on the response: who
//                          the answers are about. NULL on a self
//                          survey, which is every existing row.
//
//   invitations.id         a surrogate key, because (survey_id,
//                          employee_id) can no longer be unique. The
//                          real uniqueness rule becomes the triple,
//                          with NULLS NOT DISTINCT so a self survey
//                          still cannot invite the same person twice —
//                          without it two NULL subjects count as
//                          different rows and the sweep would invite
//                          everybody again every night.
//
// A MANAGER SURVEY CAN NEVER BE ANONYMOUS, and that is a constraint
// rather than a convention. The answers are an assessment of a named
// person by their named manager; "anonymous" would be a lie on the
// form, and worse, storing a subject against an otherwise anonymous
// response would hand HR a way to identify respondents on a survey
// that promised it would not. The CHECK below makes it unrepresentable.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE engagement.surveys
    ADD COLUMN IF NOT EXISTS audience_kind text NOT NULL DEFAULT 'self'`);

  await db.query(`DO $$ BEGIN
    ALTER TABLE engagement.surveys ADD CONSTRAINT surveys_manager_not_anonymous
      CHECK (audience_kind = 'self' OR anonymity_default = false);
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  await db.query(`ALTER TABLE engagement.invitations
    ADD COLUMN IF NOT EXISTS subject_employee_id uuid`);
  await db.query(`ALTER TABLE engagement.invitations
    ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid()`);

  // Swap the primary key. The old one is what forbids a manager being
  // invited about two different people, so it cannot simply stay.
  await db.query(`ALTER TABLE engagement.invitations DROP CONSTRAINT IF EXISTS invitations_pkey`);
  await db.query(`DO $$ BEGIN
    ALTER TABLE engagement.invitations ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);
  EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$`);

  // The uniqueness that actually matters, and the thing every
  // ON CONFLICT DO NOTHING in the invite path relies on. NULLS NOT
  // DISTINCT (Postgres 15+) is the load-bearing word: on a self survey
  // the subject is NULL, and under the default NULLS DISTINCT two such
  // rows would both insert, so the nightly sweep would re-invite the
  // whole company every time it ran.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS invitations_one_per_subject
    ON engagement.invitations (survey_id, employee_id, subject_employee_id) NULLS NOT DISTINCT`);

  await db.query(`ALTER TABLE engagement.responses
    ADD COLUMN IF NOT EXISTS subject_employee_id uuid`);

  // The library learns the same word, and the three manager templates
  // are seeded for every tenant that already has a library. Existing
  // rows are untouched: seedTemplates only inserts what is missing, so
  // a tenant who edited "Day 30 Connect" keeps their version.
  await db.query(`ALTER TABLE engagement.survey_templates
    ADD COLUMN IF NOT EXISTS audience_kind text NOT NULL DEFAULT 'self'`);
  const { seedTemplates } = require('./056-survey-templates');
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    await seedTemplates(db, id);
  }

  // Reading one manager's list, and reading everything said about one
  // employee, are the two queries this feature exists for.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_invitations_subject
    ON engagement.invitations (tenant_id, subject_employee_id) WHERE subject_employee_id IS NOT NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_responses_subject
    ON engagement.responses (tenant_id, subject_employee_id) WHERE subject_employee_id IS NOT NULL`);
};
