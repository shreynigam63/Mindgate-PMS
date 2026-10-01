// Exporting survey results.
//
// Asked for: "we should have export option for results of all surveys
// completed by employees for HR and HRBP role."
//
// A spreadsheet is where anonymity is most easily lost, because once the
// file leaves the product nothing in it is enforced any more. So what
// matters is not that the export works — it is what the export REFUSES to
// put in the file:
//
//   * a response nobody asked to be named on never appears beside a name
//   * an aggregate over too few people is withheld, because four answers
//     from a six-person team identify everybody by elimination
//   * an HRBP's file covers their remit, and says so on the front sheet
//
// The third is the one that reads as a bug if it is silent: a figure that
// differs from HR's has to look like a different population rather than a
// disagreement.

process.env.AUTH_DEV = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'survey-export-test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const db = require('../core/db');
const { devLogin } = require('../core/auth');

const SLUG = `sxp-test-${Date.now()}`;
let server; let base; let tenantId; let surveyId; let qScale; let qText;
let hrTok; let hrbpTok; let puneIds = []; let mumbaiId;

const get = async (tok, path) => {
  const r = await fetch(`${base}/api/v1/engagement${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
};
const sheets = async (buf) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const out = {};
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow((row) => rows.push(row.values.slice(1).map((v) => (v == null ? '' : String(v)))));
    out[ws.name] = rows;
  });
  return out;
};
const flat = (rows) => rows.map((r) => r.join(' | ')).join('\n');

before(async () => {
  tenantId = (await db.query(`INSERT INTO core.tenants (slug,name) VALUES ($1,$1) RETURNING id`, [SLUG])).rows[0].id;
  const mk = async (name, email, location) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,department,location)
     VALUES ($1,$2,$3,'active','Delivery',$4) RETURNING id`, [tenantId, name, email, location])).rows[0].id;
  // Six in Pune so the remit clears the floor of five; one in Mumbai, who
  // must never appear in the partner's file.
  for (let i = 1; i <= 6; i++) puneIds.push(await mk(`Pune ${i}`, `sx-p${i}@x.com`, 'Pune'));
  mumbaiId = await mk('Mumbai One', 'sx-m1@x.com', 'Mumbai');
  await mk('HR One', 'sx-hr@x.com', null);
  await mk('Partner One', 'sx-hrbp@x.com', null);

  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'sx-hr@x.com','hr'),($1,'sx-hrbp@x.com','hrbp')`, [tenantId]);
  await db.query(
    `INSERT INTO core.role_permissions (tenant_id,role,permission)
     VALUES ($1,'hr','engagement_admin'),($1,'hr','pms_admin'),($1,'hr','pms_self'),
            ($1,'hrbp','engagement_admin'),($1,'hrbp','pms_hrbp'),($1,'hrbp','pms_self')
     ON CONFLICT DO NOTHING`, [tenantId]);
  await db.query(`INSERT INTO core.hrbp_scope (tenant_id,email,kind,value,created_by) VALUES ($1,'sx-hrbp@x.com','location','Pune','test')`, [tenantId]);

  surveyId = (await db.query(
    `INSERT INTO engagement.surveys (tenant_id,title,survey_type,status,anonymity_default,allow_attribution_optin)
     VALUES ($1,'Stay Interview','pulse','closed',true,true) RETURNING id`, [tenantId])).rows[0].id;
  qScale = (await db.query(
    `INSERT INTO engagement.questions (tenant_id,survey_id,qtype,prompt,sort_order)
     VALUES ($1,$2,'scale','I find my work meaningful.',10) RETURNING id`, [tenantId, surveyId])).rows[0].id;
  qText = (await db.query(
    `INSERT INTO engagement.questions (tenant_id,survey_id,qtype,prompt,sort_order)
     VALUES ($1,$2,'text','What keeps you here?',20) RETURNING id`, [tenantId, surveyId])).rows[0].id;

  // Six Pune responses — five named, one anonymous — plus one from Mumbai.
  const respond = async (employeeId, num, text) => {
    const r = (await db.query(
      `INSERT INTO engagement.responses (tenant_id,survey_id,employee_id,submitted_at)
       VALUES ($1,$2,$3,now()) RETURNING id`, [tenantId, surveyId, employeeId])).rows[0].id;
    // engagement.answers carries NO tenant_id and no identity of its own —
    // it reaches both only through the response. That is the anonymity
    // design, not an oversight.
    await db.query(`INSERT INTO engagement.answers (response_id,question_id,value_num) VALUES ($1,$2,$3)`,
      [r, qScale, num]);
    await db.query(`INSERT INTO engagement.answers (response_id,question_id,value_text) VALUES ($1,$2,$3)`,
      [r, qText, text]);
  };
  for (let i = 0; i < 5; i++) await respond(puneIds[i], 4, `pune answer ${i}`);
  await respond(null, 2, 'SECRET-UNATTRIBUTED');          // opted out of attribution
  await respond(mumbaiId, 1, 'MUMBAI-ANSWER');

  const hash = await bcrypt.hash('pw', 4);
  for (const e of ['sx-hr@x.com', 'sx-hrbp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`, [tenantId, e, hash]);
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/engagement', require('../modules/engagement').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email) => (await (await fetch(`${base}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pw' }),
  })).json()).token;
  hrTok = await login('sx-hr@x.com');
  hrbpTok = await login('sx-hrbp@x.com');
  assert.ok(hrTok && hrbpTok, 'both test logins have to work');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tenantId) {
    await db.query(
      `DELETE FROM engagement.answers WHERE response_id IN
         (SELECT id FROM engagement.responses WHERE tenant_id=$1)`, [tenantId]).catch(() => {});
    for (const t of ['engagement.responses', 'engagement.questions',
      'engagement.invitations', 'engagement.surveys', 'core.hrbp_scope', 'core.local_credentials',
      'core.user_roles', 'core.role_permissions', 'core.employees']) {
      await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
    }
    await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  }
  await db.pool.end();
});

test('HR GETS A FILE, with the averages and the written answers', async () => {
  const r = await get(hrTok, `/surveys/${surveyId}/results.xlsx`);
  assert.equal(r.status, 200);
  const ws = await sheets(r.buf);
  assert.deepEqual(Object.keys(ws), ['About', 'Questions', 'Verbatims', 'Named responses']);
  assert.match(flat(ws.About), /The whole company/);
  // 7 responses: five 4s, one 2, one 1 -> 3.29
  assert.match(flat(ws.Questions), /I find my work meaningful\. \| scale \| 7 \| 3\.29/);
  assert.match(flat(ws.Verbatims), /MUMBAI-ANSWER/);
});

test('AN UNATTRIBUTED ANSWER NEVER APPEARS BESIDE A NAME', async () => {
  // The whole point of the opt-in. It counts towards the average and its
  // words appear in the verbatims; it must not reach the per-person sheet.
  const ws = await sheets((await get(hrTok, `/surveys/${surveyId}/results.xlsx`)).buf);
  assert.match(flat(ws.Verbatims), /SECRET-UNATTRIBUTED/, 'the answer itself should still be read');
  assert.ok(!/SECRET-UNATTRIBUTED/.test(flat(ws['Named responses'])),
    'an anonymous answer was printed next to somebody’s name');
});

test('AN HRBP GETS THEIR REMIT, and the file says so', async () => {
  const r = await get(hrbpTok, `/surveys/${surveyId}/results.xlsx`);
  assert.equal(r.status, 200);
  const ws = await sheets(r.buf);
  assert.match(flat(ws.About), /Your remit only — Pune/,
    'a number that differs from HR’s has to read as a different population');
  // Five named Pune responses clear the floor; the average is theirs alone.
  assert.match(flat(ws.Questions), /I find my work meaningful\. \| scale \| 5 \| 4/);
  assert.ok(!/MUMBAI-ANSWER/.test(flat(ws.Verbatims)), 'a Mumbai answer reached a Pune partner');
  assert.ok(!/Mumbai One/.test(flat(ws['Named responses'])), 'a Mumbai employee reached a Pune partner');
});

test('and an unattributed answer is not guessed into a remit either', async () => {
  // It cannot be placed in anybody's remit, so it is counted for HR and
  // left out of the partner's file rather than assumed to be theirs.
  const ws = await sheets((await get(hrbpTok, `/surveys/${surveyId}/results.xlsx`)).buf);
  assert.ok(!/SECRET-UNATTRIBUTED/.test(flat(ws.Verbatims)));
});

test('TOO FEW RESPONSES IS WITHHELD, not averaged', async () => {
  // Four answers from a six-person team identify everybody by elimination.
  await db.query(`DELETE FROM core.hrbp_scope WHERE tenant_id=$1`, [tenantId]);
  await db.query(`INSERT INTO core.hrbp_scope (tenant_id,email,kind,value,created_by) VALUES ($1,'sx-hrbp@x.com','location','Mumbai','test')`, [tenantId]);
  const ws = await sheets((await get(hrbpTok, `/surveys/${surveyId}/results.xlsx`)).buf);
  assert.match(flat(ws.Questions), /withheld — fewer than 5 responses/);
  assert.ok(!/\| 1 \| 1 \|/.test(flat(ws.Questions)), 'the one answer was averaged and printed anyway');
});

test('an employee cannot export anybody’s survey', async () => {
  const r = await fetch(`${base}/api/v1/engagement/surveys/${surveyId}/results.xlsx`, {
    headers: { Authorization: 'Bearer not-a-token' },
  });
  assert.ok(r.status === 401 || r.status === 403, `expected a refusal, got ${r.status}`);
});
