import { useEffect, useState } from 'react';
import { api, API_BASE } from '../utils/api';
import PageHead from '../PageHead';
import { Award, Wallet, Clock, CheckCircle2, Download, Upload, GraduationCap, FileText } from 'lucide-react';

// My Super 50 (15 Oct, from the client's policy sheet): the tier this
// person holds for the benefits year, what it brings, the balance they
// can claim against bills, their claims, and the IIT/IIM programme where
// the tier includes one. Only someone who holds a tier sees it in the menu.

const inr = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const dl = (path) => `${API_BASE}${path}${path.includes('?') ? '&' : '?'}token=${localStorage.getItem('apms_token')}`;

export const CLAIM_STATUS = {
  submitted: ['Waiting on HR', 'bg-amber-100 text-amber-700'],
  approved: ['Approved', 'bg-emerald-100 text-emerald-700'],
  returned: ['Returned', 'bg-rose-100 text-rose-700'],
  withdrawn: ['Withdrawn', 'bg-navy-50 text-navy-500'],
};
const BLANK = { hub: '', item: '', amount: '', description: '' };

export default function MySuper50Page() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [f, setF] = useState(BLANK);
  const [bill, setBill] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fileKey, setFileKey] = useState(0);

  const load = () => api('/pms/super50/me').then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const act = async (fn, done) => {
    if (busy) return false;
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await fn(); setMsg(done || (r && r.message)); await load(); return true; } catch (e) { setErr(e.message); return false; } finally { setBusy(false); }
  };

  const send = async () => {
    const fd = new FormData();
    Object.entries(f).forEach(([k, v]) => fd.append(k, v));
    if (bill) fd.append('bill', bill);
    const ok = await act(() => api('/pms/super50/me/claims', { method: 'POST', body: fd }));
    if (ok) { setF(BLANK); setBill(null); setFileKey((k) => k + 1); }
  };

  if (err && !d) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!d.award) {
    return (
      <div className="space-y-4 max-w-5xl mx-auto">
        <PageHead title="My Super 50" sub="Benefits for the company's consistent top performers" />
        <div className="card p-6 text-center text-sm text-navy-500">
          You do not hold a Super 50 tier this year. Tiers are set from the annual appraisal: Super 50 for
          one year, Super 50 Twice for two in a row, Super 50 Elite for three or more.
        </div>
      </div>
    );
  }
  const { policy, award, claims, programmes } = d;
  const hub = Object.fromEntries((policy.hubs || []).map((h) => [h.key, h]));
  const items = (hub[f.hub] || {}).items || [];

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="My Super 50" sub={`${policy.name} · based on the ${policy.basis_fiscal_year} annual appraisal`}>
        <a className="btn-sec" href={dl('/pms/super50/me/certificate.pdf')}><Download size={13} className="inline mr-1" />Certificate</a>
      </PageHead>

      {msg && <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">{msg}</p>}
      {err && <p className="text-xs text-rose-600">{err}</p>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile hue="violet" icon={Award} n={award.label} l={`${award.streak} consecutive year${award.streak === 1 ? '' : 's'}`} />
        <Tile hue="navy" icon={Wallet} n={inr(award.amount)} l="Your amount this year" />
        <Tile hue="amber" icon={Clock} n={inr(award.pending)} l="Waiting on HR" />
        <Tile hue="leaf" icon={CheckCircle2} n={inr(award.remaining)} l={`Left to claim by ${day(policy.ends_on)}`} />
      </div>

      <div className="card p-4">
        <p className="lbl">What {award.label} brings</p>
        <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm text-navy-700 mt-2">
          {award.benefits.map((b) => <li key={b} className="flex gap-2"><CheckCircle2 size={15} className="text-emerald-600 shrink-0 mt-0.5" />{b}</li>)}
          <li className="flex gap-2"><CheckCircle2 size={15} className="text-emerald-600 shrink-0 mt-0.5" />
            Up to {inr(award.amount)} for a certification or under the hubs below, against bills</li>
        </ul>
        <p className="text-[11.5px] text-navy-500 mt-3">
          The certification amount and the hub reimbursements are one budget. What is not claimed by {day(policy.ends_on)} lapses.
        </p>
      </div>

      <div className="card p-4 space-y-3">
        <p className="lbl">Claim against a bill</p>
        <div className="grid sm:grid-cols-4 gap-2 text-[11.5px] text-navy-600">
          {(policy.hubs || []).map((h) => (
            <div key={h.key} className="rounded-xl border border-navy-100 px-3 py-2">
              <b className="text-navy-700">{h.label}</b>
              <div>{(h.items || []).join(', ')}</div>
            </div>
          ))}
        </div>
        {d.claims_note && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">{d.claims_note}</p>}
        {d.claims_open && (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="lbl" htmlFor="s50-hub">Hub</label>
              <select id="s50-hub" className="inp" value={f.hub} onChange={(e) => setF({ ...f, hub: e.target.value, item: '' })}>
                <option value="">Pick a hub…</option>
                {(policy.hubs || []).map((h) => <option key={h.key} value={h.key}>{h.label}</option>)}
              </select>
            </div>
            <div>
              <label className="lbl" htmlFor="s50-item">For</label>
              <input id="s50-item" className="inp" list="s50-items" value={f.item} placeholder="e.g. Claude certification"
                onChange={(e) => setF({ ...f, item: e.target.value })} />
              <datalist id="s50-items">{items.map((i) => <option key={i} value={i} />)}</datalist>
            </div>
            <div>
              <label className="lbl" htmlFor="s50-amt">Amount (₹)</label>
              <input id="s50-amt" className="inp" type="number" min="1" step="0.01" max={award.remaining} value={f.amount}
                onChange={(e) => setF({ ...f, amount: e.target.value })} />
            </div>
            <div>
              <label className="lbl" htmlFor="s50-bill">Bill or invoice</label>
              <input key={fileKey} id="s50-bill" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="text-xs mt-2"
                onChange={(e) => setBill(e.target.files[0] || null)} />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <label className="lbl" htmlFor="s50-desc">Note for HR (optional)</label>
              <input id="s50-desc" className="inp" value={f.description} maxLength={500} onChange={(e) => setF({ ...f, description: e.target.value })} />
            </div>
            <div className="flex items-end">
              <button className="btn-pri w-full" disabled={busy || !f.hub || !f.amount || !bill} onClick={send}>
                <Upload size={13} className="inline mr-1" />{busy ? 'Sending…' : 'Send to HR'}
              </button>
            </div>
          </div>
        )}
      </div>

      {award.programme && <Programme award={award} programmes={programmes} act={act} busy={busy} />}

      <div>
        <p className="lbl mb-1 flex items-center gap-1.5"><FileText size={13} /> My claims</p>
        {!claims.length ? <div className="card p-6 text-center text-sm text-navy-400">No claims yet.</div> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
                <tr><th className="text-left p-2">Sent</th><th className="text-left p-2">Hub</th><th className="text-left p-2">For</th>
                  <th className="text-right p-2">Amount</th><th className="text-left p-2">Status</th><th className="text-left p-2">HR's note</th><th className="p-2" /></tr>
              </thead>
              <tbody>
                {claims.map((c) => {
                  const [label, cls] = CLAIM_STATUS[c.status] || [c.status, ''];
                  return (
                    <tr key={c.id} className="border-t border-navy-50">
                      <td className="p-2 whitespace-nowrap">{day(c.created_at)}</td>
                      <td className="p-2">{(hub[c.hub] || {}).label || c.hub}</td>
                      <td className="p-2">{c.item || '—'}</td>
                      <td className="p-2 text-right font-semibold">{inr(c.amount)}</td>
                      <td className="p-2"><span className={`chip ${cls}`}>{label}</span></td>
                      <td className="p-2 text-navy-600">{c.decision_note || ''}</td>
                      <td className="p-2 whitespace-nowrap text-right">
                        <a className="text-navy-600 underline mr-3" href={dl(`/pms/super50/me/claims/${c.id}/bill`)} target="_blank" rel="noreferrer">Bill</a>
                        {c.status === 'submitted' && (
                          <button className="text-rose-600 underline" disabled={busy}
                            onClick={() => act(() => api(`/pms/super50/me/claims/${c.id}/withdraw`, { method: 'POST' }), 'Claim withdrawn. Its amount is back in your balance.')}>
                            Withdraw
                          </button>
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
    </div>
  );
}

function Programme({ award, programmes, act, busy }) {
  const [pick, setPick] = useState('');
  const kind = award.programme === 'refresher' ? 'IIT/IIM 2-day refresher' : 'IIT/IIM programme';
  return (
    <div className="card p-4 space-y-2">
      <p className="lbl flex items-center gap-1.5"><GraduationCap size={13} /> Your {kind}</p>
      {award.programme_id ? (
        <p className="text-sm text-navy-700">
          <b>{award.programme_name}</b>{award.programme_provider ? ` · ${award.programme_provider}` : ''}{' '}
          <span className={`chip ${award.programme_status === 'completed' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`}>
            {award.programme_status === 'completed' ? 'Completed' : 'Chosen'}
          </span>
        </p>
      ) : <p className="text-sm text-navy-500">Not chosen yet.</p>}
      {award.programme_status !== 'completed' && (
        programmes.length ? (
          <div className="flex flex-wrap gap-2 items-center">
            <select className="inp max-w-md" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">{award.programme_id ? 'Change to…' : 'Pick from the catalogue…'}</option>
              {programmes.map((p) => <option key={p.id} value={p.id}>{p.name}{p.provider ? ` — ${p.provider}` : ''}</option>)}
            </select>
            <button className="btn-pri" disabled={!pick || busy}
              onClick={() => act(() => api('/pms/super50/me/programme', { method: 'POST', body: JSON.stringify({ programme_id: pick }) }), 'Programme saved. HR arranges it with you.')}>
              Save
            </button>
          </div>
        ) : <p className="text-[11.5px] text-navy-500">HR has not added the catalogue yet.</p>
      )}
    </div>
  );
}

function Tile({ hue, icon: Icon, n, l }) {
  return (
    <div className={`tile tile-${hue}`}>
      <div className="tile-b"><Icon size={16} /></div>
      <div className="min-w-0"><div className="tile-n truncate">{n}</div><div className="tile-l">{l}</div></div>
    </div>
  );
}
