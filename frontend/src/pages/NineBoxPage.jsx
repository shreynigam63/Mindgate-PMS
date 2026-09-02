import { useEffect, useState } from 'react';
import { api } from '../utils/api';

const PERF = ['high', 'mid', 'low']; // rows, top to bottom
const POT = ['low', 'mid', 'high'];  // columns, left to right
const LEVELS = [
  { value: 'org', label: 'Organisation' },
  { value: 'department', label: 'Department' },
  { value: 'manager', label: 'Reporting line' },
];

export default function NineBoxPage() {
  const [level, setLevel] = useState('org');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setData(null); setErr(null);
    api(`/pms/nine-box?level=${level}`).then(setData).catch(e => setErr(e.message));
  }, [level]);

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div>
        <h2 className="text-lg font-bold">9-Box Grid</h2>
        <p className="text-xs text-navy-400">Performance vs potential, from the "9-box" values entered on the Calibration screen. Visible to HR and Delivery Head.</p>
      </div>
      <div className="flex gap-1">
        {LEVELS.map(l => (
          <button key={l.value} onClick={() => setLevel(l.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${level === l.value ? 'bg-navy-700 text-white' : 'bg-navy-50 text-navy-600 hover:bg-navy-100'}`}>
            {l.label}
          </button>
        ))}
      </div>
      {err && <p className="text-sm text-rose-600">{err}</p>}
      {!err && !data && <p className="text-sm text-navy-400">Loading…</p>}
      {data && !data.groups.length && <div className="card p-8 text-center text-sm text-navy-400">No employees have a 9-box cell recorded yet for {data.cycle?.name || 'the active cycle'} — enter them on the Calibration screen.</div>}
      {data && data.groups.map(g => <Grid key={g.key} group={g} />)}
    </div>
  );
}

function Grid({ group }) {
  return (
    <div className="card p-4">
      <p className="font-semibold text-sm mb-2">{group.key} <span className="text-navy-400 font-normal">· {group.total} placed</span></p>
      <div className="grid grid-cols-3 gap-1 text-xs">
        {PERF.map(perf => POT.map(pot => {
          const key = `${perf}-${pot}`;
          const people = group.cells[key] || [];
          return (
            <div key={key} className="border border-navy-100 rounded-lg p-2 min-h-[64px] bg-navy-50">
              <p className="text-[9px] uppercase tracking-wide text-navy-400 mb-1">{perf} perf · {pot} pot</p>
              {people.map(p => <p key={p.id} className="text-[11px] font-medium">{p.name}</p>)}
            </div>
          );
        }))}
      </div>
    </div>
  );
}
