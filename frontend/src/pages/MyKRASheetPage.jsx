import { useEffect, useState } from 'react';
import { Plus, Trash2, Check, Send } from 'lucide-react';
import { api, phaseLabel, phaseColor, sheetStatusLabel } from '../utils/api';
import KraLibraryPicker from './KraLibraryPicker';
import KraSuggestPanel from './KraSuggestPanel';
import PageHead from '../PageHead';
import KraTable from '../KraTable';

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

  // numeric(5,2) comes back as the string "10.00". Left as-is it fills the
  // weight box with false precision on a field people type "10" into, and
  // every KRA then reads 10.00 in a column of 5.00s. Trimmed on load only
  // — never while typing, which would fight the cursor.
  const trimWeight = (w) => (w == null || w === '' ? w : String(Number(w)));
  const load = () => api('/pms/my/kra-sheet')
    .then(r => { setData(r); setKras((r.kras || []).map(k => ({ ...k, weight: trimWeight(k.weight) }))); setErr(null); })
    .catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active appraisal cycle. HR opens the cycle; your KRA sheet appears here.</div>;

  const total = kras.reduce((s, k) => s + (Number(k.weight) || 0), 0);
  // The sheet's own status is the lock, not the cycle's phase. An employee
  // may write and rewrite their KRAs at any point in the cycle; submitting
  // hands the sheet to their manager and closes it to them until the
  // manager returns it with feedback. See phase-machine.js for the rule and
  // why it moved off the phase.
  const locked = data.sheet.status === 'approved' || data.sheet.status === 'submitted';
  const editable = !locked;
  const set = (i, k) => (e) => setKras(ks => ks.map((r, j) => j === i ? { ...r, [k]: e.target.value } : r));

  // KRAs picked from the role library land as ordinary unsaved rows —
  // same shape as "+ Add KRA" produces, just with the fields filled in.
  // They are a COPY from that moment on: editable, deletable, and
  // untouched if HR later revises the library. Appended rather than
  // inserted into their parameter group, because grouping is computed
  // from the rows on every render and the sheet regroups itself.
  const addFromLibrary = (rows) => setKras((ks) => [...ks, ...rows]);
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
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="My KRAs" hue="navy">
        <span className={`chip ${phaseColor(data.cycle.phase)}`}>{data.cycle.name} · {phaseLabel(data.cycle.phase)}</span>
        <span className={`chip ${data.sheet.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : data.sheet.status === 'returned' ? 'bg-rose-100 text-rose-700' : 'bg-navy-50 text-navy-600'}`}>sheet: {sheetStatusLabel(data.sheet.status, data.sheet.reopened_reason)}</span>
        <span className={`chip ${Math.abs(total - 100) < 0.01 ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>weights: {total}/100</span>
      </PageHead>
      {/* Two different things land on 'returned', and attributing the
          wrong one to a manager is worse than saying nothing: a sheet
          reopened because HR changed somebody's designation was not a
          manager's judgement on their KRAs. reopened_reason is a stored
          column rather than a guess at the comment text (migration 037),
          because this is the first line the employee reads after an
          unexpected change. */}
      {data.sheet.status === 'returned' && data.sheet.manager_comment && (
        <div className="card p-3 border-rose-200 bg-rose-50 text-sm text-rose-700 space-y-2">
          <p>
            {/* THREE things land on 'returned', not two. A two-way branch
                credited HR's reopen to the manager. */}
            <b>{data.sheet.reopened_reason === 'profile_change' ? 'Reopened after a change to your role:'
              : data.sheet.reopened_reason === 'hr_reopen'      ? 'Reopened by HR:'
              : 'Returned by your manager:'}</b> {data.sheet.manager_comment}
          </p>
          {/* The KRAs on the sheet are still the OLD role's. They are kept
              rather than deleted on reopen, because a reopen is not always a
              reason to throw work away — a department move may leave the
              objectives entirely valid. But when it IS a new job, clearing
              them was eight separate deletes before the library became
              usable at all: the weights already total 100, so nothing new
              fits until something goes. This makes it one action.
              Deliberately NOT automatic on reopen, and it asks first: it
              destroys objectives the employee wrote. */}
          {data.sheet.reopened_reason === 'profile_change' && kras.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-sec !text-rose-700 !border-rose-300 !py-1 !text-xs"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(
                    `Remove all ${kras.length} KRA${kras.length === 1 ? '' : 's'} from this sheet?\n\n`
                    + 'They were written for your previous role. You can then pick fresh ones from '
                    + 'the library for the role you hold now.\n\nThis cannot be undone.')) return;
                  setKras([]);
                }}>
                <Trash2 size={12} className="inline mr-1" />
                Clear the {kras.length} KRA{kras.length === 1 ? '' : 's'} from my previous role
              </button>
              <span className="text-[11px] text-rose-600">
                Then Save, and pick from the library below. Keep them instead if they still apply.
              </span>
            </div>
          )}
        </div>
      )}
      {/* Only while KRAs are editable. Offering a shelf to someone who
          cannot add anything from it is a dead control, and after the
          phase closes the sheet is a record rather than a form. */}
      {/* Two ways to start, side by side and deliberately identical in
          shape: HR's shelf as a list you pick from, and the same shelf
          read for you by the agent. Both add ordinary editable rows. */}
      {editable && (
        <>
          <KraLibraryPicker source="/pms/my/kra-library" onAdd={addFromLibrary} />
          <KraSuggestPanel onAdd={addFromLibrary} />
        </>
      )}
      {/* ONE TABLE: Parameters · KRAs · KPIs · Weightage, the parameter
          merged across its KRAs. Asked for on 23 Sep against the client's
          own sheet, and the same component the KRA Library uses — the
          two pages showing one thing two ways was the complaint. */}
      <KraTable
        groups={groups}
        kpiHeaderNote="(measuring metrics & data source)"
        totalLabel={editable
          ? 'Total weight — must reach 100% before you can submit'
          : 'Total weight'}
        total={total}
        totalOk={Math.abs(total - 100) < 0.01}
        renderKra={({ k, i }) => (editable
          ? <input className="inp !text-[12.5px]" placeholder="KRA title *" value={k.title || ''} onChange={set(i, 'title')} />
          : <span>{k.title}</span>)}
        renderKpi={({ k, i }) => (
          <div className="space-y-1.5">
            {editable
              ? <textarea className="inp !text-[12.5px]" rows={2} placeholder="How it will be measured"
                  value={k.measures || ''} onChange={set(i, 'measures')} />
              : <span className="whitespace-pre-line">{k.measures || <i className="text-navy-300">no KPI recorded</i>}</span>}
            {/* Description is optional and hidden until it has content or
                is asked for — it read as an extra empty box on every KRA. */}
            {(hasText(k.description) || k._showDesc) ? (
              editable
                ? <textarea className="inp !text-[12.5px]" rows={2} placeholder="Description"
                    value={k.description || ''} onChange={set(i, 'description')} />
                : <div className="text-navy-400">{k.description}</div>
            ) : editable && (
              <button type="button" className="text-[11px] text-navy-300 hover:text-navy-600"
                onClick={() => openDesc(i)}>+ Add description</button>
            )}
            <MidYearOnKra midyear={k.midyear} withheld={data.manager_ratings_withheld} />
          </div>
        )}
        renderWeight={({ k, i }) => (
          <div className="space-y-1.5">
            {editable
              ? <input className="inp !w-20 !text-right !text-[12.5px] ml-auto" type="number" placeholder="wt"
                  value={k.weight ?? ''} onChange={set(i, 'weight')} />
              : <span>{k.weight == null || k.weight === '' ? '—' : `${Number(k.weight)}%`}</span>}
            {editable && (
              <div className="flex items-center justify-end gap-2">
                {/* MOVE, not a parameter box per row. With the parameter
                    merged, changing it physically moves the row to another
                    group — so the control says what it does. It commits
                    atomically for the reason the old select did: a
                    free-text box re-grouped the sheet on every keystroke
                    and the row jumped out from under the cursor. */}
                {!k._newCat ? (
                  // Always reads "Move to…", NEVER the current parameter:
                  // the merged cell to the left already says which group
                  // this row is in, and repeating it on every row is
                  // exactly the duplication this format removed. The
                  // current parameter is left out of the options for the
                  // same reason — moving something to where it already is
                  // is not a choice.
                  <select className="inp !w-auto !py-1 !text-[11px] !font-bold !text-navy-400"
                    title="Move this KRA to another parameter" value=""
                    onChange={(e) => { if (e.target.value) setCategory(i, e.target.value); }}>
                    <option value="">Move to…</option>
                    {hasText(k.category) && <option value={NO_CATEGORY}>No parameter</option>}
                    {categoryOptions
                      .filter((c) => c !== (hasText(k.category) ? String(k.category).trim() : null))
                      .map((c) => <option key={c} value={c}>{c}</option>)}
                    <option value={NEW_CAT}>+ New parameter…</option>
                  </select>
                ) : (
                  <input className="inp !w-40 !py-1 !text-[11px]" autoFocus placeholder="New parameter, then Enter"
                    value={k._newCatText || ''}
                    onChange={(e) => stageNewCategory(i, e.target.value)}
                    onBlur={() => commitNewCategory(i)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitNewCategory(i); } }} />
                )}
                <button className="text-rose-500 hover:text-rose-700" title="Remove this KRA"
                  onClick={() => setKras(ks => ks.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
              </div>
            )}
          </div>
        )}
        groupFooter={editable ? (g) => (
          <button type="button" className="kt-addbtn"
            onClick={() => setKras(ks => [...ks, { title: '', weight: '', category: g.cat === NO_CATEGORY ? '' : g.cat }])}>
            <Plus size={12} className="inline mr-1" />
            Add a KRA under {g.cat === NO_CATEGORY ? 'no parameter' : g.cat}
          </button>
        ) : null}
        bodyFooter={editable ? (
          <tr className="kt-add kt-last">
            {/* kt-param for the styling, kt-param-add because it is NOT a
                parameter — it is the control that makes one. Anything
                counting the groups on this table would otherwise count
                this cell as one. */}
            <td className="kt-param kt-param-add">
              <button type="button" className="kt-addbtn" onClick={() => setKras(ks => [...ks, { title: '', weight: '' }])}>
                <Plus size={12} className="inline mr-1" />New parameter
              </button>
            </td>
            <td colSpan={3} className="text-[11.5px] text-navy-300 pt-4">
              Adds a KRA with no parameter yet — set it with <b>Move to…</b> on the row.
            </td>
          </tr>
        ) : null}
        legend={editable
          ? <><b>Move to…</b> reassigns a KRA to another parameter; the row jumps to that group and
             both subtotals update. Submit stays disabled until the total is exactly 100%.</>
          : <>This sheet is a record now. Mid-year ratings, where they exist, sit with the KRA they
             were given for.</>}
      />
      {editable && (
        <div className="flex flex-wrap gap-2">
          <button className="btn-sec" disabled={busy} onClick={() => save(false)}><Check size={13} className="inline mr-1" />Save draft</button>
          <button className="btn-pri" disabled={busy || Math.abs(total - 100) >= 0.01 || !kras.length} onClick={() => save(true)}
            title={Math.abs(total - 100) >= 0.01 ? 'Weights must total exactly 100' : ''}>
            <Send size={13} className="inline mr-1" />Save & submit to manager</button>
        </div>
      )}
      {/* Being locked out is never left to be inferred from greyed-out
          boxes: it says who holds the sheet and what unlocks it. The two
          locks have different remedies, so they say different things. */}
      {locked && (
        <p className="text-xs text-navy-400">
          {data.sheet.status === 'submitted'
            ? 'Your manager has this sheet. It is locked until they approve it or return it with feedback.'
            : 'This sheet is approved and locked. Ask HR to reopen it if something needs to change.'}
        </p>
      )}
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
export function MidYearOnKra({ midyear, withheld }) {
  if (!midyear || (!midyear.self && !midyear.manager && !withheld)) return null;
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
      {/* The manager's half waits for publish. Said, not blanked: a bare
          dash reads as "your manager has not rated this", which is a
          different and usually untrue statement. */}
      {withheld
        ? <span className="text-navy-400">manager <i>after publish</i></span>
        : cell('manager', midyear.manager)}
    </div>
  );
}
