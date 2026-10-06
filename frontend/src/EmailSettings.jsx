// HR → Settings → Email. Asked for on 6 Oct ("yes build the settings
// screen"). Until now the send mode and the SMTP account had no screen,
// and the onboarding tracker pointed people at one that did not exist.
//
// The password field is write-only: the server never sends it back, and
// leaving it blank keeps what is stored. Anything set in the server's own
// environment is shown as "from the server" — saving here overrides it.
import { useEffect, useState } from 'react';
import { Mail, Send, Save, ShieldCheck } from 'lucide-react';
import { api } from './utils/api';

export default function EmailSettings() {
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [pass, setPass] = useState('');
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);

  const take = (r) => {
    setD(r);
    setF({ host: r.smtp.host, port: r.smtp.port, user: r.smtp.user, from: r.smtp.from, secure: r.smtp.secure });
    setPass('');
  };
  useEffect(() => {
    api('/pms/hr/mail').then(take).catch((e) => (e.status === 403 ? setDenied(true) : setErr(e.message)));
  }, []);

  // An HRBP opens this page too; the email account is HR's alone.
  if (denied) return null;
  if (err && !d) return <div className="card p-4"><p className="text-xs text-rose-600">{err}</p></div>;
  if (!d) return <div className="card p-4"><p className="text-xs text-navy-400">Loading email settings…</p></div>;

  const save = async (patch) => {
    setErr(null); setMsg(null); setBusy(true);
    try { take(await api('/pms/hr/mail', { method: 'PUT', body: JSON.stringify(patch) })); setMsg('Saved.'); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const saveServer = () => save({ smtp: { ...f, port: f.port === '' ? '' : Number(f.port), ...(pass ? { pass } : {}) } });
  const sendTest = async () => {
    setTest(null); setErr(null); setBusy(true);
    try { setTest(await api('/pms/hr/mail/test', { method: 'POST' })); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const src = (k) => (d.effective.source[k] === 'server' ? <span className="text-[10.5px] text-navy-400"> (from the server)</span> : null);
  const live = d.mode === 'live';

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Mail size={15} className="text-brand-600" />
        <p className="font-bold text-sm flex-1">Email</p>
        <span className={`chip ${live ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
          {live ? 'Live — emails are delivered' : 'Simulated — emails are recorded, not delivered'}
        </span>
      </div>
      <p className="text-xs text-navy-500">
        Every email the product sends — onboarding Email SPOC, reminders, notifications — goes through this.
        In <b>Simulated</b> mode each one is recorded but nobody receives it; the screens say so.
      </p>

      <div className="grid sm:grid-cols-2 gap-2">
        {[['simulated', 'Simulated', 'Record emails without sending. Safe while testing.'],
          ['live', 'Live', d.ready ? 'Send real emails through the server below.' : 'Needs a server and a From address first.']].map(([v, label, detail]) => (
          <button key={v} type="button" disabled={busy || (v === 'live' && !d.ready)} onClick={() => d.mode !== v && save({ mode: v })}
            className={`text-left rounded-xl border p-3 transition disabled:opacity-50 ${d.mode === v ? 'border-navy-500 bg-navy-50' : 'border-navy-100 bg-white hover:border-navy-200'}`}>
            <span className="flex items-center gap-2">
              <span className={`w-3.5 h-3.5 rounded-full border-[3px] shrink-0 ${d.mode === v ? 'border-navy-600' : 'border-navy-200'}`} />
              <span className="font-semibold text-sm">{label}</span>
            </span>
            <span className="block text-[11px] text-navy-500 mt-1">{detail}</span>
          </button>
        ))}
      </div>

      <div className="border-t border-navy-100 pt-3 space-y-2">
        <p className="lbl !mb-0">Mail server (SMTP)</p>
        <div className="grid sm:grid-cols-2 gap-2">
          <label className="text-[11px] text-navy-500">Server{src('host')}
            <input className="inp !py-1.5 mt-0.5" placeholder={d.effective.host || 'smtp.office365.com'} value={f.host}
              onChange={(e) => setF({ ...f, host: e.target.value })} /></label>
          <label className="text-[11px] text-navy-500">Port
            <input className="inp !py-1.5 mt-0.5" placeholder={String(d.effective.port || 587)} value={f.port}
              onChange={(e) => setF({ ...f, port: e.target.value.replace(/[^0-9]/g, '') })} /></label>
          <label className="text-[11px] text-navy-500">Username{src('user')}
            <input className="inp !py-1.5 mt-0.5" autoComplete="off" placeholder={d.effective.user || 'pms@company.com'} value={f.user}
              onChange={(e) => setF({ ...f, user: e.target.value })} /></label>
          <label className="text-[11px] text-navy-500">Password{src('pass')}
            <input className="inp !py-1.5 mt-0.5" type="password" autoComplete="new-password"
              placeholder={d.effective.pass_set ? '•••••••• set — leave blank to keep' : 'not set'} value={pass}
              onChange={(e) => setPass(e.target.value)} /></label>
          <label className="text-[11px] text-navy-500 sm:col-span-2">From address{src('from')}
            <input className="inp !py-1.5 mt-0.5" placeholder={d.effective.from || 'Performance Management System <pms@company.com>'} value={f.from}
              onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        </div>
        <label className="flex items-center gap-2 text-[11.5px] text-navy-600">
          <input type="checkbox" checked={f.secure === true} onChange={(e) => setF({ ...f, secure: e.target.checked })} />
          Use SSL from the start (port 465). Leave off for STARTTLS on 587.
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-pri" disabled={busy} onClick={saveServer}><Save size={13} className="inline mr-1" />Save server</button>
          {d.smtp.pass_set && (
            <button className="btn-sec" disabled={busy} onClick={() => save({ smtp: { clear_pass: true } })}>Remove saved password</button>
          )}
          <button className="btn-sec" disabled={busy} onClick={sendTest}><Send size={12} className="inline mr-1" />Send a test email to me</button>
          {msg && <span className="text-xs text-emerald-700">{msg}</span>}
          {err && <span className="text-xs text-rose-600">{err}</span>}
        </div>
        {test && (
          <p className={`text-xs ${test.outcome === 'sent' ? 'text-emerald-700' : 'text-amber-700'}`}>
            {test.outcome === 'sent' ? `Sent to ${test.to}. Check the inbox.`
              : test.outcome === 'simulated' ? `Recorded for ${test.to}, not delivered — email is in Simulated mode.`
                : `Not delivered to ${test.to}: ${test.detail || test.outcome}`}
          </p>
        )}
        <p className="text-[11px] text-navy-400"><ShieldCheck size={11} className="inline mr-1" />
          The password is never shown again or written to the audit log.</p>
      </div>
    </div>
  );
}
