// The survey library — ready-made surveys HR picks instead of typing.
//
// Asked for on 25 Sep as phase 3: "I would create a Survey Library",
// and "For the immediate release of your product, I would make Day 1 +
// Week 1 + 30 + 60 + 90 the core module."
//
// The point of the library is the point Mindgate made themselves:
//
//   "The most important point: don't ask the same questions at
//    30/60/90. The employee's questions should evolve with tenure."
//
// So these are not five copies of one engagement survey. Day 1 asks
// whether the first day worked; Week 1 asks whether they know where
// they are; Day 30 asks whether they understand the role; Day 60 asks
// whether they are becoming productive; Day 90 asks whether they are
// contributing and can see a future. The wording is Mindgate's own,
// from sections 3 to 16 of their specification.
//
// DATA, NOT CODE. Seeded per tenant into engagement.survey_templates
// and editable there, because a client configures their own library and
// never forks the product to do it. This file is the starting set and
// the thing a re-seed restores; once a tenant edits a row, their row
// wins — reseed() only inserts what is missing.
//
// Pure: no db, no express. The content can be tested directly, which
// matters because a typo in a question reaches 1,400 people.

const SCALE = 'scale';
const TEXT = 'text';
const CHOICE = 'choice';
const MULTI = 'multi';
const ENPS = 'enps';

const s = (prompt) => ({ qtype: SCALE, prompt });
const t = (prompt) => ({ qtype: TEXT, prompt, required: false });
const c = (prompt, options) => ({ qtype: CHOICE, prompt, options });
const m = (prompt, options) => ({ qtype: MULTI, prompt, options, required: false });

// The blocker taxonomy, used at 30 and 60 so the two are comparable.
// This is the question the whole productivity story hangs on, and it is
// the one that silently collected nothing until 25 Sep.
const BLOCKERS = ['Lack of training', 'Lack of system access', 'Lack of clarity',
  'Dependency on others', 'Manager support', 'Team coordination', 'Process issues',
  'Workload', 'Skill gap', 'No significant blocker', 'Other'];

// Sections 18 and 19 rate capability in four named bands rather than
// 1-5, and say so explicitly: "Below expectation / Developing / Meets
// expectation / Exceeds expectation".
const BANDS = ['Below expectation', 'Developing', 'Meets expectation', 'Exceeds expectation'];
const band = (what) => ({ qtype: CHOICE, prompt: `${what}`, options: BANDS });

const CAPABILITIES = ['Technical skill', 'Domain knowledge', 'Communication', 'Leadership',
  'Project management', 'Client management', 'Process knowledge', 'Tools / technology', 'Other'];

const TEMPLATES = [
  // ---- Onboarding ----------------------------------------------------
  {
    key: 'preboarding',
    category: 'Onboarding',
    title: 'Pre-joining / Preboarding',
    description: 'Sent before the start date, to find expectation gaps before somebody joins.',
    trigger_type: 'manual',
    anonymity_default: false,
    // NOT a lifecycle trigger, deliberately. A preboarding survey has to
    // reach somebody who has not started, and on this master nobody
    // exists before their joining date — zero future-dated joiners,
    // and no login until they start. Shipping it as a standing trigger
    // would be shipping a survey that silently never fires. It is here,
    // ready, and becomes automatic the day the HRMS loads joiners ahead
    // of their start date.
    blocked_reason: 'Nobody is on the employee master before their joining date, and a pre-joiner has no login yet, so this cannot be sent automatically. Load starters ahead of their date of joining and give them access, and this becomes a lifecycle survey like the rest.',
    questions: [
      s('How prepared do you feel for your first day?'),
      s('How clear are you about your role and responsibilities?'),
      s('How clear are you about your reporting manager and team structure?'),
      s('How clear are you about what will be expected from you in your first 30 to 90 days?'),
      c('Have you received all the information required for your joining?', ['Yes', 'Partially', 'No']),
      m('Which of these have you received instructions or documents about?',
        ['Location', 'Working hours', 'Reporting manager', 'First-day schedule',
          'IT equipment', 'HR documentation', 'Benefits', 'Policies']),
      t('Is there anything you are concerned about before joining?'),
      t('What would make your first week easier?'),
    ],
  },
  {
    key: 'day_1',
    category: 'Onboarding',
    title: 'Day 1 Check-in',
    description: 'Eight questions on the joining day. Deliberately very short.',
    trigger_type: 'tenure', trigger_day: 0, trigger_window_days: 2,
    anonymity_default: false,
    questions: [
      s('I felt welcomed on my first day.'),
      s('My joining process was smooth.'),
      s('I received the necessary equipment and access.'),
      s('I know who my manager is.'),
      s('I know who to approach when I need help.'),
      s('I received sufficient information about the company.'),
      s('I understand what I am expected to do initially.'),
      { qtype: ENPS, prompt: 'Overall, how would you rate your first day?' },
      t('What went well today?'),
      t('What could we have done better?'),
    ],
  },
  {
    key: 'week_1',
    category: 'Onboarding',
    title: 'Week 1 Onboarding',
    description: 'Role clarity, manager, team, systems and culture after the first week — with the early-warning question.',
    trigger_type: 'tenure', trigger_day: 5, trigger_window_days: 4,
    anonymity_default: false,
    questions: [
      s('I understand my role and responsibilities.'),
      s('I understand what success looks like in my role.'),
      s('I understand my initial priorities.'),
      s('My manager has clearly explained expectations.'),
      s('I have received sufficient guidance.'),
      s('I have been introduced to the relevant team members.'),
      s('I feel included within my team.'),
      s('I have access to the systems required for my job.'),
      s('I have received adequate training.'),
      s('I understand the organisation’s values.'),
      s('The actual organisation is broadly consistent with what was represented during recruitment.'),
      // Mindgate: "This should be a high-priority early-warning
      // indicator, not merely an engagement score."
      c('Based on your first week, do you feel you made the right decision in joining the organisation?',
        ['Definitely yes', 'Probably yes', 'Unsure', 'Probably no', 'Definitely no']),
      t('What would help you most in your second week?'),
    ],
  },
  {
    key: 'day_30',
    category: 'New Hire Listening',
    title: 'Day 30 Connect',
    description: 'Role clarity, ramp-up, manager, belonging, and the first retention read.',
    trigger_type: 'tenure', trigger_day: 30, trigger_window_days: 7,
    anonymity_default: false,
    questions: [
      s('I understand my responsibilities.'),
      s('I understand my KRAs / objectives.'),
      s('I understand how my performance will be measured.'),
      s('My priorities are clear.'),
      s('My actual work broadly matches what I understood when I joined.'),
      s('I have sufficient knowledge to perform my role.'),
      s('I can independently complete most of my assigned work.'),
      s('I have access to the systems and tools I need.'),
      c('What is currently preventing you from becoming fully productive?', BLOCKERS),
      s('My manager provides sufficient guidance.'),
      s('My manager is available when required.'),
      s('I receive useful feedback.'),
      s('I feel part of my team.'),
      s('I feel comfortable asking questions.'),
      { qtype: ENPS, prompt: 'How likely are you to continue working with the organisation over the next 12 months?' },
      s('At this stage, how confident are you that this role is a good fit for you?'),
      c('Have you experienced anything that has made you reconsider your decision to join?', ['No', 'Yes']),
      t('If yes, please tell us what happened.'),
      t('What support do you need from your manager over the next 30 days?'),
      t('What is one thing the organisation could do to improve your experience?'),
    ],
  },
  {
    key: 'day_60',
    category: 'New Hire Listening',
    title: 'Day 60 Connect',
    description: 'Shifts from onboarding to integration and productivity, and picks up the training need.',
    trigger_type: 'tenure', trigger_day: 60, trigger_window_days: 7,
    anonymity_default: false,
    questions: [
      s('My responsibilities are clear.'),
      s('My goals / KRAs are clear.'),
      s('I understand how my work contributes to business objectives.'),
      s('I am increasingly able to work independently.'),
      s('I can complete routine work independently.'),
      s('I am able to meet expected timelines.'),
      s('Dependencies are manageable.'),
      s('I have the tools and information necessary to perform.'),
      c('Which factor is most affecting your productivity right now?', BLOCKERS),
      s('I have received adequate training.'),
      s('My current skill set is sufficient for my role.'),
      s('I know which skills I need to develop.'),
      s('My manager discusses my development with me.'),
      c('Which capability would help you become significantly more effective in your role?', CAPABILITIES),
      s('I receive timely feedback.'),
      s('I understand what I am doing well.'),
      s('I understand what I need to improve.'),
      s('My team collaborates effectively.'),
      { qtype: ENPS, prompt: 'How likely are you to continue working with the organisation over the next 12 months?' },
      t('What is one thing your manager could do differently that would help you perform better?'),
    ],
  },
  {
    key: 'day_90',
    category: 'New Hire Listening',
    title: 'Day 90 Connect — confirmation readiness',
    description: 'Not "have you settled in" but "are you contributing, aligned, and ready for the next cycle". Doubles as the new-hire completion survey.',
    trigger_type: 'tenure', trigger_day: 90, trigger_window_days: 7,
    anonymity_default: false,
    questions: [
      s('I understand my role completely.'),
      s('I understand my KRAs / objectives.'),
      s('I understand how my performance will be evaluated.'),
      s('My actual role matches the expectations communicated during recruitment.'),
      s('I can perform my core responsibilities independently.'),
      s('I understand the quality expectations.'),
      s('I understand my team’s priorities.'),
      s('I can identify the impact of my work.'),
      c('How would you describe your current level of productivity?',
        ['Still learning', 'Partially productive', 'Mostly productive', 'Fully productive',
          'Operating above expected level']),
      s('My manager has provided adequate support during my first 90 days.'),
      s('My manager has provided meaningful feedback.'),
      s('My manager has helped remove blockers.'),
      s('I understand what my manager expects from me going forward.'),
      s('I can see opportunities for growth within the organisation.'),
      s('I understand what capabilities I need to develop for my next career step.'),
      s('I have discussed my career aspirations with my manager.'),
      c('Which direction interests you most over the next 1 to 2 years?',
        ['Deeper technical / domain expertise', 'People management', 'Project / programme management',
          'Client-facing role', 'Cross-functional role', 'Leadership', 'Not yet decided']),
      // The scorecard dimensions from section 16, as one rated block —
      // this is what makes a New Hire Experience Index computable.
      s('Overall: onboarding.'),
      s('Overall: manager support.'),
      s('Overall: team integration.'),
      s('Overall: training.'),
      { qtype: ENPS, prompt: 'How likely are you to continue working with the organisation over the next 12 months?' },
      t('What would have made your first 90 days better?'),
    ],
  },

  // ---- the rest of the library (section 26) --------------------------
  // Every one of these is answered BY the employee about themselves or
  // their manager, so the engine can release all of them today. The
  // manager-side 30/60/90 assessment is not here: it is a survey ABOUT
  // somebody else, which needs a schema change, and a template that
  // cannot be released would be worse than no template.
  // ---- the manager's side (phase 4) ---------------------------------
  // Mindgate, section 17: "BUT — YOU SHOULD ALSO SURVEY THE MANAGER.
  // This is critical. If you only ask employees, your PMS will capture
  // perception, but not the manager's assessment."
  //
  // These are surveys ABOUT a person, answered BY their manager, so
  // they carry audience_kind 'manager_about_reportee': the rule picks
  // the new joiners, and each one's manager gets an invitation naming
  // them. Never anonymous — the whole record is "what X's manager said
  // about X" — and the schema will not let them be.
  {
    key: 'manager_30',
    category: 'Manager assessment',
    title: 'Manager 30-Day Review',
    description: 'The manager\u2019s read at 30 days, on each of their new joiners.',
    audience_kind: 'manager_about_reportee',
    trigger_type: 'tenure', trigger_day: 30, trigger_window_days: 7,
    anonymity_default: false,
    questions: [
      s('The employee has understood their role.'),
      s('The employee has understood their KRAs.'),
      s('The employee is meeting expected learning milestones.'),
      s('The employee is demonstrating the required competencies.'),
      s('The employee is able to work independently.'),
      s('Productivity is progressing as expected.'),
      s('Quality of work is satisfactory.'),
      s('The employee is collaborating effectively.'),
      c('Does the employee require additional training?', ['No', 'Yes — technical', 'Yes — process', 'Yes — behavioural']),
      c('Are there any performance concerns?', ['No', 'Minor', 'Significant']),
      c('Are there any behavioural concerns?', ['No', 'Minor', 'Significant']),
      t('What support does the employee require over the next 30 days?'),
    ],
  },
  {
    key: 'manager_60',
    category: 'Manager assessment',
    title: 'Manager 60-Day Review',
    description: 'Productivity and capability at 60 days, rated in the four bands from the specification.',
    audience_kind: 'manager_about_reportee',
    trigger_type: 'tenure', trigger_day: 60, trigger_window_days: 7,
    anonymity_default: false,
    questions: [
      s('Productivity is progressing as expected.'),
      s('Quality is progressing as expected.'),
      s('The employee is meeting reasonable timelines.'),
      s('The employee manages dependencies effectively.'),
      s('The employee requires limited supervision.'),
      band('Technical / domain capability'),
      band('Problem solving'),
      band('Communication'),
      band('Collaboration'),
      band('Ownership'),
      band('Adaptability'),
      t('What is the one thing this employee should focus on next?'),
    ],
  },
  {
    key: 'manager_90',
    category: 'Manager assessment',
    title: 'Manager 90-Day Review — confirmation',
    description: 'The ten-parameter assessment at 90 days, and whether a formal development plan is needed.',
    audience_kind: 'manager_about_reportee',
    trigger_type: 'tenure', trigger_day: 90, trigger_window_days: 7,
    anonymity_default: false,
    questions: [
      s('Role understanding'),
      s('Technical capability'),
      s('Productivity'),
      s('Quality'),
      s('Ownership'),
      s('Collaboration'),
      s('Communication'),
      s('Learning agility'),
      s('Behavioural alignment'),
      s('Independence'),
      t('What should the employee focus on during the next 90 days?'),
      t('What support will you provide?'),
      // Section 19: "This can automatically create a Development
      // Plan." It does not yet — the development plan lives in the
      // performance module and modules here never reach into each
      // other's internals. The answer is captured and reported so HR
      // can act on it; wiring it through an exported interface is a
      // change to that module, not this one.
      c('Does the employee require a formal development plan?',
        ['No', 'Yes — technical', 'Yes — behavioural', 'Yes — productivity', 'Yes — role clarity', 'Yes — other']),
    ],
  },

  {
    key: 'quarterly_pulse',
    category: 'Engagement',
    title: 'Quarterly Pulse',
    description: 'Short, anonymous, repeatable. The one to run every quarter for trend.',
    trigger_type: 'manual', anonymity_default: true,
    questions: [
      s('I am clear about what is expected of me at work.'),
      s('I have the resources I need to do my job well.'),
      s('I receive recognition for good work.'),
      s('My manager supports my development.'),
      s('I can raise concerns without worry.'),
      s('My workload is manageable.'),
      { qtype: ENPS, prompt: 'How likely are you to recommend this organisation as a place to work?' },
      t('What is the one thing we should change?'),
    ],
  },
  {
    key: 'annual_engagement',
    category: 'Engagement',
    title: 'Annual Engagement Survey',
    description: 'The full annual read, anonymous.',
    trigger_type: 'manual', anonymity_default: true,
    questions: [
      s('I am proud to work for this organisation.'),
      s('I understand how my work contributes to the organisation’s goals.'),
      s('I am clear about what is expected of me.'),
      s('I have the tools and resources to do my job well.'),
      s('I receive regular, useful feedback.'),
      s('My manager treats me with respect.'),
      s('My manager supports my development.'),
      s('I am fairly recognised for my contribution.'),
      s('I can raise concerns without fear.'),
      s('Decisions here are made fairly.'),
      s('My workload is sustainable.'),
      s('I can see a future for myself here.'),
      { qtype: ENPS, prompt: 'How likely are you to recommend this organisation as a place to work?' },
      t('What should we start doing?'),
      t('What should we stop doing?'),
    ],
  },
  {
    key: 'manager_effectiveness',
    category: 'Manager',
    title: 'Manager Effectiveness',
    description: 'Upward feedback on the reporting manager. Anonymous by default — it does not work otherwise.',
    trigger_type: 'manual', anonymity_default: true,
    questions: [
      s('My manager sets clear expectations.'),
      s('My manager gives me useful feedback.'),
      s('My manager is available when I need them.'),
      s('My manager removes blockers.'),
      s('My manager recognises good work.'),
      s('My manager supports my development.'),
      s('My manager treats the team fairly.'),
      s('I would be comfortable raising a difficult issue with my manager.'),
      t('What should your manager keep doing?'),
      t('What should your manager do differently?'),
    ],
  },
  {
    key: 'training_needs',
    category: 'Development',
    title: 'Training Needs Analysis',
    description: 'Feeds the learning plan. Run half-yearly.',
    trigger_type: 'manual', anonymity_default: false,
    questions: [
      s('My current skills are sufficient for my role today.'),
      s('I know which skills I need for the next 12 months.'),
      s('I have had enough opportunity to learn this year.'),
      c('Which capability would most improve your effectiveness?', CAPABILITIES),
      m('Which of these would help you most?',
        ['Classroom training', 'Online course', 'Certification', 'Mentoring', 'Job shadowing',
          'Stretch assignment', 'Conference', 'Internal knowledge sharing']),
      t('Name one specific skill or topic you want training on.'),
    ],
  },
  {
    key: 'career_aspirations',
    category: 'Development',
    title: 'Career Aspirations',
    description: 'What people want next. Feeds the Career Pathing Matrix.',
    trigger_type: 'manual', anonymity_default: false,
    questions: [
      s('I understand the career paths available to me here.'),
      s('I have discussed my career aspirations with my manager.'),
      s('I know what I need to do to reach my next role.'),
      c('Which direction interests you most over the next 1 to 2 years?',
        ['Deeper technical / domain expertise', 'People management', 'Project / programme management',
          'Client-facing role', 'Cross-functional role', 'Leadership', 'Not yet decided']),
      t('What role would you like to be doing in two years?'),
      t('What is standing in the way?'),
    ],
  },
  {
    key: 'stay_interview',
    category: 'Retention',
    title: 'Stay Interview',
    description: 'Asked of people you want to keep, before they start looking.',
    trigger_type: 'manual', anonymity_default: false,
    questions: [
      s('I find my work meaningful.'),
      s('I am learning and growing here.'),
      s('I am fairly recognised.'),
      s('I can see a future for myself here.'),
      { qtype: ENPS, prompt: 'How likely are you to still be here in 12 months?' },
      t('What keeps you here?'),
      t('What would make you consider leaving?'),
      t('What one change would most improve your experience?'),
    ],
  },
  {
    key: 'exit',
    category: 'Exit',
    title: 'Exit Survey',
    description: 'Sent on resignation. Attributed, because the answers are acted on individually.',
    trigger_type: 'manual', anonymity_default: false,
    questions: [
      c('What is the main reason you are leaving?',
        ['Compensation', 'Career growth', 'Manager', 'Work-life balance', 'Role content',
          'Team or culture', 'Location or commute', 'Personal reasons', 'Other']),
      m('Which of these also contributed?',
        ['Compensation', 'Career growth', 'Manager', 'Work-life balance', 'Role content',
          'Team or culture', 'Recognition', 'Workload', 'Lack of training', 'Job security']),
      s('I was clear about what was expected of me.'),
      s('I received the support I needed from my manager.'),
      s('I was fairly recognised for my contribution.'),
      s('I had opportunities to grow.'),
      { qtype: ENPS, prompt: 'How likely are you to recommend this organisation as a place to work?' },
      c('Would you consider returning in the future?', ['Yes', 'Maybe', 'No']),
      t('What could we have done to keep you?'),
    ],
  },
];

// Every template is checked at load, so a typo in this file fails the
// boot rather than reaching an employee. The rules are the importer's
// own: a choice needs options, a tenure trigger needs a day.
function validateTemplates(list = TEMPLATES) {
  const errors = [];
  const keys = new Set();
  for (const tpl of list) {
    const where = tpl.key || tpl.title || '(unnamed)';
    if (!tpl.key) errors.push(`${where}: no key`);
    if (keys.has(tpl.key)) errors.push(`${where}: duplicate key`);
    keys.add(tpl.key);
    if (!tpl.title) errors.push(`${where}: no title`);
    if (!tpl.category) errors.push(`${where}: no category`);
    if (!Array.isArray(tpl.questions) || !tpl.questions.length) errors.push(`${where}: no questions`);
    if (tpl.trigger_type === 'tenure' && tpl.trigger_day == null) errors.push(`${where}: a tenure trigger needs a day`);
    if (tpl.audience_kind && !['self', 'manager_about_reportee'].includes(tpl.audience_kind)) {
      errors.push(`${where}: unknown audience_kind ${tpl.audience_kind}`);
    }
    // A manager assessment names both people on every record, so
    // "anonymous" would be a lie on the form. The database refuses it
    // too; caught here so the boot fails with a sentence.
    if (tpl.audience_kind === 'manager_about_reportee' && tpl.anonymity_default !== false) {
      errors.push(`${where}: a manager assessment cannot be anonymous`);
    }
    if (tpl.trigger_type !== 'tenure' && tpl.trigger_day != null) errors.push(`${where}: trigger_day on a non-tenure template`);
    for (const q of tpl.questions || []) {
      if (!q.prompt) errors.push(`${where}: a question with no prompt`);
      if (q.qtype === CHOICE || q.qtype === MULTI) {
        const opts = Array.isArray(q.options) ? q.options.filter(Boolean) : [];
        if (opts.length < 2) errors.push(`${where}: "${String(q.prompt).slice(0, 40)}" is ${q.qtype} with ${opts.length} option(s)`);
        if (new Set(opts).size !== opts.length) errors.push(`${where}: "${String(q.prompt).slice(0, 40)}" has duplicate options`);
      }
    }
  }
  return errors;
}

module.exports = { TEMPLATES, validateTemplates, BLOCKERS, CAPABILITIES, BANDS };
