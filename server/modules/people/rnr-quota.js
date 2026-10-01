// The RnR quota engine. Pure: no database, no express.
//
// THE DENOMINATOR AND THE POOL, which the client settled explicitly:
// the 3% is ONE CONSOLIDATED CYCLE POOL, which HR then allocates across
// Junior, Mid and Annual. Read per category instead, a 3% policy with
// six categories caps at 18% — which is how an organisation ends up
// awarding a fifth of its people while believing it awards a thirtieth.
//
// The denominator is the ACTIVE headcount, counted once when the cycle
// opens and then frozen on the cycle row. Headcount moves daily; a quota
// recomputed on every read would let the cap drift under the people
// approving against it, and two approvers reading the same screen an hour
// apart would see different numbers with nothing to explain it.

/** The cap. Rounding is HR's choice; the default floors it. */
function capacity(activeCount, pct, rounding = 'down') {
  const n = Math.max(0, Number(activeCount) || 0);
  const p = Number(pct);
  if (!Number.isFinite(p) || p < 0) return 0;
  const raw = (n * p) / 100;
  if (rounding === 'up') return Math.ceil(raw);
  if (rounding === 'nearest') return Math.round(raw);
  // Down by default: a cap is a ceiling, and rounding a ceiling up is how
  // a 3% policy quietly becomes 3.4%.
  return Math.floor(raw);
}

/**
 * Where a cycle stands.
 * @returns {{maximum:number, approved:number, balance:number, exhausted:boolean, pct:number, active:number}}
 */
function standing({ activeCount, pct, rounding, approved = 0, overrides = 0 }) {
  const maximum = capacity(activeCount, pct, rounding);
  const used = Math.max(0, Number(approved) || 0);
  return {
    active: Math.max(0, Number(activeCount) || 0),
    pct: Number(pct),
    rounding: rounding || 'down',
    maximum,
    approved: used,
    balance: maximum - used,
    exhausted: used >= maximum,
    overrides: Math.max(0, Number(overrides) || 0),
    // Over the cap only ever by an override, and the number says by how much.
    beyond_cap: Math.max(0, used - maximum),
  };
}

/**
 * HR's split of the pool. Allocating more than the pool is refused —
 * the whole point of one consolidated quota is that the parts cannot
 * silently exceed the whole.
 */
function validateAllocation(allocations, maximum) {
  const rows = Object.entries(allocations || {})
    .map(([level, slots]) => ({ level, slots: Math.max(0, Number(slots) || 0) }));
  const total = rows.reduce((s, r) => s + r.slots, 0);
  if (total > maximum) {
    return { ok: false, total, maximum,
      error: `That allocates ${total} awards out of a cycle quota of ${maximum}. `
           + `Reduce one of the levels by ${total - maximum}, or raise the quota.` };
  }
  return { ok: true, total, maximum, unallocated: maximum - total, rows };
}

/**
 * May this approval go through? The answer a final approver needs, with
 * the sentence to show when it is no.
 */
function mayApprove({ standing: st, level, levelApproved = 0, levelSlots = null, override = null }) {
  if (override && String(override.reason || '').trim()) {
    return { ok: true, via: 'override',
      note: `Approved beyond the quota under an HR override: ${String(override.reason).trim()}` };
  }
  if (st.exhausted) {
    return { ok: false, reason: 'cycle_quota',
      error: `RnR quota exhausted for this cycle — ${st.approved} of ${st.maximum} awards approved. `
           + 'Additional approval requires an HR override with a reason.' };
  }
  if (levelSlots != null && levelApproved >= levelSlots) {
    return { ok: false, reason: 'level_quota',
      error: `The ${level} allocation for this cycle is full — ${levelApproved} of ${levelSlots}. `
           + 'HR can move slots between levels, or override with a reason.' };
  }
  return { ok: true };
}

module.exports = { capacity, standing, validateAllocation, mayApprove };
