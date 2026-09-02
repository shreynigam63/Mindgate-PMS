// AI narration client — Agentic PMS core.
//
// THE house rule, enforced at the only entry point: deterministic numbers,
// AI narrates. Callers build their input with SQL, pass it here with a
// purpose tag; the output is a DRAFT, stored with the exact input that
// produced it (agentic.drafts). No AI call can produce a rating, score, or
// distribution — module code must never parse numbers out of AI text into
// rating fields, and stripRatingSuggestions() removes rating-shaped keys
// from structured outputs as a second line of defence.
//
// Configuration per instance: ANTHROPIC_API_KEY (absent = agentic features
// return 503 with a clear message, everything else works), AI_MODEL.

const db = require('./db');
const logger = require('./logger');

const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-5';
const API = 'https://api.anthropic.com/v1/messages';

function aiEnabled() { return !!process.env.ANTHROPIC_API_KEY; }

// Tolerant JSON extraction from a model reply (pure, tested).
function parseAiJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch { /* try to find an object */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

// Second line of defence: no rating-shaped keys survive in structured drafts.
const RATING_KEYS = /^(rating|score|final_rating|overall_rating|suggested_rating|proposed_rating|nine_box|ninebox)$/i;
function stripRatingSuggestions(obj) {
  if (Array.isArray(obj)) return obj.map(stripRatingSuggestions);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (RATING_KEYS.test(k)) continue;
      out[k] = stripRatingSuggestions(v);
    }
    return out;
  }
  return obj;
}

async function ensureTable() {
  await db.query(`CREATE SCHEMA IF NOT EXISTS agentic`);
  await db.query(`CREATE TABLE IF NOT EXISTS agentic.drafts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    kind text NOT NULL,             -- appraisal_draft | calibration_brief | engagement_themes | letter_draft | cycle_health
    ref jsonb NOT NULL DEFAULT '{}',-- {cycle_id, employee_id, survey_id ...}
    input jsonb NOT NULL,           -- the deterministic input, verbatim
    output jsonb NOT NULL,          -- the parsed draft
    model text NOT NULL,
    requested_by text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
}

// Token allowance added on top of each route's own answer budget, to
// cover reasoning tokens (see the max_tokens comment in narrate()).
// Sized generously on purpose: unused allowance costs nothing — only
// tokens actually generated are billed — whereas too little silently
// truncates the JSON and produces an unusable draft.
const REASONING_HEADROOM = 8000;

// The one entry point. Returns {draft, id} or throws with a clear message.
async function narrate({ tenantId, kind, ref, system, input, requestedBy, maxTokens = 1500 }) {
  if (!aiEnabled()) {
    const e = new Error('Agentic features are not configured on this instance (ANTHROPIC_API_KEY missing).');
    e.status = 503; throw e;
  }
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      // max_tokens = the caller's answer budget PLUS headroom for
      // reasoning tokens.
      //
      // Why the headroom exists: each route above passes a maxTokens
      // sized for the LENGTH OF THE JSON IT WANTS BACK (400 for a short
      // autotag, 1600 for engagement themes). That sizing was correct
      // for a model that returns only an answer. On current models,
      // reasoning is on by default and its tokens are billed and
      // counted against this SAME max_tokens ceiling — so the answer
      // gets whatever is left, and a route asking for 400 could be cut
      // off before it emits any JSON at all.
      //
      // Found by exercising POST /agentic/cycle-health against a live
      // deploy: the model returned well-formed JSON that stopped
      // mid-string ("HR: collect 1 outstanding self), parseAiJson()
      // failed on the truncated text, and the response fell back to
      // {_unparsed: "..."} — no crash, no error, just an unusable
      // draft. That fallback is what made this quiet rather than loud.
      //
      // Adding headroom instead of inflating each route's number keeps
      // the per-route intent readable as "how long should the answer
      // be", which is the only thing those call sites can sensibly
      // reason about.
      model: MODEL, max_tokens: maxTokens + REASONING_HEADROOM, system,
      messages: [{ role: 'user', content: `Deterministic input (do not alter any number in it):\n${JSON.stringify(input, null, 2)}\n\nRespond ONLY with the JSON your instructions describe.` }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const e = new Error(`AI call failed (${res.status}): ${body.slice(0, 200)}`);
    e.status = 502; throw e;
  }
  const data = await res.json();
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  // A reply cut off at the token ceiling is reported, not just absorbed.
  // The _unparsed fallback below is a genuinely useful backstop for a
  // model that answers in prose, but it swallowed truncation just as
  // quietly — an operator saw only an unusable draft with nothing in the
  // logs pointing at the cause. This distinguishes the two, per this
  // repo's no-silent-failure rule: truncation is a misconfiguration
  // (max_tokens too low for the model's reasoning), not model prose.
  if (data.stop_reason === 'max_tokens') {
    logger.warn('ai reply hit the token ceiling — draft may be truncated', {
      kind, model: MODEL, max_tokens: maxTokens + REASONING_HEADROOM,
      answer_budget: maxTokens, output_tokens: data.usage && data.usage.output_tokens,
    });
  }
  let draft = parseAiJson(text);
  if (!draft) {
    draft = { _unparsed: text.slice(0, 2000), note: 'Model reply was not valid JSON; raw text preserved.' };
    logger.warn('ai reply was not valid JSON', {
      kind, model: MODEL, stop_reason: data.stop_reason, chars: text.length,
    });
  }
  draft = stripRatingSuggestions(draft);
  draft._draft = true; // every consumer labels this as a draft

  await ensureTable();
  const saved = await db.query(
    `INSERT INTO agentic.drafts (tenant_id, kind, ref, input, output, model, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [tenantId, kind, JSON.stringify(ref || {}), JSON.stringify(input), JSON.stringify(draft), MODEL, requestedBy || null]);
  logger.info('agentic draft', { kind, id: saved.rows[0].id });
  return { id: saved.rows[0].id, created_at: saved.rows[0].created_at, draft };
}

module.exports = { narrate, parseAiJson, stripRatingSuggestions, aiEnabled, ensureTable };
