import { useEffect, useState } from 'react';
import { Upload, Plus, Trash2, Save, Calculator, AlertTriangle } from 'lucide-react';
import { api, API_BASE } from '../utils/api';

// The Simulation Report: model increments from the cycle's final ratings
// and a budget.
//
// EVERYTHING HERE IS SALARY, behind pms_compensation — which managers and
// Delivery Heads do not have. The page shows a plain 403 explanation
// rather than an empty screen if someone reaches it without the grant.
//
// Nothing on this page changes anybody's pay. Scenarios are models; the
// only way a salary enters the system is the upload at the top, and the
// only way one changes is another upload.
const money = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }));

export default function IncrementSimulationPage() {
  const [tab, setTab] = useState('scenarios');
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    api('/pms/increment-matrix').catch(e => { if (e.status === 403) setDenied(true); });
  }, []);

  if (denied) {
    return (
      <div className="card p-8 max-w-xl mx-auto text-center space-y-2">
        <AlertTriangle size={20} className="inline text-amber-500" />
        <p className="text-sm font-semibold">Compensation access is granted separately</p>
        <p className="text-xs text-navy-500">
          This report holds salary data, so it sits behind its own permission (<code>pms_compensation</code>) rather than
          general HR access. An administrator can grant it without changing anything else about your role.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <div>
        <h2 className="text-lg font-bold">Increment Simulation</h2>
        <p className="text-xs text-navy-400">
          Models what an increment round would cost, from this cycle's ratings and the salaries on record.
          Nothing here changes anyone's pay.
        </p>
      </div>
      <div className="flex gap-2">
        {[['scenarios', 'Scenarios'], ['matrix', 'Rating → increment'], ['salaries', 'Salaries on record']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'btn-pri' : 'btn-sec'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'scenarios' && <Scenarios />}
      {tab === 'matrix' && <Matrix />}
      {tab === 'salaries' && <Salaries />}
    </div>
  );
}

function Matrix() {
  const [bands, setBands] = useState([]);
  const [scope, setScope] = useState('standing');
  const [errs, setErrs] = useState([]);
  const [msg, setMsg] = useState(null);
  const load = () => api('/pms/increment-matrix').then(r => { setBands(r.bands); setScope(r.scope); }).catch(() => {});
  useEffect(() => { load(); }, []);

  const save = async () => {
    setErrs([]); setMsg(null);
    try {
      await api('/pms/increment-matrix', { method: 'PUT', body: JSON.stringify({ bands, cycle_scoped: scope === 'cycle' }) });
      setMsg('Saved.'); load();
    } catch (e) { setErrs(e.data?.errors || [{ error: e.message }]); }
  };
  const set = (i, k) => (ev) => setBands(bs => bs.map((b, j) => (j === i ? { ...b, [k]: ev.target.value } : b)));

  return (
    <div className="card p-4 space-y-2">
      <p className="lbl mb-0">What each rating is worth</p>
      <p className="text-[11px] text-navy-400">
        Ranges are inclusive at both ends, and must not overlap — one rating cannot mean two increments.
        A final rating can be fractional (a weighted 4.2), which is why these are ranges rather than exact values.
      </p>
      {bands.map((b, i) => (
        <div key={i} className="flex flex-wrap gap-2 items-center">
          <input className="inp flex-1 min-w-[140px]" placeholder="Label (e.g. Outstanding)" value={b.label || ''} onChange={set(i, 'label')} />
          <input className="inp w-20 text-right" type="number" step="0.1" placeholder="from" value={b.rating_min ?? ''} onChange={set(i, 'rating_min')} />
          <span className="text-xs text-navy-400">to</span>
          <input className="inp w-20 text-right" type="number" step="0.1" placeholder="to" value={b.rating_max ?? ''} onChange={set(i, 'rating_max')} />
          <input className="inp w-24 text-right" type="number" step="0.01" placeholder="%" value={b.increment_pct ?? ''} onChange={set(i, 'increment_pct')} />
          <button className="text-rose-500" onClick={() => setBands(bs => bs.filter((_, j) => j !== i))}><Trash2 size={15} /></button>
        </div>
      ))}
      {errs.map((e, i) => <p key={i} className="text-xs text-rose-600">{e.row ? `Row ${e.row}: ` : ''}{e.error}</p>)}
      {msg && <p className="text-xs text-emerald-600">{msg}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-sec" onClick={() => setBands(bs => [...bs, { label: '', rating_min: '', rating_max: '', increment_pct: '' }])}>
          <Plus size={13} className="inline mr-1" />Add band
        </button>
        <select className="inp w-auto" value={scope} onChange={e => setScope(e.target.value)}>
          <option value="standing">Standing policy</option>
          <option value="cycle">This cycle only</option>
        </select>
        <button className="btn-pri" onClick={save}><Save size={13} className="inline mr-1" />Save matrix</button>
      </div>
    </div>
  );
}

function Salaries() {
  const [data, setData] = useState(null);
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api('/pms/compensation').then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  const send = async (commit) => {
    setErr(null);
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await api(`/pms/compensation/upload${commit ? '?commit=1' : ''}`, { method: 'POST', body: fd });
      setReport(r); if (commit) load();
    } catch (e) { setErr(e.message); setReport(e.data?.errors ? e.data : null); }
  };

  return (
    <div className="space-y-3">
      <div className="card p-4 space-y-2">
        <p className="lbl mb-0">Load current salaries</p>
        <p className="text-[11px] text-navy-400">
          Columns: <b>employee_email</b>, <b>annual_ctc</b>, optionally <b>currency</b> and <b>effective_from</b> (yyyy-mm-dd).
          Commas and currency symbols in the figures are fine. A raise is a new row with a later effective date — the old
          one stays, so past scenarios still reconcile.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept=".csv,.xlsx" onChange={e => { setFile(e.target.files[0]); setReport(null); }} className="text-xs" />
          <button className="btn-sec" disabled={!file} onClick={() => send(false)}><Upload size={13} className="inline mr-1" />Validate</button>
          <button className="btn-pri" disabled={!file || !(report && report.ok && !report.committed)} onClick={() => send(true)}>Load</button>
        </div>
        {err && <p className="text-xs text-rose-600">{err}</p>}
        {report && (
          <div className="text-xs space-y-1">
            <p className="font-semibold">{report.committed ? `LOADED ${report.loaded}` : report.ok ? 'VALID — press Load' : 'REJECTED'}</p>
            {(report.errors || []).map((e, i) => <p key={i} className="text-rose-600">line {e.line}: {e.error}</p>)}
            {(report.warnings || []).map((w, i) => <p key={i} className="text-amber-700">line {w.line}: {w.warning}</p>)}
          </div>
        )}
      </div>

      {data && (
        <div className="card p-4">
          <p className="lbl">{data.on_record} on record · {data.missing} missing</p>
          {data.missing > 0 && (
            <p className="text-[11px] text-amber-700 mb-2">
              Anyone without a salary is left out of every scenario and reported there by name — they are not modelled at zero.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-navy-400"><th className="py-1">Employee</th><th>Department</th><th className="text-right">Annual CTC</th><th>Effective</th></tr></thead>
              <tbody>
                {data.employees.map(e => (
                  <tr key={e.employee_id} className="border-t border-navy-100">
                    <td className="py-1">{e.name}</td>
                    <td className="text-navy-500">{e.department || '—'}</td>
                    <td className={`text-right ${e.annual_ctc == null ? 'text-amber-600' : ''}`}>{e.annual_ctc == null ? 'not on record' : money(e.annual_ctc)}</td>
                    <td className="text-navy-400">{e.effective_from ? String(e.effective_from).slice(0, 10) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Scenarios() {
  const [list, setList] = useState(null);
  const [cycle, setCycle] = useState(null);
  const [open, setOpen] = useState(null);
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('');
  const [err, setErr] = useState(null);
  const load = () => api('/pms/increment-simulations').then(r => { setList(r.simulations); setCycle(r.cycle); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  const create = async () => {
    setErr(null);
    try {
      const r = await api('/pms/increment-simulations', { method: 'POST', body: JSON.stringify({ name, budget_amount: budget === '' ? null : Number(budget) }) });
      setName(''); setBudget(''); load(); setOpen(r);
    } catch (e) { setErr(e.message); }
  };
  const remove = async (id) => {
    if (!confirm('Delete this scenario? The salaries and the matrix are untouched.')) return;
    try { await api(`/pms/increment-simulations/${id}`, { method: 'DELETE' }); if (open?.simulation?.id === id) setOpen(null); load(); }
    catch (e) { setErr(e.message); }
  };

  if (!list) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle to model.</div>;

  return (
    <div className="space-y-3">
      <div className="card p-4 space-y-2">
        <p className="lbl mb-0">New scenario · {cycle.name}</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grow min-w-[180px]"><label className="text-[11px] text-navy-400">Name</label>
            <input className="inp" placeholder="e.g. 8% blended" value={name} onChange={e => setName(e.target.value)} /></div>
          <div><label className="text-[11px] text-navy-400">Budget (optional)</label>
            <input className="inp w-44 text-right" type="number" placeholder="total pot" value={budget} onChange={e => setBudget(e.target.value)} /></div>
          <button className="btn-pri" disabled={!name.trim()} onClick={create}><Calculator size={13} className="inline mr-1" />Model it</button>
        </div>
        {err && <p className="text-xs text-rose-600">{err}</p>}
      </div>

      {list.map(s => (
        <div key={s.id} className="card p-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">{s.name}</p>
            <p className="text-[11px] text-navy-400">
              budget {s.budget_amount == null ? 'not set' : money(s.budget_amount)} · {s.overrides} override{s.overrides === 1 ? '' : 's'}
              {s.scale_to_fit && ' · scaled to fit'} · by {s.created_by}
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn-sec" onClick={async () => setOpen(await api(`/pms/increment-simulations/${s.id}`))}>Open</button>
            <button className="btn-sec !p-1.5" onClick={() => remove(s.id)}><Trash2 size={14} /></button>
          </div>
        </div>
      ))}

      {open && <ScenarioDetail data={open} onChange={setOpen} onReload={load} />}
    </div>
  );
}

function ScenarioDetail({ data, onChange, onReload }) {
  const [err, setErr] = useState(null);
  const [overriding, setOverriding] = useState(null);
  const [pct, setPct] = useState(''); const [reason, setReason] = useState('');
  const sim = data.simulation; const t = data.totals;

  const patch = async (body) => {
    setErr(null);
    try { onChange(await api(`/pms/increment-simulations/${sim.id}`, { method: 'PUT', body: JSON.stringify(body) })); onReload(); }
    catch (e) { setErr(e.message); }
  };
  const setOverride = async (employeeId) => {
    setErr(null);
    try {
      const r = await api(`/pms/increment-simulations/${sim.id}/overrides/${employeeId}`, {
        method: 'PUT', body: JSON.stringify({ increment_pct: Number(pct), reason }),
      });
      onChange({ ...data, ...r }); setOverriding(null); setPct(''); setReason(''); onReload();
    } catch (e) { setErr(e.message); }
  };
  const clearOverride = async (employeeId) => {
    try { const r = await api(`/pms/increment-simulations/${sim.id}/overrides/${employeeId}`, { method: 'DELETE' }); onChange({ ...data, ...r }); onReload(); }
    catch (e) { setErr(e.message); }
  };

  return (
    <div className="card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-bold text-sm">{sim.name}</p>
        <label className="text-xs flex items-center gap-1">
          <input type="checkbox" checked={sim.scale_to_fit} onChange={e => patch({ scale_to_fit: e.target.checked })} />
          Scale to fit the budget
        </label>
      </div>

      <div className="grid sm:grid-cols-4 gap-2 text-center">
        {[['Current total', t.current_total], ['Increment cost', t.increment_total], ['New total', t.new_total]].map(([k, v]) => (
          <div key={k} className="bg-navy-50 rounded-lg p-2"><p className="text-[11px] text-navy-400">{k}</p><p className="text-sm font-bold">{money(v)}</p></div>
        ))}
        <div className="bg-navy-50 rounded-lg p-2"><p className="text-[11px] text-navy-400">Blended</p><p className="text-sm font-bold">{t.average_increment_pct}%</p></div>
      </div>

      {t.budget != null && (
        <p className={`text-xs font-medium ${t.within_budget ? 'text-emerald-700' : 'text-rose-600'}`}>
          Budget {money(t.budget)} — {t.within_budget ? `${money(t.variance)} unspent` : `${money(Math.abs(t.variance))} over`}
          {t.scaled && ' · non-overridden increments were scaled down to fit (rounded down, so the total never exceeds the pot)'}
        </p>
      )}
      {err && <p className="text-xs text-rose-600">{err}</p>}

      {data.by_department.length > 0 && (
        <div className="text-xs">
          <p className="lbl">By department</p>
          {data.by_department.map(d => (
            <div key={d.department} className="flex justify-between border-b border-navy-100 py-1">
              <span>{d.department} <span className="text-navy-400">({d.employees})</span></span>
              <span>{money(d.increment_total)} <span className="text-navy-400">· {d.average_increment_pct}%</span></span>
            </div>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-navy-400">
            <th className="py-1">Employee</th><th>Rating</th><th>Band</th><th className="text-right">Current</th>
            <th className="text-right">%</th><th className="text-right">Increment</th><th className="text-right">New</th><th></th>
          </tr></thead>
          <tbody>
            {data.lines.map(l => (
              <tr key={l.employee_id} className="border-t border-navy-100">
                <td className="py-1">{l.name}</td>
                <td>{l.final_rating}</td>
                <td className="text-navy-500">{l.overridden ? <span className="chip bg-amber-100 text-amber-700">override</span> : l.band_label}</td>
                <td className="text-right">{money(l.current_ctc)}</td>
                <td className="text-right">{l.increment_pct}%{l.scaled && <span className="text-navy-400"> ↓</span>}</td>
                <td className="text-right">{money(l.increment_amount)}</td>
                <td className="text-right font-medium">{money(l.new_ctc)}</td>
                <td className="text-right">
                  {l.overridden
                    ? <button className="btn-sec !py-0.5 !text-[11px]" onClick={() => clearOverride(l.employee_id)} title={l.override_reason}>Clear</button>
                    : <button className="btn-sec !py-0.5 !text-[11px]" onClick={() => { setOverriding(l.employee_id); setPct(String(l.increment_pct)); setReason(''); }}>Override</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {overriding && (
        <div className="flex flex-wrap items-end gap-2 bg-amber-50 border border-amber-100 rounded-lg p-2">
          <div><label className="text-[11px] text-navy-500">Increment %</label>
            <input className="inp w-24 text-right" type="number" step="0.01" value={pct} onChange={e => setPct(e.target.value)} /></div>
          <div className="grow min-w-[220px]"><label className="text-[11px] text-navy-500">Reason (required)</label>
            <input className="inp" placeholder="Why this differs from the band" value={reason} onChange={e => setReason(e.target.value)} /></div>
          <button className="btn-pri" disabled={!reason.trim()} onClick={() => setOverride(overriding)}>Apply</button>
          <button className="btn-sec" onClick={() => setOverriding(null)}>Cancel</button>
        </div>
      )}

      {data.excluded.length > 0 && (
        <div className="text-xs">
          <p className="lbl">Not modelled ({data.excluded.length})</p>
          <p className="text-[11px] text-navy-400 mb-1">Reported by name rather than dropped — a missing person in a budget round is somebody who does not get a raise.</p>
          {data.excluded.map(e => <p key={e.employee_id} className="text-navy-500">{e.name} — {e.reason}</p>)}
        </div>
      )}
    </div>
  );
}
