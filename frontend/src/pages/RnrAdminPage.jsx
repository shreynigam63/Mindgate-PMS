import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import { AlertTriangle, Play, Square, Plus, Save } from 'lucide-react';

// HR's RnR administration: the masters, the cycles, and the split of the
// one quota pool.
//
// Everything on this page is DATA the rule engine reads. Nothing here
// changes behaviour by changing code — which is the point the brief makes
// twice, and the reason the band mapping and the experience windows are
// editable rows rather than constants.

const fmt = (d) => (d ? String(d).slice(0, 10) : '');

export default function RnrAdminPage() {
  const [m, setM] = useState(null);
  const [cycles, setCycles] = useState(null);
  const [quota, setQuota] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [newCycle, setNewCycle] = useState({ name: '', kind: 'quarterly', nominations_open: '', nominations_close: '', award_date: '' });
  const [alloc, setAlloc] = useState({ junior: 0, mid: 0, all: 0 });
  const [settings, setSettings] = useState(null);

  const load = async () => {
    try {
      const [masters, cyc] = await Promise.all([api('/people/rnr/masters'), api('/people/rnr/cycles')]);
      setM(masters); setSettings(masters.settings); setCycles(cyc.cycles);
      const open = (cyc.cycles || []).find((c) => c.status === 'open') || (cyc.cycles || [])[0];
      if (open) {
        const q = await api(`/people/rnr/cycles/${open.id}/quota`);
        setQuota(q);
        setAlloc({ junior: q.quota.allocations.junior || 0, mid: q.quota.allocations.mid || 0, all: q.quota.allocations.all || 0 });
      }
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const act = async (fn) => {
    setErr(null); setMsg(null);
    try { const r = await fn(); setMsg(r && (r.note || 'Saved.')); await load(); }
    catch (e) { setErr(e.message); }
  };

  if (err && !m) return <div className="card p-4"><p className="text-sm text-rose-600">{err}</p></div>;
  if (!m) return <p className="text-sm text-navy-400">Loading…</p>;

  return (
    <div className="space-y-3 max-w-5xl mx-auto">
      <PageHead title="RnR Administration" hue="amber"
        sub="The masters the eligibility engine reads, the cycles, and the award quota." />

      {/* What the master is missing. Said once, at the top, because every
          "0 eligible" on the nomination screen traces back to here. */}
      {m.data_gaps.messages.length > 0 && (
        <div className="card p-3 text-xs border-l-4 border-amber-500 space-y-1">
          <p className="flex items-center gap-1.5 font-semibold text-amber-700">
            <AlertTriangle size={13} />The employee master is missing what the rules read
          </p>
          {m.data_gaps.messages.map((x, i) => <p key={i} className="text-navy-600">{x}</p>)}
          <p className="text-navy-400">These come from the HRMS import, not from this page.</p>
        </div>
      )}

      {msg && <div className="card p-3 text-xs border-l-4 border-leaf-500">{msg}</div>}
      {err && <p className="text-xs text-rose-600">{err}</p>}

      {/* ---- the quota ---------------------------------------------- */}
      {quota && (
        <div className="card p-4 space-y-3">
          <p className="lbl mb-0">Award quota · {quota.cycle.name}</p>
          <div className="grid sm:grid-cols-5 gap-2 text-xs">
            {[['Active employees', quota.quota.active], ['Allocation', `${quota.quota.pct}%`],
              ['Maximum awards', quota.quota.maximum], ['Approved', quota.quota.approved],
              ['Balance', quota.quota.balance]].map(([k, v]) => (
              <div key={k} className="bg-navy-50 rounded-xl px-3 py-2">
                <span className="block text-navy-400 text-[10.5px]">{k}</span>
                <b className="text-lg">{v}</b>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-navy-400">
            The headcount was counted when the cycle opened and is fixed for its life — a quota that
            moved with the headcount would change under the people approving against it. 3% applies
            to each cycle, so four quarterly cycles allow up to 12% of the company in a year.
          </p>
          {quota.quota.outside_quota > 0 && (
            <p className="text-[11px] text-navy-500">
              <b>{quota.quota.outside_quota}</b> further award{quota.quota.outside_quota === 1 ? '' : 's'} approved
              outside the cap — loyalty milestones do not consume a slot.
            </p>
          )}

          <div className="pt-1">
            <p className="text-[11px] text-navy-500 mb-1">
              Split of the {quota.quota.maximum} across the levels. One pool, allocated — not 3% each.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              {['junior', 'mid', 'all'].map((lvl) => (
                <div key={lvl}>
                  <label className="text-[10.5px] text-navy-400 block">{lvl === 'all' ? 'annual / special' : lvl}</label>
                  <input className="inp !w-24 !text-xs" type="number" min="0" value={alloc[lvl]}
                    onChange={(e) => setAlloc((p) => ({ ...p, [lvl]: Number(e.target.value) }))} />
                </div>
              ))}
              <button className="btn-sec !py-1.5" onClick={() => act(() =>
                api(`/people/rnr/cycles/${quota.cycle.id}/allocations`, { method: 'PUT',
                  body: JSON.stringify({ allocations: alloc }) }))}>
                <Save size={12} className="inline mr-1" />Save split
              </button>
              <span className="text-[11px] text-navy-400">
                {quota.quota.maximum - (alloc.junior + alloc.mid + alloc.all)} unallocated
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ---- cycles --------------------------------------------------- */}
      <div className="card p-4 space-y-3">
        <p className="lbl mb-0">Cycles</p>
        <table className="w-full text-xs">
          <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
            <tr><th className="text-left px-3 py-2">Cycle</th><th className="text-left px-3 py-2">Nominations</th>
              <th className="text-left px-3 py-2">Award date</th><th className="text-left px-3 py-2">Quota</th>
              <th className="text-left px-3 py-2">Status</th><th className="px-3 py-2" /></tr>
          </thead>
          <tbody className="divide-y divide-navy-100">
            {(cycles || []).map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-2"><b>{c.name}</b><span className="block text-[10px] text-navy-400">{c.kind}</span></td>
                <td className="px-3 py-2">{fmt(c.nominations_open)} → {fmt(c.nominations_close)}</td>
                <td className="px-3 py-2">{fmt(c.award_date) || '—'}</td>
                <td className="px-3 py-2">{c.quota_total == null ? '—' : `${c.approved}/${c.quota_total}`}</td>
                <td className="px-3 py-2"><span className={`chip ${c.status === 'open' ? 'bg-leaf-50 text-leaf-600' : 'bg-navy-50 text-navy-500'}`}>{c.status}</span></td>
                <td className="px-3 py-2 text-right">
                  {c.status === 'draft' && <button className="btn-sec !py-1" onClick={() => act(() => api(`/people/rnr/cycles/${c.id}/open`, { method: 'POST' }))}><Play size={11} className="inline mr-1" />Open</button>}
                  {c.status === 'open' && <button className="btn-sec !py-1" onClick={() => act(() => api(`/people/rnr/cycles/${c.id}/close`, { method: 'POST' }))}><Square size={11} className="inline mr-1" />Close</button>}
                </td>
              </tr>
            ))}
            {!(cycles || []).length && <tr><td colSpan={6} className="px-3 py-6 text-center text-navy-400">No cycles yet.</td></tr>}
          </tbody>
        </table>

        <div className="flex flex-wrap items-end gap-2 pt-1">
          {[['name', 'Name', 'text'], ['nominations_open', 'Opens', 'date'],
            ['nominations_close', 'Closes', 'date'], ['award_date', 'Award date', 'date']].map(([k, label, type]) => (
            <div key={k}>
              <label className="text-[10.5px] text-navy-400 block">{label}</label>
              <input className="inp !text-xs !w-auto" type={type} value={newCycle[k]}
                onChange={(e) => setNewCycle((p) => ({ ...p, [k]: e.target.value }))} />
            </div>
          ))}
          <div>
            <label className="text-[10.5px] text-navy-400 block">Kind</label>
            <select className="inp !text-xs !w-auto" value={newCycle.kind}
              onChange={(e) => setNewCycle((p) => ({ ...p, kind: e.target.value }))}>
              <option value="quarterly">quarterly</option><option value="annual">annual</option>
            </select>
          </div>
          <button className="btn-sec !py-1.5" onClick={() => act(() =>
            api('/people/rnr/cycles', { method: 'POST', body: JSON.stringify(newCycle) }))}>
            <Plus size={12} className="inline mr-1" />Add cycle
          </button>
        </div>
      </div>

      {/* ---- settings ------------------------------------------------- */}
      <div className="card p-4 space-y-3">
        <p className="lbl mb-0">Rules</p>
        <div className="grid sm:grid-cols-4 gap-3 text-xs">
          <div>
            <label className="text-[10.5px] text-navy-400 block">Quota %</label>
            <input className="inp !text-xs" type="number" step="0.1" value={settings.quota_pct ?? 3}
              onChange={(e) => setSettings((p) => ({ ...p, quota_pct: Number(e.target.value) }))} />
          </div>
          <div>
            <label className="text-[10.5px] text-navy-400 block">Rounding</label>
            <select className="inp !text-xs" value={settings.rounding || 'down'}
              onChange={(e) => setSettings((p) => ({ ...p, rounding: e.target.value }))}>
              <option value="down">down</option><option value="up">up</option><option value="nearest">nearest</option>
            </select>
          </div>
          <div>
            <label className="text-[10.5px] text-navy-400 block">Minimum service (months)</label>
            <input className="inp !text-xs" type="number" value={settings.min_tenure_months ?? 6}
              onChange={(e) => setSettings((p) => ({ ...p, min_tenure_months: Number(e.target.value) }))} />
          </div>
          <div>
            <label className="text-[10.5px] text-navy-400 block">Awards per person per year</label>
            <input className="inp !text-xs" type="number" value={settings.max_awards_per_year ?? 1}
              onChange={(e) => setSettings((p) => ({ ...p, max_awards_per_year: Number(e.target.value) }))} />
          </div>
        </div>
        <label className="text-[11px] text-navy-600 flex items-center gap-1.5">
          <input type="checkbox" checked={!!settings.senior_in_quarterly}
            onChange={(e) => setSettings((p) => ({ ...p, senior_in_quarterly: e.target.checked }))} />
          Senior-level employees may be nominated in the quarterly cycle
        </label>
        <button className="btn-pri" onClick={() => act(() =>
          api('/people/rnr/masters/settings', { method: 'PUT', body: JSON.stringify(settings) }))}>
          <Save size={13} className="inline mr-1" />Save rules
        </button>
      </div>

      {/* ---- the award master ---------------------------------------- */}
      <div className="card p-4 space-y-2">
        <p className="lbl mb-0">Award master</p>
        <p className="text-[11px] text-navy-400">
          The experience window is half-open: “1 to 3” means one year up to but not including three.
          That is what keeps Rising Star and Buddy Star from both claiming somebody at exactly three years.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
              <tr><th className="text-left px-3 py-2">Award</th><th className="text-left px-3 py-2">Level</th>
                <th className="text-left px-3 py-2">When</th><th className="text-left px-3 py-2">Experience</th>
                <th className="text-left px-3 py-2">Measured on</th>
                <th className="text-left px-3 py-2">Uses a slot</th>
                <th className="text-left px-3 py-2">Criteria</th></tr>
            </thead>
            <tbody className="divide-y divide-navy-100">
              {m.awards.map((a) => (
                <tr key={a.id} className={a.active ? '' : 'opacity-50'}>
                  <td className="px-3 py-2 font-semibold">{a.name}</td>
                  <td className="px-3 py-2">{a.level}</td>
                  <td className="px-3 py-2">{a.frequency}</td>
                  <td className="px-3 py-2">
                    {a.min_experience_years == null && a.max_experience_years == null ? 'any'
                      : a.max_experience_years == null ? `${a.min_experience_years}+ yrs`
                      : `${a.min_experience_years ?? 0} to under ${a.max_experience_years} yrs`}
                  </td>
                  <td className="px-3 py-2">{a.experience_basis === 'tenure' ? 'Mindgate tenure' : 'total experience'}</td>
                  <td className="px-3 py-2">
                    {a.counts_towards_quota === false
                      ? <span className="chip bg-navy-50 text-navy-500">outside the quota</span>
                      : <span className="chip bg-amber-50 text-amber-700">yes</span>}
                  </td>
                  <td className="px-3 py-2 text-navy-500">{a.criteria || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- band and status masters --------------------------------- */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="card p-4 space-y-2">
          <p className="lbl mb-0">Band → level</p>
          <div className="flex flex-wrap gap-1.5">
            {m.bandLevels.map((b) => (
              <span key={b.band} className="chip bg-navy-50 text-navy-600">{b.band} → {b.level}</span>
            ))}
          </div>
        </div>
        <div className="card p-4 space-y-2">
          <p className="lbl mb-0">Which statuses count as active</p>
          <div className="flex flex-wrap gap-1.5">
            {m.statuses.map((s) => (
              <span key={s.status} className={`chip ${s.is_active ? 'bg-leaf-50 text-leaf-600' : 'bg-navy-50 text-navy-400'}`}>
                {s.status}{s.is_active ? '' : ' · excluded'}
              </span>
            ))}
          </div>
          <p className="text-[11px] text-navy-400">This list is the denominator of the 3%.</p>
        </div>
      </div>
    </div>
  );
}
