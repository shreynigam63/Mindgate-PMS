import { useEffect, useState } from 'react';
import { Video, Sparkles, Trash2, Link2 } from 'lucide-react';
import { api, KraBullets } from '../utils/api';
import { AiModal } from './AiDraftPanel';

// Meetings for a one-on-one connect, a mid-year review or an annual
// appraisal — and the KRA-wise summary of what was said.
//
// GOOGLE MEET IS SHOWN AS A NAMED, NOT-YET-CONNECTED OPTION rather than
// hidden. The client asked for the provision without the connection, and
// an option that is visibly "coming" is honest in a way that an absent
// option is not: nobody has to wonder whether they missed a setting.
// Today the working path is pasting a link from whatever tool was used.
//
// The transcript box is the other half. Once Meet is connected the
// transcript arrives on its own; until then, pasting one in gets the same
// summary — the same endpoint, the same consent gate.
export default function MeetingPanel({ employeeId, context, refId, title }) {
  const [providers, setProviders] = useState([]);
  const [list, setList] = useState([]);
  const [url, setUrl] = useState('');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [text, setText] = useState('');
  const [summary, setSummary] = useState(null);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const q = new URLSearchParams({ context, ...(employeeId ? { employee_id: employeeId } : {}) });
  const load = () => api(`/pms/meetings?${q}`).then((r) => setList(r.meetings)).catch((e) => setErr(e.message));
  useEffect(() => {
    api('/pms/meetings/providers').then((r) => setProviders(r.providers)).catch(() => {});
    load();
  }, [employeeId, context]);

  const add = async () => {
    setBusy(true); setErr(null);
    try {
      await api('/pms/meetings', { method: 'POST', body: JSON.stringify({
        employee_id: employeeId, context, ref_id: refId, meeting_url: url, scheduled_at: when || null }) });
      setUrl(''); setWhen(''); load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const remove = async (id) => {
    try { await api(`/pms/meetings/${id}`, { method: 'DELETE' }); load(); } catch (e) { setErr(e.message); }
  };

  const saveTranscript = async (id) => {
    setBusy(true); setErr(null);
    try {
      await api(`/pms/meetings/${id}/transcript`, { method: 'PUT', body: JSON.stringify({ content: text }) });
      setText(''); setOpenId(null); load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const summarise = async (id) => {
    setBusy(true); setErr(null); setSummary(null);
    try { setSummary(await api('/agentic/meeting-summary', { method: 'POST', body: JSON.stringify({ meeting_id: id }) })); setSummaryOpen(true); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const soon = providers.filter((p) => !p.available);
  const d = summary && summary.draft;

  return (
    <div className="card p-3 space-y-2">
      <p className="lbl mb-0"><Video size={13} className="inline mr-1" />{title}</p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="grow min-w-[220px]">
          <label className="text-[11px] text-navy-400">Meeting link</label>
          <input className="inp" placeholder="https://meet.google.com/… (or Teams, Zoom — any link)"
            value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div>
          <label className="text-[11px] text-navy-400">When (optional)</label>
          <input className="inp" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </div>
        <button className="btn-sec" disabled={busy || !url} onClick={add}><Link2 size={13} className="inline mr-1" />Add</button>
      </div>

      {soon.length > 0 && (
        <p className="text-[11px] text-navy-400">
          {soon.map((p) => `${p.label}: ${p.unavailable_reason}`).join(' ')} Once connected, meetings can be scheduled from here
          and — with your consent — the transcript summarised against your KRAs automatically.
        </p>
      )}
      {err && <p className="text-xs text-rose-600">{err}</p>}

      {list.length === 0 && <p className="text-xs text-navy-400">No meetings recorded yet.</p>}
      {list.map((m) => (
        <div key={m.id} className="border border-navy-100 rounded-lg p-2 space-y-1 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <a className="text-blue-700 underline break-all" href={m.meeting_url} target="_blank" rel="noreferrer">{m.meeting_url}</a>
            <div className="flex items-center gap-2">
              {m.scheduled_at && <span className="text-navy-400">{new Date(m.scheduled_at).toLocaleString()}</span>}
              {m.has_transcript
                ? <button className="btn-sec !py-0.5" disabled={busy} onClick={() => summarise(m.id)}>
                    <Sparkles size={12} className="inline mr-1 text-amber-500" />Summarise KRA-wise</button>
                : <button className="btn-sec !py-0.5" onClick={() => setOpenId(openId === m.id ? null : m.id)}>Add transcript</button>}
              <button className="btn-sec !p-1" onClick={() => remove(m.id)}><Trash2 size={12} /></button>
            </div>
          </div>
          {openId === m.id && (
            <div className="space-y-1">
              <textarea className="inp" rows={5} placeholder="Paste the meeting transcript or your notes of the conversation…"
                value={text} onChange={(e) => setText(e.target.value)} />
              <p className="text-[11px] text-navy-400">
                Stored only with the employee’s recorded consent for AI insights — the request is refused without it.
              </p>
              <button className="btn-pri" disabled={busy || !text.trim()} onClick={() => saveTranscript(m.id)}>Save transcript</button>
            </div>
          )}
        </div>
      ))}

      {/* This panel is embedded inside other screens (self-appraisal,
          mid-year, a connect), so a KRA-wise summary printed inline pushes
          whatever is hosting it down the page. */}
      {d && !summaryOpen && (
        <button className="text-[11px] font-semibold text-navy-600 hover:underline self-start" onClick={() => setSummaryOpen(true)}>
          Reopen the meeting summary
        </button>
      )}
      {d && summaryOpen && (
        <AiModal title="What the meeting covered" onClose={() => setSummaryOpen(false)}>
          <KraBullets byKra={d.by_kra} crossCutting={d.cross_cutting}
            sections={[['discussed', 'Discussed'], ['agreed_actions', 'Agreed actions'], ['concerns', 'Concerns']]} />
          {(d.kras_not_discussed || []).length > 0 && (
            <p className="text-amber-700">Not discussed: {d.kras_not_discussed.join(' · ')}</p>
          )}
          {(d.follow_up_needed || []).length > 0 && (
            <div><p className="font-semibold text-navy-500">Left unresolved</p>
              <ul className="list-disc pl-4">{d.follow_up_needed.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
          )}
        </AiModal>
      )}
    </div>
  );
}
