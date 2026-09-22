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
    t = ''.join(f'<div class="tile g-{c}"><div class="tb">{l}</div>'
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
def head(title, tag=None, sub=None, actions='', hue='navy'):
    t = f' <span class="tag">{tag}</span>' if tag else ''
    s = f'<p class="sub">{sub}</p>' if sub else ''
    a = f'<div class="hact">{actions}</div>' if actions else ''
    return f'<div class="hero h-{hue}"><div><h1>{title}{t}</h1>{s}</div>{a}</div>'

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


def s_approvals():
    """Every approval in the product, in one queue. HR / super admin only."""
    a = btn('Approve','teal') + ' ' + btn('Return','gh')
    return (head('All Approvals','Super admin','Every pending decision across the whole company, in one place.',
                 btn('Approve selected','pink'), 'violet')
        + tiles([('K','4','KRA sheets','lagoon'),('G','3','Growth plans','violet'),
                 ('M','2','Mid-Year sign-offs','amber'),('E','5','Evaluations','pink'),
                 ('C','1','Connect confirmations','leaf')])
        + tabs([('All pending','15'),('KRA sheets','4'),('Growth plans','3'),
                ('Mid-Year','2'),('Evaluations','5'),('Connects','1')])
        + search('Search across every approval queue…')
        + '<div class="card" style="margin-top:12px"><div class="cb0">'
        + table(['','Employee','Type','Waiting on','Submitted','Action'],
            [['<input type="checkbox">', emp('Suraj Khairnar','Sales Manager'),
              pill('KRA sheet','lagoon'),'Nida Vajid Momin','2 days', a],
             ['<input type="checkbox">', emp('Abhedya Tembe','Cloud Engineer'),
              pill('KRA sheet','lagoon'),'Rajiv Nair','5 days', a],
             ['<input type="checkbox">', emp('Rekha Joshi','Presales Lead'),
              pill('Growth plan','violet'),'Amit Shah','1 day', a],
             ['<input type="checkbox">', emp('Manoj Surwade','Office Assistant'),
              pill('Mid-Year','wait'),'Imtiyaz Mulla','8 days', a],
             ['<input type="checkbox">', emp('Priya Nair','Sales Executive'),
              pill('Evaluation','ret'),'Nida Vajid Momin','3 days', a],
             ['<input type="checkbox">', emp('Vikas Patil','Support Engineer'),
              pill('Connect','ok'),'Rajiv Nair','6 days', a]])
        + '</div></div>'
        + note('As <b>super admin</b> you can approve at any level for any employee — including your own records. Every self-approval is recorded in the audit log.','violet'))

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
    RANK = {'Low': 0, 'Med': 1, 'High': 2}
    # Warmth follows the box, so the grid reads at a glance: top-right is the
    # talent pool, bottom-left is the risk corner.
    heat = lambda perf, p: ('cold', 'cold', 'warm', 'hot', 'hot')[RANK[perf] + RANK[p]]
    grid = ''.join(f'<div class="nb {heat(perf,p)}"><b>{n}</b>'
                   f'<span>{p} potential<br>{perf} performance</span></div>' for perf, p, n in cells)
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


# ================================================================== assembly ===
CSS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prototype.css'), encoding='utf-8').read()


# Two layouts, one set of screens. The whole point of the second variant is
# that it differs ONLY in navigation — if the content diverged, comparing
# them would tell you nothing.
# The left sidebar is the chosen direction, so it gets the plain filename.
# Reversing to role tabs is swapping the two 'file' values below and running
# this script — nothing else in here, and no screen, knows which shell it is in.
LAYOUTS = {
    'sidebar': {'file': 'pms-ui-prototype.html', 'title': 'left sidebar',
                'other': 'pms-ui-prototype-tabs.html', 'other_title': 'role tabs'},
    'tabs': {'file': 'pms-ui-prototype-tabs.html', 'title': 'role tabs',
             'other': 'pms-ui-prototype.html', 'other_title': 'left sidebar'},
}

DOC_HEAD = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agentic PMS &mdash; UI prototype (__TITLE__)</title>
<style>__FACES__</style>
<style>
__CSS__
</style></head><body>
<div class="banner"><b>VISUAL PROTOTYPE &middot; __TITLE__</b> &mdash; proposed UI only. Not connected to any data, and the live PMS is unchanged. Switch the person on the right to see what each role can open. <a class="vlink" href="__OTHER__">Compare with the __OTHER_TITLE__ variant &rarr;</a></div>
<div class="appbar">
  <div class="logo"><div class="logomark"></div><div class="logotext">Performance Management System</div></div>
  <div class="who-wrap">__PERSONA__ __WHO__</div>
</div>
<div class="topnav">__TOP__</div>
"""

BODY_TABS = """__ROLEBARS__
__SUBNAVS__
<div class="wrap">__SCREENS__</div>
"""

BODY_SIDE = """<div class="shell">__SIDENAVS__<div class="wrap">__SCREENS__</div></div>
"""

JS_TABS = """
function show(id){
  document.querySelectorAll('.screen').forEach(s => s.hidden = s.id !== id);
  document.querySelectorAll('.subnav a').forEach(a => a.classList.toggle('on', a.dataset.go === id));
  window.scrollTo(0, 0);
}
// A group = one role tab (Self / Manager / HR). Only groups the signed-in
// person may open are rendered for them at all, so this never has to hide one.
function showGroup(g){
  document.querySelectorAll('.gt').forEach(b => b.classList.toggle('on', b.dataset.group === g));
  document.querySelectorAll('.subnav').forEach(n => n.hidden = n.dataset.for !== g);
  var first = document.querySelector('.subnav[data-for="' + g + '"] a');
  if (first) show(first.dataset.go);
}
function showPersona(p){
  document.querySelectorAll('.pb').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  document.querySelectorAll('.who').forEach(w => w.hidden = w.dataset.who !== p);
  document.querySelectorAll('.rolebar').forEach(r => r.hidden = r.dataset.persona !== p);
  var tab = document.querySelector('.rolebar[data-persona="' + p + '"] .gt');
  if (tab) showGroup(tab.dataset.group);
}
document.querySelectorAll('.gt').forEach(b => b.onclick = () => showGroup(b.dataset.group));
document.querySelectorAll('.subnav a').forEach(a => a.onclick = () => show(a.dataset.go));
"""

JS_SIDE = """
function show(id){
  document.querySelectorAll('.screen').forEach(s => s.hidden = s.id !== id);
  document.querySelectorAll('.side a').forEach(a => a.classList.toggle('on', a.dataset.go === id));
  window.scrollTo(0, 0);
}
// No groups to switch between: the sidebar shows everything this person can
// open at once, which is the difference being compared.
function showPersona(p){
  document.querySelectorAll('.pb').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  document.querySelectorAll('.who').forEach(w => w.hidden = w.dataset.who !== p);
  document.querySelectorAll('.sidenav').forEach(n => n.hidden = n.dataset.persona !== p);
  var first = document.querySelector('.sidenav[data-persona="' + p + '"] a');
  if (first) show(first.dataset.go);
}
document.querySelectorAll('.side a').forEach(a => a.onclick = () => show(a.dataset.go));
"""

JS_COMMON = """
document.querySelectorAll('.pb').forEach(b => b.onclick = () => showPersona(b.dataset.p));
// Dashboard is home: back to whatever the signed-in person's first screen is.
document.querySelectorAll('.topnav a').forEach(a => a.onclick = () => {
  var on = document.querySelector('.pb.on');
  if (on) showPersona(on.dataset.p);
});
// Rating chips and filter tabs respond, so the prototype feels alive without data.
document.addEventListener('click', e => {
  var rb = e.target.closest('.rb');
  if (rb) rb.parentElement.querySelectorAll('.rb').forEach(x => x.classList.toggle('on', x === rb));
  var tb = e.target.closest('.tab');
  if (tb) tb.parentElement.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === tb));
});
</script></body></html>"""

# WHO SEES WHAT. The prototype models real access, not a view switcher:
#   employee -> Self only
#   manager  -> Self + Manager
#   hr/admin -> everything, plus the consolidated Approvals queue
# Pages are (id, label, render fn, hero hue).
SELF_PAGES = [('mykras', 'My KRAs', s_mykras, 'navy'),
              ('growth', 'My Growth', s_growth, 'leaf'),
              ('connects', 'Quarterly Connects', s_connects, 'pink'),
              ('midyear', 'Mid-Year Review', s_midyear, 'amber'),
              ('annual', 'Annual Review', s_annual, 'navy'),
              ('final', 'Final Rating', s_final, 'teal'),
              ('myrating', 'My Rating', s_myrating, 'violet')]
MGR_PAGES = [('teamover', 'Team Overview', s_teamover, 'teal'),
             ('teamkras', 'Team KRA Sheets', s_teamkras, 'navy'),
             ('teameval', 'Team Evaluation', s_teameval, 'teal'),
             ('hod', 'Delivery Head Review', s_hod, 'navy'),
             ('pip', 'Improvement Plans', s_pip, 'amber')]
HR_PAGES = [('dash', 'Dashboard', s_dash, 'violet'),
            ('approvals', 'All Approvals', s_approvals, 'violet'),
            ('kraover', 'KRA Overview', s_kraover, 'navy'),
            ('library', 'KRA Library', s_library, 'teal'),
            ('cycles', 'Cycles', s_cycles, 'pink'),
            ('employees', 'Employees', s_employees, 'navy'),
            ('calib', 'Calibration', s_calib, 'amber'),
            ('ninebox', '9-Box Grid', s_ninebox, 'leaf'),
            ('reports', 'Completion Report', s_reports, 'teal')]

GROUPS = [('self', 'Self', SELF_PAGES), ('mgr', 'Manager', MGR_PAGES), ('hr', 'HR / Admin', HR_PAGES)]

# role id, label, person, initial, which groups they may open.
# The "Viewing as" control exists only so all three can be reviewed in one
# file; in the real app the signed-in role decides and there is no switcher.
PERSONAS = [
    ('employee', 'Employee', 'Vishakha Rane', 'V', ['self']),
    ('manager', 'Manager', 'Nida Vajid Momin', 'N', ['self', 'mgr']),
    ('hr', 'HR / Super Admin', 'Akshay Raut', 'A', ['self', 'mgr', 'hr']),
]

TOP = ['Dashboard']


def render_screens():
    """The 21 screens, identical in both layouts. Shared ids, shared markup."""
    out = ''
    for i, (gid, _, pages) in enumerate(GROUPS):
        for j, (pid, _, fn, hue) in enumerate(pages):
            # Every screen opens with one hero band; recolour it per page.
            body = fn().replace('hero h-navy', f'hero h-{hue}', 1)
            out += (f'<section class="screen" id="{gid}-{pid}"'
                    f'{"" if (i == 0 and j == 0) else " hidden"}>{body}</section>')
    return out


def build(layout='tabs'):
    meta = LAYOUTS[layout]
    topnav = ''.join(f'<a class="{"on" if i == 0 else ""}">{t}</a>' for i, t in enumerate(TOP))

    persona = ('<div class="persona"><span class="plab">Viewing as</span>' + ''.join(
        f'<button class="pb{" on" if i == 0 else ""}" data-p="{pid}">{label}</button>'
        for i, (pid, label, _, _, _) in enumerate(PERSONAS)) + '</div>')

    who = ''.join(
        f'<span class="who" data-who="{pid}"{"" if i == 0 else " hidden"}>{name}'
        f'<span class="avatar">{init}</span></span>'
        for i, (pid, _, name, init, _) in enumerate(PERSONAS))

    if layout == 'tabs':
        # One tab row per person, carrying only the groups that person may open.
        rolebars = ''.join(
            f'<div class="rolebar" data-persona="{pid}"{"" if i == 0 else " hidden"}>' + ''.join(
                f'<button class="gt{" on" if j == 0 else ""}" data-group="{gid}">{glabel}</button>'
                for j, (gid, glabel, _) in enumerate(g for g in GROUPS if g[0] in allowed)) + '</div>'
            for i, (pid, _, _, _, allowed) in enumerate(PERSONAS))
        subnavs = ''.join(
            f'<nav class="subnav" data-for="{gid}"{"" if i == 0 else " hidden"}>' + ''.join(
                f'<a class="{"on" if j == 0 else ""}" data-go="{gid}-{pid}">{pname}</a>'
                for j, (pid, pname, _, _) in enumerate(pages)) + '</nav>'
            for i, (gid, _, pages) in enumerate(GROUPS))
        body = BODY_TABS.replace('__ROLEBARS__', rolebars).replace('__SUBNAVS__', subnavs)
        js = JS_TABS
    else:
        # One sidebar per person: every screen they may open, grouped under a
        # heading, all visible at once. No tab to switch first.
        sidenavs = ''
        for i, (pid, _, _, _, allowed) in enumerate(PERSONAS):
            groups = ''
            first = True
            for gid, glabel, pages in GROUPS:
                if gid not in allowed:
                    continue
                items = ''
                for spid, pname, _, hue in pages:
                    # The badge is tinted with the page's own hero colour, so the
                    # menu and the page you land on agree.
                    on = ' class="on"' if first else ''
                    first = False
                    items += (f'<a{on} data-go="{gid}-{spid}">'
                              f'<i class="k-{hue}">{pname[0]}</i>{pname}</a>')
                groups += f'<div class="sgroup s-{gid}"><div class="sglab">{glabel}</div>{items}</div>'
            sidenavs += (f'<aside class="side sidenav" data-persona="{pid}"'
                         f'{"" if i == 0 else " hidden"}>{groups}</aside>')
        body = BODY_SIDE.replace('__SIDENAVS__', sidenavs)
        js = JS_SIDE

    doc = DOC_HEAD + body + '<script>' + js + JS_COMMON
    return (doc.replace('__FACES__', faces()).replace('__CSS__', CSS)
            .replace('__TITLE__', meta['title']).replace('__OTHER_TITLE__', meta['other_title'])
            .replace('__OTHER__', meta['other'])
            .replace('__TOP__', topnav).replace('__PERSONA__', persona).replace('__WHO__', who)
            .replace('__SCREENS__', render_screens()))


if __name__ == '__main__':
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    for layout, meta in LAYOUTS.items():
        html = build(layout)
        path = os.path.join(os.path.dirname(OUT), meta['file'])
        open(path, 'w', encoding='utf-8').write(html)
        print(f'wrote {path}  ({len(html) // 1024} KB)')
