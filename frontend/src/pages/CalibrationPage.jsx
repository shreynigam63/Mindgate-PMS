import { useEffect, useState } from 'react';
import { Sparkles, SlidersHorizontal } from 'lucide-react';
import { api, DraftBadge } from '../utils/api';

const NINE_BOX = ['low-low', 'low-mid', 'low-high', 'mid-low', 'mid-mid', 'mid-high', 'high-low', 'high-mid', 'high-high'];

export default function CalibrationPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api('/pms/calibration').then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  const askBrief = async () => {
    setBusy(true); setErr(null);
    try { const r = await api('/agentic/calibration-brief', { method: 'POST' }); setBrief(r.draft); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  if (err && !data) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle.</div>;

  const dist = data.distribution || {};
  const targets = data.cycle.bell_curve || {};
  const total = Object.values(dist).reduce((a, b) => a + b, 0) || 1;

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">Calibration</h2>
        <span className="chip bg-purple-100 text-purple-700">{data.cycle.name}</span>
        <button className="btn-sec" disabled={busy} onClick={askBrief}><Sparkles size={13} className="inline mr-1 text-amber-500" />{busy ? 'Drafting…' : 'Session brief (agent)'}</button>
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {brief && (
        <div className="bg-navy-800 text-slate-100 rounded-xl p-4 text-xs space-y-2">
          <DraftBadge />
          <p className="text-sm font-semibold">{brief.headline}</p>
          {(brief.deviations || []).map((d, i) => <p key={i}>• {d}</p>)}
          {(brief.discussion_points || []).length > 0 && <p><b>Discuss:</b> {brief.discussion_points.join(' · ')}</p>}
          {brief.outstanding && <p className="text-amber-300">{brief.outstanding}</p>}
        </div>
      )}
      <div className="card p-4">
        <p className="lbl">Distribution vs bell-curve targets</p>
        {/* 5-point letter-grade scale (A+=5..C=1) — briefly had a '6'
            bucket for an earlier 6-grade version, reverted along with
            narrowing the default scale back down. */}
        <div className="flex gap-3 flex-wrap">
          {['5', '4', '3', '2', '1', 'unrated'].map(k => (
            <div key={k} className="text-center">
              <p className="text-lg font-bold">{dist[k] || 0}</p>
              <p className="text-[10px] text-navy-400">rating {k}</p>
              <p className="text-[10px] text-navy-500">{Math.round(((dist[k] || 0) / total) * 100)}% {targets[k] != null && <span className="text-navy-400">/ tgt {targets[k]}%</span>}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="card overflow-x-auto">
        {/* table-fixed + explicit widths on the header row: with auto
            layout, the browser infers each column's width from ALL rows
            (including the wide colSpan=7 adjustment-reason row below),
            which could shift column boundaries in ways not visible just
            from reading the code. Fixed layout makes widths deterministic
            from these header cells alone — every other row, including
            that spanning one, has to respect them. */}
        <table className="w-full text-xs table-fixed">
          <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
            <tr>
              <th className="text-left px-3 py-2 w-[16%]">Employee</th>
              <th className="text-left px-3 py-2 w-[10%]">Dept</th>
              <th className="text-right px-3 py-2 w-[8%]">Mgr</th>
              <th className="text-right px-3 py-2 w-[12%]">Delivery Head</th>
              <th className="text-right px-3 py-2 w-[14%]">Final Rating</th>
              <th className="text-left px-3 py-2 w-[16%]">9-box</th>
              <th className="text-left px-3 py-2 w-[24%]">Adjust Rating</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-100">
            {data.rows.map(r => <CalRow key={r.employee_id} r={r} reload={load} />)}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-navy-400">Every adjustment requires a reason — it is the permanent answer to "why did my rating change".</p>
    </div>
  );
}

function CalRow({ r, reload }) {
  const [to, setTo] = useState('');
  const [box, setBox] = useState(r.nine_box_cell || '');
  const [err, setErr] = useState(null);
  const adjust = async () => {
    const reason = prompt(`Adjust ${r.name} from ${r.proposed} to ${to}. Reason (required):`);
    if (!reason || !reason.trim()) return;
    try {
      await api('/pms/calibration/adjust', { method: 'POST', body: JSON.stringify({ employee_id: r.employee_id, from_rating: r.proposed, to_rating: Number(to), reason }) });
      setTo(''); reload();
    } catch (e) { setErr(e.message); }
  };
  const saveBox = async (v) => {
    setBox(v);
    try { await api('/pms/calibration/top-talent', { method: 'POST', body: JSON.stringify({ employee_id: r.employee_id, nine_box_cell: v || null }) }); }
    catch (e) { setErr(e.message); }
  };
  // Requested: the adjustment reason typed into the prompt was saved but
  // never shown again anywhere on this page. A badge next to Proposed
  // makes it visible AT A GLANCE that a number differs from the raw
  // manager/DH inputs, and the reason itself is shown directly below the
  // row — not hidden behind a hover or another click, since the whole
  // point raised was that this information was missing from view.
  const preAdjustment = r.hod_rating ?? r.manager_rating;
  const wasAdjusted = r.adjustment_reason && preAdjustment != null && r.proposed != null && Number(r.proposed) !== Number(preAdjustment);

  return (
    <>
      <tr className={wasAdjusted ? 'bg-amber-50/40' : ''}>
        <td className="px-3 py-2 font-semibold">{r.name}</td>
        <td className="px-3 py-2">{r.department || '—'}</td>
        <td className="px-3 py-2 text-right font-mono">{r.manager_rating ?? '—'}</td>
        <td className="px-3 py-2 text-right font-mono">{r.hod_rating ?? '—'}</td>
        <td className="px-3 py-2 text-right font-mono font-bold">{r.proposed ?? '—'}</td>
        <td className="px-3 py-2">
          <select className="inp !py-1 !text-[11px] w-auto" value={box} onChange={e => saveBox(e.target.value)}>
            <option value="">—</option>{NINE_BOX.map(b => <option key={b}>{b}</option>)}
          </select>
        </td>
        <td className="px-3 py-2">
          <span className="inline-flex items-center gap-1">
            <input className="inp w-14 !py-1 text-right" type="number" step="0.5" min="1" max="5" value={to} onChange={e => setTo(e.target.value)} />
            <button className="btn-sec !py-1" disabled={!to} onClick={adjust}><SlidersHorizontal size={12} /></button>
          </span>
          {err && <p className="text-[10px] text-rose-600">{err}</p>}
        </td>
      </tr>
      {/* Simplified per direct request: badge removed from Final Rating,
          and this row now shows just "adjusted X -> Y" instead of the
          reason/adjusted-by/date inline. That detail isn't thrown away —
          it's on the title attribute, so it's still reachable on hover
          rather than gone from the page entirely. */}
      {wasAdjusted && (
        <tr className="bg-amber-50/40">
          <td colSpan={7} className="px-3 pb-2 -mt-1">
            <p className="text-[11px] text-amber-800" title={`${r.adjustment_reason} — ${r.adjusted_by}${r.adjusted_at ? `, ${new Date(r.adjusted_at).toLocaleDateString()}` : ''}`}>
              adjusted <b>{preAdjustment} → {r.proposed}</b>
            </p>
          </td>
        </tr>
      )}
    </>
  );
}
