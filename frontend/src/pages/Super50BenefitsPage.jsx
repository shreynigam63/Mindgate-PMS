import { useEffect, useState } from 'react';
import { NavLink, useSearchParams } from 'react-router-dom';
import { api, API_BASE } from '../utils/api';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import { Award, RefreshCw, Download, Plus, Save, Trash2, CalendarDays, Clock, CheckCircle2, Users } from 'lucide-react';
import { CLAIM_STATUS } from './MySuper50Page';

// HR's Super 50 Benefits (15 Oct, from the client's policy sheet).
//
//   Awardees     who holds which tier, their balance, their programme;
//                setting the tiers; the two exports; certificates.
//   Claims       the queue: open the bill, approve, or return with a
//                reason the employee sees. HR alone decides.
//   Policy       the benefits year itself: dates, tiers, amounts,
//                benefits, entitlements and hubs — all data, edited here.
//   Programmes   the IIT/IIM catalogue a Twice or Elite picks from.

const inr = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const dl = (path) => `${API_BASE}${path}${path.includes('?') ? '&' : '?'}token=${localStorage.getItem('apms_token')}`;
const TIER_CHIP = { elite: 'bg-violet-100 text-violet-700', twice: 'bg-blue-100 text-blue-700', super50: 'bg-amber-100 text-amber-700' };
const TABS = [['awardees', 'Awardees'], ['claims', 'Claims'], ['policy', 'Policy'], ['programmes', 'IIT/IIM programmes']];

export default function Super50BenefitsPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'awardees';
  const [list, setList] = useState(null);
  const [pid, setPid] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const load = () => api('/pms/super50/policies').then((r) => {
    setList(r.policies);
    setPid((cur) => (cur && r.policies.some((p) => p.id === cur) ? cur : (r.policies.find((p) => p.status === 'active') || r.policies[0] || {}).id || null));
  }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const act = async (fn, done) => {
    if (busy) return null;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await fn();
      setMsg(typeof done === 'function' ? done(r) : done);
      await load(); setTick((t) => t + 1);
      return r;
    } catch (e) { setErr(e.message); return null; } finally { setBusy(false); }
  };

  if (err && !list) return <p className="text-sm text-rose-600">{err}</p>;
  if (!list) return <p className="text-sm text-navy-400">Loading…</p>;
  const policy = list.find((p) => p.id === pid);

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <PageHead title="Super 50 Benefits" hue="violet"
        sub={policy ? `${policy.name} · ${day(policy.starts_on)} – ${day(policy.ends_on)} · based on the ${policy.basis_fiscal_year} appraisal` : 'Tiers, the benefits table and claims'}>
        {list.length > 1 && (
          <select className="inp !w-auto !py-1.5 text-xs" value={pid || ''} onChange={(e) => setPid(e.target.value)}>
            {list.map((p) => <option key={p.id} value={p.id}>{p.name}{p.status === 'closed' ? ' (closed)' : ''}</option>)}
          </select>
        )}
      </PageHead>

      {msg && <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">{msg}</p>}
      {err && <p className="text-xs text-rose-600">{err}</p>}

      {!policy ? (
        <div className="card p-6 text-center space-y-3">
          <p className="text-sm text-navy-600">No benefits year is set up yet.</p>
          <p className="text-[11.5px] text-navy-500">
            Start from the policy sheet: July 2026 to June 2027, based on the FY25-26 appraisal, ₹30,000 for Super 50 and Twice,
            ₹50,000 for Elite, claims under the Knowledge, Health, Personal and Tech hubs. Everything can be changed after.
          </p>
          <button className="btn-pri" disabled={busy}
            onClick={() => act(() => api('/pms/super50/policies', { method: 'POST', body: JSON.stringify({ from_default: true }) }), 'Benefits year created from the policy sheet. Set the tiers on Awardees.')}>
            <Plus size={13} className="inline mr-1" />Create from the policy sheet
          </button>
        </div>
      ) : (
        <>
          <div className="tabbar">
            {TABS.map(([k, label]) => (
              <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setParams(k === 'awardees' ? {} : { tab: k })}>
                {label}{k === 'claims' && policy.claims_waiting ? ` (${policy.claims_waiting})` : ''}
              </button>
            ))}
          </div>
          {tab === 'awardees' && <Awardees key={`${pid}-${tick}`} policy={policy} act={act} busy={busy} />}
          {tab === 'claims' && <Claims key={`${pid}-${tick}`} policy={policy} act={act} busy={busy} />}
          {tab === 'policy' && <PolicyForm key={`${pid}-${tick}`} policy={policy} act={act} busy={busy} />}
          {tab === 'programmes' && <Programmes key={`${pid}-${tick}`} policy={policy} act={act} busy={busy} />}
        </>
      )}
    </div>
  );
}

function Awardees({ policy, act, busy }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState(null);
  useEffect(() => { api(`/pms/super50/policies/${policy.id}/awards`).then((r) => setRows(r.awards)).catch((e) => setErr(e.message)); }, [policy.id]);
  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!rows) return <p className="text-sm text-navy-400">Loading…</p>;
  const active = rows.filter((a) => a.status === 'active');
  const count = (k) => active.filter((a) => a.tier === k).length;
  const label = (k) => (policy.tiers.find((t) => t.key === k) || {}).label;
  const shown = rows.filter((a) => matches(q, a.name, a.emp_code, a.department, a.label));
  const felicitation = `/admin/events?${new URLSearchParams({
    title: `${policy.name}: felicitation`,
    description: `Grand celebration with the Senior Management Team for ${active.length} Super 50 awardee${active.length === 1 ? '' : 's'} `
      + `(${count('elite')} Elite, ${count('twice')} Twice, ${count('super50')} Super 50).`,
  })}`;
  const assign = () => act(() => api(`/pms/super50/policies/${policy.id}/assign`, { method: 'POST' }),
    (r) => `${r.problem ? `${r.problem} ` : ''}Tiers set: ${r.awarded} new, ${r.upgraded} moved up, ${r.changed} changed, ${r.withdrawn} withdrawn${r.kept_with_claims ? `, ${r.kept_with_claims} no longer qualify but keep the tier because claims are paid` : ''}. ${r.notified} told by email and in the app.`);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[['elite', 'violet'], ['twice', 'azure'], ['super50', 'amber']].map(([k, hue]) => (
          <div key={k} className={`tile tile-${hue}`}><div className="tile-b"><Award size={16} /></div>
            <div><div className="tile-n">{count(k)}</div><div className="tile-l">{label(k)}</div></div></div>
        ))}
        <div className="tile tile-leaf"><div className="tile-b"><CheckCircle2 size={16} /></div>
          <div><div className="tile-n">{inr(active.reduce((s, a) => s + a.used, 0))}</div><div className="tile-l">Approved so far</div></div></div>
      </div>
      <div className="card p-3 flex flex-wrap items-center gap-2 text-[11.5px] text-navy-600">
        <button className="btn-pri" disabled={busy || policy.status !== 'active'} onClick={assign}>
          <RefreshCw size={13} className="inline mr-1" />{busy ? 'Working…' : 'Set the tiers now'}
        </button>
        <span className="flex-1 min-w-[16rem]">
          {policy.assigned_at ? `Last set ${day(policy.assigned_at)}. ` : 'Not set yet. '}
          Tiers are also set when the {policy.basis_fiscal_year} annual cycle is published. Imported pre-PMS years count.
        </span>
        <a className="btn-sec" href={dl(`/pms/super50/policies/${policy.id}/export.xlsx?kind=entitlements`)}><Download size={13} className="inline mr-1" />Entitlements</a>
        <a className="btn-sec" href={dl(`/pms/super50/policies/${policy.id}/export.xlsx?kind=claims`)}><Download size={13} className="inline mr-1" />Approved claims</a>
        <NavLink className="btn-sec" to={felicitation}><CalendarDays size={13} className="inline mr-1" />Plan the felicitation</NavLink>
      </div>
      <SearchBox value={q} onChange={setQ} placeholder="Search by name, code, department or tier…" shown={shown.length} total={rows.length} />
      {!rows.length ? (
        <div className="card p-6 text-center text-sm text-navy-400">Nobody holds a tier yet. Use <b>Set the tiers now</b>.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
              <tr><th className="text-left p-2">Employee</th><th className="text-left p-2">Tier</th><th className="text-right p-2">Years</th>
                <th className="text-right p-2">Amount</th><th className="text-right p-2">Approved</th><th className="text-right p-2">Waiting</th>
                <th className="text-right p-2">Left</th><th className="text-left p-2">Programme</th><th className="p-2" /></tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id} className={`border-t border-navy-50 ${a.status !== 'active' ? 'opacity-50' : ''}`}>
                  <td className="p-2"><b className="text-navy-700">{a.name}</b><div className="text-[10.5px] text-navy-400">{[a.emp_code, a.department].filter(Boolean).join(' · ')}</div></td>
                  <td className="p-2"><span className={`chip ${TIER_CHIP[a.tier]}`}>{a.label}</span>{a.status !== 'active' && <span className="ml-1 text-[10.5px]">withdrawn</span>}</td>
                  <td className="p-2 text-right">{a.streak}</td>
                  <td className="p-2 text-right">{inr(a.amount)}</td>
                  <td className="p-2 text-right">{inr(a.used)}</td>
                  <td className="p-2 text-right">{a.pending ? inr(a.pending) : '—'}</td>
                  <td className="p-2 text-right font-semibold">{inr(a.remaining)}</td>
                  <td className="p-2">
                    {a.programme_name ? (
                      <span>{a.programme_name}{' '}
                        {a.programme_status === 'completed' ? <span className="chip bg-emerald-100 text-emerald-700">Completed</span> : (
                          <button className="text-navy-600 underline" disabled={busy}
                            onClick={() => act(() => api(`/pms/super50/awards/${a.id}/programme`, { method: 'PUT', body: JSON.stringify({ status: 'completed' }) }), `${a.name}'s programme is marked completed.`)}>
                            Mark completed
                          </button>
                        )}
                      </span>
                    ) : <span className="text-navy-400">{(policy.tiers.find((t) => t.key === a.tier) || {}).entitlements?.programme ? 'Not chosen yet' : '—'}</span>}
                  </td>
                  <td className="p-2 text-right">{a.status === 'active' && <a className="text-navy-600 underline whitespace-nowrap" href={dl(`/pms/super50/awards/${a.id}/certificate.pdf`)}>Certificate</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Claims({ policy, act, busy }) {
  const [status, setStatus] = useState('submitted');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [returning, setReturning] = useState(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    setRows(null);
    api(`/pms/super50/policies/${policy.id}/claims${status ? `?status=${status}` : ''}`).then((r) => setRows(r.claims)).catch((e) => setErr(e.message));
  }, [policy.id, status]);
  const hub = Object.fromEntries(policy.hubs.map((h) => [h.key, h.label]));
  const label = (k) => (policy.tiers.find((t) => t.key === k) || {}).label;
  const decide = (c, decision) => act(() => api(`/pms/super50/claims/${c.id}/decide`, { method: 'POST', body: JSON.stringify({ decision, note: decision === 'return' ? note : undefined }) }),
    decision === 'approve' ? `Approved ${inr(c.amount)} for ${c.name}. They have been told.` : `Returned to ${c.name} with your reason.`);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        {[['submitted', 'Waiting on HR'], ['approved', 'Approved'], ['returned', 'Returned'], ['', 'All']].map(([k, l]) => (
          <button key={k || 'all'} type="button" className={`chip ${status === k ? 'bg-navy-700 text-white' : 'bg-navy-50 text-navy-600'}`} onClick={() => setStatus(k)}>{l}</button>
        ))}
      </div>
      {err && <p className="text-sm text-rose-600">{err}</p>}
      {!rows ? <p className="text-sm text-navy-400">Loading…</p> : !rows.length ? (
        <div className="card p-6 text-center text-sm text-navy-400">{status === 'submitted' ? 'No claims are waiting on HR.' : 'No claims here.'}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
              <tr><th className="text-left p-2">Sent</th><th className="text-left p-2">Employee</th><th className="text-left p-2">Hub · for</th>
                <th className="text-right p-2">Amount</th><th className="text-left p-2">Status</th><th className="p-2" /></tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const [sl, cls] = CLAIM_STATUS[c.status] || [c.status, ''];
                return (
                  <tr key={c.id} className="border-t border-navy-50 align-top">
                    <td className="p-2 whitespace-nowrap">{day(c.created_at)}</td>
                    <td className="p-2"><b className="text-navy-700">{c.name}</b><div className="text-[10.5px] text-navy-400">{label(c.tier)}{c.emp_code ? ` · ${c.emp_code}` : ''}</div></td>
                    <td className="p-2">{hub[c.hub] || c.hub}{c.item ? ` · ${c.item}` : ''}{c.description && <div className="text-[10.5px] text-navy-500">{c.description}</div>}</td>
                    <td className="p-2 text-right font-semibold">{inr(c.amount)}</td>
                    <td className="p-2"><span className={`chip ${cls}`}>{sl}</span>
                      {c.decision_note && <div className="text-[10.5px] text-navy-500 mt-1">{c.decision_note}</div>}
                      {c.decided_by && <div className="text-[10.5px] text-navy-400">{c.decided_by} · {day(c.decided_at)}</div>}</td>
                    <td className="p-2 text-right whitespace-nowrap">
                      <a className="text-navy-600 underline mr-3" href={dl(`/pms/super50/claims/${c.id}/bill`)} target="_blank" rel="noreferrer">Bill</a>
                      {c.status === 'submitted' && returning !== c.id && (
                        <>
                          <button className="btn-pri !py-1 mr-1" disabled={busy} onClick={() => decide(c, 'approve')}>Approve</button>
                          <button className="btn-sec !py-1" disabled={busy} onClick={() => { setReturning(c.id); setNote(''); }}>Return</button>
                        </>
                      )}
                      {returning === c.id && (
                        <div className="flex gap-1 items-center justify-end mt-1">
                          <input className="inp !py-1 text-xs w-56" autoFocus placeholder="Why it is returned (they see this)" value={note} onChange={(e) => setNote(e.target.value)} />
                          <button className="btn-pri !py-1" disabled={busy || !note.trim()} onClick={async () => { if (await decide(c, 'return')) setReturning(null); }}>Return</button>
                          <button className="btn-sec !py-1" onClick={() => setReturning(null)}>Cancel</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const linesOf = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

function PolicyForm({ policy, act, busy }) {
  const [p, setP] = useState(() => ({
    ...policy,
    tiers: policy.tiers.map((t) => ({ ...t, benefitsText: (t.benefits || []).join('\n'), entitlements: { ...t.entitlements } })),
    hubs: policy.hubs.map((h) => ({ ...h, itemsText: (h.items || []).join(', ') })),
  }));
  const setTier = (i, patch) => setP({ ...p, tiers: p.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const setEnt = (i, patch) => setTier(i, { entitlements: { ...p.tiers[i].entitlements, ...patch } });
  const setHub = (i, patch) => setP({ ...p, hubs: p.hubs.map((h, j) => (j === i ? { ...h, ...patch } : h)) });
  const save = () => act(async () => {
    const body = {
      name: p.name, basis_fiscal_year: p.basis_fiscal_year, starts_on: p.starts_on, ends_on: p.ends_on,
      lapse_reminder_days: Number(p.lapse_reminder_days), status: p.status,
      tiers: p.tiers.map((t) => ({ key: t.key, label: t.label, min_streak: Number(t.min_streak), amount: Number(t.amount), benefits: linesOf(t.benefitsText),
        entitlements: { ...t.entitlements, mandatory_el_days: Number(t.entitlements.mandatory_el_days || 0),
          variable_pct: t.entitlements.variable_pct === '' || t.entitlements.variable_pct == null ? null : Number(t.entitlements.variable_pct) } })),
      hubs: p.hubs.map((h) => ({ key: h.key, label: h.label, items: String(h.itemsText || '').split(',').map((x) => x.trim()).filter(Boolean) })),
    };
    return api(`/pms/super50/policies/${policy.id}`, { method: 'PUT', body: JSON.stringify(body) });
  }, (r) => r.note);

  return (
    <div className="space-y-4">
      <div className="card p-4 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Field label="Name"><input className="inp" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
        <Field label="Based on the appraisal of"><input className="inp" value={p.basis_fiscal_year} onChange={(e) => setP({ ...p, basis_fiscal_year: e.target.value })} /></Field>
        <Field label="Status">
          <select className="inp" value={p.status} onChange={(e) => setP({ ...p, status: e.target.value })}>
            <option value="active">Active</option><option value="closed">Closed</option>
          </select>
        </Field>
        <Field label="Claims open from"><input className="inp" type="date" value={p.starts_on} onChange={(e) => setP({ ...p, starts_on: e.target.value })} /></Field>
        <Field label="Unused balance lapses after"><input className="inp" type="date" value={p.ends_on} onChange={(e) => setP({ ...p, ends_on: e.target.value })} /></Field>
        <Field label="Lapse reminder (days before)"><input className="inp" type="number" min="0" max="180" value={p.lapse_reminder_days} onChange={(e) => setP({ ...p, lapse_reminder_days: e.target.value })} /></Field>
      </div>

      <div className="grid lg:grid-cols-3 gap-3">
        {p.tiers.map((t, i) => (
          <div key={t.key} className="card p-4 space-y-2">
            <Field label="Tier"><input className="inp" value={t.label} onChange={(e) => setTier(i, { label: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Consecutive years"><input className="inp" type="number" min="1" value={t.min_streak} onChange={(e) => setTier(i, { min_streak: e.target.value })} /></Field>
              <Field label="Amount (₹)"><input className="inp" type="number" min="0" value={t.amount} onChange={(e) => setTier(i, { amount: e.target.value })} /></Field>
            </div>
            <Field label="Benefits, one per line"><textarea className="inp" rows={6} value={t.benefitsText} onChange={(e) => setTier(i, { benefitsText: e.target.value })} /></Field>
            <p className="lbl !mb-0 pt-1">For the entitlements sheet</p>
            <label className="flex items-center gap-2 text-xs text-navy-700"><input type="checkbox" checked={!!t.entitlements.single_punch} onChange={(e) => setEnt(i, { single_punch: e.target.checked })} />Single-punch full attendance</label>
            <label className="flex items-center gap-2 text-xs text-navy-700"><input type="checkbox" checked={!!t.entitlements.fast_track} onChange={(e) => setEnt(i, { fast_track: e.target.checked })} />Fast-track promotion (shown on Calibration)</label>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Mandatory EL days"><input className="inp" type="number" min="0" value={t.entitlements.mandatory_el_days} onChange={(e) => setEnt(i, { mandatory_el_days: e.target.value })} /></Field>
              <Field label="Variable (% of last year)"><input className="inp" type="number" min="0" value={t.entitlements.variable_pct ?? ''} onChange={(e) => setEnt(i, { variable_pct: e.target.value })} /></Field>
            </div>
            <Field label="IIT/IIM programme">
              <select className="inp" value={t.entitlements.programme || ''} onChange={(e) => setEnt(i, { programme: e.target.value || null })}>
                <option value="">None</option><option value="course">A course from the catalogue</option><option value="refresher">A 2-day refresher</option>
              </select>
            </Field>
          </div>
        ))}
      </div>

      <div className="card p-4 space-y-2">
        <p className="lbl">Hubs a claim can be made under</p>
        {p.hubs.map((h, i) => (
          <div key={i} className="grid sm:grid-cols-[14rem_1fr_auto] gap-2 items-center">
            <input className="inp" value={h.label} placeholder="Hub name" onChange={(e) => setHub(i, { label: e.target.value })} />
            <input className="inp" value={h.itemsText} placeholder="What it covers, separated by commas" onChange={(e) => setHub(i, { itemsText: e.target.value })} />
            <button className="btn-sec" title="Remove this hub" onClick={() => setP({ ...p, hubs: p.hubs.filter((_, j) => j !== i) })}><Trash2 size={13} /></button>
          </div>
        ))}
        <button className="btn-sec" onClick={() => setP({ ...p, hubs: [...p.hubs, { key: '', label: '', itemsText: '' }] })}><Plus size={13} className="inline mr-1" />Add a hub</button>
      </div>
      <div className="flex justify-end">
        <button className="btn-pri" disabled={busy} onClick={save}><Save size={13} className="inline mr-1" />{busy ? 'Saving…' : 'Save the policy'}</button>
      </div>
    </div>
  );
}

function Programmes({ policy, act, busy }) {
  const [rows, setRows] = useState(null);
  const [n, setN] = useState({ name: '', provider: '', kind: 'course' });
  const [err, setErr] = useState(null);
  useEffect(() => { api(`/pms/super50/policies/${policy.id}/programmes`).then((r) => setRows(r.programmes)).catch((e) => setErr(e.message)); }, [policy.id]);
  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!rows) return <p className="text-sm text-navy-400">Loading…</p>;
  const KIND = { course: 'Course (Twice)', refresher: '2-day refresher (Elite)' };
  return (
    <div className="space-y-3">
      <div className="card p-4 grid sm:grid-cols-[1fr_12rem_14rem_auto] gap-2 items-end">
        <Field label="Programme"><input className="inp" value={n.name} placeholder="e.g. IIM Ahmedabad leadership programme" onChange={(e) => setN({ ...n, name: e.target.value })} /></Field>
        <Field label="Institute"><input className="inp" value={n.provider} placeholder="e.g. IIM Ahmedabad" onChange={(e) => setN({ ...n, provider: e.target.value })} /></Field>
        <Field label="For">
          <select className="inp" value={n.kind} onChange={(e) => setN({ ...n, kind: e.target.value })}>
            <option value="course">{KIND.course}</option><option value="refresher">{KIND.refresher}</option>
          </select>
        </Field>
        <button className="btn-pri" disabled={busy || !n.name.trim()}
          onClick={async () => { if (await act(() => api(`/pms/super50/policies/${policy.id}/programmes`, { method: 'POST', body: JSON.stringify(n) }), 'Programme added to the catalogue.')) setN({ name: '', provider: '', kind: n.kind }); }}>
          <Plus size={13} className="inline mr-1" />Add
        </button>
      </div>
      {!rows.length ? <div className="card p-6 text-center text-sm text-navy-400">The catalogue is empty. Twice and Elite awardees pick from what is added here.</div> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
              <tr><th className="text-left p-2">Programme</th><th className="text-left p-2">Institute</th><th className="text-left p-2">For</th><th className="text-right p-2">Chosen by</th><th className="p-2" /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`border-t border-navy-50 ${r.active ? '' : 'opacity-50'}`}>
                  <td className="p-2 font-semibold text-navy-700">{r.name}</td>
                  <td className="p-2">{r.provider || '—'}</td>
                  <td className="p-2">{KIND[r.kind]}</td>
                  <td className="p-2 text-right"><Users size={11} className="inline mr-1" />{r.chosen_by}</td>
                  <td className="p-2 text-right">
                    <button className="text-navy-600 underline" disabled={busy}
                      onClick={() => act(() => api(`/pms/super50/programmes/${r.id}`, { method: 'PUT', body: JSON.stringify({ active: !r.active }) }), r.active ? 'Taken off the catalogue. Anyone who already chose it keeps it.' : 'Back on the catalogue.')}>
                      {r.active ? 'Take off' : 'Put back'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-navy-500 flex items-center gap-1.5"><Clock size={12} />HR marks a programme completed on Awardees.</p>
    </div>
  );
}

function Field({ label, children }) {
  return <label className="block"><span className="lbl">{label}</span>{children}</label>;
}
