// The kitty, the pools and the per-person allocation, on the
// Calibration page. Asked for on 29 Sep as a spec for this screen.
//
// SPLIT OUT OF CalibrationPage ON PURPOSE. That page is about ratings —
// the distribution, the bell curve, the 9-box, the adjustment reason —
// and it stays readable. This file is about money, which is gated on a
// different permission and fetched separately, so keeping it apart
// means a user without pms_compensation renders the page they have
// today with none of this attempted.
//
// EVERY FIGURE HERE COMES FROM THE SERVER. Nothing is recomputed in the
// browser, including the totals that move as HR types: each save
// returns the whole recomputed view. A client that patched one row
// locally would drift from the server's arithmetic, and the first
// person to notice would be whoever reconciled the budget afterwards.
import { useState } from 'react';
import { AlertTriangle, Save, X, ChevronDown, ChevronRight, Pencil } from 'lucide-react';
import { api } from '../utils/api';

const money = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
const pct = (n) => (n == null ? '—' : `${Number(n)}%`);

// A date column comes back as a timestamp string, and rendering it raw
// puts "2026-10-25T00:00:00.000Z" in front of HR mid-sentence.
const day = (d) => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? String(d) : t.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

// Lakhs, because that is how an Indian compensation conversation is
// actually held — "the kitty is 3.2 crore" not "32,000,000".
function short(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (Math.abs(v) >= 100000) return `₹${(v / 100000).toFixed(2)} L`;
  return money(v);
}

// A collapsible section. Asked for on 29 Sep: "can we have dropdown for
// kitty, calibration and increment allocation" — the page had grown to
// three full-width blocks stacked down a single scroll.
//
// THE STATE STICKS, per section, in localStorage. A panel that springs
// back open on every reload is worse than no panel at all: HR collapses
// the grid to work on the kitty, saves an allocation, the page reloads
// and they are back where they started.
//
// THE HEADER KEEPS THE HEADLINE FIGURE. Collapsing a section must not
// hide the number somebody collapsed it to get past — the summary prop
// stays visible either way, so a closed kitty still says what is left.
export function Section({ id, title, summary, actions, children, defaultOpen = true }) {
  const key = `apms.cal.section.${id}`;
  const [open, setOpen] = useState(() => {
    // Wrapped, because localStorage throws in a private window and a
    // crash here would take the whole page with it.
    try {
      const v = localStorage.getItem(key);
      return v == null ? defaultOpen : v === '1';
    } catch { return defaultOpen; }
  });
  const toggle = () => {
    setOpen((x) => {
      try { localStorage.setItem(key, x ? '0' : '1'); } catch { /* not worth failing over */ }
      return !x;
    });
  };
  return (
    <div className="card">
      <div className="px-4 py-3 flex flex-wrap items-center gap-2">
        {/* The whole title is the control, not just the chevron: a
            6px target is a miss on a laptop trackpad. */}
        <button type="button" onClick={toggle} aria-expanded={open}
          className="flex items-center gap-1.5 text-left flex-1 min-w-0">
          {open ? <ChevronDown size={14} className="text-navy-400 shrink-0" />
                : <ChevronRight size={14} className="text-navy-400 shrink-0" />}
          <span className="lbl !mb-0">{title}</span>
          {summary && <span className="text-[11px] text-navy-400 font-normal truncate">· {summary}</span>}
        </button>
        {/* Buttons in the header must not toggle the section they sit
            in — pressing Export should export, not fold the grid away. */}
        {actions && <span onClick={(e) => e.stopPropagation()}>{actions}</span>}
      </div>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

export const BRACKETS = [
  { v: 'all', label: 'All employees' },
  { v: 'above', label: 'Above the bracket' },
  { v: 'at_or_below', label: 'At or below' },
];

export function BracketFilter({ value, onChange, threshold }) {
  // The threshold is shown IN the labels rather than assumed: it is a
  // configurable column, and a chip reading "> ₹50L" on a tenant who
  // set 40 would be a lie.
  const t = threshold == null ? null : short(threshold);
  return (
    <div className="flex flex-wrap gap-1.5">
      {BRACKETS.map((b) => (
        <button key={b.v} type="button" onClick={() => onChange(b.v)}
          className={`chip ${value === b.v ? 'bg-navy-700 text-white' : 'bg-navy-50 text-navy-600'}`}>
          {b.v === 'all' ? b.label : `${b.v === 'above' ? '>' : '≤'} ${t || 'the bracket'}`}
        </button>
      ))}
    </div>
  );
}

function Pool({ label, pool, hue }) {
  if (!pool) return null;
  const over = pool.over;
  return (
    <div className={`rounded-lg p-2.5 ${over ? 'bg-rose-50 border border-rose-200' : `bg-${hue}-50`}`}>
      <p className="text-[10px] uppercase font-bold text-navy-400">{label}</p>
      <p className="text-sm font-bold">{short(pool.approved)}</p>
      <p className="text-[11px] text-navy-500">
        {short(pool.spent)} allocated
        {pool.used_pct != null && <span className="text-navy-400"> · {pool.used_pct}%</span>}
      </p>
      <p className={`text-[11px] font-semibold ${over ? 'text-rose-700' : 'text-emerald-700'}`}>
        {over ? `${short(Math.abs(pool.remaining))} over` : `${short(pool.remaining)} left`}
      </p>
    </div>
  );
}

// ---- the panel ----------------------------------------------------------

export function KittyPanel({ view, onSaved, onError }) {
  const [editing, setEditing] = useState(false);
  // The grade table. Editable here because a calibration session is
  // exactly where "A+ should top out at 22 this year" gets said, and
  // until now the target could only be changed on the Cycles page and
  // the range nowhere at all.
  const [bandEdit, setBandEdit] = useState(null);   // null = not editing
  const [bandErr, setBandErr] = useState(null);
  const [bandBusy, setBandBusy] = useState(false);
  const b = view.budget || {};
  const [form, setForm] = useState({
    kitty_pct: b.kitty_pct ?? 0, bracket_threshold: b.bracket_threshold ?? 5000000,
    retention_pool: b.retention_pool ?? 0, market_pool: b.market_pool ?? 0,
    promotion_pool: b.promotion_pool ?? 0,
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try { await api('/pms/calibration/kitty', { method: 'PUT', body: JSON.stringify(form) }); setEditing(false); onSaved(); }
    catch (e) { onError(e.message); }
    setBusy(false);
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const startBands = () => {
    setBandErr(null);
    setBandEdit((view.grades || []).map((g) => ({
      label: g.label,
      rating_min: g.rating_min, rating_max: g.rating_max,
      target_pct: g.target_pct == null ? '' : g.target_pct,
      increment_pct: g.standard_pct == null ? '' : g.standard_pct,
      increment_pct_min: g.increment_min_pct == null ? '' : g.increment_min_pct,
      increment_pct_max: g.increment_max_pct == null ? '' : g.increment_max_pct,
    })));
  };
  const setBand = (i, k) => (e) => setBandEdit((rows) =>
    rows.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)));

  const saveBands = async () => {
    setBandBusy(true); setBandErr(null);
    try {
      await api('/pms/calibration/bands', { method: 'PUT', body: JSON.stringify({ bands: bandEdit }) });
      setBandEdit(null);
      onSaved();
    } catch (e) {
      // The server returns a per-row list for a bad matrix. Shown as
      // the list it is, so HR fixes every clash at once rather than
      // one save at a time.
      const rows = (e.data && e.data.errors) || [];
      setBandErr(rows.length ? `${e.message}: ${rows.map((r) => `row ${r.row} — ${r.error}`).join('; ')}` : e.message);
    }
    setBandBusy(false);
  };
  // The targets have to total 100, and saying so while they are being
  // typed beats a 422 after the fact.
  const targetTotal = (bandEdit || [])
    .reduce((t, r) => t + (r.target_pct === '' ? 0 : Number(r.target_pct) || 0), 0);

  // What the header says when the section is folded away: the two
  // numbers somebody would otherwise open it to read.
  const summary = `${short(view.pools.kitty.approved)} kitty · ${short(view.pools.kitty.remaining)} left`
    + (view.warnings.length ? ` · ${view.warnings.length} to check` : '');

  return (
    <Section id="kitty" title="Kitty & budget" summary={summary}
      actions={(
        <button className="btn-sec !py-1" onClick={() => setEditing((x) => !x)}>
          {editing ? 'Cancel' : 'Set the kitty'}
        </button>
      )}>
      <div className="space-y-3">

      {editing && (
        <div className="bg-navy-50 rounded-lg p-3 space-y-2">
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <label className="lbl">Approved kitty (% of CTC)</label>
              <input className="inp" type="number" step="0.1" min="0" value={form.kitty_pct} onChange={set('kitty_pct')} />
            </div>
            <div>
              <label className="lbl">Salary bracket at (₹)</label>
              <input className="inp" type="number" step="1" min="1" value={form.bracket_threshold} onChange={set('bracket_threshold')} />
            </div>
            <div>
              <label className="lbl">Retention pool (₹)</label>
              <input className="inp" type="number" step="1" min="0" value={form.retention_pool} onChange={set('retention_pool')} />
            </div>
            <div>
              <label className="lbl">Market correction pool (₹)</label>
              <input className="inp" type="number" step="1" min="0" value={form.market_pool} onChange={set('market_pool')} />
            </div>
            <div>
              <label className="lbl">Promotion pool (₹)</label>
              <input className="inp" type="number" step="1" min="0" value={form.promotion_pool} onChange={set('promotion_pool')} />
            </div>
          </div>
          {/* Said where the number is typed, because it is the thing
              most likely to be assumed the other way round. */}
          <p className="text-[11px] text-navy-500">
            The kitty funds <b>standard performance hikes</b>. Retention, market correction and
            promotion are <b>separate pools on top</b> — spending one does not reduce the others.
          </p>
          <button className="btn-pri !py-1.5" disabled={busy} onClick={save}>
            <Save size={12} className="inline mr-1" />{busy ? 'Saving…' : 'Save the kitty'}
          </button>
        </div>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2">
        <div className="rounded-lg p-2.5 bg-navy-50">
          <p className="text-[10px] uppercase font-bold text-navy-400">Total salary pool</p>
          <p className="text-sm font-bold">{short(view.total_ctc)}</p>
          <p className="text-[11px] text-navy-500">
            {view.counts.employees} {view.counts.employees === 1 ? 'person' : 'people'}
            {view.counts.of_total !== view.counts.employees && <span className="text-navy-400"> of {view.counts.of_total}</span>}
          </p>
          {view.counts.frozen > 0 && (
            <p className="text-[11px] text-amber-700">{view.counts.frozen} frozen (leaving)</p>
          )}
        </div>
        <Pool label={`Incremental kitty · ${pct(view.kitty_pct)}`} pool={view.pools.kitty} hue="navy" />
        <Pool label="Retention" pool={view.pools.retention} hue="navy" />
        <Pool label="Market correction" pool={view.pools.market} hue="navy" />
        <Pool label="Promotion" pool={view.pools.promotion} hue="navy" />
      </div>

      {/* Budget guardrails, said before anything is pressed and naming
          the pool and the amount — an alert nobody can act on is noise,
          and noise gets clicked through. */}
      {view.warnings.map((w, i) => (
        <p key={i} className="text-[11.5px] text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
          <AlertTriangle size={12} className="inline mr-1" />{w}
        </p>
      ))}

      {/* ---- the grade table ---- */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="lbl">Grades, targets and what each is worth</p>
        {!bandEdit ? (
          <button className="btn-sec !py-1 !text-xs" onClick={startBands}>
            <Pencil size={12} className="inline mr-1" />Edit bands
          </button>
        ) : (
          <span className="flex items-center gap-2">
            <span className={`text-[11px] ${Math.round(targetTotal) === 100 ? 'text-navy-400' : 'text-amber-700'}`}>
              targets total {Math.round(targetTotal * 10) / 10}%
            </span>
            <button className="btn-pri !py-1 !text-xs" disabled={bandBusy} onClick={saveBands}>
              <Save size={12} className="inline mr-1" />Save bands
            </button>
            <button className="btn-sec !py-1 !text-xs" disabled={bandBusy} onClick={() => { setBandEdit(null); setBandErr(null); }}>
              <X size={12} className="inline mr-1" />Cancel
            </button>
          </span>
        )}
      </div>
      {bandErr && <p className="text-[11.5px] text-rose-600">{bandErr}</p>}
      {bandEdit && (
        <p className="text-[11px] text-navy-500">
          These are <b>this cycle's</b> bands. The standing company matrix on Increment Simulation is
          left alone. Changing them is audited with what they were.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
            <tr>
              <th className="text-left px-2 py-1.5">Grade</th>
              <th className="text-right px-2 py-1.5">Target</th>
              <th className="text-right px-2 py-1.5">Count</th>
              <th className="text-right px-2 py-1.5">Actual</th>
              <th className="text-right px-2 py-1.5">Increment range</th>
              <th className="text-right px-2 py-1.5">Standard</th>
              <th className="text-right px-2 py-1.5">Kitty spent</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-100">
            {view.grades.map((g, i) => {
              // Over target is what a calibration session is looking
              // for, so it is coloured rather than left to be worked
              // out from two numbers side by side.
              const over = g.target_pct != null && g.actual_pct > g.target_pct;
              const e = bandEdit && bandEdit[i];
              // Count, actual and spend stay read-only in edit mode:
              // they are COMPUTED from the ratings and salaries on
              // record, and an input over a derived number invites
              // somebody to try to type a different answer.
              return (
                <tr key={g.label}>
                  <td className="px-2 py-1.5 font-bold">{g.label}</td>
                  <td className="px-2 py-1.5 text-right text-navy-400">
                    {e
                      ? <input className="inp !py-0.5 !px-1 w-16 text-right !text-xs" type="number" min="0" max="100" step="0.1"
                          value={e.target_pct} onChange={setBand(i, 'target_pct')} />
                      : (g.target_pct == null ? '—' : `${g.target_pct}%`)}
                  </td>
                  <td className="px-2 py-1.5 text-right">{g.count}</td>
                  <td className={`px-2 py-1.5 text-right font-semibold ${over ? 'text-amber-700' : ''}`}>{g.actual_pct}%</td>
                  <td className="px-2 py-1.5 text-right text-navy-500">
                    {e ? (
                      <span className="inline-flex items-center gap-1 justify-end">
                        <input className="inp !py-0.5 !px-1 w-14 text-right !text-xs" type="number" min="0" max="100" step="0.1"
                          value={e.increment_pct_min} onChange={setBand(i, 'increment_pct_min')} />
                        <span className="text-navy-300">–</span>
                        <input className="inp !py-0.5 !px-1 w-14 text-right !text-xs" type="number" min="0" max="100" step="0.1"
                          value={e.increment_pct_max} onChange={setBand(i, 'increment_pct_max')} />
                      </span>
                    ) : (g.increment_min_pct == null ? '—' : `${g.increment_min_pct}–${g.increment_max_pct}%`)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {e
                      ? <input className="inp !py-0.5 !px-1 w-16 text-right !text-xs" type="number" min="0" max="100" step="0.1"
                          value={e.increment_pct} onChange={setBand(i, 'increment_pct')} />
                      : (g.standard_pct == null ? '—' : `${g.standard_pct}%`)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">{short(g.spend)}</td>
                </tr>
              );
            })}
            {view.unrated.count > 0 && (
              <tr className="text-navy-400">
                <td className="px-2 py-1.5 font-bold">unrated</td>
                <td className="px-2 py-1.5 text-right">—</td>
                <td className="px-2 py-1.5 text-right">{view.unrated.count}</td>
                <td className="px-2 py-1.5 text-right">—</td>
                <td className="px-2 py-1.5 text-right">—</td>
                <td className="px-2 py-1.5 text-right">—</td>
                <td className="px-2 py-1.5 text-right font-mono">{short(view.unrated.spend)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-navy-400">
        Nothing here changes anybody&rsquo;s pay. These are modelled figures against the ratings and
        salaries on record — the system has no route that turns one into a stored salary.
      </p>
      </div>
    </Section>
  );
}

// ---- one person's money -------------------------------------------------

export function AllocationRow({ line, bracket, onSaved, onError, currency }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    standard_pct: line.standard_overridden ? line.standard_pct : '',
    standard_reason: line.reasons.standard || '',
    market_pct: line.market_pct || 0, market_reason: line.reasons.market || '',
    promoted: line.promoted, proposed_designation: line.proposed_designation || '',
    proposed_band: line.proposed_band || '', promotion_pct: line.promotion_pct || 0,
    promotion_reason: line.reasons.promotion || '',
    retention_approved: line.retention_approved, retention_pct: line.retention_pct || 0,
    retention_lumpsum: line.retention_lumpsum || 0, retention_reason: line.reasons.retention || '',
  });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      const r = await api(`/pms/calibration/allocation/${line.employee_id}`,
        { method: 'PUT', body: JSON.stringify({ ...f, bracket }) });
      setOpen(false);
      onSaved(r);
    } catch (e) { onError(e.message); }
    setBusy(false);
  };

  return (
    <>
      <tr className={line.frozen ? 'bg-navy-50/60 text-navy-400' : (line.out_of_band ? 'bg-amber-50/40' : '')}>
        <td className="px-2 py-1.5">
          <button className="flex items-start gap-1 text-left" onClick={() => setOpen((x) => !x)}>
            {open ? <ChevronDown size={12} className="mt-0.5" /> : <ChevronRight size={12} className="mt-0.5" />}
            <span>
              <span className="font-semibold">{line.name}</span>
              {line.emp_code && <span className="text-navy-400 text-[10px]"> · {line.emp_code}</span>}
              <span className="block text-[10px] text-navy-400">{line.designation || '—'}</span>
            </span>
          </button>
        </td>
        <td className="px-2 py-1.5">
          {line.department || '—'}
          <span className="block text-[10px] text-navy-400">{line.delivery_head || '—'}</span>
        </td>
        <td className="px-2 py-1.5">
          <span className="chip bg-navy-50 text-navy-500 text-[10px]">{line.band_label || '—'}</span>
        </td>
        <td className="px-2 py-1.5 text-right font-mono">
          {line.ctc_missing
            ? <span className="text-amber-600 text-[10.5px]">not on record</span>
            : money(line.current_ctc)}
        </td>
        <td className="px-2 py-1.5">
          {line.resigned
            ? <span className={`chip text-[10px] ${line.retention_approved ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                {line.retention_approved ? 'retained' : 'leaving'}
              </span>
            : <span className="chip bg-navy-50 text-navy-400 text-[10px]">active</span>}
          {line.promoted && <span className="chip bg-violet-100 text-violet-700 text-[10px] ml-1">promoted</span>}
        </td>
        <td className="px-2 py-1.5 text-right font-mono">{line.standard_pct}%{line.standard_overridden && <span className="text-amber-600">*</span>}</td>
        <td className="px-2 py-1.5 text-right font-mono">{line.market_pct || '—'}</td>
        <td className="px-2 py-1.5 text-right font-mono">{line.promotion_pct || '—'}</td>
        <td className="px-2 py-1.5 text-right font-mono">{line.retention_pct || '—'}</td>
        <td className="px-2 py-1.5 text-right font-mono font-bold">{line.total_pct}%</td>
        <td className="px-2 py-1.5 text-right font-mono">{line.ctc_missing ? '—' : money(line.revised_ctc)}</td>
      </tr>

      {line.frozen && (
        <tr className="bg-navy-50/60">
          <td colSpan={11} className="px-2 pb-1.5">
            <p className="text-[11px] text-navy-500">
              Leaving{day(line.last_working_date) ? ` on ${day(line.last_working_date)}` : ''} and retention is not
              approved, so no increment is allocated and nothing is drawn from any pool. Their rating still
              counts in the distribution.
            </p>
          </td>
        </tr>
      )}

      {open && (
        <tr>
          <td colSpan={11} className="px-2 pb-3 bg-navy-50/40">
            <div className="grid md:grid-cols-3 gap-3 pt-2">
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase font-bold text-navy-400">Standard hike</p>
                <input className="inp !py-1" type="number" step="0.1" min="0" placeholder={`band: ${line.matrix_pct == null ? '—' : `${line.matrix_pct}%`}`}
                  value={f.standard_pct} onChange={(e) => set('standard_pct', e.target.value)} />
                <p className="text-[10px] text-navy-400">
                  Leave it empty to track the band{line.band_min_pct != null && ` (${line.band_min_pct}–${line.band_max_pct}%)`}.
                </p>
                {String(f.standard_pct) !== '' && (
                  <input className="inp !py-1" placeholder="Why this differs from the band (required)"
                    value={f.standard_reason} onChange={(e) => set('standard_reason', e.target.value)} />
                )}
                <p className="text-[10px] uppercase font-bold text-navy-400 pt-1">Market correction</p>
                <input className="inp !py-1" type="number" step="0.1" min="0" value={f.market_pct}
                  onChange={(e) => set('market_pct', e.target.value)} />
                {Number(f.market_pct) > 0 && (
                  <input className="inp !py-1" placeholder="Reason (required)" value={f.market_reason}
                    onChange={(e) => set('market_reason', e.target.value)} />
                )}
              </div>

              <div className="space-y-1.5">
                <p className="text-[10px] uppercase font-bold text-navy-400">Promotion</p>
                <label className="flex items-center gap-2 text-[11px]">
                  <input type="checkbox" checked={f.promoted} onChange={(e) => set('promoted', e.target.checked)} />
                  Promoted this cycle
                </label>
                {f.promoted && (
                  <>
                    <input className="inp !py-1" placeholder="New designation" value={f.proposed_designation}
                      onChange={(e) => set('proposed_designation', e.target.value)} />
                    <input className="inp !py-1" placeholder="New band" value={f.proposed_band}
                      onChange={(e) => set('proposed_band', e.target.value)} />
                    <input className="inp !py-1" type="number" step="0.1" min="0" placeholder="Promotion hike %"
                      value={f.promotion_pct} onChange={(e) => set('promotion_pct', e.target.value)} />
                    {Number(f.promotion_pct) > 0 && (
                      <input className="inp !py-1" placeholder="Reason (required)" value={f.promotion_reason}
                        onChange={(e) => set('promotion_reason', e.target.value)} />
                    )}
                  </>
                )}
              </div>

              <div className="space-y-1.5">
                <p className="text-[10px] uppercase font-bold text-navy-400">Retention</p>
                {!line.resigned ? (
                  // Not offered rather than offered-and-refused: retention
                  // is for somebody who is leaving, and a disabled control
                  // with an explanation is clearer than a 422 after typing.
                  <p className="text-[11px] text-navy-400">
                    No resignation on record, so retention does not apply. It comes from the
                    employee master — upload a sheet with a resignation date.
                  </p>
                ) : (
                  <>
                    <label className="flex items-center gap-2 text-[11px]">
                      <input type="checkbox" checked={f.retention_approved}
                        onChange={(e) => set('retention_approved', e.target.checked)} />
                      Retention approved
                    </label>
                    {f.retention_approved && (
                      <>
                        <input className="inp !py-1" type="number" step="0.1" min="0" placeholder="Retention increase %"
                          value={f.retention_pct} onChange={(e) => set('retention_pct', e.target.value)} />
                        <input className="inp !py-1" type="number" step="1" min="0" placeholder="Lump sum (₹)"
                          value={f.retention_lumpsum} onChange={(e) => set('retention_lumpsum', e.target.value)} />
                        <input className="inp !py-1" placeholder="Reason (required)" value={f.retention_reason}
                          onChange={(e) => set('retention_reason', e.target.value)} />
                      </>
                    )}
                    {!f.retention_approved && (
                      <p className="text-[11px] text-navy-500">
                        Not approved: their increment is frozen at 0% and nothing is drawn from any pool.
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 pt-2">
              <button className="btn-pri !py-1" disabled={busy} onClick={save}>
                <Save size={12} className="inline mr-1" />{busy ? 'Saving…' : 'Save'}
              </button>
              <button className="btn-sec !py-1" onClick={() => setOpen(false)}>
                <X size={12} className="inline mr-1" />Close
              </button>
              {line.out_of_band && (
                <span className="text-[11px] text-amber-700">
                  Outside the {line.band_min_pct}–{line.band_max_pct}% range for {line.band_label}.
                </span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export { money, short };
