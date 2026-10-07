// HR → Settings → Email. Built on 6 Oct; simplified for HR on 7 Oct, then
// the same day given its main route for Mindgate, which is on Google
// Workspace ("why can't it be directly emails from spocs").
//
//   1. Connect — GOOGLE WORKSPACE (recommended): IT uploads a service
//      account's key once and authorises it in the Google Admin console;
//      every email is then sent from the person's own Gmail — the SPOC,
//      the manager, the reminders sender — with no PMS mailbox and no
//      passwords (core/gmail.js). Or MICROSOFT 365 / OTHER: one mailbox
//      and its password, sending as the SPOC with Send-As.
//   2. Send a test email — delivered for real, to you, even while email is
//      still recorded-only; a failure comes back as a sentence to act on.
//      With Google, each SPOC address is checked too, without sending.
//   3. Go live — offered only once a test has been delivered. The server
//      enforces the same order (performance/index.js, PUT /hr/mail).
//
// Secrets are write-only: the Google key and the mailbox password are
// never sent back, and a blank field keeps what is stored.
import { useEffect, useState } from 'react';
import { Mail, Send, Save, ShieldCheck, CheckCircle2, AlertTriangle, ChevronDown, Rocket, Upload, Copy, XCircle } from 'lucide-react';
import { api } from './utils/api';

const PROVIDERS = {
  google: { label: 'Google Workspace', sub: 'Gmail — sends from each person’s own Gmail' },
  microsoft365: {
    label: 'Microsoft 365', sub: 'One mailbox and its password', host: 'smtp.office365.com', port: 587, secure: false,
    note: 'Use a shared mailbox such as pms@yourcompany.com. IT must turn on “Authenticated SMTP” for that mailbox in the Microsoft 365 admin centre.',
  },
  other: { label: 'Other', sub: 'Any mail server', note: 'Enter the mail server details from IT under Advanced.' },
};
const DEFAULT_NAME = 'Performance Management System';
const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

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
const providerOf = (d) => (d.transport === 'google' ? 'google'
  : d.smtp.provider === 'microsoft365' || /office365|outlook/i.test(d.smtp.host || '') ? 'microsoft365'
    : d.smtp.host ? 'other' : 'google');

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

function CopyValue({ label, value }) {
  const [ok, setOk] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px]">
      <span className="text-navy-500">{label}</span>
      <code className="px-1.5 py-0.5 rounded bg-white border border-navy-100 break-all">{value}</code>
      <button type="button" className="text-navy-400 hover:text-navy-700" aria-label={`Copy ${label}`}
        onClick={() => { navigator.clipboard?.writeText(value).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); }).catch(() => {}); }}>
        {ok ? <CheckCircle2 size={13} className="text-emerald-600" /> : <Copy size={13} />}
      </button>
    </span>
  );
}

// STEP 1 FOR GOOGLE WORKSPACE. IT's part, once, then one address from HR.
function GoogleConnect({ d, busy, save }) {
  const g = d.google;
  const [sender, setSender] = useState(g.sender || '');
  const [howOpen, setHowOpen] = useState(!g.connected);
  const [fileErr, setFileErr] = useState(null);
  const upload = (file) => {
    setFileErr(null);
    if (!file) return;
    if (file.size > 20000) { setFileErr('That file is too large to be a Google key file.'); return; }
    file.text().then((txt) => save({ transport: 'google', google: { key_json: txt } },
      'Key uploaded. Now ask IT to finish step 4 below, then set the reminders address.'))
      .catch(() => setFileErr('Could not read that file.'));
  };
  return (
    <>
      <p className="text-[11.5px] text-navy-500">
        Every email goes from the person’s own Gmail — First-Week Journey emails from the SPOC who owns the activity.
        No PMS mailbox and no passwords. They appear in that person’s Sent folder, and replies come back to them.
      </p>

      {g.connected ? (
        <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-2.5 space-y-1.5">
          <p className="text-xs text-emerald-800 font-semibold flex items-center gap-1.5"><CheckCircle2 size={13} /> Key uploaded — {g.client_email}</p>
          <p className="text-[11.5px] text-navy-600">IT authorises it in the Google Admin console with these two values (step 4 below):</p>
          <div className="flex flex-col gap-1">
            <CopyValue label="Client ID" value={g.client_id} />
            <CopyValue label="OAuth scope" value={g.scope} />
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <label className="btn-sec !text-xs cursor-pointer">
              <Upload size={12} className="inline mr-1" />Replace key file
              <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => upload(e.target.files[0])} />
            </label>
            <button type="button" className="btn-sec !text-xs" disabled={busy}
              onClick={() => window.confirm('Disconnect Google Workspace? Email goes back to recorded-only until it is connected and tested again.')
                && save({ google: { disconnect: true }, transport: 'google' }, 'Disconnected.')}>Disconnect</button>
          </div>
        </div>
      ) : (
        <label className="btn-pri cursor-pointer inline-flex items-center">
          <Upload size={13} className="mr-1" />Upload the key file (.json) from IT
          <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => upload(e.target.files[0])} />
        </label>
      )}
      {fileErr && <p className="text-xs text-rose-600">{fileErr}</p>}

      <button type="button" className="flex items-center gap-1 text-[11.5px] font-semibold text-navy-500" onClick={() => setHowOpen((v) => !v)} aria-expanded={howOpen}>
        <ChevronDown size={13} className={`transition-transform ${howOpen ? '' : '-rotate-90'}`} /> What IT does, once (about 10 minutes)
      </button>
      {howOpen && (
        <ol className="list-decimal pl-5 text-[11.5px] text-navy-600 space-y-1 rounded-xl bg-[#f7f9fd] p-3">
          <li><b>Google Cloud console</b> (console.cloud.google.com) → pick or create a project → APIs &amp; Services → Library → <b>Gmail API</b> → Enable.</li>
          <li>IAM &amp; Admin → Service accounts → <b>Create service account</b> (e.g. “pms-sender”, no roles needed) → open it → Keys → Add key → <b>JSON</b>. A .json file downloads.</li>
          <li>Upload that file here. Keep no other copy — the PMS never shows it again.</li>
          <li><b>Google Admin console</b> (admin.google.com) → Security → Access and data control → API controls → <b>Manage domain-wide delegation</b> → Add new: the <b>Client ID</b> and <b>OAuth scope</b> shown above once the file is uploaded.</li>
          <li className="list-none -ml-5 pt-1 text-navy-500">
            <ShieldCheck size={11} className="inline mr-1" />This lets the PMS send — only send, never read — as a user in the company’s Google Workspace.
            It only ever sends as the activity’s SPOC, the joiner’s manager, buddy or HR POC, and the reminders address below; every email is logged with who it was from.
          </li>
        </ol>
      )}

      <div className="grid sm:grid-cols-[1fr_auto] gap-2 items-end">
        <label className="text-[11px] text-navy-500">Reminders and notifications are sent from
          <input className="inp !py-1.5 mt-0.5" type="email" placeholder="hr@yourcompany.com" value={sender}
            onChange={(e) => setSender(e.target.value)} /></label>
        <button className="btn-sec" disabled={busy || !EMAIL.test(sender.trim()) || sender.trim().toLowerCase() === (g.sender || '')}
          onClick={() => save({ transport: 'google', google: { sender: sender.trim() } }, 'Saved. Now send a test email.')}>
          <Save size={12} className="inline mr-1" />Save
        </button>
      </div>
      <p className="text-[11px] text-navy-400">A real person’s or shared user’s Google account — a Google Group address cannot send.</p>
    </>
  );
}

// STEP 1 FOR MICROSOFT 365 / OTHER: one mailbox, sending as the SPOC.
function MailboxConnect({ d, provider, busy, save }) {
  const s = d.smtp;
  const from = splitFrom(s.from);
  const mailbox0 = from.addr || s.user || '';
  const [f, setF] = useState({
    mailbox: mailbox0, name: from.name || DEFAULT_NAME, host: s.host, port: s.port, secure: s.secure,
    user: s.user && s.user !== mailbox0 ? s.user : '',
  });
  const [pass, setPass] = useState('');
  const [adv, setAdv] = useState(provider === 'other');
  const p = PROVIDERS[provider];
  const fromServer = !s.host && d.effective.source.host === 'server';
  const saveMailbox = () => {
    const mailbox = f.mailbox.trim();
    const server = provider === 'other'
      ? { host: f.host, port: f.port === '' ? '' : Number(f.port), secure: f.secure === true }
      : { host: p.host, port: p.port, secure: p.secure };
    save({ transport: 'smtp', smtp: {
      provider, ...server,
      user: f.user.trim() || mailbox,
      from: `${(f.name.trim() || DEFAULT_NAME).replace(/[<>"]/g, '')} <${mailbox}>`,
      ...(pass ? { pass } : {}),
    } }, 'Mailbox saved. Now send a test email.');
    setPass('');
  };
  return (
    <>
      <p className="text-[11.5px] text-navy-500">{p.note}</p>
      {fromServer && (
        <p className="text-[11.5px] text-navy-500">Currently using the mailbox set on the server, <b>{d.effective.from}</b>. Saving here replaces it.</p>
      )}
      <div className="grid sm:grid-cols-2 gap-2">
        <label className="text-[11px] text-navy-500">Mailbox
          <input className="inp !py-1.5 mt-0.5" type="email" autoComplete="off" placeholder="pms@yourcompany.com" value={f.mailbox}
            onChange={(e) => setF({ ...f, mailbox: e.target.value })} /></label>
        <label className="text-[11px] text-navy-500">Password
          <input className="inp !py-1.5 mt-0.5" type="password" autoComplete="new-password"
            placeholder={s.pass_set ? '•••••••• saved — leave blank to keep' : 'the mailbox’s password'} value={pass}
            onChange={(e) => setPass(e.target.value)} /></label>
      </div>
      <button type="button" className="flex items-center gap-1 text-[11.5px] font-semibold text-navy-500" onClick={() => setAdv((v) => !v)} aria-expanded={adv}>
        <ChevronDown size={13} className={`transition-transform ${adv ? '' : '-rotate-90'}`} /> Advanced (for IT)
      </button>
      {adv && (
        <div className="grid sm:grid-cols-2 gap-2 rounded-xl bg-[#f7f9fd] p-3">
          <label className="text-[11px] text-navy-500 sm:col-span-2">Sender name for reminders and notifications
            <input className="inp !py-1.5 mt-0.5" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          {provider === 'other' ? (
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
          {s.pass_set && (
            <button type="button" className="btn-sec !text-xs justify-self-start" disabled={busy}
              onClick={() => save({ smtp: { clear_pass: true } }, 'Saved password removed.')}>Remove saved password</button>
          )}
        </div>
      )}
      <button className="btn-pri" disabled={busy || !EMAIL.test(f.mailbox.trim()) || (provider === 'other' && !f.host)} onClick={saveMailbox}>
        <Save size={13} className="inline mr-1" />Save mailbox
      </button>
    </>
  );
}

export default function EmailSettings() {
  const [d, setD] = useState(null);
  const [provider, setProvider] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [denied, setDenied] = useState(false);
  const [check, setCheck] = useState(null);

  const loadCheck = () => api('/people/onboarding/spocs/check').then(setCheck).catch(() => setCheck(null));
  const take = (r, keepProvider) => { setD(r); if (!keepProvider) setProvider(providerOf(r)); };
  useEffect(() => {
    api('/pms/hr/mail').then((r) => take(r)).catch((e) => (e.status === 403 ? setDenied(true) : setErr(e.message)));
    loadCheck();
  }, []);

  // An HRBP opens this page too; the email account is HR's alone.
  if (denied) return null;
  if (err && !d) return <div className="card p-4"><p className="text-xs text-rose-600">{err}</p></div>;
  if (!d) return <div className="card p-4"><p className="text-xs text-navy-400">Loading email settings…</p></div>;

  const save = async (patch, ok = 'Saved.') => {
    setErr(null); setMsg(null); setBusy(true);
    try { take(await api('/pms/hr/mail', { method: 'PUT', body: JSON.stringify(patch) }), true); setMsg(ok); loadCheck(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const sendTest = async () => {
    setErr(null); setMsg(null); setBusy(true); setTesting(true);
    try { const r = await api('/pms/hr/mail/test', { method: 'POST' }); if (r.view) take(r.view, true); loadCheck(); }
    catch (e) { setErr(e.message); }
    setBusy(false); setTesting(false);
  };

  const google = provider === 'google';
  // The screen's provider can differ from the saved one until it is saved;
  // the steps below describe what is SAVED, and say so when they differ.
  const pending = (google ? 'google' : 'smtp') !== d.transport;
  const stage = pending ? 'not_set_up' : (d.stage || 'not_set_up');
  const [badgeTone, badgeText] = STAGE[stage];
  const t = pending ? null : d.last_test;
  const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const spocList = check ? check.spocs : [];

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

      <Step n={1} title={google ? 'Connect Google Workspace' : 'Connect the PMS mailbox that sends the emails'} done={!pending && d.ready}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {Object.entries(PROVIDERS).map(([k, v]) => (
            <button key={k} type="button" onClick={() => setProvider(k)}
              className={`rounded-xl border px-3 py-2 text-left transition ${provider === k ? 'border-navy-500 bg-navy-50' : 'border-navy-100 bg-white hover:border-navy-200'}`}>
              <span className="flex items-center gap-2 text-[13px] font-semibold text-navy-900">
                <span className={`w-3.5 h-3.5 rounded-full border-[3px] shrink-0 ${provider === k ? 'border-navy-600' : 'border-navy-200'}`} />
                {v.label}{k === 'google' && <span className="chip bg-emerald-100 text-emerald-700 !text-[10px]">Mindgate</span>}
              </span>
              <span className="block text-[11px] text-navy-500 mt-0.5 pl-5">{v.sub}</span>
            </button>
          ))}
        </div>
        {pending && d.ready && (
          <p className="text-[11.5px] text-amber-700">
            Email is currently set up through {d.transport === 'google' ? 'Google Workspace' : 'a mailbox'}. Saving here switches it, and it must be tested again.
          </p>
        )}
        {google
          ? <GoogleConnect key={`${d.google.client_id}-${d.google.sender}`} d={d} busy={busy} save={save} />
          : <MailboxConnect key={`${provider}-${d.smtp.from}-${d.smtp.host}`} d={d} provider={provider} busy={busy} save={save} />}
        {(msg || err) && (
          <p className={`text-xs ${err ? 'text-rose-600' : 'text-emerald-700'}`}>{err || msg}</p>
        )}
      </Step>

      <Step n={2} title="Send a test email to yourself" done={!!(t && t.ok)}>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-sec" disabled={busy || pending || !d.ready} onClick={sendTest}>
            <Send size={12} className="inline mr-1" />{testing ? 'Sending… (up to 20 seconds)' : 'Send a test email to me'}
          </button>
          {(pending || !d.ready) && <span className="text-[11.5px] text-navy-400">Finish step 1 first.</span>}
        </div>
        {t && t.ok && (
          <p className="text-xs text-emerald-700 flex items-center gap-1.5">
            <CheckCircle2 size={13} /> Delivered to {t.to} on {when(t.at)}. Check that inbox — if it arrived, go to step 3.
          </p>
        )}
        {t && !t.ok && (
          <div className="text-xs rounded-xl bg-rose-50 border border-rose-100 p-2.5 space-y-1">
            <p className="text-rose-700 font-semibold flex items-start gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{t.hint || 'The test email was not delivered.'}</p>
            {t.detail && <p className="text-[11px] text-navy-500">The server said: <code className="break-all">{t.detail}</code></p>}
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

      {/* FIRST-WEEK JOURNEY EMAILS GO FROM EACH SPOC'S OWN ADDRESS (7 Oct).
          With Google, each SPOC address is checked here without sending:
          Google refuses a token for a group, a typo or an outsider. */}
      <div className="border-t border-navy-100 pt-3 space-y-1.5">
        <p className="font-semibold text-[13px] text-navy-900">First-Week Journey emails go from each SPOC’s own address</p>
        <p className="text-[11.5px] text-navy-500">
          {google
            ? 'Sent from each SPOC’s own Gmail. Each address must be a person’s or shared user’s Google account — not a Google Group.'
            : <>The mailbox above sends them as the SPOC. Ask IT to give it <b>“Send As”</b> permission for each SPOC address below — once.</>}
        </p>
        {check && (spocList.length ? (
          <div className="space-y-1">
            {spocList.map((x) => (
              <div key={x.role} className="text-[11.5px]">
                <span className="inline-flex items-center gap-1.5">
                  {check.checkable && (x.ok ? <CheckCircle2 size={13} className="text-emerald-600" /> : <XCircle size={13} className="text-rose-600" />)}
                  <b className="text-navy-800">{x.role}</b> <span className="text-navy-600">{x.email}</span>
                </span>
                {check.checkable && !x.ok && <span className="block pl-5 text-rose-700">{x.hint || x.detail}</span>}
              </div>
            ))}
            {check.checkable && <button type="button" className="text-[11.5px] font-semibold text-brand-600" onClick={loadCheck}>Check again</button>}
          </div>
        ) : <p className="text-[11.5px] text-amber-700">No SPOC addresses yet — set them under New Hire Insights → First-Week Journey → SPOCs.</p>)}
        <p className="text-[11px] text-navy-400">
          Managers, buddies and HR POCs send from their own addresses too{google ? '.' : '; IT can grant the mailbox Send As for them, or for everyone, the same way.'}
        </p>
      </div>

      <p className="text-[11px] text-navy-400"><ShieldCheck size={11} className="inline mr-1" />
        Keys and passwords are never shown again or written to the audit log.</p>
    </div>
  );
}
