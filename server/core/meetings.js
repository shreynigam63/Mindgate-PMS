// Meeting providers — the seam a calendar/conferencing integration plugs
// into, with NOTHING plugged in today.
//
// The client asked for the provision to integrate Google Meet and was
// explicit that it must not be connected now. This file is that provision:
// it names the providers, says which are available and why, and gives the
// routes one place to ask. Connecting Meet later means implementing the
// google_meet entry — adding an OAuth flow and a Calendar/Meet client —
// not rewriting the callers, because the callers only ever talk to this.
//
// WHAT IS DELIBERATELY ABSENT: any Google dependency, any OAuth
// credential, any environment variable that would let a half-finished
// integration start talking to a real account. There is no code path here
// that makes a network call. A provider that cannot work says so, with a
// reason, and the route returns that reason to the user — which is the
// honest behaviour and also stops the feature from looking broken.

const MANUAL = 'manual';
const GOOGLE_MEET = 'google_meet';

const PROVIDERS = {
  // Available today: somebody creates the meeting in whatever tool they
  // already use and pastes the link in. Works with Meet, Teams, Zoom or a
  // phone number, needs no integration, and is what every one-on-one in
  // this system is actually run on right now.
  [MANUAL]: {
    id: MANUAL,
    label: 'Paste a link',
    available: true,
    creates_events: false,
    captures_transcripts: false,
    description: 'Paste the link to a meeting you scheduled yourself, in any tool.',
  },

  // NOT CONNECTED, ON PURPOSE. Left declared rather than deleted so the
  // shape of the thing is visible: the UI can show it as a coming option,
  // the routes already refuse it with a real reason instead of a 500, and
  // whoever implements it knows exactly which capabilities are expected of
  // it. Turning it on is: implement create()/fetchTranscript(), flip
  // available, and set the credentials — no schema change (migration 027
  // already carries provider and external_event_id) and no route change.
  [GOOGLE_MEET]: {
    id: GOOGLE_MEET,
    label: 'Google Meet',
    available: false,
    creates_events: true,
    captures_transcripts: true,
    unavailable_reason: 'Google Meet is not connected on this instance yet.',
    description: 'Schedule the meeting in Google Calendar and, with the employee’s consent, bring the transcript back for a KRA-wise summary.',
  },
};

function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id, label: p.label, available: p.available,
    creates_events: p.creates_events, captures_transcripts: p.captures_transcripts,
    description: p.description,
    unavailable_reason: p.available ? null : p.unavailable_reason,
  }));
}

// Throws a shaped { status } error the route can let propagate, matching
// the convention core/ai.js and core/consent.js already use.
function requireProvider(id) {
  const p = PROVIDERS[id];
  if (!p) {
    const e = new Error(`Unknown meeting provider "${id}"`);
    e.status = 400; throw e;
  }
  if (!p.available) {
    // 501, not 400: the request is well-formed and will be valid once the
    // integration exists. A 400 would tell the caller they got it wrong.
    const e = new Error(p.unavailable_reason);
    e.status = 501; throw e;
  }
  return p;
}

const CONTEXTS = ['connect', 'midyear', 'annual'];
function requireContext(context) {
  if (!CONTEXTS.includes(context)) {
    const e = new Error(`context must be one of: ${CONTEXTS.join(', ')}`);
    e.status = 400; throw e;
  }
  return context;
}

module.exports = { PROVIDERS, MANUAL, GOOGLE_MEET, CONTEXTS, listProviders, requireProvider, requireContext };
