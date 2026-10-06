// The First-Week Journey — the client's "7 Days Onboarding Tracker"
// workbook, as tables.
//
// Asked for on 6 Oct with the workbook attached: "Onboarding tracker
// should be built as per information available in attached sheet … under
// hiring insights tab available in HRBP and HR tab."
//
// The workbook's sheets map one to one:
//   Activity Matrix -> people.onboarding_activities (48 rows, seeded)
//   Journey         -> people.onboarding_days       (the question each day answers)
//   Holidays        -> people.onboarding_holidays   (the three it shipped with)
//   Joiners         -> people.onboarding_joiners    (one per joiner, from the employee master)
//   Tracker         -> people.onboarding_tasks      (one per joiner per activity)
//   Feedback        -> people.onboarding_feedback + _feedback_questions
//   Dashboard       -> computed on read; nothing stored
//
// WHAT IS NOT STORED: planned dates, statuses and days overdue. The
// workbook computes them from the DOJ, the offset and the holiday list
// every time it recalculates, so a holiday added late moves every plan
// that crosses it. Storing them would freeze the first answer. See
// modules/people/onboarding-calendar.js.
//
// A JOINER IS AN EMPLOYEE. The workbook typed names in by hand; here a
// joiner row points at core.employees, so manager, department and
// designation come from the mirror instead of being retyped, and an
// HRBP's remit applies to a joiner exactly as it does to everyone else.
//
// Three things in the workbook were corrected rather than copied, and
// are written down where they were changed:
//   * The Day column is derived from the offset (see dayLabel) — the six
//     Readiness rows said "Day 1" while being planned before joining.
//   * The Tracker had 55 rows per joiner for 48 activities; the seven
//     extra were #N/A rows that counted towards "Total Activities", so a
//     joiner who had done everything showed 87% and "On track". Here a
//     tracker has exactly one task per activity.
//   * Owners are kept as written, plus the owner GROUPS each one belongs
//     to. The Ownership sheet counted "IT" as a substring, so every
//     Recruiter row was counted as IT's.

const ACTIVITIES = [
  // [code, theme, activity, owner, owner groups, process, expected outcome, offset, mandatory, ack]
  [1, "Readiness", "Intimation Mail", "Recruiter", ["HR"], "Send personalised welcome mail with joining date, reporting time, location, POC and Day-1 agenda", "Employee knows what to expect before joining", -2, true, false],
  [2, "Readiness", "Manager Intimation", "Recruiter", ["HR"], "Share new joiner details with reporting manager and confirm Day-1 plan", "Manager is prepared for the new employee", -2, true, false],
  [3, "Readiness", "Buddy Allocation", "HR Ops (on the recruiter’s mail)", ["HR"], "Assign a buddy and share buddy responsibilities", "Employee has a go-to person from Day 1", -2, true, false],
  [4, "Readiness", "IT Readiness", "HR Ops → IT", ["HR", "IT"], "Create email ID, system access, laptop/desktop and required applications", "Employee is technically ready", -2, true, false],
  [5, "Readiness", "Workstation Readiness", "HR Ops → Admin", ["HR", "Admin"], "Allocate workstation, ID card, access card and basic stationery", "Employee has a ready workplace", -2, true, false],
  [6, "Readiness", "Welcome Kit", "HR Ops", ["HR"], "Prepare welcome kit, employee handbook and relevant information", "Creates a positive first impression", -2, true, false],
  [7, "Welcome & Belonging", "HR Welcome", "HR Ops", ["HR"], "Personally welcome employee and explain the Day-1 schedule", "Employee feels welcomed and comfortable", 0, true, false],
  [8, "Welcome & Belonging", "Documentation", "HR Ops", ["HR"], "Complete joining forms, KYC, bank, PF/ESIC and other applicable documentation", "Joining formalities completed", 0, true, true],
  [9, "Welcome & Belonging", "Company Introduction", "HR Ops", ["HR"], "Explain company history, business, structure, values and culture", "Employee understands the organisation", 0, true, false],
  [10, "Welcome & Belonging", "Workplace Tour", "Admin", ["Admin"], "Show workstation, cafeteria, meeting rooms, washrooms, emergency exits and other facilities", "Employee becomes comfortable with workplace", 0, true, false],
  [11, "Welcome & Belonging", "IT Setup", "IT", ["IT"], "Complete login, email, VPN, applications and access verification", "Employee can access required systems", 0, true, false],
  [12, "Welcome & Belonging", "Team Introduction", "Manager", ["Manager"], "Introduce employee to team and explain team structure", "Employee knows immediate team", 0, true, false],
  [13, "Welcome & Belonging", "Manager Connect", "Manager", ["Manager"], "Explain role, immediate priorities and expectations", "Initial role clarity established", 0, true, false],
  [14, "Welcome & Belonging", "Buddy Introduction", "Buddy", ["Buddy"], "Explain buddy role and provide informal support", "Employee knows whom to approach for day-to-day queries", 0, true, false],
  [15, "Welcome & Belonging", "Lunch/Informal Connect", "Recruiter", ["HR"], "Arrange lunch or informal interaction with team", "Social integration begins", 0, false, false],
  [16, "Welcome & Belonging", "End-of-Day Check-in", "HR", ["HR"], "Ask about experience, access issues and concerns", "Day-1 issues identified immediately", 0, true, false],
  [17, "Organisation & Culture", "Business Overview", "HRBP", ["HR"], "Explain products/services, customers, business model and key functions", "Employee understands business context", 1, true, false],
  [18, "Organisation & Culture", "Organisation Structure", "HRBP", ["HR"], "Explain leadership structure and major functions", "Employee understands organisational ecosystem", 1, true, false],
  [19, "Organisation & Culture", "HRMS walk through/ Policies", "HR Ops", ["HR"], "Explain attendance, leave, WFH/hybrid, working hours, payroll and reimbursement", "Employee understands key employment processes", 1, true, true],
  [20, "Organisation & Culture", "Employee Benefits", "HRBP", ["HR"], "Explain insurance, PF, gratuity, leave benefits and applicable employee benefits", "Employee understands benefits", 1, true, false],
  [21, "Organisation & Culture", "Code of Conduct", "HR", ["HR"], "Explain professional conduct, confidentiality, POSH, information security and ethics", "Employee understands behavioural expectations", 1, true, true],
  [22, "Role & Expectations", "Role Orientation", "Manager", ["Manager"], "Explain purpose of role and how it contributes to team/business objectives", "Employee understands why the role exists", 2, true, false],
  [23, "Role & Expectations", "JD Walkthrough", "Manager", ["Manager"], "Discuss each major responsibility in the JD with practical examples", "Responsibilities become clear", 2, true, false],
  [24, "Role & Expectations", "KPI/KRA Discussion", "Manager", ["Manager"], "Explain performance metrics, KRAs, KPIs and expected outcomes", "Employee understands success measures", 2, true, false],
  [25, "Role & Expectations", "Stakeholder Mapping", "Manager", ["Manager"], "Identify internal/external stakeholders and explain interaction model", "Employee knows whom they will work with", 2, true, false],
  [26, "Role & Expectations", "30-Day Expectations", "Manager", ["Manager"], "Define initial learning and delivery expectations", "Clear short-term objectives established", 2, true, false],
  [27, "Role & Expectations", "Key Process Introduction", "Manager/SME", ["Manager", "SME"], "Explain critical processes relevant to the employee’s role", "Employee understands basic workflow", 2, true, false],
  [28, "Role & Expectations", "Questions & Clarification", "Manager", ["Manager"], "Invite employee to identify gaps or ambiguity", "Misunderstanding is addressed early", 2, true, false],
  [29, "Systems & Processes", "System Training", "IT/Manager", ["IT", "Manager"], "Demonstrate applications and systems required for the role", "Employee understands tools", 3, true, false],
  [30, "Systems & Processes", "Process Demonstration", "Manager/SME", ["Manager", "SME"], "Demonstrate an actual end-to-end process", "Employee understands how work gets done", 3, true, false],
  [31, "Systems & Processes", "Workflow Explanation", "Manager", ["Manager"], "Explain request → assignment → execution → review → approval → closure", "Employee understands workflow", 3, true, false],
  [32, "Systems & Processes", "Sample Task", "Manager/Buddy", ["Manager", "Buddy"], "Give employee a simple practical task", "Employee applies learning", 3, true, false],
  [33, "Systems & Processes", "Access Validation", "IT", ["IT"], "Verify all required systems and permissions", "No access dependency remains", 3, true, false],
  [34, "Systems & Processes", "Documentation Standards", "Manager", ["Manager"], "Explain file naming, documentation, reporting and communication standards", "Employee follows team standards", 3, true, false],
  [35, "People & Culture", "Team Connect", "Manager", ["Manager"], "Conduct informal team interaction", "Employee builds relationships", 4, true, false],
  [36, "People & Culture", "Stakeholder Connect", "Manager", ["Manager"], "Arrange short introductions with key stakeholders", "Employee understands stakeholder ecosystem", 4, true, false],
  [37, "People & Culture", "Buddy Connect", "Buddy", ["Buddy"], "Discuss informal culture, team practices and practical workplace tips", "Employee becomes culturally comfortable", 4, true, false],
  [38, "People & Culture", "Employee Engagement", "HR", ["HR"], "Introduce R&R, celebrations, CSR, sports, committees and engagement initiatives", "Employee knows opportunities beyond core work", 4, true, false],
  [39, "Performance & Development", "PMS Orientation", "HRBP", ["HR"], "Explain goal setting, check-ins, feedback, review and rating process", "Employee understands performance cycle", 5, true, false],
  [40, "Performance & Development", "Performance Expectations", "HRBP", ["HR"], "Explain quality, productivity, timelines and behavioural expectations", "Performance standards become clear", 5, true, false],
  [41, "Performance & Development", "Learning Needs", "L&D", ["L&D"], "Identify technical, functional and behavioural training requirements", "Individual learning plan identified", 5, true, false],
  [42, "Performance & Development", "Career & Growth", "Manager", ["Manager"], "Explain possible growth paths and development opportunities", "Employee understands development opportunities", 5, true, false],
  [43, "Performance & Development", "First Assignment Review", "Manager", ["Manager"], "Review employee’s initial task/learning progress", "Manager identifies support required", 5, true, false],
  [44, "Feedback & Alignment", "HR 7-Day Connect", "HR (system-generated mail)", ["HR"], "Conduct structured one-on-one discussion based on the survey report", "Employee experience assessed", 6, true, false],
  [45, "Feedback & Alignment", "Manager Check-in", "Manager", ["Manager"], "Review role understanding and initial progress", "Alignment confirmed", 6, true, false],
  [46, "Feedback & Alignment", "Onboarding Feedback", "HR (system-generated mail)", ["HR"], "Collect structured feedback using 1–5 rating", "Onboarding quality becomes measurable", 6, true, false],
  [47, "Feedback & Alignment", "Access/Process Closure", "HR/IT/Manager", ["HR", "IT", "Manager"], "Check whether any access, documentation or process issue remains open", "First-week issues closed", 6, true, false],
  [48, "Feedback & Alignment", "30-Day Plan", "Manager", ["Manager"], "Confirm learning and delivery priorities for next 30 days", "Employee has clear next steps", 6, true, false],
];
const QUESTIONS = [
  ["Q1", "My joining formalities and Day-1 welcome were smooth"],
  ["Q2", "My laptop, email and system access were ready when I needed them"],
  ["Q3", "I clearly understand my role, KRAs and 30-day expectations"],
  ["Q4", "My manager gave me enough time and guidance"],
  ["Q5", "My buddy was available and helpful"],
  ["Q6", "I know whom to contact for HR, IT, Admin and payroll queries"],
  ["Q7", "Overall, this week prepared me well for my role"],
];
const HOLIDAYS = [
  ["2026-10-02", "Gandhi Jayanti"],
  ["2026-12-25", "Christmas"],
  ["2027-01-26", "Republic Day"],
];

const DAYS = [
  ['Pre-Day 1', 'Readiness', 'Is everything ready before I arrive?', 'Systems, workplace and people ready'],
  ['Day 1', 'Welcome & Belonging', 'Am I welcome here?', 'Welcome & Belonging'],
  ['Day 2', 'Organisation & Culture', 'What is this organisation about?', 'Organisation & Culture'],
  ['Day 3', 'Role & Expectations', 'What exactly am I supposed to do?', 'Role & Expectations'],
  ['Day 4', 'Systems & Processes', 'How do I actually do my work?', 'Systems & Processes'],
  ['Day 5', 'People & Culture', 'Who are the people I work with?', 'People & Culture'],
  ['Day 6', 'Performance & Development', 'How will I succeed and grow?', 'Performance & Development'],
  ['Day 7', 'Feedback & Alignment', 'Am I on the right track?', 'Feedback & Alignment'],
];

// Called at boot as well as here — a migration cannot seed a tenant that
// is created after it runs (the core.tenants trap; see 069). ON CONFLICT
// DO NOTHING, so a matrix HR has edited is never put back.
async function seedFor(db, tenantId) {
  for (const [code, theme, activity, owner, groups, process, outcome, offset, mandatory, ack] of ACTIVITIES) {
    await db.query(
      `INSERT INTO people.onboarding_activities
         (tenant_id, code, theme, activity, owner, owner_groups, process, outcome, day_offset, mandatory, ack_required, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$2)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenantId, code, theme, activity, owner, groups, process, outcome, offset, mandatory, ack]);
  }
  for (const [i, [day, theme, question, answer]] of DAYS.entries()) {
    await db.query(
      `INSERT INTO people.onboarding_days (tenant_id, day_label, theme, question, answer, sort)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, day_label) DO NOTHING`,
      [tenantId, day, theme, question, answer, i]);
  }
  for (const [i, [code, statement]] of QUESTIONS.entries()) {
    await db.query(
      `INSERT INTO people.onboarding_feedback_questions (tenant_id, code, statement, sort)
       VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenantId, code, statement, i]);
  }
  for (const [d, name] of HOLIDAYS) {
    await db.query(
      `INSERT INTO people.onboarding_holidays (tenant_id, holiday_date, name)
       VALUES ($1,$2,$3) ON CONFLICT (tenant_id, holiday_date) DO NOTHING`,
      [tenantId, d, name]);
  }
}

async function up(db) {
  await db.query(`CREATE SCHEMA IF NOT EXISTS people`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.onboarding_activities (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES core.tenants(id),
    code         integer NOT NULL,
    theme        text NOT NULL,
    activity     text NOT NULL,
    owner        text NOT NULL,
    owner_groups text[] NOT NULL DEFAULT '{}',
    process      text,
    outcome      text,
    day_offset   integer NOT NULL CHECK (day_offset BETWEEN -10 AND 6),
    mandatory    boolean NOT NULL DEFAULT true,
    ack_required boolean NOT NULL DEFAULT false,
    active       boolean NOT NULL DEFAULT true,
    sort         integer NOT NULL DEFAULT 0,
    UNIQUE (tenant_id, code)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.onboarding_days (
    tenant_id uuid NOT NULL REFERENCES core.tenants(id),
    day_label text NOT NULL,
    theme     text NOT NULL,
    question  text NOT NULL,
    answer    text,
    sort      integer NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, day_label)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.onboarding_holidays (
    tenant_id    uuid NOT NULL REFERENCES core.tenants(id),
    holiday_date date NOT NULL,
    name         text NOT NULL,
    PRIMARY KEY (tenant_id, holiday_date)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.onboarding_joiners (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES core.tenants(id),
    employee_id uuid NOT NULL REFERENCES core.employees(id),
    doj         date NOT NULL,
    buddy_id    uuid REFERENCES core.employees(id),
    hr_poc_id   uuid REFERENCES core.employees(id),
    started_by  text NOT NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, employee_id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.onboarding_tasks (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES core.tenants(id),
    joiner_id     uuid NOT NULL REFERENCES people.onboarding_joiners(id) ON DELETE CASCADE,
    activity_id   uuid NOT NULL REFERENCES people.onboarding_activities(id),
    completed_on  date,
    ack_received  boolean,
    remarks       text,
    issue         text,
    action_owner  text,
    closure_date  date,
    updated_by    text,
    updated_at    timestamptz,
    UNIQUE (joiner_id, activity_id)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_onb_tasks_tenant ON people.onboarding_tasks(tenant_id, joiner_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.onboarding_feedback_questions (
    tenant_id uuid NOT NULL REFERENCES core.tenants(id),
    code      text NOT NULL,
    statement text NOT NULL,
    sort      integer NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, code)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.onboarding_feedback (
    tenant_id     uuid NOT NULL REFERENCES core.tenants(id),
    joiner_id     uuid PRIMARY KEY REFERENCES people.onboarding_joiners(id) ON DELETE CASCADE,
    feedback_date date NOT NULL,
    ratings       jsonb NOT NULL,
    worked_best   text,
    improve       text,
    open_issue    text,
    recorded_by   text NOT NULL,
    recorded_at   timestamptz NOT NULL DEFAULT now()
  )`);
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) await seedFor(db, id);
}

module.exports = { up, seedFor, ACTIVITIES, DAYS, QUESTIONS, HOLIDAYS };
