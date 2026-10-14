// Forgot password (15 Oct). A one-time code by email, not a link: a link
// needs the site's public address, and taking that from the request would
// let anyone aim a victim's reset email at their own site. The code is
// stored hashed, lives 30 minutes, allows five tries, and a new request
// replaces any earlier one.
async function up(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS core.password_resets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    email       text NOT NULL,
    code_hash   text NOT NULL,
    expires_at  timestamptz NOT NULL,
    attempts    int NOT NULL DEFAULT 0,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS password_resets_email ON core.password_resets (tenant_id, lower(email), created_at DESC)`);
}

module.exports = { up };
