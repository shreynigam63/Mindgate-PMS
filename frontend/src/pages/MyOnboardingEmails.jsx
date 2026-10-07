// ONBOARDING EMAILS FOR YOU TO SEND, on Home. Decided 7 Oct: "avoid all
// these setup and share mails directly from spocs mail". Each SPOC — the
// IT desk, the joiner's manager, their buddy — sees the First-Week Journey
// emails that are theirs, due within a week or overdue. "Open in Gmail"
// opens the draft in their own Gmail, addressed to the joiner; they send
// it there and tick it sent here. Nothing to set up, for anyone.
//
// Shows nothing at all for the many people who are nobody's SPOC.
import { useEffect, useState } from 'react';
import { MailPlus, ExternalLink, Check } from 'lucide-react';
import { api } from '../utils/api';
import { gmailCompose } from '../utils/gmail';

const fmt = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

export default function MyOnboardingEmails({ user }) {
  const [list, setList] = useState(null);
  const [opened, setOpened] = useState({});
  const [err, setErr] = useState(null);
  const [all, setAll] = useState(false);
  const load = () => api('/people/onboarding/my-emails').then((r) => setList(r.emails || [])).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  if (!list || !list.length) return null;

  // Most urgent first (the server sorts by date, so overdue leads); five
  // at a time — a manager with several joiners can owe dozens.
  const SHOW = 5;
  const shown = all ? list : list.slice(0, SHOW);
  const overdue = list.filter((e) => e.status === 'Overdue').length;
  const today = list.filter((e) => e.status === 'Due Today').length;
  const markSent = async (e) => {
    setErr(null);
    try { await api(`/people/onboarding/tasks/${e.task_id}/mark-sent`, { method: 'POST', body: JSON.stringify({ subject: e.subject }) }); load(); }
    catch (x) { setErr(x.message); }
  };
  return (
    <div className="panel">
      <div className="panel-h">
        <MailPlus size={17} className="text-brand-600" />
        <span className="panel-t">Onboarding emails for you to send</span>
        <span className="text-[12px] text-navy-400">
          {list.length} new-joiner {list.length === 1 ? 'email' : 'emails'} — sent from your own Gmail
        </span>
        <span className="ml-auto flex gap-1.5">
          {overdue > 0 && <span className="pill pill-red">{overdue} overdue</span>}
          {today > 0 && <span className="pill pill-amber">{today} due today</span>}
        </span>
      </div>
      {err && <p className="text-[12px] text-rose-600 mb-1">{err}</p>}
      <div className="divide-y divide-[#eef1f6]">
        {shown.map((e) => (
          <div key={e.task_id} className="py-2 flex flex-wrap items-center gap-2 text-[13px]">
            <span className="flex-1 min-w-[220px]">
              <b className="text-navy-900">{e.activity}</b> <span className="text-navy-500">to {e.joiner}</span>
              <span className="block text-[11.5px] text-navy-400">{e.subject}</span>
            </span>
            <span className={`pill ${e.status === 'Overdue' ? 'pill-red' : e.status === 'Due Today' ? 'pill-amber' : 'pill-gray'}`}>
              {e.status === 'Upcoming' ? `Due ${fmt(e.planned_date)}` : e.status}
            </span>
            {e.to ? (
              <a className="btn-pri !py-1.5" target="_blank" rel="noopener noreferrer"
                href={gmailCompose({ to: e.to.email, subject: e.subject, body: e.body, account: user && user.email })}
                onClick={() => setOpened({ ...opened, [e.task_id]: true })}>
                <ExternalLink size={12} className="inline mr-1" />Open in Gmail
              </a>
            ) : <span className="text-[11.5px] text-amber-700">{e.to_missing}</span>}
            <button type="button" className={`btn-sec !py-1.5 ${opened[e.task_id] ? '!border-emerald-300' : ''}`} onClick={() => markSent(e)}
              title="Tick once you have pressed Send in Gmail">
              <Check size={12} className="inline mr-1" />I’ve sent it
            </button>
          </div>
        ))}
      </div>
      {list.length > SHOW && (
        <button type="button" className="text-[12px] font-semibold text-brand-600 mt-1" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${list.length}`}
        </button>
      )}
      <p className="text-[11px] text-navy-400 mt-1">The draft opens in Gmail addressed to the joiner — check it, press Send there, then tick it here.</p>
    </div>
  );
}
