import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import { Save, AlertTriangle, MapPin, Users, Plus, X } from 'lucide-react';

// HR assigns each HRBP their remit. HR's page, not the HRBP's: a remit
// nobody but its holder can change is not a control, and an HRBP widening
// their own is the obvious abuse.
//
// The options come from the employee master rather than a free-text box,
// because a location typed as "Pune " or "pune" that does not match the
// master is an assignment that silently reaches nobody — and the screen
// would look exactly the same as a working one.

export default function HrbpAdminPage() {
  const [opts, setOpts] = useState(null);
  const [partners, setPartners] = useState(null);
  const [err, setErr] = useState(null);
  const [draft, setDraft] = useState(null);     // { email, locations[], hods[] }
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [newEmail, setNewEmail] = useState('');

  const load = () => Promise.all([api('/pms/hrbp/admin/options'), api('/pms/hrbp/admin/partners')])
    .then(([o, p]) => { setOpts(o); setPartners(p); })
    .catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!opts || !partners) return <p className="text-sm text-navy-400">Loading…</p>;

  const start = (p) => { setSaved(null); setDraft({ email: p.email, locations: [...p.locations], hods: [...p.hods] }); };
  const toggle = (kind, value) => setDraft((d) => {
    const list = d[kind];
    return { ...d, [kind]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] };
  });
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api(`/pms/hrbp/admin/partners/${encodeURIComponent(draft.email)}`, {
        method: 'PUT', body: JSON.stringify({ locations: draft.locations, hods: draft.hods }),
      });
      setSaved(r); setDraft(null); await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3 max-w-5xl mx-auto">
      <PageHead title="HR Business Partners" hue="amber"
        sub="Who covers which locations and HODs. An HRBP sees only the people their remit reaches." />

      {opts.coverage && (
        <div className="card p-3 text-xs text-amber-700 flex items-start gap-1.5">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{opts.coverage.message}</span>
        </div>
      )}

      {saved && (
        <div className="card p-3 text-xs">
          Saved. <b>{saved.email}</b> now reaches <b>{saved.reaches}</b> {saved.reaches === 1 ? 'person' : 'people'}.
          {saved.reaches === 0 && <span className="text-amber-700"> Nobody in the master matches that remit — check the spelling against the list below.</span>}
        </div>
      )}

      <div className="card p-4 space-y-3">
        <p className="lbl mb-0">Partners</p>
        {!partners.partners.length && (
          <p className="text-xs text-navy-400">
            Nobody holds the HRBP role yet. Give somebody the <b>hrbp</b> role on the Employees page, or
            assign a remit to an address below — the remit alone does not grant the tab.
          </p>
        )}
        <table className="w-full text-xs">
          <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
            <tr>
              <th className="text-left px-3 py-2">Partner</th>
              <th className="text-left px-3 py-2">Locations</th>
              <th className="text-left px-3 py-2">HODs</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-100">
            {partners.partners.map((p) => (
              <tr key={p.email} className={p.locations.length || p.hods.length ? '' : 'bg-amber-50/40'}>
                <td className="px-3 py-2">
                  <span className="font-semibold">{p.name || p.email}</span>
                  <span className="block text-[10px] text-navy-400">{p.email}</span>
                </td>
                <td className="px-3 py-2">
                  {p.locations.length
                    ? p.locations.map((l) => <span key={l} className="chip bg-amber-50 text-amber-700 mr-1">{l}</span>)
                    : <span className="text-navy-300">—</span>}
                </td>
                <td className="px-3 py-2">
                  {p.hods.length
                    ? p.hods.map((h) => <span key={h} className="chip bg-navy-50 text-navy-600 mr-1">{h}</span>)
                    : <span className="text-navy-300">—</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  <button className="btn-sec !py-1" onClick={() => start(p)}>Edit remit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* Somebody who holds the role but has no row yet, and anybody HR
            wants to assign before granting the role. */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <input className="inp !text-xs !w-auto" placeholder="add a partner by email"
            value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          <button className="btn-sec !py-1 !text-xs" disabled={!newEmail.trim()}
            onClick={() => { start({ email: newEmail.trim().toLowerCase(), locations: [], hods: [] }); setNewEmail(''); }}>
            <Plus size={12} className="inline mr-1" />Set their remit
          </button>
        </div>
      </div>

      {draft && (
        <div className="card p-4 space-y-3 border-l-4 border-amber-500">
          <div className="flex items-center justify-between">
            <p className="lbl mb-0">Remit for {draft.email}</p>
            <button className="btn-sec !py-1" onClick={() => setDraft(null)}><X size={12} /></button>
          </div>

          <div>
            <p className="text-[11px] text-navy-500 mb-1 flex items-center gap-1"><MapPin size={11} />Locations</p>
            <div className="flex flex-wrap gap-1.5">
              {opts.locations.map((o) => (
                <button key={o.value} onClick={() => toggle('locations', o.value)}
                  className={`chip ${draft.locations.includes(o.value) ? 'bg-amber-100 text-amber-800' : 'bg-navy-50 text-navy-500'}`}>
                  {o.value} <span className="opacity-60">· {o.people}</span>
                </button>
              ))}
              {!opts.locations.length && <span className="text-xs text-navy-400">No locations on the master yet.</span>}
            </div>
          </div>

          <div>
            <p className="text-[11px] text-navy-500 mb-1 flex items-center gap-1"><Users size={11} />HODs</p>
            <div className="flex flex-wrap gap-1.5">
              {opts.hods.map((o) => (
                <button key={o.value} onClick={() => toggle('hods', o.value)}
                  className={`chip ${draft.hods.includes(o.value) ? 'bg-amber-100 text-amber-800' : 'bg-navy-50 text-navy-500'}`}>
                  {o.value} <span className="opacity-60">· {o.people}</span>
                </button>
              ))}
              {!opts.hods.length && <span className="text-xs text-navy-400">No HODs on the master yet.</span>}
            </div>
          </div>

          <p className="text-[11px] text-navy-400">
            A person is in the remit if their location is one of these <b>or</b> their HOD is — the two
            widen it, they do not narrow it. Clearing both leaves the partner seeing nobody.
          </p>
          <button className="btn-pri" disabled={busy} onClick={save}>
            <Save size={13} className="inline mr-1" />{busy ? 'Saving…' : 'Save remit'}
          </button>
        </div>
      )}
    </div>
  );
}
