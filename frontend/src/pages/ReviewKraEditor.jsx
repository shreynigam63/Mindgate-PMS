import { useEffect, useState } from 'react';
import { Pencil, Save, X } from 'lucide-react';
import { api } from '../utils/api';

// KRA, KPI and weightage, editable during the reviews — IN PLACE.
//
// Asked for on 7 Oct: "KRA, KPIs and weightage should be editable in mid
// year, annual review." The first cut put a separate table above the
// rating cards; the client then asked for the edit to sit "in existing
// KRAs rating in mid year and annual year review/team evaluation instead
// of separate option". So the rating list itself goes into edit mode: one
// button at the top of "Rate each KRA" turns every card's title, KPI and
// weight into fields, with a running total and Save / Cancel. The weights
// still have to total 100 across the sheet, which is why it is one edit
// over all the cards rather than a pencil per card.
//
// The rules are the server's (GET/PUT /pms/review/kras/:employeeId, see
// reviewKraEditable() in phase-machine.js): the same KRAs, no adding or
// removing, weights to 100, the sheet stays approved, every change is
// audited and the other person is told.

/** The edit state for one employee's sheet. Safe to call with no id yet. */
export function useKraEdit(employeeId, onSaved) {
  const [info, setInfo] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  const load = () => {
    if (!employeeId) return Promise.resolve();
    return api(`/pms/review/kras/${employeeId}`).then(setInfo).catch(() => setInfo(null));
  };
  useEffect(() => { setEditing(false); setDraft({}); load(); }, [employeeId]);

  const kras = (info && info.kras) || [];
  const allowed = !!(info && info.editable && kras.length);
  const value = (k, field) => {
    const d = draft[k.id];
    if (d && d[field] !== undefined) return d[field];
    const base = kras.find((x) => x.id === k.id) || k;
    return field === 'weight' ? String(Number(base.weight)) : (base[field] || '');
  };
  const total = kras.reduce((s, k) => s + (Number(value(k, 'weight')) || 0), 0);
  const totalOk = Math.abs(total - 100) < 0.01;

  return {
    allowed, editing, busy, err, note, total, totalOk,
    reason: info && !info.editable ? info.reason : null,
    value,
    set: (id, patch) => setDraft((p) => ({ ...p, [id]: { ...(p[id] || {}), ...patch } })),
    start: () => { setDraft({}); setErr(null); setNote(null); setEditing(true); },
    cancel: () => { setDraft({}); setErr(null); setEditing(false); },
    save: async () => {
      setBusy(true); setErr(null); setNote(null);
      try {
        const r = await api(`/pms/review/kras/${employeeId}`, {
          method: 'PUT',
          body: JSON.stringify({ kras: kras.map((k) => ({
            id: k.id, title: value(k, 'title'), measures: value(k, 'measures'), weight: Number(value(k, 'weight')),
          })) }),
        });
        setNote(r.changes.length ? `${r.changes.length} ${r.changes.length === 1 ? 'change' : 'changes'} saved.` : 'Nothing changed.');
        setEditing(false); setDraft({});
        await load();
        if (onSaved) await onSaved();
      } catch (e) { setErr(e.message); }
      setBusy(false);
    },
  };
}

/** The one control above the cards: Edit, or the running total with Save / Cancel. */
export function KraEditBar({ edit }) {
  if (!edit || (!edit.allowed && !edit.note)) return null;
  if (!edit.editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {edit.allowed && (
          <button type="button" className="btn-sec !py-1 !text-[11.5px]" onClick={edit.start}>
            <Pencil size={12} className="inline mr-1" />Edit KRAs, KPIs &amp; weightage
          </button>
        )}
        {edit.note && <span className="text-[11px] text-emerald-700">{edit.note}</span>}
      </div>
    );
  }
  return (
    <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
      <span className="text-[11.5px] text-navy-700">
        Editing KRAs — weights total <b className={edit.totalOk ? 'text-emerald-700' : 'text-rose-600'}>{+edit.total.toFixed(2)}%</b>
        {!edit.totalOk && <span className="text-rose-600"> (must be 100)</span>}
      </span>
      <span className="ml-auto flex gap-2">
        <button type="button" className="btn-pri !py-1 !text-[11.5px]" disabled={edit.busy || !edit.totalOk} onClick={edit.save}>
          <Save size={12} className="inline mr-1" />{edit.busy ? 'Saving…' : 'Save KRAs'}
        </button>
        <button type="button" className="btn-sec !py-1 !text-[11.5px]" disabled={edit.busy} onClick={edit.cancel}>
          <X size={12} className="inline mr-1" />Cancel
        </button>
      </span>
      {edit.err && <p className="basis-full text-[11px] text-rose-600">{edit.err}</p>}
      <p className="basis-full text-[10.5px] text-navy-400">Changes are recorded and the other person is told. KRAs cannot be added or removed during a review.</p>
    </div>
  );
}

/**
 * A rating card's heading: the KRA's title, weight and KPI — as text, or
 * as fields while the list is in edit mode. `compact` matches the smaller
 * cards on Team Evaluation.
 */
export function KraHead({ edit, k, index, compact }) {
  const editing = edit && edit.editing;
  if (!editing) {
    return (
      <>
        <div className="flex flex-wrap items-baseline gap-2">
          {index != null && <span className="text-[10px] font-mono text-navy-400">KRA {index + 1}</span>}
          <p className={`${compact ? 'text-xs' : 'text-sm'} font-semibold flex-1 min-w-[12ch]`}>{k.title}</p>
          <span className="chip bg-navy-50 text-navy-600">{Number(k.weight)}%</span>
        </div>
        {k.measures && <p className="text-[11px] text-navy-400">KPI: {k.measures}</p>}
      </>
    );
  }
  return (
    <div className="space-y-1.5 bg-amber-50/60 rounded-lg p-2 -m-1">
      <div className="flex flex-wrap items-center gap-2">
        {index != null && <span className="text-[10px] font-mono text-navy-400">KRA {index + 1}</span>}
        <input className="inp !py-1 flex-1 min-w-[16ch] text-sm font-semibold" aria-label="KRA"
          value={edit.value(k, 'title')} onChange={(e) => edit.set(k.id, { title: e.target.value })} />
        <label className="flex items-center gap-1 text-[11px] text-navy-500">
          <input className="inp !py-1 w-20 text-right" type="number" min="1" max="100" step="1" aria-label="Weight %"
            value={edit.value(k, 'weight')} onChange={(e) => edit.set(k.id, { weight: e.target.value })} />%
        </label>
      </div>
      <label className="block">
        <span className="text-[10px] uppercase font-bold text-navy-400">KPI</span>
        <textarea className="inp !py-1 text-[12px]" rows={2}
          value={edit.value(k, 'measures')} onChange={(e) => edit.set(k.id, { measures: e.target.value })} />
      </label>
    </div>
  );
}
