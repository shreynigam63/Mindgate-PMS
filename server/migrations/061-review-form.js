// The company's own appraisal form, as data.
//
// Asked for on 28 Sep with the workbook attached ("PMS_Form.xlsx") and a
// screenshot of the Mid-Year Review page: "Please find attached
// screenshot and headers on PMS form in mid-year review."
//
// The workbook is an export of the Google Form Mindgate runs their
// appraisal on today — one header row, 53 columns. Three kinds of thing
// are mixed together in it:
//
//   A  columns 1-11   who the person is: name, code, joining date,
//                     reporting manager, delivery head, designation
//   B  columns 12-35  KRA 1..8, each with a self rating and a
//                     justification
//   C  columns 36-53  everything the PMS had no home for: ten
//                     behavioural ratings in two blocks of five, two
//                     training questions, and six on running a team
//
// B is what this product already does, and does better — the KRA sheet
// is not capped at eight, the ratings are weighted, and the overall is
// derived rather than typed. A is already on the employee master. So
// this migration is about C, plus the two things in A that the master
// cannot answer.
//
// WHY A TABLE AND NOT A FORM COMPONENT. Two of these questions name
// specific years ("Training attended year 2024-2025"). Two more name a
// specific tool ("Support org Initiatives (Zoho / Hiring)"). Those will
// be wrong in April, and a form built in JSX would need a release to
// fix a year. Same rule as every other label and threshold in this
// product: it lives in a table and HR edits it.
//
// THE TWO SECTION NAMES ARE MINE. The export is a flat header row and
// the Google Form's own section titles did not survive it — the give-
// away is that the numbering restarts, "1. Go Getter ... 5. Passion"
// then "1. Adherence to Timelines ... 5. Quality Focus". Two blocks of
// five, so two sections. I have called them "Attitude & Drive" and
// "Discipline & Quality" from what the questions in each have in
// common. They are rows in a table; if Mindgate calls them something
// else, HR renames them without a release.
//
// form_key is 'midyear' because that is what was asked for. The same
// three tables serve an annual form the day somebody wants one.

async function up(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS pms.review_form_sections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      form_key text NOT NULL,
      title text NOT NULL,
      blurb text,
      sort_order integer NOT NULL DEFAULT 100,
      active boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, form_key, title)
    )`);

  // kind decides what the page renders and what the server will accept:
  //   rating  a value on the CYCLE'S rating scale, shown as a letter
  //   text    free text
  //   yes_no  a boolean, stored in the text column as 'yes'/'no' so a
  //           question can be changed from yes_no to text later without
  //           losing what people already answered
  await db.query(`
    CREATE TABLE IF NOT EXISTS pms.review_form_questions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      section_id uuid NOT NULL REFERENCES pms.review_form_sections(id) ON DELETE CASCADE,
      label text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('rating','text','yes_no')),
      required boolean NOT NULL DEFAULT false,
      sort_order integer NOT NULL DEFAULT 100,
      active boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, section_id, label)
    )`);

  // One row per person per question per cycle. `perspective` is here
  // because the manager's half of this page already exists and will
  // want the same sections one day; today only 'self' is written.
  //
  // Rating and text are separate columns rather than one jsonb blob:
  // "what did the team average on Quality Focus" is a question HR will
  // ask, and it should be a SUM, not a scan of json.
  await db.query(`
    CREATE TABLE IF NOT EXISTS pms.review_form_answers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      cycle_id uuid NOT NULL,
      employee_id uuid NOT NULL,
      question_id uuid NOT NULL REFERENCES pms.review_form_questions(id) ON DELETE CASCADE,
      perspective text NOT NULL DEFAULT 'self' CHECK (perspective IN ('self','manager')),
      rating numeric(3,1),
      answer_text text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, cycle_id, employee_id, question_id, perspective)
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS review_form_answers_lookup
                    ON pms.review_form_answers (tenant_id, cycle_id, employee_id)`);

  // ---- the form, transcribed from PMS_Form.xlsx -----------------------
  //
  // [title, blurb, [[label, kind, required], ...]]
  //
  // "About you" carries the two columns from the identity block that the
  // employee master genuinely cannot answer. Everything else in that
  // block — name, code, joining date, designation, reporting manager,
  // delivery head — is already on record and is shown at the top of the
  // page as fact, not asked again. Total experience is a whole CAREER,
  // which the master does not hold (it holds a joining date, which is
  // tenure here and a different number); technology used is not on the
  // master at all.
  const FORM = [
    ['About you', 'Two things the employee record cannot answer for you.', [
      ['Total Years of Experience', 'text', true],
      ['Technology Used', 'text', false],
    ]],
    ['Attitude & Drive', 'Rate yourself on each, on the same scale as your KRAs.', [
      ['Go Getter', 'rating', false],
      ['Availability during critical deliverables', 'rating', false],
      ['Customer Focus', 'rating', false],
      ['Ability to Handle Pressure', 'rating', false],
      ['Passion', 'rating', false],
    ]],
    ['Discipline & Quality', 'Rate yourself on each, on the same scale as your KRAs.', [
      ['Adherence to Timelines', 'rating', false],
      ['Adherence to Process', 'rating', false],
      ['Adherence to Org Policies', 'rating', false],
      ['Support org Initiatives (Zoho / Hiring)', 'rating', false],
      ['Quality Focus', 'rating', false],
    ]],
    ['Learning & Training', 'What you have done, and what you need next.', [
      ['Training attended year 2024-2025', 'text', false],
      ['Training Required for 2025-2026', 'text', false],
    ]],
    ['Team & Capability Building', 'Answer the first one; the rest apply if you lead a team.', [
      ['Are you handling Team?', 'yes_no', false],
      ['Mentoring and Grooming within Team', 'text', false],
      ['No Dependencies, backups created', 'text', false],
      ['Create Knowledge repositories / documents', 'text', false],
      ['System rather than people focus', 'text', false],
      ['Contribute towards capability building initiatives', 'text', false],
    ]],
  ];

  const tenants = (await db.query(`SELECT id FROM core.tenants`)).rows;
  for (const t of tenants) {
    for (let s = 0; s < FORM.length; s++) {
      const [title, blurb, questions] = FORM[s];
      // DO UPDATE on the wording, because this is a transcription of the
      // client's own form and a correction to it has to reach a tenant
      // that already ran this. The ANSWERS are untouched either way, and
      // a question HR has added themselves is not in this list so it is
      // never removed.
      const sec = (await db.query(
        `INSERT INTO pms.review_form_sections (tenant_id, form_key, title, blurb, sort_order)
         VALUES ($1,'midyear',$2,$3,$4)
         ON CONFLICT (tenant_id, form_key, title)
         DO UPDATE SET blurb=EXCLUDED.blurb, sort_order=EXCLUDED.sort_order
         RETURNING id`, [t.id, title, blurb, (s + 1) * 10])).rows[0];
      for (let q = 0; q < questions.length; q++) {
        const [label, kind, required] = questions[q];
        await db.query(
          `INSERT INTO pms.review_form_questions (tenant_id, section_id, label, kind, required, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, section_id, label)
           DO UPDATE SET kind=EXCLUDED.kind, required=EXCLUDED.required, sort_order=EXCLUDED.sort_order`,
          [t.id, sec.id, label, kind, required, (q + 1) * 10]);
      }
    }
  }
}

module.exports = { up };
