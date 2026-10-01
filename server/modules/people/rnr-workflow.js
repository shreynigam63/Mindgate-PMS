// The RnR approval workflow. Pure: no database, no express.
//
// Manager → HOD → HRBP → Final HR, with Reject and Send Back
// available at every stage. Kept as a table rather than as branches in a
// handler, because the thing most likely to change about this is the
// number of stages — a client with no HOD, or one with a second
// HR step, should be a row here and not a rewrite.

const STAGES = [
  { status: 'draft', label: 'Draft', actor: 'manager' },
  { status: 'pending_delivery_head', label: 'Pending HOD', actor: 'delivery_head' },
  { status: 'pending_hrbp', label: 'Pending HRBP', actor: 'hrbp' },
  { status: 'pending_hr', label: 'Pending Final HR', actor: 'hr' },
  { status: 'final_approved', label: 'Final Approved', actor: null },
];
const TERMINAL = ['final_approved', 'rejected', 'awarded'];

const stageOf = (status) => STAGES.find((s) => s.status === status) || null;
const indexOf = (status) => STAGES.findIndex((s) => s.status === status);

/** Who may act on a nomination in this state. */
function actorFor(status) {
  const s = stageOf(status);
  return s ? s.actor : null;
}

/**
 * What happens when `action` is taken on a nomination in `status`.
 * Returns the next status, or an error naming why not.
 */
function transition(status, action, { reason = '' } = {}) {
  if (TERMINAL.includes(status) && action !== 'award') {
    return { ok: false, error: `This nomination is already ${status.replace(/_/g, ' ')}.` };
  }
  if (action === 'submit') {
    if (status !== 'draft' && status !== 'sent_back') {
      return { ok: false, error: 'Only a draft or a returned nomination can be submitted.' };
    }
    return { ok: true, next: 'pending_delivery_head' };
  }
  if (action === 'approve') {
    const i = indexOf(status);
    if (i < 1) return { ok: false, error: 'There is nothing to approve yet — this is still a draft.' };
    return { ok: true, next: STAGES[i + 1].status };
  }
  if (action === 'reject' || action === 'send_back') {
    // A refusal without a reason is not a refusal anybody can act on.
    if (!String(reason || '').trim()) {
      return { ok: false, error: action === 'reject'
        ? 'A rejection needs a reason — the manager has to be told what was wrong with it.'
        : 'Sending it back needs a reason, or the manager cannot tell what to change.' };
    }
    return { ok: true, next: action === 'reject' ? 'rejected' : 'sent_back' };
  }
  if (action === 'award') {
    if (status !== 'final_approved') {
      return { ok: false, error: 'Only a finally approved nomination can be marked awarded.' };
    }
    return { ok: true, next: 'awarded' };
  }
  return { ok: false, error: `Unknown action "${action}".` };
}

/** The tracker the cycle dashboard draws. */
function progress(status) {
  const order = ['draft', 'pending_delivery_head', 'pending_hrbp', 'pending_hr', 'final_approved', 'awarded'];
  const i = order.indexOf(status);
  return {
    steps: order.map((s, n) => ({
      status: s,
      label: (stageOf(s) || {}).label || (s === 'awarded' ? 'Awarded' : s),
      done: i > -1 && n < i,
      current: n === i,
    })),
    rejected: status === 'rejected',
    sent_back: status === 'sent_back',
  };
}

const LABELS = {
  draft: 'Draft', pending_delivery_head: 'Pending HOD', pending_hrbp: 'Pending HRBP',
  pending_hr: 'Pending Final HR', final_approved: 'Final Approved', rejected: 'Rejected',
  sent_back: 'Sent Back', awarded: 'Awarded',
};

module.exports = { STAGES, TERMINAL, LABELS, stageOf, actorFor, transition, progress };
