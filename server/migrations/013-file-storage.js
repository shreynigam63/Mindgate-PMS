// 013 — Evidence upload (BRD Phase-4 item, table existed since migration
// 003 but nothing wrote to it) and closure-letter PDF generation
// (also flagged as deferred to "Phase 4 template engine decision" in
// modules/performance/index.js's own comments — this migration and the
// routes built alongside it are that decision).
//
// STORAGE CHOICE: file bytes are stored directly in Postgres (bytea),
// not on the application server's local disk and not in an external
// object store (S3/GCS/etc). Two reasons: (1) this deploys to Render as
// a web service with an EPHEMERAL filesystem — anything written to local
// disk is silently lost on the next restart or redeploy, which would be
// a much worse failure mode than "slightly heavier database rows"; (2)
// no object-storage credentials exist to configure in this environment,
// and Postgres is the one piece of real, persistent infrastructure
// already wired up and tested. For a POC's expected evidence/letter
// volume this is a reasonable choice; a client's production deployment
// with heavy file volume would eventually want dedicated object storage
// instead — worth flagging during UAT, not a silent decision.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.evidence ALTER COLUMN storage_key DROP NOT NULL`);
  await db.query(`ALTER TABLE pms.evidence ADD COLUMN IF NOT EXISTS file_data bytea`);
  await db.query(`ALTER TABLE pms.evidence ADD COLUMN IF NOT EXISTS content_type text`);
  await db.query(`ALTER TABLE pms.evidence ADD COLUMN IF NOT EXISTS file_size integer`);

  await db.query(`ALTER TABLE pms.closure_letters ADD COLUMN IF NOT EXISTS file_data bytea`);
  await db.query(`ALTER TABLE pms.closure_letters ADD COLUMN IF NOT EXISTS content_type text DEFAULT 'application/pdf'`);
  await db.query(`ALTER TABLE pms.closure_letters ADD COLUMN IF NOT EXISTS generated_by text`);
};
