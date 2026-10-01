// The quarterly connect form's questions, as data.
//
// Asked for: "Make the quarterly connect/discussion forms fully editable
// for HR admins to update questions."
//
// The wording was in the page — "What went well…", "What's stuck…",
// "Coaching / direction…" — so changing a question meant a release. That
// is exactly what the house rule about labels living in tables exists to
// prevent, and this is the form most likely to need rewording, because
// every client runs their 1:1s slightly differently.
//
// WHAT IS EDITABLE IS THE QUESTION, NOT THE STORAGE. Each row points at a
// column that already exists on pms.connects. HR can retitle a box, give
// it a new hint, reorder the form or switch a box off; HR cannot invent a
// fifth box, because there is nowhere to put its answer and a question
// whose answer is discarded is worse than no question. Adding a field is
// a migration, deliberately.

const SEED = [
  // key, field on pms.connects, label, hint, sort
  ['topic', 'topic', 'Topic', 'e.g. Mid-quarter check-in', 10],
  ['discussion', 'discussion_notes', 'What did you discuss?', 'The substance of the conversation.', 20],
  ['achievements', 'achievements', 'Achievements', 'What went well…', 30],
  ['blockers', 'blockers', 'Blockers', "What's stuck…", 40],
  ['feedback', 'feedback', 'Feedback', 'Coaching / direction…', 50],
];

// The only columns a question may point at. Anything else would be a
// question whose answer goes nowhere.
const FIELDS = SEED.map(([, f]) => f);

async function up(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.connect_questions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id),
    key         text NOT NULL,
    field       text NOT NULL,
    label       text NOT NULL,
    hint        text,
    sort_order  integer NOT NULL DEFAULT 100,
    active      boolean NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT connect_questions_field_check CHECK (field IN (${FIELDS.map((f) => `'${f}'`).join(',')})),
    CONSTRAINT connect_questions_label_check CHECK (btrim(label) <> '')
  )`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_connect_questions_key
    ON pms.connect_questions (tenant_id, key)`);

  // Seeded per existing tenant. A tenant created later gets them from
  // ensureConnectQuestions() at request time — index.js creates the
  // tenant AFTER migrations run, so seeding here alone would miss it.
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    await seedFor(db, id);
  }
}

async function seedFor(db, tenantId) {
  for (const [key, field, label, hint, sort] of SEED) {
    await db.query(
      `INSERT INTO pms.connect_questions (tenant_id, key, field, label, hint, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, key) DO NOTHING`,
      [tenantId, key, field, label, hint, sort]);
  }
}

module.exports = { up, SEED, FIELDS, seedFor };
