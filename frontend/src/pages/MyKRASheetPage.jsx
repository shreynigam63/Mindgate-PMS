import { useEffect, useState } from 'react';
import { Plus, Trash2, Check, Send } from 'lucide-react';
import { api, phaseLabel, phaseColor } from '../utils/api';

// Whitespace counts as empty. An imported cell can carry a stray space or
// newline, and treating that as content would put the box back on exactly
// the rows this was meant to clear.
export const hasText = (v) => !!(v && String(v).trim());

// KRAs grouped by the sheet's "Parameters" column (pms.kras.category).
//
// Migration 025 records why this is structure rather than decoration: in
// the source workbooks the column is filled once per group and left blank
// down the rest of it, so the grouping IS how the sheet reads. Group order
// is first appearance, not alphabetical, so an imported sheet keeps the
// order its author chose.
//
// Rows carry their original index because every edit goes through set(i)
// and a KRA is deleted by index — grouping must not renumber anything.
// A KRA with no parameter goes in a trailing group rather than vanishing.
export const NO_CATEGORY = '__none__';
export function groupByCategory(kras) {
  const order = [];
  const byCat = new Map();
  kras.forEach((k, i) => {
    const cat = hasText(k.category) ? String(k.category).trim() : NO_CATEGORY;
    if (!byCat.has(cat)) { byCat.set(cat, []); order.push(cat); }
    byCat.get(cat).push({ k, i });
  });
  // The unparameterised group sits last wherever it first appeared —
  // it is the leftovers, and reading it between two real groups implies
  // an order the sheet does not have.
  const cats = order.filter((c) => c !== NO_CATEGORY);
  if (byCat.has(NO_CATEGORY)) cats.push(NO_CATEGORY);
  return cats.map((cat) => ({
    cat,
    rows: byCat.get(cat),
    weight: byCat.get(cat).reduce((t, r) => t + (Number(r.k.weight) || 0), 0),
  }));
}

export default function MyKRASheetPage() {
  const [data, setData] = useState(null);
  const [kras, setKras] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api('/pms/my/kra-sheet').then(r => { setData(r); setKras(r.kras || []); setErr(null); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active appraisal cycle. HR opens the cycle; your KRA sheet appears here.</div>;

  const total = kras.reduce((s, k) => s + (Number(k.weight) || 0), 0);
  const locked = data.sheet.status === 'approved' || data.sheet.status === 'submitted';
  const editable = data.cycle.phase === 'kra_open' && !locked;
  const set = (i, k) => (e) => setKras(ks => ks.map((r, j) => j === i ? { ...r, [k]: e.target.value } : r));
  // Requested: the Description box read as an extra empty box on every
  // KRA. It is now shown only when that KRA has description text — which,
  // for an imported sheet, is whatever was in its Comments column.
  //
  // Hidden is not removed. The field still imports, still shows on the
  // manager's Team KRA Sheets view, and still feeds the AI (the
  // development-plan suggestions and the justification review both read
  // it), so an employee has to be able to add one; "+ Add description"
  // below opens the box on demand instead of it sitting there empty. The
  // flag lives on the row rather than on an index, because removing a KRA
  // renumbers every row after it and an index-keyed flag would then point
  // at the wrong one.
  const openDesc = (i) => setKras(ks => ks.map((r, j) => j === i ? { ...r, _showDesc: true } : r));

  // The Parameter picker commits ATOMICALLY, and that is the point. A
  // free-text input would re-group the sheet on every keystroke, so the
  // row being typed into would jump out from under the cursor. Choosing an
  // existing value moves the row once, deliberately; naming a new one
  // stages the text and applies it on Enter or blur.
  const NEW_CAT = '__new__';
  const setCategory = (i, value) => setKras(ks => ks.map((r, j) => {
    if (j !== i) return r;
    if (value === NEW_CAT) return { ...r, _newCat: true, _newCatText: '' };
    return { ...r, category: value === NO_CATEGORY ? '' : value, _newCat: false, _newCatText: undefined };
  }));
  const stageNewCategory = (i, text) => setKras(ks => ks.map((r, j) => j === i ? { ...r, _newCatText: text } : r));
  const commitNewCategory = (i) => setKras(ks => ks.map((r, j) => {
    if (j !== i) return r;
    const named = hasText(r._newCatText);
    // An empty name leaves the KRA where it was rather than clearing its
    // parameter — cancelling out of "+ New" should not be destructive.
    return { ...r, category: named ? String(r._newCatText).trim() : r.category, _newCat: false, _newCatText: undefined };
  }));

  // Options offered by every picker: what this tenant already uses (from
  // GET /my/kra-sheet), plus anything on this sheet that is not saved yet.
  const categoryOptions = [...new Set([
    ...(data.known_categories || []),
    ...kras.map((k) => (hasText(k.category) ? String(k.category).trim() : null)).filter(Boolean),
  ])].sort((a, b) => a.localeCompare(b));
  const groups = groupByCategory(kras);

  const save = async (thenSubmit) => {
    setBusy(true); setErr(null);
    try {
      // Anything underscore-prefixed is UI state, not part of a KRA
      // (_showDesc, _newCat, _newCatText). Stripped by prefix rather than
      // by name so the next transient field added here cannot be
      // forgotten and end up in the request and the request log.
      const payload = kras.map((k) => Object.fromEntries(
        Object.entries(k).filter(([key]) => !key.startsWith('_'))));
      await api('/pms/my/kra-sheet/kras', { method: 'PUT', body: JSON.stringify({ kras: payload }) });
      if (thenSubmit) await api('/pms/my/kra-sheet/submit', { method: 'POST' });
      load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">My KRAs</h2>
        <span className={`chip ${phaseColor(data.cycle.phase)}`}>{data.cycle.name} · {phaseLabel(data.cycle.phase)}</span>
        <span className={`chip ${data.sheet.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : data.sheet.status === 'returned' ? 'bg-rose-100 text-rose-700' : 'bg-navy-50 text-navy-600'}`}>sheet: {data.sheet.status}</span>
        <span className={`chip ${Math.abs(total - 100) < 0.01 ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>weights: {total}/100</span>
      </div>
      {data.sheet.status === 'returned' && data.sheet.manager_comment && (
        <div className="card p-3 border-rose-200 bg-rose-50 text-sm text-rose-700"><b>Returned by your manager:</b> {data.sheet.manager_comment}</div>
      )}
      {groups.map((g) => (
        <div key={g.cat} className="space-y-2">
          {/* The Parameter heading, with that group's weight beside it.
              The subtotal is the reason to group at all beyond looks: a
              scorecard that is 70% Financial and 5% People is the sort of
              thing nobody notices in a flat list of eight KRAs. */}
          <div className="flex items-baseline gap-2 px-1">
            <p className={`text-xs font-bold uppercase tracking-wide ${g.cat === NO_CATEGORY ? 'text-navy-300' : 'text-navy-500'}`}>
              {g.cat === NO_CATEGORY ? 'No parameter set' : g.cat}
            </p>
            <span className="text-[11px] text-navy-400">{Math.round(g.weight * 100) / 100}%</span>
          </div>
          {g.rows.map(({ k, i }) => (
            <div key={i} className="card p-3 space-y-2">
              <div className="flex gap-2">
                <input className="inp font-semibold" placeholder="KRA title *" value={k.title || ''} onChange={set(i, 'title')} disabled={!editable} />
                <input className="inp w-24 text-right" type="number" placeholder="wt %" value={k.weight ?? ''} onChange={set(i, 'weight')} disabled={!editable} />
                {editable && <button className="text-rose-500" onClick={() => setKras(ks => ks.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}
              </div>
              {/* The two small controls share one line so a KRA does not
                  grow a row per optional field. !w-auto because .inp is
                  @apply w-full and a full-width dropdown for four short
                  words dominates the card. */}
              {editable && (
                <div className="flex flex-wrap items-center gap-3">
                  {/* The picker is a select, not a text box — see
                      setCategory for why. Options are what this tenant
                      already uses, so a sheet does not split into
                      "Project/Process" and "Project & Process" without
                      anyone noticing. */}
                  {!k._newCat ? (
                    <select className="inp !w-auto !py-1.5 text-xs" value={hasText(k.category) ? String(k.category).trim() : NO_CATEGORY}
                      onChange={(e) => setCategory(i, e.target.value)}>
                      <option value={NO_CATEGORY}>Parameter — none</option>
                      {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                      <option value={NEW_CAT}>+ New parameter…</option>
                    </select>
                  ) : (
                    <input className="inp !w-56 !py-1.5 text-xs" autoFocus placeholder="New parameter name, then Enter"
                      value={k._newCatText || ''}
                      onChange={(e) => stageNewCategory(i, e.target.value)}
                      onBlur={() => commitNewCategory(i)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitNewCategory(i); } }} />
                  )}
                  {!hasText(k.description) && !k._showDesc && (
                    <button type="button" className="text-[11px] text-navy-400 hover:text-navy-600" onClick={() => openDesc(i)}>
                      + Add description
                    </button>
                  )}
                </div>
              )}
              {/* Read-only view still needs to show the parameter, since
                  the select above is gone once the phase closes. */}
              {!editable && hasText(k.category) && (
                <span className="chip bg-navy-50 text-navy-500 self-start">{String(k.category).trim()}</span>
              )}
              {/* Measures then description, matching the template's own
                  column order (Parameters, KRA, KPIs, Comments) — the
                  optional field goes last rather than splitting the two
                  that are always filled. */}
              <input className="inp" placeholder="How it will be measured" value={k.measures || ''} onChange={set(i, 'measures')} disabled={!editable} />
              {(hasText(k.description) || k._showDesc) && (
                <textarea className="inp" rows={2} placeholder="Description" value={k.description || ''} onChange={set(i, 'description')} disabled={!editable} />
              )}
              <MidYearOnKra midyear={k.midyear} />
            </div>
          ))}
        </div>
      ))}
      {editable && (
        <div className="flex flex-wrap gap-2">
          <button className="btn-sec" onClick={() => setKras(ks => [...ks, { title: '', weight: '' }])}><Plus size={13} className="inline mr-1" />Add KRA</button>
          <button className="btn-sec" disabled={busy} onClick={() => save(false)}><Check size={13} className="inline mr-1" />Save draft</button>
          <button className="btn-pri" disabled={busy || Math.abs(total - 100) >= 0.01 || !kras.length} onClick={() => save(true)}
            title={Math.abs(total - 100) >= 0.01 ? 'Weights must total exactly 100' : ''}>
            <Send size={13} className="inline mr-1" />Save & submit to manager</button>
        </div>
      )}
      {!editable && !locked && <p className="text-xs text-navy-400">KRA editing opens in the {phaseLabel('kra_open')} phase.</p>}
    </div>
  );
}

// The mid-year rating, against the KRA it was given for.
//
// Mid-year scoring has always been per-KRA, but it lived only on its own
// page — so the KRA sheet showed what someone signed up to and nothing
// about how it was going. Read-only here on purpose: mid-year is still
// scored on the Mid-Year Review page, under its own phase gate. This is
// the same number, shown where it means something.
export function MidYearOnKra({ midyear }) {
  if (!midyear || (!midyear.self && !midyear.manager)) return null;
  const cell = (label, entry) => (
    <span>
      {label} <b>{entry?.rating ?? '—'}</b>
      {entry?.narrative && <span className="text-navy-400"> — {entry.narrative}</span>}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-3 text-[11px] text-navy-500 bg-navy-50 rounded-md px-2 py-1">
      <span className="font-semibold text-navy-600">Mid-year:</span>
      {cell('self', midyear.self)}
      {cell('manager', midyear.manager)}
    </div>
  );
}
