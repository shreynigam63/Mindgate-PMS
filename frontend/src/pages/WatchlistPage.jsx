import { useEffect, useState } from 'react';
import { api, API_BASE } from '../utils/api';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import { Award, RefreshCw, Upload, Download, Info, AlertTriangle } from 'lucide-react';

// Super 50 — the high-performer watchlist.
//
// Restated by the client on 24 Sep: "ratings will be derived from last
// three annual reviews and ratings should be A or A+ with current year
// ratings as A+."
//
// That was already the rule. What this page did NOT do was explain
// itself, and on their instance the explanation is the whole story:
// 1,398 employees, zero published annual cycles, so the window is empty
// for everybody and the rule cannot fire. The old page said "No one
// currently qualifies", which reads like nobody is good enough.
//
// So the page now states the rule, says how much history exists, shows
// who is one thing away, and offers the two ways out: import the prior
// years, or publish a cycle.

const dl = (path) => `${API_BASE}${path}${path.includes('?') ? '&' : '?'}token=${localStorage.getItem('apms_token')}`;

const REASON = {
  not_enough_history: 'Not enough history',
  latest_not_top: 'This year',
  streak_broken: 'Streak broken',
  scale_mismatch: 'Rule does not match the scale',
};

export default function WatchlistPage() {
  const [q, setQ] = useState('');
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);

  const load = () => api('/pms/watchlist').then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const recompute = async () => {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await api('/pms/watchlist/recompute', { method: 'POST' });
      setMsg(`Re-ran the rule — ${r.added} added, ${r.removed} removed, ${r.on_list} on the list.`);
      await load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const send = async (commit) => {
    if (!file) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`${API_BASE}/pms/watchlist/prior-ratings/upload${commit ? '?commit=1' : ''}`, {
        method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('apms_token')}` }, body: fd,
      });
      const body = await r.json();
      setReport(body);
      if (!r.ok) setErr(body.error || `${(body.errors || []).length} rows need fixing`);
      else if (commit) { setMsg(`Imported ${body.rows} ratings for ${body.employees} employees.`); await load(); }
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  if (err && !d) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;

  const list = d.watchlist || [];
  const nearly = d.nearly || [];
  const c = d.coverage || {};
  const shown = list.filter((r) => matches(q, r.name, r.department, r.designation));
  const nearShown = nearly.filter((r) => matches(q, r.name, r.department, r.designation));

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <PageHead title="Super 50 — High-Performer Watchlist" hue="violet"
        sub={d.rule?.statement}>
        <span className="chip bg-white/20 text-white">{list.length} on the list</span>
        <button className="btn-sec" disabled={busy} onClick={recompute}>
          <RefreshCw size={13} className="inline mr-1" />{busy ? 'Working…' : 'Re-run the rule'}
        </button>
      </PageHead>

      {msg && <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">{msg}</p>}
      {err && <p className="text-xs text-rose-600">{err}</p>}

      {/* WHY THE LIST LOOKS THE WAY IT DOES. The rule cannot produce
          anybody without history, and an empty list with no denominator
          is indistinguishable from a broken one. */}
      <div className="card p-3 text-[11.5px] text-navy-600 space-y-1">
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span><b>{c.employees}</b> active employees</span>
          <span><b>{c.with_any_history}</b> with any annual rating on record</span>
          <span><b>{c.with_full_window}</b> with all {d.rule?.window} years</span>
          <span><b>{list.length}</b> qualify</span>
        </p>
        {c.with_full_window === 0 && (
          <p className="flex items-start gap-1.5 text-amber2-600">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span>
              <b>Nobody has {d.rule?.window} annual reviews on record yet</b>, so the rule cannot
              place anyone — this is not a judgement about performance. Either publish annual
              cycles from here on, or load the years you appraised on before this system using
              the import below.
            </span>
          </p>
        )}
        {d.stale > 0 && (
          <p className="text-amber2-600">
            <b>{d.stale}</b> {d.stale === 1 ? 'person is' : 'people are'} flagged differently from
            what the rule says today — the flag is written when a cycle publishes. Use
            <b> Re-run the rule</b> above.
          </p>
        )}
      </div>

      <div className="card p-3 text-[11px] text-navy-500 flex gap-2">
        <Info size={14} className="shrink-0 mt-0.5 text-navy-400" />
        <span>
          The rule is <b>{d.rule?.statement}</b> The grades are read off the cycle's own rating
          scale ({(d.scale || []).map((s) => s.label).join(' · ')}), and all three parts — how many
          years, the minimum grade, and this year's grade — are settings on the Settings page.
          A lapsed streak takes somebody off the list; it is a current standing, not a badge.
        </span>
      </div>

      {/* Prior years. Without this a three-year rule takes three years
          to say anything on a new installation. */}
      <div className="card p-4 space-y-2 border-l-4 border-violet-500">
        <p className="lbl">Load appraisal years from before this system</p>
        <p className="text-[11.5px] text-navy-500">
          One row per employee per past year, matched on employee code or email. These count
          towards the {d.rule?.window}-year window alongside cycles published here — and a cycle
          published here always wins for the same year.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <a className="btn-sec" href={dl('/pms/watchlist/prior-ratings/template.xlsx')}>
            <Download size={13} className="inline mr-1" />Template (.xlsx)
          </a>
          <input type="file" accept=".xlsx,.csv" className="text-xs"
            onChange={(e) => { setFile(e.target.files[0] || null); setReport(null); setErr(null); }} />
          <button className="btn-sec" disabled={!file || busy} onClick={() => send(false)}>Validate</button>
          <button className="btn-pri" disabled={!file || busy || !(report && report.ok && !report.committed)}
            title={!report ? 'Validate first' : ''} onClick={() => send(true)}>
            <Upload size={13} className="inline mr-1" />Import
          </button>
        </div>
        {report && report.ok && !report.committed && (
          <p className="text-[11.5px] text-emerald-700">
            {report.rows} rows for {report.employees} employees, years {(report.years || []).join(', ')} — nothing saved yet.
          </p>
        )}
        {report && !report.ok && (
          <div className="text-[11.5px] text-rose-600 max-h-40 overflow-y-auto">
            {(report.errors || []).slice(0, 25).map((e, i) => <p key={i}>Line {e.line}: {e.error}</p>)}
            {(report.errors || []).length > 25 && <p>…and {report.errors.length - 25} more.</p>}
          </div>
        )}
      </div>

      <SearchBox value={q} onChange={setQ} placeholder="Search by name, department or designation…"
        shown={shown.length + nearShown.length} total={list.length + nearly.length} />

      <div>
        <p className="lbl mb-1 flex items-center gap-1.5"><Award size={13} /> On the watchlist</p>
        {!shown.length && (
          <div className="card p-6 text-center text-sm text-navy-400">
            {list.length ? 'Nobody matches that search.' : 'Nobody qualifies under the rule right now.'}
          </div>
        )}
        {!!shown.length && <People rows={shown} rule={d.rule} qualified />}
      </div>

      {/* Near misses. An empty watchlist tells HR nothing to do; "these
          eleven are one A+ away" is a succession conversation. */}
      {!!nearly.length && (
        <div>
          <p className="lbl mb-1">Close — {d.rule?.window} years on record, one thing missing</p>
          {!nearShown.length
            ? <div className="card p-6 text-center text-sm text-navy-400">Nobody matches that search.</div>
            : <People rows={nearShown} rule={d.rule} />}
        </div>
      )}
    </div>
  );
}

function People({ rows, rule, qualified }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
          <tr>
            <th className="text-left px-3 py-2">Name</th>
            <th className="text-left px-3 py-2">Department</th>
            <th className="text-left px-3 py-2">Designation</th>
            <th className="text-left px-3 py-2">Last {rule?.window} annual reviews</th>
            <th className="text-left px-3 py-2">{qualified ? 'On the list since' : 'What is missing'}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-navy-100">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 font-semibold text-navy-900">{r.name}</td>
              <td className="px-3 py-2 text-navy-500">{r.department || '—'}</td>
              <td className="px-3 py-2 text-navy-500">{r.designation || '—'}</td>
              <td className="px-3 py-2">
                {/* Most recent first, so the left-hand chip is "this
                    year" — the one the rule is strictest about. */}
                <span className="flex flex-wrap gap-1">
                  {r.history.length
                    ? r.history.map((h, i) => (
                        <span key={i} title={`${h.fiscal_year} · ${h.source}`}
                          className={`chip ${i === 0 ? 'bg-violet-100 text-violet-700' : 'bg-navy-50 text-navy-600'}`}>
                          {h.grade || h.rating}
                          <span className="opacity-60"> {h.fiscal_year}</span>
                          {h.source === 'imported' && <span className="opacity-60"> ·i</span>}
                        </span>
                      ))
                    : <span className="text-navy-300">none on record</span>}
                </span>
              </td>
              <td className="px-3 py-2">
                {qualified
                  ? <span className="text-navy-500">{r.super50_since ? new Date(r.super50_since).toLocaleDateString() : '—'}</span>
                  : <span className="text-navy-600">
                      <b className="text-amber2-600">{REASON[r.reason] || r.reason}</b> — {r.detail}
                    </span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
