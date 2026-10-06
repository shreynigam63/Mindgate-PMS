// Who an onboarding task's email goes to, and what it says. Pure.
// See migrations/082-onboarding-spocs.js for the roles and why.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
const fmt = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB',
  { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');

/**
 * @param {string[]} roles      the activity's spoc_roles
 * @param {object} joiner       manager_name/email, buddy_name/email, hr_poc_name/email
 * @param {object} directory    role -> {name, email}
 * @returns {{to:{role,name,email}[], missing:{role,why}[]}}
 */
function recipients(roles, joiner, directory = {}) {
  const to = []; const missing = [];
  for (const role of roles || []) {
    let hit = null; let why = null;
    if (role === 'Manager') {
      hit = joiner.manager_email ? { name: joiner.manager_name, email: joiner.manager_email } : null;
      why = 'The joiner has no reporting manager in the employee master.';
    } else if (role === 'Buddy') {
      hit = joiner.buddy_email ? { name: joiner.buddy_name, email: joiner.buddy_email } : null;
      why = 'No buddy is chosen for this joiner yet.';
    } else if (role === 'HR' && joiner.hr_poc_email) {
      // The joiner's own HR POC first; the HR desk when none is set.
      hit = { name: joiner.hr_poc_name, email: joiner.hr_poc_email };
    } else {
      const d = directory[role];
      hit = d && d.email ? { name: d.name || role, email: d.email } : null;
      why = `No ${role} SPOC email is set — HR sets it under SPOCs on this page.`;
    }
    if (hit) {
      if (!to.some((t) => t.email.toLowerCase() === hit.email.toLowerCase())) to.push({ role, ...hit });
    } else missing.push({ role, why });
  }
  return { to, missing };
}

/** The draft. Editable on screen before it is sent. */
function draft(task, joiner, sender) {
  const subject = `Onboarding: ${task.activity} for ${joiner.name} — ${task.day}, ${fmt(task.planned_date)}`;
  const lines = [
    `Hello,`,
    ``,
    `This is about the onboarding of ${joiner.name}${joiner.designation ? `, ${joiner.designation}` : ''}`
      + `${joiner.department ? ` (${joiner.department})` : ''}, who ${joiner.doj > new Date().toISOString().slice(0, 10) ? 'joins' : 'joined'} on ${fmt(joiner.doj)}.`,
    ``,
    `Activity: ${task.activity} — ${task.day}, planned for ${fmt(task.planned_date)}.`,
    `What to do: ${task.process || '—'}`,
    `Expected outcome: ${task.outcome || '—'}`,
    `Status: ${task.status}${task.days_overdue ? ` (${task.days_overdue} working day${task.days_overdue === 1 ? '' : 's'} overdue)` : ''}.`,
    ``,
    `Please complete it and reply to confirm, so it can be marked done on the tracker.`,
    ``,
    `Thank you,`,
    `${sender.name || sender.email}`,
  ];
  return { subject, body: lines.join('\n') };
}

// Plain text in, safe HTML out: the body is what a person typed.
const toHtml = (body) => `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${
  esc(body).split('\n').map((l) => l || '&nbsp;').join('<br>')}</div>`;

module.exports = { recipients, draft, toHtml, esc };
