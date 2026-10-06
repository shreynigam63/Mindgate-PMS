// THE TIMESHEET RATING OF ONE KRA, shown beside the rating a person gives.
//
// Asked for on 6 Oct — "there should be rating against KRA as per
// timesheet filled" — with the client's choice of how it is used:
// "shown beside, manager decides". So this is read-only evidence on the
// screens where a KRA is rated (Team Evaluation, HOD Review); it never
// pre-selects or changes the manager's own rating. How it is computed is
// in server/modules/performance/timesheet-kra-score.js (kraRatings).
import { useEffect, useState } from 'react';
import { Clock3, Info } from 'lucide-react';
import { api } from './utils/api';

const TONE = { 'A+': 'bg-emerald-100 text-emerald-700', A: 'bg-emerald-50 text-emerald-700',
  'B+': 'bg-sky-50 text-sky-700', B: 'bg-amber-50 text-amber-700', C: 'bg-rose-50 text-rose-700' };

// One fetch per person, shared by every KRA row on their card. A failure
// is not an error on the rating screen — the timesheet is evidence, and
// a manager must be able to rate without it — so it resolves to null.
export function useTimesheetRatings(employeeId) {
  const [r, setR] = useState(undefined);
  useEffect(() => {
    if (!employeeId) return;
    api(`/pms/timesheet/kra/ratings/${employeeId}`).then((x) => setR(x)).catch(() => setR(null));
  }, [employeeId]);
  return r;
}

export function TimesheetRatingNote({ data }) {
  if (!data || !data.kra_ratings) return null;
  const k = data.kra_ratings;
  if (!data.has_entries) {
    return <p className="text-[11px] text-navy-400"><Clock3 size={11} className="inline mr-1 -mt-px" />No timesheet uploaded for this cycle yet, so there is no timesheet rating.</p>;
  }
  const ladder = (k.bands || []).slice().sort((x, y) => y.min - x.min).map((b) => `${b.label} ≥ ${b.min}%`).join(', ');
  return (
    <p className={`text-[11px] ${k.thin ? 'text-amber-700' : 'text-navy-500'}`}>
      <Info size={11} className="inline mr-1 -mt-px" />
      Timesheet rating, {data.window.from} – {data.window.to}: {k.working_days} working days × {k.hours_per_day} h
      = <b>{k.required_hours} h required</b>, shared across the KRAs by weight. Each KRA's hours ÷ its expected hours
      gives its % ({ladder}). Shown as evidence — your rating is the one that counts.
      {k.note ? ` ${k.note}` : ''}
    </p>
  );
}

export function TimesheetRatingChip({ data, kraId }) {
  if (!data || !data.kra_ratings || !data.has_entries) return null;
  const row = (data.kra_ratings.ratings || []).find((x) => String(x.kra_id) === String(kraId));
  if (!row) return null;
  if (!row.measured) {
    return <span className="text-[11px] text-navy-400" title={row.reason || ''}>Timesheet: not measured</span>;
  }
  if (!row.rating) {
    return <span className="text-[11px] text-navy-400">Timesheet: {row.reason ? row.reason.toLowerCase() : '—'}</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-navy-500">
      Timesheet:
      <span className={`chip ${TONE[row.rating] || 'bg-navy-50 text-navy-700'}`}>{row.rating}</span>
      <span>{row.hours} h worked of {row.expected_hours} h expected · {row.effort_pct}%</span>
    </span>
  );
}
