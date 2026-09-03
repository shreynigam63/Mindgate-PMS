// 029 — AI recommendations that stick.
//
// THE PROBLEM. Every AI feature here produced text that appeared in a
// panel and vanished when the page was closed. The raw exchange was
// archived to agentic.drafts, but that is a log — nobody browses it, and
// there was no way to say "yes, do that", no way to see what was
// suggested last cycle, and no way to answer "did anyone act on this".
// Asked for AI recommendations to be given more consideration, which they
// cannot be while they are transient.
//
// A ROW PER RECOMMENDATION, not per draft. A single draft carries several
// suggestions — five development goals, three milestones, a bullet per
// KRA — and they are accepted or dismissed one at a time. Storing the
// whole draft as one accept/reject would force an all-or-nothing decision
// on things that are not one decision.
//
// draft_id keeps the link back to the full exchange (what the model was
// shown, what it said, which model, when) so an accepted recommendation
// can always be traced to its evidence. NOT a foreign key: agentic.drafts
// is a log with its own retention, and a recommendation someone acted on
// must not disappear because the log behind it was pruned.
//
// status is text, not an enum: 'suggested' | 'accepted' | 'dismissed' |
// 'done'. New states are likely as this gets used, and an enum would need
// a migration for each.
//
// SCOPED TO A SUBJECT, not just a requester. about_employee_id is who the
// recommendation concerns, which is what makes "show me everything ever
// suggested about this person" answerable — and what makes it deletable
// on a GDPR erasure.
module.exports.up = async (db) => {
  await db.query(`CREATE SCHEMA IF NOT EXISTS agentic`);
  await db.query(`CREATE TABLE IF NOT EXISTS agentic.recommendations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL,
    draft_id          uuid,
    kind              text NOT NULL,
    cycle_id          uuid,
    about_employee_id uuid NOT NULL,
    -- What it is about, when the recommendation hangs off something
    -- specific: a KRA id, a milestone, a development goal. Free-form
    -- because the referent differs per kind.
    ref               jsonb NOT NULL DEFAULT '{}'::jsonb,
    title             text NOT NULL,
    detail            text,
    status            text NOT NULL DEFAULT 'suggested',
    -- Why it was dismissed. A dismissal without a reason teaches nobody
    -- anything; this is what makes a pattern of bad suggestions visible.
    decided_by        text,
    decided_at        timestamptz,
    decision_note     text,
    created_at        timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_recs_subject
    ON agentic.recommendations (tenant_id, about_employee_id, status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_recs_cycle
    ON agentic.recommendations (tenant_id, cycle_id, kind)`);
};
