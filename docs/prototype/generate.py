#!/usr/bin/env python3
"""Generate the clickable PMS UI prototype.

VISUAL ONLY. Nothing here touches frontend/src — it is a standalone HTML
file for reviewing the proposed shell before any real code changes.

Screens are written as functions so the file stays editable; the router is
plain JS swapping one <section> for another. Colours are the PRODUCT's own
tokens (frontend/tailwind.config.js), not new ones, so what you see is
achievable with the classes the app already has.
"""
import base64, glob, os

ROOT = '/home/user/Mindgate-PMS'
OUT = f'{ROOT}/docs/prototype/pms-ui-prototype.html'

def faces():
    out = []
    for w in (400, 500, 600, 700, 800):
        hits = sorted(glob.glob(f'{ROOT}/frontend/dist/assets/inter-latin-{w}-normal-*.woff2'))
        if not hits: continue
        b64 = base64.b64encode(open(hits[0], 'rb').read()).decode()
        out.append("@font-face{font-family:'Inter';font-style:normal;font-weight:%d;"
                   "font-display:swap;src:url(data:font/woff2;base64,%s) format('woff2');}" % (w, b64))
    return '\n'.join(out)

# ---------------------------------------------------------------- shared bits
def card(title, body, accent='teal', badge=None, sub=None):
    b = f'<div class="badge b-{accent}">{badge}</div>' if badge else ''
    s = f'<p class="muted">{sub}</p>' if sub else ''
    return f'<div class="card t-{accent}"><div class="cb">{b}<div class="h2">{title}</div>{s}{body}</div></div>'

def tiles(items):
    t = ''.join(f'<div class="tile"><div class="tb b-{c}">{l}</div>'
                f'<div><div class="tn">{n}</div><div class="tl">{lab}</div></div></div>'
                for l, n, lab, c in items)
    return f'<div class="tiles">{t}</div>'

def tabs(items, active=0):
    return '<div class="tabs">' + ''.join(
        f'<button class="tab{" on" if i==active else ""}">{t}<span class="c">{c}</span></button>'
        for i, (t, c) in enumerate(items)) + '</div>'

def table(cols, rows):
    head = ''.join(f'<th>{c}</th>' for c in cols)
    body = ''.join('<tr>' + ''.join(f'<td>{c}</td>' for c in r) + '</tr>' for r in rows)
    return f'<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>'

def pill(text, kind): return f'<span class="pill p-{kind}">{text}</span>'
def btn(text, kind='gh'): return f'<button class="bt bt-{kind}">{text}</button>'
def emp(name, desig): return f'<div class="nm">{name}</div><div class="dg">{desig}</div>'
def search(ph): return f'<div class="srch"><span>&#128269;</span><input placeholder="{ph}" readonly></div>'
def note(text, kind='amber'): return f'<div class="note n-{kind}">{text}</div>'
def head(title, tag=None, sub=None, actions=''):
    t = f' <span class="tag">{tag}</span>' if tag else ''
    s = f'<p class="sub">{sub}</p>' if sub else ''
    a = f'<div class="hact">{actions}</div>' if actions else ''
    return f'<div class="phead"><div><h1>{title}{t}</h1>{s}</div>{a}</div>'

def steps(active):
    names = [('KRA Setting','Apr 2026'),('Quarterly Connects','Jul · Oct'),
             ('Mid-Year Review','Oct 2026'),('Annual Review','Mar 2027'),('Final Rating','Apr 2027')]
    out = []
    for i,(n,when) in enumerate(names):
        if i:
            out.append(f'<div class="sline{" done" if i<=active else ""}"></div>')
        if i < active:   circ, st = '<div class="sc done">&#10003;</div>', 'Completed'
        elif i == active: circ, st = f'<div class="sc now">{i+1}</div>', 'In progress'
        else:            circ, st = f'<div class="sc todo">{i+1}</div>', 'Upcoming'
        out.append(f'<div class="step">{circ}<div class="sname">{n}</div><div class="sst">{st} · {when}</div></div>')
    return '<div class="card steps">' + ''.join(out) + '</div>'

# ============================================================ SELF screens ===
def s_mykras():
    kras = [('New Business Acquisition','New logos closed, funnel conversion','25'),
            ('Customer Relationship','CSAT, renewal rate, escalations closed','20'),
            ('POCs','POCs delivered, conversion to funded','20'),
            ('Data Center & Infra SLA','Uptime, incident MTTR','20'),
            ('Team Capability','Certifications, bench readiness','15')]
    rows = ''.join(f'<div class="kra"><div class="kt">{t}<span class="kw">{w}%</span></div>'
                   f'<div class="km">Measures: {m}</div></div>' for t,m,w in kras)
    return (head('My KRAs','FY 2026-27 · KRA Setting',
                 'Your weighted objectives for the cycle — draft, then submit to your manager.')
        + steps(0)
        + '<div class="two">'
        + card('My KRA Sheet ' + pill('draft','wait'), rows +
               f'<div class="wt">Total weight <b>100%</b> · 5 KRAs</div>'
               f'<div class="row">{btn("+ Choose from library")}{btn("Save","teal")}{btn("Submit to manager &rarr;","pink")}</div>',
               'teal','K','Weighted key result areas for this cycle.')
        + card('From the library',
               note('Shelf matched on <b>Sales Manager</b> in <b>Sales</b>. 6 KRAs available, 5 already added.','teal')
               + '<div class="libr"><label><input type="checkbox" checked disabled> New Business Acquisition <i>25%</i></label>'
               '<label><input type="checkbox" checked disabled> Customer Relationship <i>20%</i></label>'
               '<label><input type="checkbox"> Channel Partner Enablement <i>10%</i></label></div>'
               + f'<div class="row">{btn("Select all")}{btn("Add selected","teal")}</div>',
               'navy','L','Published by HR for your department and designation.')
        + '</div>')

def s_growth():
    return (head('My Growth', None, 'Development plan and career path — related to your KRAs, tracked separately from your rating.')
        + '<div class="two">'
        + card('Development Plan &middot; Org IDP',
               '<p class="cur"><b>Current designation</b> &middot; Sales Manager, Sales</p>'
               + ''.join(f'<div class="prog"><span>{n}</span><div class="bar"><i style="width:{p}%;background:{c}"></i></div><b>{p}%</b></div>'
                         for n,p,c in [('Cloud Architecture Certification',70,'var(--lagoon)'),
                                       ('Stakeholder Negotiation Workshop',40,'var(--amber)'),
                                       ('Client Presentation Skills',100,'var(--leaf)')])
               + f'<div class="row">{btn("Open Development Plan &rarr;","teal")}{btn("&#10022; Suggest goals")}</div>',
               'teal','D','Short-term skills being built this year, defined by you and approved by your manager.')
        + card('Career Path',
               ''.join(f'<div class="ladder"><span class="ln">{i}</span><div><b>{r}</b>{cur}<div class="dg">{w}</div></div></div>'
                       for i,(r,cur,w) in enumerate([('Sales Manager',' <em>(Current)</em>','Since Jan 2024'),
                                                     ('Senior Sales Manager','','Target: 12–18 months'),
                                                     ('Regional Sales Head','','Target: 2–3 years')],1))
               + f'<div class="row">{btn("View full progression &rarr;","pink")}</div>',
               'pink','C','Where you&rsquo;re headed next — 1 to 3 years out, within your defined growth guardrails.')
        + '</div>')

def s_connects():
    return (head('Quarterly Connect &middot; 1-on-1 Log', None,
                 'Continuous feedback captured through the cycle, auto-mapped to KRAs.',
                 btn('+ Log a connect','pink'))
        + tiles([('Q','Quarterly','Cadence &middot; every 90 days','lagoon'),
                 ('1','1 of 1','Progress this cycle','leaf'),
                 ('D','28 Sep','Next due','amber')])
        + '<div class="card"><div class="cb">'
        + '<div class="cmeta">19 Aug 2026 &middot; 30 min &middot; Logged by Suraj Khairnar</div>'
        + '<div class="h2" style="margin-top:4px">Quarterly review</div>'
        + '<p class="muted">Discussed ABC General Insurance migration progress and funding status; XYZ Bank POC funding received.</p>'
        + '<div class="three">'
        + '<div class="fb f-green"><b>Achievements</b><p>Received POC funding of &#8377;10L; procured a firewall from OEM.</p></div>'
        + '<div class="fb f-amber"><b>Blockers</b><p>Relationship with AWS stakeholders needs strengthening.</p></div>'
        + '<div class="fb f-blue"><b>Feedback</b><p>Requested RM support to improve AWS relationship and fast-track funding.</p></div>'
        + '</div>'
        + '<div class="ai"><span class="aitag">AI INSIGHTS</span> <span class="pill p-wait">Needs attention</span>'
        + '<p class="aiq">&ldquo;POC funding secured, but the AWS relationship blocker risks slowing the migration timeline.&rdquo;</p>'
        + '<div class="two2"><div><b>Themes</b><ul><li>AWS stakeholder friction</li><li>Migration funding acceleration</li><li>POC funding secured</li></ul></div>'
        + '<div><b>Suggested follow-ups</b><ul><li>RM to mediate AWS relationship</li><li>Fast-track funding approval</li><li>Schedule migration timeline check-in</li></ul></div></div></div>'
        + '<div class="foot"><span class="dg">Linked KRAs:</span> '
        + ' '.join(pill(k,'none') for k in ['New Business Acquisition','Customer Relationship','POCs'])
        + f'<span class="right">{pill("&#10003; Confirmed by manager","ok")}</span></div>'
        + '</div></div>')

def s_midyear():
    return (head('Mid-Year Review &middot; H1 FY 2026-27','In progress',
                 'Halfway checkpoint against your KRAs and the development plan.')
        + note('<b>For reference only.</b> The mid-year reading supports the conversation — it does <b>not</b> count toward your final rating.')
        + '<div class="signoff"><div><span class="dg">EMPLOYEE (YOU)</span><b>In progress &middot; 2.6</b></div>'
          '<span class="so">SIGN-OFF</span><div class="right"><span class="dg">MANAGER</span><b>Not shared until published</b></div></div>'
        + '<div class="two">'
        + card('Employee narrative',
               '<div class="rate"><span class="rl">Self-rating</span>'
               + ''.join(f'<div class="rb{" on" if r=="A+" else ""}">{r}</div>' for r in ['A+','A','B+','B','C'])
               + '</div><div class="ta">Reflect on progress this half — highlights, challenges, focus for next half.</div>'
               + f'<div class="row">{btn("&#10022; AI draft")}{btn("Save")}{btn("Save &amp; sign","teal")}</div>',
               'teal','E','Your halfway reading against each KRA.')
        + card('Manager narrative',
               note('<b>Not shared yet.</b> Your manager&rsquo;s mid-year rating and comments appear here once HR publishes the cycle.','navy')
               + '<p class="cur">Manager status &middot; <b class="am">Pending</b></p>','navy','M',
               'Withheld until publish — you still see whether they have completed theirs.')
        + '</div>')

def s_annual():
    return (head('Annual Review','FY 2026-27','Your self-appraisal against each KRA. Submitted to your manager for evaluation.')
        + note('Only <b>your own</b> rating is visible before HR publishes the cycle.','navy')
        + '<div class="card"><div class="cb">'
        + table(['KRA','Weight','Your rating','Your evidence'],
                [['New Business Acquisition','25%','<b>A</b>','3 new logos, 118% of target'],
                 ['Customer Relationship','20%','<b>A+</b>','CSAT 4.7, zero escalations'],
                 ['POCs','20%','<b>B+</b>','4 of 5 POCs converted']])
        + f'<div class="row">{btn("&#10022; AI draft")}{btn("Save")}{btn("Submit to manager &rarr;","pink")}</div>'
        + '</div></div>')

def s_final():
    return (head('Final Rating','FY 2026-27','Consolidated ratings across every review layer.')
        + note('Published on 12 Apr 2027 by HR. All layers are now visible.','leaf')
        + '<div class="card"><div class="cb">'
        + table(['Layer','Rating','By','When'],
                [['Self-appraisal','A','You','14 Mar 2027'],
                 ['Manager evaluation','A','Nida Vajid Momin','22 Mar 2027'],
                 ['Delivery Head review','A','Rajiv Nair','29 Mar 2027'],
                 ['Calibration adjustment','&mdash;','&mdash;','&mdash;'],
                 ['<b>Final rating</b>','<b>A</b>','<b>Published</b>','<b>12 Apr 2027</b>']])
        + '</div></div>')

def s_myrating():
    return (head('My Rating', None, 'Your published rating and how it was reached.')
        + tiles([('A','A','Final rating','leaf'),('P','High','Potential','lagoon'),
                 ('N','2A','9-Box cell','navy'),('I','8%','Indicative increment','amber')])
        + card('Rating history', table(['Cycle','Final rating','Increment'],
               [['FY 2026-27','A','8%'],['FY 2025-26','B+','6%'],['FY 2024-25','A','9%']]),
               'navy','H','Your published cycles.'))

# ========================================================== MANAGER screens ===
def s_teamover():
    return (head('Team Overview','Manager view','Where each of your reports stands across the whole cycle.')
        + tiles([('T','8','My reports','navy'),('S','4','Awaiting me','amber'),
                 ('A','3','Approved','leaf'),('N','1','Not started','lagoon')])
        + search('Search your team by name, code or department…')
        + '<div class="card" style="margin-top:12px"><div class="cb0">'
        + table(['Employee','KRAs','Growth plan','Mid-Year','Annual','Connects'],
            [[emp('Suraj Khairnar','Sales Manager'), pill('Submitted','wait'), pill('Approved','ok'), pill('In progress','wait'), pill('Not started','none'),'1 of 1'],
             [emp('Abhedya Tembe','Cloud Engineer'), pill('Submitted','wait'), pill('Draft','none'), pill('Not started','none'), pill('Not started','none'),'0 of 1'],
             [emp('Manoj Surwade','Office Assistant'), pill('Approved','ok'), pill('Approved','ok'), pill('Signed','ok'), pill('Not started','none'),'1 of 1'],
             [emp('Priya Nair','Sales Executive'), pill('Not started','none'), pill('Not started','none'), pill('Not started','none'), pill('Not started','none'),'0 of 1']])
        + '</div></div>')

def s_teamkras():
    act = btn('Approve','teal') + ' ' + btn('Return')
    return (head('Team KRA Sheets','Manager view','Approve or return your reports&rsquo; KRA sheets.')
        + tiles([('D','3','Draft','navy'),('S','4','Submitted','amber'),('R','0','Returned','pink'),
                 ('A','3','Approved','leaf'),('N','1','Not started','lagoon')])
        + tabs([('Pending approval','4'),('Approved','3'),('Returned','0'),('All','11')])
        + search('Search by name, code, email, manager or department…')
        + '<div class="card" style="margin-top:12px"><div class="cb0">'
        + table(['Employee','Department','KRAs','Weight','Status','Action'],
            [[emp('Suraj Khairnar','Sales Manager'),'Sales','6','100%',pill('Submitted','wait'),act],
             [emp('Abhedya Tembe','Cloud Engineer'),'Cloud','5','100%',pill('Submitted','wait'),act],
             [emp('Rekha Joshi','Presales Lead'),'Presales','6','105%',pill('Submitted','wait'),
              f'<span class="warn">Weights &ne; 100</span> {btn("Return","pink")}'],
             [emp('Manoj Surwade','Office Assistant'),'Admin','4','100%',pill('Approved','ok'),btn('View')]])
        + '</div></div>'
        + note('<b>Approve</b> accepts the sheet as submitted. <b>Return</b> needs a comment — the employee must know why.','navy'))

def s_teameval():
    return (head('Team Evaluation','Manager evaluation phase','Score the 7 organisational parameters. The overall rating is computed, not typed.')
        + tabs([('Pending','5'),('Submitted','3'),('All','8')])
        + '<div class="two">'
        + card('Suraj Khairnar &middot; Sales Manager',
               ''.join(f'<div class="prm"><span>{n}</span><div class="rate">'
                       + ''.join(f'<div class="rb{" on" if r==sel else ""}">{r}</div>' for r in ['1','2','3','4','5'])
                       + '</div></div>' for n,sel in [('Delivery & Quality','4'),('Ownership','4'),
                         ('Collaboration','5'),('Customer Focus','4'),('Innovation','3'),
                         ('People Development','4'),('Values & Conduct','5')])
               + '<div class="calc">Computed overall <b>4.1</b> &rarr; <b>A</b></div>'
               + '<div class="prm pot"><span><b>Potential rating</b><i>New — asked for in item 30</i></span><div class="rate">'
               + ''.join(f'<div class="rb{" on" if r=="High" else ""}">{r}</div>' for r in ['Low','Medium','High'])
               + '</div></div>'
               + f'<div class="row">{btn("&#10022; AI draft")}{btn("Save")}{btn("Submit evaluation &rarr;","pink")}</div>',
               'navy','E','7-parameter scoring for an annual cycle.')
        + card('Their self-appraisal',
               table(['KRA','Weight','Self'],
                 [['New Business Acquisition','25%','A'],['Customer Relationship','20%','A+'],['POCs','20%','B+']])
               + '<p class="muted">Submitted 14 Mar 2027. Read-only.</p>','teal','S','What the employee said, beside your scoring.')
        + '</div>')

def s_hod():
    return (head('Delivery Head Review','HOD view','Manager ratings for your departments, with your override.')
        + tiles([('Q','12','In your queue','amber'),('R','7','Reviewed','leaf'),('C','2','Changed','pink')])
        + search('Search within your departments…')
        + '<div class="card" style="margin-top:12px"><div class="cb0">'
        + table(['Employee','Department','Manager','Manager rating','Your rating','Action'],
            [[emp('Suraj Khairnar','Sales Manager'),'Sales','Nida Vajid Momin','A','<b>A</b>',btn('Confirm','teal')],
             [emp('Abhedya Tembe','Cloud Engineer'),'Cloud','Rajiv Nair','B+','<b class="pk">A</b>',btn('Changed','pink')],
             [emp('Rekha Joshi','Presales Lead'),'Presales','Amit Shah','A','&mdash;',btn('Review')]])
        + '</div></div>'
        + note('A change here is recorded against the manager&rsquo;s original — the employee sees neither until HR publishes.','navy'))

def s_pip():
    return (head('Improvement Plans', None, 'Employees on a formal improvement plan this cycle.')
        + tiles([('O','2','Open','amber'),('C','1','Closed','leaf'),('D','0','Overdue','pink')])
        + '<div class="card"><div class="cb0">'
        + table(['Employee','Opened','Review date','Owner','Status'],
            [[emp('Vikas Patil','Support Engineer'),'02 May 2026','30 Sep 2026','Rajiv Nair',pill('Open','wait')],
             [emp('Neha Kulkarni','Analyst'),'11 Jun 2026','15 Oct 2026','Amit Shah',pill('Open','wait')]])
        + '</div></div>')

# =============================================================== HR screens ===
def s_dash():
    return (head('PMS Dashboard','FY 2026-27 &middot; KRA Setting','Completion and pending work across all 1,398 active employees.')
        + steps(0)
        + tiles([('E','1,398','Active employees','navy'),('K','924','KRAs submitted','lagoon'),
                 ('A','611','KRAs approved','leaf'),('P','474','Not started','amber'),('R','0','Published','pink')])
        + '<div class="two">'
        + card('Completion by stage',
               ''.join(f'<div class="prog"><span>{n}</span><div class="bar"><i style="width:{p}%;background:{c}"></i></div><b>{p}%</b></div>'
                 for n,p,c in [('KRA Setting',66,'var(--lagoon)'),('Quarterly Connects',41,'var(--amber)'),
                               ('Mid-Year Review',0,'var(--navy300)'),('Annual Review',0,'var(--navy300)'),
                               ('Final Rating',0,'var(--navy300)')]),'lagoon','C','Where the company is in the cycle.')
        + card('Needs attention',
               '<div class="att"><b>61</b> employees have no reporting manager <span class="dg">— their KRAs cannot be approved</span></div>'
               '<div class="att"><b>16</b> employees whose designation has no library shelf</div>'
               '<div class="att"><b>1</b> shelf whose weights total 105% <span class="dg">— Senior Software Engineer</span></div>'
               '<div class="att"><b>0</b> users hold the HR role <span class="dg">— only one account can publish</span></div>',
               'pink','!','Blocking issues, counted from live data.')
        + '</div>')

def s_kraover():
    return (head('Org-wide KRA Overview','HR','Every KRA sheet for FY 2026-27 &middot; 1,398 active employees.',
                 btn('Bulk upload','teal') + ' ' + btn('Download template'))
        + tiles([('D','3','Draft','navy'),('S','4','Submitted','amber'),('R','0','Returned','pink'),
                 ('A','1','Approved','leaf'),('N','474','Not started','lagoon')])
        + tabs([('All','482'),('Pending','4'),('Approved','1'),('Not started','474')])
        + search('Search by name, code, email, manager or department…')
        + '<div class="card" style="margin-top:12px"><div class="cb0">'
        + table(['Employee','Department','Manager','KRAs','Weight','Status','Action'],
            [[emp('Hemprakash Karotiya','Office Assistant'),'Admin','Priyanka Shinde','0','0%',pill('Not started','none'),btn('Enter on behalf','teal')],
             [emp('Manoj Surwade','Office Assistant'),'Admin','Imtiyaz Mulla','0','0%',pill('Not started','none'),btn('Enter on behalf','teal')],
             [emp('Abhedya Tembe','Cloud Engineer'),'Cloud','Rajiv Nair','0','0%',pill('Not started','none'),btn('Enter on behalf','teal')],
             [emp('Suraj Khairnar','Sales Manager'),'Sales','Nida Vajid Momin','6','100%',pill('Approved','ok'),btn('View')]])
        + '</div></div>')

def s_library():
    return (head('KRA Library','HR','Published shelves per department and designation — employees pick from these.',
                 btn('Upload library','teal') + ' ' + btn('Download template'))
        + tiles([('R','2,155','Library rows','navy'),('D','267','Designations','lagoon'),
                 ('P','0','With a department','pink'),('W','1','Weights &ne; 100%','amber')])
        + note('<b>0 of 2,155 rows carry a Department.</b> Department matching is switched on, so every shelf currently falls back to designation only. Re-upload with the Department column to activate it.','amber')
        + search('Search the library by designation, department or KRA title…')
        + '<div class="card" style="margin-top:12px"><div class="cb0">'
        + table(['Designation','Department','KRA','Weight','Actions'],
            [['Sales Manager','<span class="dg">— none —</span>','New Business Acquisition','25%',btn('Edit')+' '+btn('Delete','pink')],
             ['Sales Manager','<span class="dg">— none —</span>','Customer Relationship','20%',btn('Edit')+' '+btn('Delete','pink')],
             ['Senior Software Engineer','<span class="dg">— none —</span>','Code Quality','20%',btn('Edit')+' '+btn('Delete','pink')]])
        + '</div></div>')

def s_cycles():
    return (head('Cycles','HR','Create a cycle and move it through the nine phases.', btn('+ New cycle','pink'))
        + steps(0)
        + '<div class="card"><div class="cb0">'
        + table(['Cycle','Fiscal year','Type','Phase','Employees','Action'],
            [['<b>Annual Appraisal FY26-27</b>','FY 2026-27','Annual',pill('KRA Setting','wait'),'1,398',
              btn('Advance to Quarterly Connects &rarr;','teal')],
             ['Annual Appraisal FY25-26','FY 2025-26','Annual',pill('Closed','none'),'1,204',btn('View')]])
        + '</div></div>'
        + note('Advancing moves one step at a time and can be rolled back one step. KRAs stay editable in every phase except Draft and Closed.','navy'))

def s_calib():
    return (head('Calibration','HR','Adjust ratings across the company, with a reason recorded against each change.')
        + tiles([('S','3.9','Mean rating','navy'),('A','22%','A and above','leaf'),
                 ('B','61%','B band','lagoon'),('C','17%','Below B','amber')])
        + '<div class="card"><div class="cb0">'
        + table(['Employee','Department','Manager','HOD','Proposed','Adjust to','Reason'],
            [[emp('Suraj Khairnar','Sales Manager'),'Sales','A','A','<b>A</b>','<select class="sel"><option>A</option><option>A+</option></select>','<input class="inp2" placeholder="Required…">'],
             [emp('Abhedya Tembe','Cloud Engineer'),'Cloud','B+','A','<b>A</b>','<select class="sel"><option>A</option></select>','<input class="inp2" placeholder="Required…">']])
        + '</div></div>')

def s_ninebox():
    cells = [('Low','Low','12'),('Low','Med','31'),('Low','High','8'),
             ('Med','Low','44'),('Med','Med','188'),('Med','High','61'),
             ('High','Low','9'),('High','Med','74'),('High','High','23')]
    grid = ''.join(f'<div class="nb"><b>{n}</b><span>{p} potential<br>{perf} performance</span></div>' for perf,p,n in cells)
    return (head('9-Box Grid','HR','Performance against potential, for the published population.')
        + f'<div class="card"><div class="cb"><div class="ninebox">{grid}</div></div></div>')

def s_reports():
    return (head('PMS Completion Report','HR','Who has completed which stage, exportable.', btn('Export .xlsx','teal'))
        + search('Filter by department, manager or status…')
        + '<div class="card" style="margin-top:12px"><div class="cb0">'
        + table(['Department','Employees','KRAs set','Mid-Year','Annual','Published'],
            [['Sales','214','188 (88%)','0','0','0'],['Cloud','176','142 (81%)','0','0','0'],
             ['Admin','98','44 (45%)','0','0','0'],['Presales','61','55 (90%)','0','0','0']])
        + '</div></div>')

def s_employees():
    return (head('Employees','HR','The employee master, synced from your HRMS.',
                 btn('Import','teal') + ' ' + btn('Download template'))
        + note('<b>New hires are assigned KRAs automatically</b> from the library shelf for their department and designation. Validate first — the dry run shows how many would get KRAs and which designations have no shelf.','leaf')
        + search('Search by name, code, email, manager or department…')
        + '<div class="card" style="margin-top:12px"><div class="cb0">'
        + table(['Employee','Code','Department','Manager','Role','Actions'],
            [[emp('Suraj Khairnar','Sales Manager'),'MGS167','Sales','Nida Vajid Momin',pill('employee','none'),btn('Edit')+' '+btn('Set password')],
             [emp('Nida Vajid Momin','Regional Head'),'MGS092','Sales','Rajiv Nair',pill('manager','wait'),btn('Edit')+' '+btn('Set password')],
             [emp('Akshay Raut','HR Business Partner'),'MGS004','HR','&mdash;',pill('hr','ok'),btn('Edit')+' '+btn('Set password')]])
        + '</div></div>')

TEMPLATE = '<!doctype html><html lang="en"><head><meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>Agentic PMS — UI prototype</title>\n<style>__FACES__</style>\n<style>\n:root{--navy:#1b3b6f;--navy900:#101f3d;--navy800:#152f59;--navy500:#2c4b7c;--navy400:#3a5a8c;\n--navy300:#7d95bb;--navy100:#dbe3ef;--navy50:#eef2f8;--brand:#ec407a;--brand600:#d42f68;\n--brand50:#fdf0f5;--lagoon:#17a2b8;--lagoon50:#eafbfd;--leaf:#43a047;--leaf50:#eef9ee;\n--amber:#f5821f;--amber50:#fff6ec;--page:#f1f4f9}\n*{box-sizing:border-box;margin:0;padding:0}\nbody{font-family:Inter,system-ui,sans-serif;background:var(--page);color:var(--navy900);font-size:14px;-webkit-font-smoothing:antialiased}\n[hidden]{display:none!important}\n.banner{background:var(--navy900);color:#c9d6ea;font-size:11.5px;padding:7px 28px;text-align:center;letter-spacing:.02em}\n.banner b{color:#fff}\n.appbar{background:#fff;padding:13px 28px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--navy100)}\n.logo{display:flex;align-items:center;gap:10px}\n.logomark{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--navy),var(--lagoon))}\n.logotext{font-size:20px;font-weight:800;letter-spacing:-.02em}\n.logosub{font-size:11px;color:var(--navy300);font-weight:500;margin-left:6px}\n.who{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--navy500)}\n.avatar{width:29px;height:29px;border-radius:50%;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12.5px}\n.topnav{background:var(--navy);display:flex;padding:0 16px;overflow-x:auto}\n.topnav a{color:#c9d6ea;padding:14px 17px;font-size:13.5px;font-weight:500;white-space:nowrap;cursor:default}\n.topnav a.on{background:var(--brand);color:#fff;font-weight:600}\n.rolebar{background:#fff;border-bottom:1px solid var(--navy100);padding:9px 28px 0;display:flex;gap:7px}\n.rt{padding:8px 20px;border:1px solid var(--navy100);border-bottom:0;border-radius:9px 9px 0 0;background:var(--navy50);\n  color:var(--navy400);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}\n.rt.on{background:var(--navy);color:#fff;border-color:var(--navy)}\n.subnav{background:#fff;border-bottom:1px solid var(--navy100);padding:0 28px;display:flex;gap:3px;overflow-x:auto}\n.subnav a{padding:12px 15px;font-size:12.5px;color:var(--navy400);white-space:nowrap;border-bottom:2.5px solid transparent;font-weight:500;cursor:pointer}\n.subnav a:hover{color:var(--navy)}\n.subnav a.on{color:var(--brand);border-bottom-color:var(--brand);font-weight:600}\n.wrap{padding:22px 28px 40px;max-width:1500px}\n.phead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}\n.hact{display:flex;gap:8px;flex-shrink:0}\nh1{font-size:24px;font-weight:800;letter-spacing:-.02em}\n.sub{color:var(--navy300);font-size:13px;margin-top:3px}\n.tag{display:inline-block;font-size:10.5px;font-weight:700;padding:4px 10px;border-radius:99px;background:var(--lagoon50);color:#0f6a7a;vertical-align:middle;margin-left:6px}\n.card{background:#fff;border-radius:13px;box-shadow:0 1px 2px rgba(16,31,61,.05),0 6px 18px -9px rgba(16,31,61,.14);overflow:hidden;margin-bottom:16px}\n.card.t-teal{border-top:4px solid var(--lagoon)}.card.t-pink{border-top:4px solid var(--brand)}\n.card.t-navy{border-top:4px solid var(--navy)}.card.t-lagoon{border-top:4px solid var(--lagoon)}\n.cb{padding:18px 20px}.cb0{padding:0}\n.badge{width:38px;height:38px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:16px;margin-bottom:11px}\n.b-teal,.b-lagoon{background:var(--lagoon)}.b-pink{background:var(--brand)}.b-navy{background:var(--navy)}\n.h2{font-size:16.5px;font-weight:700}\n.muted{color:var(--navy300);font-size:12.5px;margin-top:5px;line-height:1.55}\n.two{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}\n.two2{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:10px;font-size:12.5px}\n.three{display:grid;grid-template-columns:repeat(3,1fr);gap:11px;margin-top:13px}\n.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}\n.tile{background:#fff;border-radius:11px;padding:13px 15px;display:flex;align-items:center;gap:11px;box-shadow:0 1px 2px rgba(16,31,61,.05)}\n.tb{width:33px;height:33px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:13.5px;flex-shrink:0}\n.tb.b-amber{background:var(--amber)}.tb.b-leaf{background:var(--leaf)}\n.tn{font-size:20px;font-weight:800;line-height:1.1}\n.tl{font-size:9.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--navy300);font-weight:700;margin-top:2px}\n.srch{display:flex;align-items:center;gap:9px;background:#fff;border:1px solid var(--navy100);border-radius:10px;padding:11px 15px}\n.srch input{border:0;outline:0;flex:1;font:inherit;font-size:13px;color:var(--navy400);background:none}\ntable{width:100%;border-collapse:collapse}\nth{text-align:left;padding:12px 16px;font-size:9.8px;text-transform:uppercase;letter-spacing:.08em;color:var(--navy400);font-weight:700;background:var(--navy50)}\ntd{padding:12px 16px;border-top:1px solid var(--navy50);font-size:13px;vertical-align:middle}\n.nm{font-weight:700}.dg{font-size:11.5px;color:var(--navy300)}\n.pill{display:inline-block;font-size:10.5px;font-weight:700;padding:4px 11px;border-radius:99px;white-space:nowrap}\n.p-ok{background:var(--leaf50);color:#2f7a33}.p-wait{background:var(--amber50);color:#a35a0c}\n.p-none{background:var(--navy50);color:var(--navy300)}.p-ret{background:var(--brand50);color:var(--brand600)}\n.bt{font-size:12px;font-weight:600;padding:8px 14px;border-radius:8px;border:0;cursor:pointer;font-family:inherit;white-space:nowrap}\n.bt-pink{background:var(--brand);color:#fff}.bt-teal{background:var(--lagoon);color:#fff}\n.bt-gh{background:#fff;color:var(--navy500);border:1px solid var(--navy100)}\n.tabs{display:flex;gap:7px;margin:15px 0 12px;flex-wrap:wrap}\n.tab{padding:8px 16px;border-radius:99px;font-size:12.5px;font-weight:600;background:#fff;color:var(--navy400);border:1px solid var(--navy100);cursor:pointer;font-family:inherit}\n.tab.on{background:var(--navy);color:#fff;border-color:var(--navy)}\n.tab .c{opacity:.7;margin-left:6px;font-weight:700}\n.steps{display:flex;align-items:flex-start;padding:20px 22px 22px}\n.step{text-align:center;width:160px;flex-shrink:0}\n.sc{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;margin:0 auto}\n.sc.done{background:var(--leaf);color:#fff}.sc.now{background:var(--lagoon);color:#fff}\n.sc.todo{background:var(--navy100);color:var(--navy400)}\n.sname{font-size:12.5px;font-weight:700;margin-top:8px}.sst{font-size:10.5px;color:var(--navy300);margin-top:2px}\n.sline{flex:1;height:3px;background:var(--navy100);margin-top:20px;border-radius:2px;min-width:20px}\n.sline.done{background:var(--leaf)}\n.kra{border:1px solid var(--navy100);border-radius:10px;padding:12px 14px;margin-bottom:8px}\n.kt{font-weight:700;font-size:13.5px;display:flex;justify-content:space-between}\n.kw{color:var(--navy400)}.km{font-size:12px;color:var(--navy300);margin-top:3px}\n.wt{font-size:12.5px;color:var(--navy400);margin-top:10px}\n.row{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}\n.libr label{display:flex;align-items:center;gap:9px;font-size:13px;padding:9px 0;border-bottom:1px solid var(--navy50)}\n.libr i{margin-left:auto;font-style:normal;color:var(--navy300);font-weight:600;font-size:12px}\n.note{border-radius:0 9px 9px 0;padding:11px 15px;font-size:12.5px;margin-bottom:14px;line-height:1.55}\n.note.n-amber{background:var(--amber50);border-left:3px solid var(--amber)}\n.note.n-navy{background:var(--navy50);border-left:3px solid var(--navy300)}\n.note.n-teal{background:var(--lagoon50);border-left:3px solid var(--lagoon)}\n.note.n-leaf{background:var(--leaf50);border-left:3px solid var(--leaf)}\n.cur{font-size:12.5px;color:var(--navy500);margin:10px 0}\n.prog{display:flex;align-items:center;gap:11px;font-size:12.5px;padding:7px 0}\n.prog span{flex:1}.prog b{width:42px;text-align:right}\n.bar{width:120px;height:6px;background:var(--navy50);border-radius:4px;overflow:hidden}\n.bar i{display:block;height:100%;border-radius:4px}\n.ladder{display:flex;gap:11px;padding:10px 0;border-bottom:1px solid var(--navy50);font-size:13px}\n.ln{width:22px;height:22px;border-radius:50%;background:var(--navy50);color:var(--navy400);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}\n.ladder em{color:var(--brand);font-style:normal;font-weight:700;font-size:12px}\n.cmeta{font-size:11.5px;color:var(--navy300)}\n.fb{border-radius:9px;padding:11px 13px;font-size:12.5px}\n.fb b{display:block;margin-bottom:4px;font-size:12px}\n.f-green{background:var(--leaf50)}.f-green b{color:#2f7a33}\n.f-amber{background:var(--amber50)}.f-amber b{color:#a35a0c}\n.f-blue{background:var(--lagoon50)}.f-blue b{color:#0f6a7a}\n.ai{background:#f6f1fd;border-radius:10px;padding:13px 15px;margin-top:13px}\n.aitag{font-size:9.5px;font-weight:800;letter-spacing:.08em;background:#7c4dbe;color:#fff;padding:3px 9px;border-radius:99px}\n.aiq{font-style:italic;color:var(--navy500);margin:9px 0;font-size:13px}\n.ai ul{margin:5px 0 0 16px;color:var(--navy400)}.ai li{margin-bottom:3px}\n.foot{display:flex;align-items:center;gap:7px;margin-top:14px;padding-top:12px;border-top:1px solid var(--navy50);flex-wrap:wrap}\n.right{margin-left:auto}\n.signoff{display:flex;align-items:center;background:#fff;border-radius:11px;padding:14px 20px;margin-bottom:14px;box-shadow:0 1px 2px rgba(16,31,61,.05)}\n.signoff .dg{display:block;font-size:9.5px;text-transform:uppercase;letter-spacing:.07em;font-weight:700}\n.so{flex:1;text-align:center;font-size:10px;letter-spacing:.1em;color:var(--navy300);font-weight:700}\n.rate{display:flex;gap:6px;align-items:center}\n.rl{font-size:9.5px;font-weight:700;color:var(--navy300);text-transform:uppercase;letter-spacing:.07em;margin-right:5px}\n.rb{min-width:33px;height:29px;padding:0 8px;border-radius:7px;border:1px solid var(--navy100);background:#fff;font-size:12px;font-weight:700;color:var(--navy400);display:flex;align-items:center;justify-content:center;cursor:pointer}\n.rb.on{background:var(--navy);color:#fff;border-color:var(--navy)}\n.ta{margin-top:12px;background:var(--navy50);border-radius:9px;padding:14px;font-size:12.5px;color:var(--navy300);min-height:64px}\n.am{color:var(--amber)}.pk{color:var(--brand)}\n.prm{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--navy50);font-size:12.5px}\n.prm.pot{border-top:2px solid var(--navy100);border-bottom:0;margin-top:8px;padding-top:12px}\n.prm i{display:block;font-style:normal;font-size:10.5px;color:var(--brand);font-weight:600}\n.calc{margin-top:11px;background:var(--lagoon50);border-radius:9px;padding:10px 13px;font-size:13px;color:#0f6a7a}\n.att{padding:9px 0;border-bottom:1px solid var(--navy50);font-size:12.5px}\n.att b{color:var(--brand);font-size:15px;margin-right:5px}\n.warn{color:var(--brand600);font-size:11.5px;font-weight:700;margin-right:6px}\n.ninebox{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}\n.nb{background:var(--navy50);border-radius:10px;padding:16px;text-align:center}\n.nb b{display:block;font-size:22px;font-weight:800}\n.nb span{font-size:10.5px;color:var(--navy300);line-height:1.5;display:block;margin-top:4px}\n.sel,.inp2{font:inherit;font-size:12px;padding:6px 9px;border:1px solid var(--navy100);border-radius:7px;background:#fff;width:100%}\n@media(max-width:1000px){.two,.three,.two2{grid-template-columns:1fr}.steps{overflow-x:auto}}\n</style></head><body>\n<div class="banner"><b>VISUAL PROTOTYPE</b> — proposed UI only. Not connected to any data, and the live PMS is unchanged. Click the role tabs and the menu to move around.</div>\n<div class="appbar">\n  <div class="logo"><div class="logomark"></div><div class="logotext">PMS<span class="logosub">Performance &amp; Growth</span></div></div>\n  __WHO__\n</div>\n<div class="topnav">__TOP__</div>\n<div class="rolebar">__ROLETABS__</div>\n__SUBNAVS__\n<div class="wrap">__SCREENS__</div>\n<script>\nfunction show(id){\n  document.querySelectorAll(\'.screen\').forEach(s=>s.hidden = s.id!==id);\n  document.querySelectorAll(\'.subnav a\').forEach(a=>a.classList.toggle(\'on\', a.dataset.go===id));\n  window.scrollTo(0,0);\n}\ndocument.querySelectorAll(\'.subnav a\').forEach(a=>a.onclick=()=>show(a.dataset.go));\ndocument.querySelectorAll(\'.rt\').forEach(b=>b.onclick=()=>{\n  const r=b.dataset.role;\n  document.querySelectorAll(\'.rt\').forEach(x=>x.classList.toggle(\'on\',x===b));\n  document.querySelectorAll(\'.subnav\').forEach(n=>n.hidden = n.dataset.for!==r);\n  document.querySelectorAll(\'.who\').forEach(w=>w.hidden = w.dataset.who!==r);\n  const first=document.querySelector(\'.subnav[data-for="\'+r+\'"] a\');\n  if(first) show(first.dataset.go);\n});\n// Rating chips and tabs respond, so the prototype feels alive without data.\ndocument.addEventListener(\'click\',e=>{\n  const rb=e.target.closest(\'.rb\');\n  if(rb){ rb.parentElement.querySelectorAll(\'.rb\').forEach(x=>x.classList.toggle(\'on\',x===rb)); }\n  const tb=e.target.closest(\'.tab\');\n  if(tb){ tb.parentElement.querySelectorAll(\'.tab\').forEach(x=>x.classList.toggle(\'on\',x===tb)); }\n});\n</script></body></html>'

# ================================================================== assembly ===
# Option B from the assessment: a role tab row (Self / Manager / HR), each with
# its own sub-nav. Solves BOTH the 29-item overflow and item 25's request for
# role-based views, with one control.
ROLES = [
    ('self', 'Self', 'Vishakha Rane', 'V', [
        ('mykras','My KRAs',s_mykras), ('growth','My Growth',s_growth),
        ('connects','Quarterly Connects',s_connects), ('midyear','Mid-Year Review',s_midyear),
        ('annual','Annual Review',s_annual), ('final','Final Rating',s_final),
        ('myrating','My Rating',s_myrating)]),
    ('mgr', 'Manager', 'Nida Vajid Momin', 'N', [
        ('teamover','Team Overview',s_teamover), ('teamkras','Team KRA Sheets',s_teamkras),
        ('teameval','Team Evaluation',s_teameval), ('hod','Delivery Head Review',s_hod),
        ('pip','Improvement Plans',s_pip)]),
    ('hr', 'HR', 'Akshay Raut', 'A', [
        ('dash','Dashboard',s_dash), ('kraover','KRA Overview',s_kraover),
        ('library','KRA Library',s_library), ('cycles','Cycles',s_cycles),
        ('employees','Employees',s_employees), ('calib','Calibration',s_calib),
        ('ninebox','9-Box Grid',s_ninebox), ('reports','Completion Report',s_reports)]),
]

TOP = ['DashBoard','Admin','Employee','Attendance','Leave','Payroll','Training','RMS','PMS','Analytics','Utilities']

def build():
    topnav = ''.join(f'<a class="{"on" if t=="PMS" else ""}">{t}</a>' for t in TOP)
    roletabs = ''.join(f'<button class="rt{" on" if i==0 else ""}" data-role="{rid}">{label}</button>'
                       for i,(rid,label,_,_,_) in enumerate(ROLES))
    subnavs, screens = '', ''
    for i,(rid,label,who,init,pages) in enumerate(ROLES):
        links = ''.join(f'<a class="{"on" if j==0 else ""}" data-go="{rid}-{pid}">{pname}</a>'
                        for j,(pid,pname,_) in enumerate(pages))
        subnavs += f'<nav class="subnav" data-for="{rid}" {"" if i==0 else "hidden"}>{links}</nav>'
        for j,(pid,pname,fn) in enumerate(pages):
            screens += (f'<section class="screen" id="{rid}-{pid}" {"" if (i==0 and j==0) else "hidden"}>'
                        + fn() + '</section>')
    return TEMPLATE.replace('__FACES__', faces()).replace('__TOP__', topnav) \
        .replace('__ROLETABS__', roletabs).replace('__SUBNAVS__', subnavs).replace('__SCREENS__', screens) \
        .replace('__WHO__', ''.join(
            f'<span class="who" data-who="{rid}" {"" if i==0 else "hidden"}>Welcome, {who}'
            f'<span class="avatar">{init}</span></span>'
            for i,(rid,_,who,init,_) in enumerate(ROLES)))


if __name__ == '__main__':
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    html = build()
    open(OUT, 'w', encoding='utf-8').write(html)
    print(f'wrote {OUT}  ({len(html)//1024} KB)')
