// The configurable part of the appraisal form — the rules, with no
// database and no Express in sight.
//
// Built on 28 Sep from Mindgate's own PMS_Form.xlsx (see migration 061
// for what was in it and what was already covered elsewhere). The
// sections and questions are rows in a table; this file is what decides
// whether an answer to one of them is acceptable.
//
// Pure on purpose. "Is 3.5 a legal rating on this cycle's scale", "is
// this required question still blank", and "what did they actually
// change" are decisions that want a unit test and not a live Postgres,
// and the same three questions will be asked again by the annual form.

// A yes_no is stored as text so that a question can be changed from
// yes_no to text later without throwing away what people have already
// answered. These are the two values it may hold.
const YES_NO = ['yes', 'no'];

const trimmed = (v) => (v == null ? null : String(v).trim());

// One answer, checked against the question it claims to answer.
//
// Returns { ok, rating, answer_text } or { ok: false, reason } — a
// reason per answer rather than one blanket "invalid", because a form
// with fifteen questions that refuses with "bad input" is a form nobody
// can submit.
function validateAnswer(question, incoming, scale) {
  if (!question) return { ok: false, reason: 'no such question on this form' };
  if (question.active === false) return { ok: false, reason: 'this question is no longer on the form' };
  const v = incoming || {};

  if (question.kind === 'rating') {
    const raw = v.rating;
    if (raw == null || raw === '') return { ok: true, rating: null, answer_text: null };
    const n = Number(raw);
    const rows = Array.isArray(scale) ? scale : [];
    if (!rows.some((s) => Number(s.value) === n)) {
      return { ok: false, reason: `must be one of: ${rows.map((s) => `${s.value} (${s.label})`).join(', ')}` };
    }
    return { ok: true, rating: n, answer_text: null };
  }

  if (question.kind === 'yes_no') {
    const t = trimmed(v.answer_text);
    if (!t) return { ok: true, rating: null, answer_text: null };
    const low = t.toLowerCase();
    if (!YES_NO.includes(low)) return { ok: false, reason: "must be 'yes' or 'no'" };
    return { ok: true, rating: null, answer_text: low };
  }

  // text
  const t = trimmed(v.answer_text);
  // A 4000-character answer is not an answer, it is a paste. Named
  // rather than silently truncated — losing the end of what somebody
  // wrote about their own appraisal is not an acceptable failure.
  if (t && t.length > 4000) return { ok: false, reason: 'keep it under 4000 characters' };
  return { ok: true, rating: null, answer_text: t || null };
}

// Merge an incoming { question_id: {rating|answer_text} } map onto what
// is stored. Only questions actually SENT are touched — a page that
// renders one section must not blank the others.
//
// Returns { ok, writes: [{question_id, rating, answer_text}], errors:
// [{question_id, label, reason}] }. Errors do not stop the good rows
// from being reported; the caller decides whether to write a partial
// set or refuse the lot, and it refuses.
function mergeAnswers({ questions, incoming, scale }) {
  const byId = new Map((questions || []).map((q) => [String(q.id), q]));
  const writes = [];
  const errors = [];
  for (const [id, value] of Object.entries(incoming || {})) {
    const q = byId.get(String(id));
    const r = validateAnswer(q, value, scale);
    if (!r.ok) { errors.push({ question_id: id, label: q ? q.label : null, reason: r.reason }); continue; }
    writes.push({ question_id: id, rating: r.rating, answer_text: r.answer_text });
  }
  return { ok: errors.length === 0, writes, errors };
}

// Which required questions are still unanswered, by label — what a
// submit gate refuses with, and what the page puts next to the button.
//
// A rating of 0 is an answer; an empty string is not. `== null` rather
// than falsy, so a legitimate zero on some future scale is not read as
// a blank.
function missingRequired(questions, answers) {
  const byQ = new Map((answers || []).map((a) => [String(a.question_id), a]));
  return (questions || [])
    .filter((q) => q.required && q.active !== false)
    .filter((q) => {
      const a = byQ.get(String(q.id));
      if (!a) return true;
      if (q.kind === 'rating') return a.rating == null;
      return !trimmed(a.answer_text);
    })
    .map((q) => q.label);
}

// Sections with their questions and this person's answers attached, in
// the order the form is meant to be read. Shaping only — the caller has
// already loaded all three lists.
function assemble({ sections, questions, answers }) {
  const ansByQ = new Map((answers || []).map((a) => [String(a.question_id), a]));
  return (sections || [])
    .filter((s) => s.active !== false)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((s) => ({
      id: s.id, title: s.title, blurb: s.blurb || null,
      questions: (questions || [])
        .filter((q) => String(q.section_id) === String(s.id) && q.active !== false)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((q) => {
          const a = ansByQ.get(String(q.id));
          return {
            id: q.id, label: q.label, kind: q.kind, required: q.required,
            rating: a && a.rating != null ? Number(a.rating) : null,
            answer_text: (a && a.answer_text) || null,
          };
        }),
    }))
    // A section whose questions have all been deactivated is not a
    // section, it is an empty box with a heading.
    .filter((s) => s.questions.length);
}

module.exports = { validateAnswer, mergeAnswers, missingRequired, assemble, YES_NO };
