// An onboarding email: who it is FROM, who it goes TO, and what it says.
// Pure. See migrations/083-onboarding-senders.js for why it is this way
// round — to the joiner, from the SPOC who owns the activity.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
const fmt = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB',
  { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');

/**
 * The person the email comes from, for the activity's sender role.
 * Manager and Buddy are the joiner's own; every other role is the SPOCs
 * list. Returns { role, name, email } or { role, missing: why }.
 */
function sender(role, joiner, directory = {}) {
  if (!role) return { role: null, missing: 'This activity has no owner to send it from.' };
  if (role === 'Manager') {
    return joiner.manager_email ? { role, name: joiner.manager_name, email: joiner.manager_email }
      : { role, missing: 'The joiner has no reporting manager in the employee master.' };
  }
  if (role === 'Buddy') {
    return joiner.buddy_email ? { role, name: joiner.buddy_name, email: joiner.buddy_email }
      : { role, missing: 'No buddy is chosen for this joiner yet.' };
  }
  // HR: the joiner's own HR POC when one is chosen, the HR desk otherwise.
  if (role === 'HR' && joiner.hr_poc_email) return { role, name: joiner.hr_poc_name, email: joiner.hr_poc_email };
  const d = directory[role];
  return d && d.email ? { role, name: d.name || role, email: d.email }
    : { role, missing: `No ${role} SPOC email is set — HR sets it under SPOCs on this page.` };
}

/**
 * Where the joiner receives it. Before joining, a personal address when
 * HR has one — the company mailbox usually does not work yet. After, the
 * company address from the employee master.
 */
function joinerAddress(task, joiner) {
  const before = task.planned_date && joiner.doj && task.planned_date < joiner.doj;
  const company = joiner.email || null;
  const personal = joiner.personal_email || null;
  if (before && personal) return { email: personal, kind: 'personal', why: 'before joining, so their personal address' };
  if (company) return { email: company, kind: 'company', why: 'their company address from the employee master' };
  if (personal) return { email: personal, kind: 'personal', why: 'no company address on the master' };
  return null;
}

/** The draft, written to the joiner. Editable on screen before it goes. */
function draft(task, joiner, from) {
  const first = String(joiner.name || '').split(/\s+/)[0] || 'there';
  const subject = `Your onboarding: ${task.activity} — ${fmt(task.planned_date)}`;
  const lines = [
    `Dear ${first},`,
    ``,
    `${joiner.doj > new Date().toISOString().slice(0, 10) ? 'Welcome — we look forward to you joining us' : 'Welcome aboard'}`
      + `${joiner.doj ? ` on ${fmt(joiner.doj)}` : ''}.`,
    ``,
    `As part of your first week, "${task.activity}" is planned for ${fmt(task.planned_date)} (${task.day}).`,
    task.process ? `What happens: ${task.process}.` : null,
    task.outcome ? `What it is for: ${task.outcome}.` : null,
    ``,
    `If you have any questions, simply reply to this email.`,
    ``,
    `Regards,`,
    `${from && from.name ? from.name : ''}${from && from.role ? ` (${from.role})` : ''}`,
  ].filter((l) => l !== null);
  return { subject, body: lines.join('\n') };
}

// Plain text in, safe HTML out: the body is what a person typed.
const toHtml = (body) => `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${
  esc(body).split('\n').map((l) => l || '&nbsp;').join('<br>')}</div>`;

module.exports = { sender, joinerAddress, draft, toHtml, esc };
