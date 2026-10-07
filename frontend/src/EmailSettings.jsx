// HR → Settings → Email. Built on 6 Oct; SIMPLIFIED FOR HR on 7 Oct ("can
// we make this setup more simple as for HR users"). It used to ask for a
// server, port, username, SSL and a From address — IT's vocabulary. Now:
//
//   1. Connect the mailbox — pick Microsoft 365 / Google Workspace / Other,
//      type the mailbox and its password. The server details are filled in
//      from the provider and live under "Advanced (for IT)".
//   2. Send a test email — delivered for real, to you, even while email is
//      still simulated; a failure comes back as a sentence to act on.
//   3. Go live — offered only once a test has been delivered. The server
//      enforces the same order (performance/index.js, PUT /hr/mail).
//
// The password field is write-only: the server never sends it back, and
// leaving it blank keeps what is stored.
import { useEffect, useState } from 'react';
import { Mail, Send, Save, ShieldCheck, CheckCircle2, AlertTriangle, ChevronDown, Rocket } from 'lucide-react';
import { api } from './utils/api';

const PROVIDERS = {
  microsoft365: {
    label: 'Microsoft 365', host: 'smtp.office365.com', port: 587, secure: false,
    note: 'Use a shared mailbox such as pms@yourcompany.com. IT must turn on “Authenticated SMTP” for that mailbox in the Microsoft 365 admin centre.',
  },
  google: {
    label: 'Google Workspace', host: 'smtp.gmail.com', port: 587, secure: false,
    note: 'Use an app password, not the mailbox’s normal password: Google Account → Security → App passwords.',
  },
  other: { label: 'Other', note: 'Enter the mail server details from IT under Advanced.' },
};
const DEFAULT_NAME = 'Performance Management System';

const STAGE = {
  not_set_up: ['bg-navy-100 text-navy-600', 'Not set up — emails are recorded, not delivered'],
  untested: ['bg-amber-100 text-amber-700', 'Next: send a test email'],
  test_failed: ['bg-rose-100 text-rose-700', 'Test failed — see step 2'],
  ready: ['bg-sky-100 text-sky-700', 'Ready to go live'],
  live: ['bg-emerald-100 text-emerald-700', 'Live — emails are delivered'],
};

// "Name <addr>" → { name, addr }; a bare address → { name: '', addr }.
const splitFrom = (s) => {
  const m = String(s || '').match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), addr: m[2].trim() } : { name: '', addr: String(s || '').trim() };
};
const guessProvider = (host) => (!host ? 'microsoft365' : /office365|outlook/i.test(host) ? 'microsoft365'
  : /gmail|google/i.test(host) ? 'google' : 'other');

function Step({ n, title, done, children }) {
  return (
    <div className="border-t border-navy-100 pt-3 space-y-2">
      <p className="flex items-center gap-2 font-semibold text-[13px] text-navy-900">
        <span className={`w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center ${done ? 'bg-emerald-500 text-white' : 'bg-navy-100 text-navy-600'}`}>
          {done ? '✓' : n}
        </span>
        {title}
      </p>
      <div className="pl-7 space-y-2">{children}</div>
    </div>
  );
}

export default function EmailSettings() {
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [pass, setPass] = useState('');
  const [adv, setAdv] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [denied, setDenied] = useState(false);
  const [spocs, setSpocs] = useState(null);

  const take = (r) => {
    setD(r);
    const s = r.smtp;
    const from = splitFrom(s.from);
    const mailbox = from.addr || s.user || '';
    const provider = s.provider || guessProvider(s.host);
    setF({
      provider, mailbox, name: from.name || DEFAULT_NAME,
      host: s.host, port: s.port, secure: s.secure,
      // Only kept when it differs from the mailbox — the usual case is the same.
      user: s.user && s.user !== mailbox ? s.user : '',
    });
    setPass('');
  };
  useEffect(() => {
    api('/pms/hr/mail').then(take).catch((e) => (e.status === 403 ? setDenied(true) : setErr(e.message)));
    // The desks whose address the onboarding emails are sent as.
    api('/people/onboarding/spocs').then((r) => setSpocs((r.spocs || []).filter((x) => x.email))).catch(() => setSpocs(null));
  }, []);

  // An HRBP opens this page too; the email account is HR's alone.
  if (denied) return null;
  if (err && !d) return <div className="card p-4"><p className="text-xs text-rose-600">{err}</p></div>;
  if (!d) return <div className="card p-4"><p className="text-xs text-navy-400">Loading email settings…</p></div>;

  const save = async (patch, ok = 'Saved.') => {
    setErr(null); setMsg(null); setBusy(true);
    try { take(await api('/pms/hr/mail', { method: 'PUT', body: JSON.stringify(patch) })); setMsg(ok); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const p = PROVIDERS[f.provider];
  const mailboxOk = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(f.mailbox.trim());
  const saveMailbox = () => {
    const mailbox = f.mailbox.trim();
    const server = f.provider === 'other'
      ? { host: f.host, port: f.port === '' ? '' : Number(f.port), secure: f.secure === true }
      : { host: p.host, port: p.port, secure: p.secure };
    save({ smtp: {
      provider: f.provider, ...server,
      user: f.user.trim() || mailbox,
      from: `${(f.name.trim() || DEFAULT_NAME).replace(/[<>"]/g, '')} <${mailbox}>`,
      ...(pass ? { pass } : {}),
    } }, 'Mailbox saved. Now send a test email.');
  };
  const sendTest = async () => {
    setErr(null); setMsg(null); setBusy(true); setTesting(true);
    try { const r = await api('/pms/hr/mail/test', { method: 'POST' }); if (r.view) take(r.view); }
    catch (e) { setErr(e.message); }
    setBusy(false); setTesting(false);
  };

  const stage = d.stage || (d.mode === 'live' ? 'live' : d.ready ? 'untested' : 'not_set_up');
  const [badgeTone, badgeText] = STAGE[stage];
  const t = d.last_test;
  const fromServer = !d.smtp.host && d.effective.source.host === 'server';
  const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Mail size={15} className="text-brand-600" />
        <p className="font-bold text-sm flex-1">Email</p>
        <span className={`chip ${badgeTone}`}>{badgeText}</span>
      </div>
      <p className="text-xs text-navy-500">
        Until email is Live, every email the product sends — First-Week Journey emails, reminders, notifications — is
        recorded but nobody receives it. Three steps to switch it on:
      </p>

      <Step n={1} title="Connect the PMS mailbox that sends the emails" done={d.ready && stage !== 'not_set_up'}>
        <div className="grid grid-cols-3 gap-2">
          {Object.entries(PROVIDERS).map(([k, v]) => (
            <button key={k} type="button" onClick={() => { setF({ ...f, provider: k }); if (k === 'other') setAdv(true); }}
              className={`rounded-xl border px-3 py-2 text-[13px] font-semibold text-left transition ${f.provider === k ? 'border-navy-500 bg-navy-50 text-navy-900' : 'border-navy-100 bg-white text-navy-600 hover:border-navy-200'}`}>
              <span className="flex items-center gap-2">
                <span className={`w-3.5 h-3.5 rounded-full border-[3px] shrink-0 ${f.provider === k ? 'border-navy-600' : 'border-navy-200'}`} />
                {v.label}
              </span>
            </button>
          ))}
        </div>
        <p className="text-[11.5px] text-navy-500">{p.note}</p>
        {fromServer && (
          <p className="text-[11.5px] text-navy-500">
            Currently using the mailbox set on the server, <b>{d.effective.from}</b>. Saving here replaces it.
          </p>
        )}
        <div className="grid sm:grid-cols-2 gap-2">
          <label className="text-[11px] text-navy-500">Mailbox
            <input className="inp !py-1.5 mt-0.5" type="email" autoComplete="off" placeholder="pms@yourcompany.com" value={f.mailbox}
              onChange={(e) => setF({ ...f, mailbox: e.target.value })} /></label>
          <label className="text-[11px] text-navy-500">{f.provider === 'google' ? 'App password' : 'Password'}
            <input className="inp !py-1.5 mt-0.5" type="password" autoComplete="new-password"
              placeholder={d.smtp.pass_set ? '•••••••• saved — leave blank to keep' : 'the mailbox’s password'} value={pass}
              onChange={(e) => setPass(e.target.value)} /></label>
        </div>

        <button type="button" className="flex items-center gap-1 text-[11.5px] font-semibold text-navy-500" onClick={() => setAdv((v) => !v)} aria-expanded={adv}>
          <ChevronDown size={13} className={`transition-transform ${adv ? '' : '-rotate-90'}`} /> Advanced (for IT)
        </button>
        {adv && (
          <div className="grid sm:grid-cols-2 gap-2 rounded-xl bg-[#f7f9fd] p-3">
            <label className="text-[11px] text-navy-500 sm:col-span-2">Sender name joiners and employees see
              <input className="inp !py-1.5 mt-0.5" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            {f.provider === 'other' ? (
              <>
                <label className="text-[11px] text-navy-500">Server
                  <input className="inp !py-1.5 mt-0.5" placeholder={d.effective.host || 'mail.yourcompany.com'} value={f.host}
                    onChange={(e) => setF({ ...f, host: e.target.value })} /></label>
                <label className="text-[11px] text-navy-500">Port
                  <input className="inp !py-1.5 mt-0.5" placeholder="587" value={f.port}
                    onChange={(e) => setF({ ...f, port: e.target.value.replace(/[^0-9]/g, '') })} /></label>
                <label className="flex items-center gap-2 text-[11.5px] text-navy-600 sm:col-span-2">
                  <input type="checkbox" checked={f.secure === true} onChange={(e) => setF({ ...f, secure: e.target.checked })} />
                  Use SSL from the start (port 465). Leave off for STARTTLS on 587.
                </label>
              </>
            ) : (
              <p className="text-[11px] text-navy-400 sm:col-span-2">Server {p.host}, port {p.port}, STARTTLS — set for {p.label}.</p>
            )}
            <label className="text-[11px] text-navy-500 sm:col-span-2">Sign-in username, only if it differs from the mailbox
              <input className="inp !py-1.5 mt-0.5" autoComplete="off" placeholder={f.mailbox || 'same as the mailbox'} value={f.user}
                onChange={(e) => setF({ ...f, user: e.target.value })} /></label>
            {d.smtp.pass_set && (
              <button type="button" className="btn-sec !text-xs justify-self-start" disabled={busy}
                onClick={() => save({ smtp: { clear_pass: true } }, 'Saved password removed.')}>Remove saved password</button>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-pri" disabled={busy || !mailboxOk || (f.provider === 'other' && !f.host)} onClick={saveMailbox}>
            <Save size={13} className="inline mr-1" />Save mailbox
          </button>
          {msg && <span className="text-xs text-emerald-700">{msg}</span>}
          {err && <span className="text-xs text-rose-600">{err}</span>}
        </div>
      </Step>

      <Step n={2} title="Send a test email to yourself" done={!!(t && t.ok)}>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-sec" disabled={busy || !d.ready} onClick={sendTest}>
            <Send size={12} className="inline mr-1" />{testing ? 'Sending… (up to 20 seconds)' : 'Send a test email to me'}
          </button>
          {!d.ready && <span className="text-[11.5px] text-navy-400">Save the mailbox first.</span>}
        </div>
        {t && t.ok && (
          <p className="text-xs text-emerald-700 flex items-center gap-1.5">
            <CheckCircle2 size={13} /> Delivered to {t.to} on {when(t.at)}. Check that inbox — if it arrived, go to step 3.
          </p>
        )}
        {t && !t.ok && (
          <div className="text-xs rounded-xl bg-rose-50 border border-rose-100 p-2.5 space-y-1">
            <p className="text-rose-700 font-semibold flex items-start gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{t.hint || 'The test email was not delivered.'}</p>
            {t.detail && <p className="text-[11px] text-navy-500">The mail server said: <code className="break-all">{t.detail}</code></p>}
          </div>
        )}
        <p className="text-[11px] text-navy-400">The test is really delivered, and only to you — even while email is still recorded-only.</p>
      </Step>

      <Step n={3} title="Go live" done={stage === 'live'}>
        {stage === 'live' ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-emerald-700">Email is live: everything the product sends is delivered.</span>
            <button className="btn-sec !text-xs" disabled={busy} onClick={() => save({ mode: 'simulated' }, 'Back to recorded-only.')}>
              Switch back to recorded-only
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-pri" disabled={busy || stage !== 'ready'} onClick={() => save({ mode: 'live' }, 'Email is live.')}>
              <Rocket size={13} className="inline mr-1" />Go live
            </button>
            {stage !== 'ready' && <span className="text-[11.5px] text-navy-400">Opens once a test email has been delivered.</span>}
          </div>
        )}
      </Step>

      {/* FIRST-WEEK JOURNEY EMAILS GO FROM EACH SPOC'S OWN ADDRESS (decided
          7 Oct). The mailbox above signs in and sends them AS the SPOC, so
          IT grants it Send-As for each SPOC address once — listed here so
          HR can hand IT the list. */}
      <div className="border-t border-navy-100 pt-3 space-y-1.5">
        <p className="font-semibold text-[13px] text-navy-900">First-Week Journey emails go from each SPOC’s own address</p>
        <p className="text-[11.5px] text-navy-500">
          The mailbox above sends them as the SPOC who owns the activity. Ask IT to give it <b>“Send As”</b> permission
          for each SPOC address below — once. Until then, those emails are refused and the tracker says why.
        </p>
        {spocs && (spocs.length ? (
          <div className="flex flex-wrap gap-1.5">
            {spocs.map((x) => <span key={x.role} className="chip bg-navy-50 text-navy-700">{x.role}: {x.email}</span>)}
          </div>
        ) : <p className="text-[11.5px] text-amber-700">No SPOC addresses yet — set them under New Hire Insights → First-Week Journey → SPOCs.</p>)}
        <p className="text-[11px] text-navy-400">
          Managers, buddies and HR POCs send from their own addresses too; IT can grant the PMS mailbox Send-As for them, or for everyone, the same way.
        </p>
      </div>

      <p className="text-[11px] text-navy-400"><ShieldCheck size={11} className="inline mr-1" />
        The password is never shown again or written to the audit log.</p>
    </div>
  );
}
