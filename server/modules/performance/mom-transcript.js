// The MoM tab, part 3: reading the transcript Google Meet made of the call,
// and turning the AI's draft into the MoM template. Pure, apart from
// unzipping a .docx.
//
// HOW THE TRANSCRIPT GETS HERE. Google Meet transcribes the call (Meet's
// own Transcripts, or "Take notes with Gemini") and saves a Google Doc in
// the organiser's Drive, in the Meet Recordings folder, with a link in an
// email after the call. The organiser opens it, chooses File → Download →
// Microsoft Word (.docx) or Plain text (.txt), and uploads that file — or
// pastes the text. Nothing is transcribed on the PMS server, and no Google
// API is used.
const JSZip = require('jszip');

const MAX_CHARS = 400000; // about seven hours of talk
const TYPES = 'Upload the transcript as .docx or .txt — in Google Docs, File → Download → Microsoft Word or Plain text.';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

function tidy(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// WebVTT / SRT / SBV captions: drop the cue numbers and timings, keep the
// words, and turn a <v Speaker> voice tag into "Speaker: ".
function fromCaptions(text) {
  return text.split(/\r?\n/)
    .filter((l) => !/^WEBVTT/.test(l) && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^\d+:\d{2}:\d{2}\.\d+,\d+:\d{2}:\d{2}\.\d+$/.test(l.trim()))
    .map((l) => l.replace(/<v\s+([^>]+)>/g, '$1: ').replace(/<[^>]+>/g, ''))
    .join('\n');
}

async function fromDocx(buf) {
  let zip;
  try { zip = await JSZip.loadAsync(buf); } catch { throw Object.assign(new Error('That .docx file could not be opened.'), { status: 422 }); }
  const doc = zip.file('word/document.xml');
  if (!doc) throw Object.assign(new Error('That .docx file has no document in it.'), { status: 422 });
  const xml = await doc.async('string');
  return decode(xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ''));
}

// The words of an uploaded transcript file (or pasted text, name null).
async function parseTranscript(buf, name) {
  const ext = name ? ((String(name).match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase() : 'txt';
  let text;
  if (ext === 'docx') text = await fromDocx(buf);
  else if (['txt', 'md', 'text', ''].includes(ext)) text = buf.toString('utf8');
  else if (['vtt', 'srt', 'sbv'].includes(ext)) text = fromCaptions(buf.toString('utf8'));
  else if (['html', 'htm'].includes(ext)) text = decode(buf.toString('utf8').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n').replace(/<[^>]+>/g, ''));
  else if (ext === 'pdf') throw Object.assign(new Error(`A PDF is not read here. ${TYPES}`), { status: 422 });
  else throw Object.assign(new Error(TYPES), { status: 422 });
  text = tidy(text);
  if (text.replace(/\s/g, '').length < 20) throw Object.assign(new Error('The transcript is empty.'), { status: 422 });
  if (text.length > MAX_CHARS) throw Object.assign(new Error('The transcript is too long (more than about seven hours).'), { status: 422 });
  return { text, speakers: speakersOf(text), language: /[\u0900-\u097F]/.test(text) ? 'hi-en' : 'en' };
}

// "Name: what they said" — the speaker labels Google Meet writes.
function speakersOf(text) {
  const seen = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:\n]{2,60}?):\s+\S/);
    if (!m) continue;
    const name = m[1].trim();
    if (/^\d/.test(name) || name.split(/\s+/).length > 6 || /^(https?|note|notes|summary|transcript|attendees)$/i.test(name)) continue;
    seen.set(name, (seen.get(name) || 0) + 1);
  }
  return [...seen.keys()].slice(0, 50);
}

// ------------------------------------------------------------------ the draft

const SYSTEM = `You draft the minutes (MoM) of a team's daily connect from the Google Meet
transcript of the call, in a fixed template. The organiser reviews and edits
your draft before anyone else sees it.

Rules:
- Use only what was said or written in the transcript. Do not add facts,
  tasks or decisions that were not stated.
- Name an action item's owner only if the transcript says who will do it,
  using that person's name exactly as it appears in the attendee list.
  Otherwise leave the owner empty for the organiser to fill in.
- Give a due date only if one was said. Turn relative dates ("by Friday",
  "tomorrow") into YYYY-MM-DD from the meeting date. Otherwise leave it empty.
- Never give performance ratings, scores or judgements about any person.
  Record what people said and agreed, not how well anyone did.
- open_items_from_previous are the team's open action items from earlier
  MoMs, each with a ref. For each one the transcript mentions, say whether
  it was reported done or is still open. Leave out the ones not mentioned.
- present: the attendees the transcript shows on the call (its attendee
  list or its speakers), by their names in the attendee list. Leave it
  empty if the transcript does not show who was there.
- If the transcript is very short, mostly noise or hard to follow, set
  confidence to "low" and say why.
- Mixed English and Hindi is normal. Write the minutes in English.

Respond with JSON only, in exactly this shape:
{"summary": "3 to 5 sentences on what the meeting covered",
 "discussion": ["one line per topic discussed"],
 "decisions": ["what was agreed"],
 "action_items": [{"task": "", "owner": "", "due_date": "", "priority": "low|medium|high"}],
 "blockers": [{"issue": "", "help_from": ""}],
 "carried_forward": [{"ref": "C1", "status": "done|open", "note": "what was said"}],
 "present": ["names"],
 "confidence": "high|low",
 "confidence_reason": ""}`;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u0900-\u097F ]+/g, ' ').replace(/\s+/g, ' ').trim();

// A name the AI wrote, matched to a person: the full name, or a first name
// only one of them has. Anything else is left for the organiser.
function matchPerson(name, people) {
  const n = norm(name);
  if (!n) return null;
  const full = people.filter((p) => norm(p.name) === n);
  if (full.length === 1) return full[0].id;
  const first = people.filter((p) => norm(p.name).split(' ')[0] === n.split(' ')[0]);
  return first.length === 1 && n.split(' ').length === 1 ? first[0].id : null;
}

const strList = (v, max = 300) => (Array.isArray(v) ? v : []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean).map((x) => x.slice(0, max)).slice(0, 60);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

// The AI's JSON, made into the minutes the editor opens with.
//   people     everyone who can own an item (attendees, organiser, team)
//   attendees  the meeting's attendees
//   carried    the open items it was shown, [{ref, id}]
//   words      the transcript's length in words
function draftToMinutes(draft, { people, attendees, carried, words }) {
  const d = draft && typeof draft === 'object' ? draft : {};
  const unmatched = [];
  const items = (Array.isArray(d.action_items) ? d.action_items : []).map((a) => {
    const task = String((a && a.task) || '').trim().slice(0, 500);
    const ownerName = String((a && a.owner) || '').trim();
    const owner = ownerName ? matchPerson(ownerName, people) : null;
    if (ownerName && !owner) unmatched.push(ownerName);
    return { id: null, task, owner_id: owner, due_date: isDate(a && a.due_date) ? a.due_date : null,
      priority: ['low', 'medium', 'high'].includes(a && a.priority) ? a.priority : 'medium' };
  }).filter((a) => a.task).slice(0, 40);
  const blockers = (Array.isArray(d.blockers) ? d.blockers : []).map((b) => ({
    issue: String((b && b.issue) || '').trim().slice(0, 300), help_from: String((b && b.help_from) || '').trim().slice(0, 120),
  })).filter((b) => b.issue).slice(0, 30);
  // Attendance only when the transcript showed who was there and the names
  // match someone; a draft must not mark the whole team absent because the
  // names were spelt differently.
  const presentIds = new Set(strList(d.present).map((n) => matchPerson(n, attendees)).filter(Boolean));
  const attendance = presentIds.size ? Object.fromEntries(attendees.map((a) => [a.id, presentIds.has(a.id) ? 'present' : 'absent'])) : {};
  const byRef = new Map((carried || []).map((c) => [c.ref, c.id]));
  const hints = (Array.isArray(d.carried_forward) ? d.carried_forward : [])
    .filter((c) => c && byRef.has(c.ref) && ['done', 'open'].includes(c.status))
    .map((c) => ({ id: byRef.get(c.ref), status: c.status, note: String(c.note || '').slice(0, 300) }));
  const discussion = strList(d.discussion);
  const reasons = [];
  if (d.confidence === 'low') reasons.push(String(d.confidence_reason || 'The AI was unsure of this transcript.').slice(0, 300));
  if (words < 80) reasons.push('The transcript is very short.');
  if (!discussion.length) reasons.push('No discussion points were found.');
  return {
    value: { summary: String(d.summary || '').trim().slice(0, 3000) || null, discussion, decisions: strList(d.decisions),
      blockers, attendance, action_items: items, start_time: null, end_time: null },
    confidence: reasons.length ? 'low' : 'high',
    notes: { carried_hints: hints, confidence_reason: reasons.join(' ') || null, unmatched_owners: [...new Set(unmatched)] },
  };
}

module.exports = { parseTranscript, speakersOf, draftToMinutes, matchPerson, SYSTEM, MAX_CHARS };
