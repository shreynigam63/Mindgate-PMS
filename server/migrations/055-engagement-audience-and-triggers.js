// Engagement phase 1+2: who a survey goes to, and when it goes.
//
// Asked for on 25 Sep: "We need to create engagement form in the
// engagement survey which will be pushed to all employees who are
// fitting in that employees categories" — and a lifecycle of
// Day 1 / Week 1 / 30 / 60 / 90 driven off the date of joining.
//
// Until now a survey's audience was a single text column holding either
// 'all' or 'department:<name>', and the New Survey screen did not even
// expose it, so every survey created through the UI went to the whole
// company. Releasing was a manual press of Open, once, forever.
//
// Three things change here:
//
//   audience_rule  a jsonb rule — departments, designations, role bands,
//                  managers, and a tenure window — replacing the one
//                  text field. Empty object means everybody, which is
//                  what 'all' meant.
//
//   trigger_*      'manual' keeps today's behaviour exactly. 'tenure'
//                  makes the survey a STANDING one: it stays open and
//                  the daily sweep invites each employee as they reach
//                  the window, so Day 30 catches this week's joiners
//                  and next week's without anyone pressing anything.
//
//   value_list     a multi-select answer. 'choice' already existed in
//                  the schema and was implemented nowhere; it rendered
//                  to the employee as a 1-5 scale and reported n=0.
//
// The tenure trigger is a WINDOW, never an exact day. On the real
// Mindgate master the day-counts of recent joiners run 15, 17, 18, 23,
// 24, 29, 32, 38 — almost nobody is sitting on exactly 30, so
// `days = 30` would silently miss most of a cohort, and one missed
// sweep would skip a whole day's intake permanently. The window plus
// the invitations primary key (survey_id, employee_id) makes the sweep
// idempotent: running it twice, or ten times, invites each person once.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE engagement.surveys
    ADD COLUMN IF NOT EXISTS audience_rule jsonb`);
  await db.query(`ALTER TABLE engagement.surveys
    ADD COLUMN IF NOT EXISTS trigger_type text NOT NULL DEFAULT 'manual'`);
  await db.query(`ALTER TABLE engagement.surveys
    ADD COLUMN IF NOT EXISTS trigger_day integer`);
  await db.query(`ALTER TABLE engagement.surveys
    ADD COLUMN IF NOT EXISTS trigger_window_days integer NOT NULL DEFAULT 7`);
  await db.query(`ALTER TABLE engagement.surveys
    ADD COLUMN IF NOT EXISTS last_swept_at timestamptz`);
  await db.query(`ALTER TABLE engagement.surveys
    ADD COLUMN IF NOT EXISTS swept_count integer NOT NULL DEFAULT 0`);

  // A tenure trigger without a day is not a trigger. Enforced here so a
  // half-configured survey cannot sit open sweeping nobody in silence.
  await db.query(`DO $$ BEGIN
    ALTER TABLE engagement.surveys ADD CONSTRAINT surveys_trigger_day_ck
      CHECK (trigger_type <> 'tenure' OR trigger_day IS NOT NULL);
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  // Multi-select. 'choice' keeps using value_text — one answer, one
  // string — so nothing that already stored a choice has to move.
  await db.query(`ALTER TABLE engagement.answers
    ADD COLUMN IF NOT EXISTS value_list text[]`);

  // Carry the old text audience across, so every survey has a rule and
  // no code path has to keep guessing which field to read. 'all' and
  // anything unrecognised become {} — everybody — which is what the
  // open handler did with them.
  await db.query(`UPDATE engagement.surveys
     SET audience_rule = CASE
           WHEN target_audience LIKE 'department:%'
             THEN jsonb_build_object('departments',
                    jsonb_build_array(substr(target_audience, length('department:') + 1)))
           ELSE '{}'::jsonb
         END
   WHERE audience_rule IS NULL`);

  // The sweep reads open tenure surveys every day; the invitation
  // lookup per employee is the hot path.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_surveys_open_tenure
    ON engagement.surveys (tenant_id) WHERE status='open' AND trigger_type='tenure'`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_invitations_employee
    ON engagement.invitations (tenant_id, employee_id)`);
};
