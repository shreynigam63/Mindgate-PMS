// HR's screen for the per-KRA timesheet rating. Asked for on 6 Oct ("yes
// build the settings screen"): the bands and hours per day had no screen,
// and were only reachable through the API.
//
// Saves through PUT /pms/timesheet/kra/scoring, which validates the ladder
// (labels, one band from 0) and keeps every other scoring switch as it was.
import { useEffect, useState } from 'react';
import { Plus, Trash2, Save, Gauge } from 'lucide-react';
import { api } from './utils/api';

const rate = (pct, bands) => {
  const list = bands.slice().sort((a, b) => Number(b.min) - Number(a.min));
  const hit = list.find((b) => pct >= Number(b.min));
  return hit ? hit.label : '—';
};

export default function KraRatingSettings() {
  const [cfg, setCfg] = useState(null);
  const [bands, setBands] = useState([]);
  const [hours, setHours] = useState(8);
  const [minMapped, setMinMapped] = useState(80);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = () => api('/pms/timesheet/kra/scoring').then((r) => {
    setCfg(r.scoring);
    setBands((r.scoring.kra_bands || []).map((b) => ({ label: b.label, min: b.min })).sort((a, b) => b.min - a.min));
    setHours(r.scoring.hours_per_day || 8);
    setMinMapped(r.scoring.min_mapped_pct);
  }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err && !cfg) return <div className="card p-4"><p className="text-xs text-rose-600">{err}</p></div>;
  if (!cfg) return null;

  const save = async () => {
    setErr(null); setMsg(null);
    try {
      await api('/pms/timesheet/kra/scoring', { method: 'PUT', body: JSON.stringify({
        kra_bands: bands.map((b) => ({ label: String(b.label).trim(), min: Number(b.min) })),
        hours_per_day: Number(hours), min_mapped_pct: Number(minMapped),
      }) });
      setMsg('Saved. Every KRA rating on every screen now uses these.'); load();
    } catch (e) { setErr(e.message); }
  };
  const setBand = (i, patch) => setBands(bands.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const required = 17.5 * Number(hours || 0);
  const expected = required * 0.25;
  const sorted = bands.slice().sort((a, b) => Number(b.min) - Number(a.min));

  return (
    <div className="card p-4 space-y-3">
      <p className="lbl"><Gauge size={12} className="inline mr-1" />KRA rating from the timesheet</p>
      <p className="text-[11.5px] text-navy-500">
        Each KRA: hours worked against it ÷ the hours its weight expects (working days × hours per day × weight).
        The % is turned into a rating with the bands below. The rating is shown beside the manager's and HOD's
        own — it never sets the appraisal rating.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-[11px] text-navy-500">Hours per working day
          <input type="number" min="1" max="24" step="0.5" className="inp !py-1 !px-2 !w-24 mt-0.5"
            value={hours} onChange={(e) => setHours(e.target.value)} />
        </label>
        <label className="text-[11px] text-navy-500">Flag as indicative below this % of hours mapped
          <input type="number" min="0" max="100" className="inp !py-1 !px-2 !w-24 mt-0.5"
            value={minMapped} onChange={(e) => setMinMapped(e.target.value)} />
        </label>
      </div>
      <div>
        <p className="text-[11px] font-semibold text-navy-500 mb-1">Bands — a rating applies from its % upwards</p>
        <div className="space-y-1.5">
          {bands.map((b, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className="inp !py-1 !px-2 !w-24" value={b.label} placeholder="Label"
                onChange={(e) => setBand(i, { label: e.target.value })} aria-label="Band label" />
              <span className="text-[11.5px] text-navy-500">from</span>
              <input type="number" min="0" max="100" className="inp !py-1 !px-2 !w-20" value={b.min}
                onChange={(e) => setBand(i, { min: e.target.value })} aria-label="Band starts at %" />
              <span className="text-[11.5px] text-navy-500">%</span>
              <button type="button" className="p-1.5 rounded-md text-rose-500 hover:bg-rose-50 disabled:opacity-30"
                disabled={bands.length <= 1} onClick={() => setBands(bands.filter((_, j) => j !== i))} aria-label={`Remove ${b.label}`}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="btn-sec mt-2" onClick={() => setBands([...bands, { label: '', min: 0 }])}>
          <Plus size={12} className="inline mr-1" />Add a band
        </button>
      </div>
      <p className="text-[11.5px] text-navy-600 bg-navy-50 rounded-lg px-3 py-2">
        <b>Check:</b> a month of 17.5 working days × {hours || 0} h = {required} h required; a 25% KRA expects {expected} h.
        {' '}{[0.5, 0.71, 0.8, 1].map((f) => `${Math.round(expected * f * 10) / 10} h → ${rate(f * 100, sorted)}`).join(' · ')}
      </p>
      <div className="flex items-center gap-2">
        <button className="btn-pri" onClick={save}><Save size={13} className="inline mr-1" />Save rating settings</button>
        {msg && <span className="text-xs text-emerald-700">{msg}</span>}
        {err && <span className="text-xs text-rose-600">{err}</span>}
      </div>
    </div>
  );
}
