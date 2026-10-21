#!/usr/bin/env python3
"""Agentic PMS process flows -> print-ready HTML (then PDF with topdf.js).

    python3 docs/tools/process-flows.py /tmp/flows.html
    IN=/tmp/flows.html OUT=$PWD/docs/Agentic-PMS-Process-Flows.pdf LANDSCAPE=1 \
      FOOTER="Agentic PMS — Process Flows" node docs/tools/topdf.js

This file IS the source of the document: the flows are data (lanes, steps,
arrows) and the swimlane diagrams are drawn from that data as SVG, so a
diagram and the step table under it can never disagree about the order of
things. Edit the FLOWS below, not the PDF.

Every rule stated here was read from the code at build 211b79e or from
docs/LOGIC-BOOK.md, which names the file that enforces it.
"""
import base64, glob, html, os, re, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/process-flows.html'
BUILD = '211b79e'
DATE = '21 October 2026'

# ---------------------------------------------------------------- drawing
LW, CW, BW = 96, 144, 124           # lane label width, column pitch, box width
FS, LH = 10.6, 13                   # font size, line height (px)
CHARS = 21                          # characters per line inside a box
WARNINGS = []                       # arrows drawn through a box (checked at build)
INK, MUTED, ACCENT = '#14212e', '#5b6b7c', '#0f5f7a'

STYLE = {   # kind: (fill, stroke, text colour, dashed)
    'start':    ('#e3f4ea', '#2e8b57', INK, False),
    'end':      ('#14212e', '#14212e', '#ffffff', False),
    'task':     ('#ffffff', ACCENT, INK, False),
    'system':   ('#e6f1f5', '#5b9bb0', INK, True),
    'decision': ('#fdf4e3', '#d9a53a', INK, False),
    'notify':   ('#f1ecfb', '#7a5bb5', INK, False),
    'ai':       ('#eaf2ff', '#3b7dd8', INK, True),
}


def esc(s):
    return html.escape(str(s), quote=True)


def wrap(text, n=CHARS):
    out = []
    for part in str(text).split('\n'):
        line = ''
        for w in part.split():
            if line and len(line) + 1 + len(w) > n:
                out.append(line); line = w
            else:
                line = (line + ' ' + w).strip()
        out.append(line)
    return out


def swimlane(flow):
    lanes, nodes, edges = flow['lanes'], flow['nodes'], flow.get('edges', [])
    for n in nodes.values():
        n['lines'] = wrap(n['text'], n.get('chars', CHARS))
        n['h'] = max(40, len(n['lines']) * LH + 16) + (10 if n['kind'] == 'decision' else 0)
    ncols = int(max(n['col'] for n in nodes.values()) + 1)
    lane_h = []
    for i in range(len(lanes)):
        hs = [n['h'] + 2 * abs(n.get('dy', 0)) for n in nodes.values() if n['lane'] == i]
        lane_h.append(max([92] + [h + 50 for h in hs]))
    lane_y = [sum(lane_h[:i]) for i in range(len(lanes))]
    W = LW + ncols * CW + 8
    H = sum(lane_h) + 2
    for n in nodes.values():
        n['cx'] = LW + n['col'] * CW + CW / 2
        n['cy'] = lane_y[n['lane']] + lane_h[n['lane']] / 2 + n.get('dy', 0)
        w = n.get('w', BW)
        n['x1'], n['x2'] = n['cx'] - w / 2, n['cx'] + w / 2
        n['y1'], n['y2'] = n['cy'] - n['h'] / 2, n['cy'] + n['h'] / 2

    ks = list(nodes)
    for i, a in enumerate(ks):
        for b in ks[i + 1:]:
            m, q = nodes[a], nodes[b]
            if m['x1'] < q['x2'] and q['x1'] < m['x2'] and m['y1'] < q['y2'] and q['y1'] < m['y2']:
                WARNINGS.append(f"{flow.get('name', '?')}: boxes {a} and {b} overlap")
    o = [f'<svg viewBox="0 0 {W} {H}" width="{W}" height="{H}" xmlns="http://www.w3.org/2000/svg" '
         f'font-family="Inter, sans-serif" class="flow">',
         '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
         'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#5b6b7c"/></marker></defs>']
    for i, name in enumerate(lanes):
        y, h = lane_y[i], lane_h[i]
        o.append(f'<rect x="0" y="{y}" width="{W}" height="{h}" fill="{"#f6f9fb" if i % 2 == 0 else "#ffffff"}" '
                 f'stroke="#d8e0e8" stroke-width="1"/>')
        o.append(f'<rect x="0" y="{y}" width="{LW - 8}" height="{h}" fill="{ACCENT}"/>')
        ls = wrap(name, 13)
        for k, t in enumerate(ls):
            ty = y + h / 2 - (len(ls) - 1) * 7 + k * 14 + 4
            o.append(f'<text x="{(LW - 8) / 2}" y="{ty}" text-anchor="middle" font-size="11" '
                     f'font-weight="700" fill="#ffffff">{esc(t)}</text>')

    def seg_label(pts, label, which=None):
        segs = list(zip(pts, pts[1:]))
        if which is not None:
            best = segs[which]
        else:
            best, bl = None, -1
            for a, b in segs:
                L = abs(a[0] - b[0]) + abs(a[1] - b[1])
                if L > bl:
                    best, bl = (a, b), L
        (ax, ay), (bx, by) = best
        mx, my = (ax + bx) / 2, (ay + by) / 2
        w = len(label) * 5.4 + 8
        if ax == bx:   # vertical segment: label beside it
            return (f'<rect x="{mx + 4}" y="{my - 8}" width="{w}" height="14" rx="3" fill="#ffffff" '
                    f'stroke="#d8e0e8" stroke-width=".6"/><text x="{mx + 8}" y="{my + 2.5}" font-size="9" '
                    f'fill="{MUTED}" font-weight="600">{esc(label)}</text>')
        up = 15 if my > 18 else -3      # above the line, unless that is off the top edge
        return (f'<rect x="{mx - w / 2}" y="{my - up}" width="{w}" height="14" rx="3" fill="#ffffff" '
                f'stroke="#d8e0e8" stroke-width=".6"/><text x="{mx}" y="{my - up + 10}" font-size="9" '
                f'text-anchor="middle" fill="{MUTED}" font-weight="600">{esc(label)}</text>')

    for e in edges:
        s, t = nodes[e['f']], nodes[e['t']]
        via, off = e.get('via'), e.get('off', 0)
        if e.get('ch'):   # a named channel: just inside the top or bottom of a lane
            li, side = e['ch']
            y = lane_y[li] + 9 if side == 'top' else lane_y[li] + lane_h[li] - 9
            sx = s['cx'] + e.get('sx', 0); tx = t['cx'] + e.get('tx', 0)
            sy = s['y1'] if y < s['cy'] else s['y2']
            ty = t['y1'] if y < t['cy'] else t['y2']
            pts = [(sx, sy), (sx, y), (tx, y), (tx, ty)]
        elif via:
            y = (s['y2'] + 14 + off) if via == 'below' else (s['y1'] - 14 - off)
            sy = s['y2'] if via == 'below' else s['y1']
            ty = t['y1'] if t['cy'] > y else t['y2']
            sx = s['cx'] + e.get('sx', 0); tx = t['cx'] + e.get('tx', 0)
            pts = [(sx, sy), (sx, y), (tx, y), (tx, ty)]
        elif t['col'] > s['col']:
            if abs(s['cy'] - t['cy']) < 1:
                pts = [(s['x2'], s['cy']), (t['x1'], t['cy'])]
            elif e.get('route') == 'vh':
                sy = s['y2'] if t['cy'] > s['cy'] else s['y1']
                pts = [(s['cx'], sy), (s['cx'], t['cy']), (t['x1'], t['cy'])]
            elif e.get('route') == 'hv':
                ty = t['y1'] if t['cy'] > s['cy'] else t['y2']
                pts = [(s['x2'], s['cy']), (t['cx'], s['cy']), (t['cx'], ty)]
            else:
                gap = (CW - BW) / 2
                mx = (s['x2'] + gap) if e.get('leg') == 'src' else (t['x1'] - gap)
                pts = [(s['x2'], s['cy']), (mx, s['cy']), (mx, t['cy']), (t['x1'], t['cy'])]
        elif t['col'] == s['col']:
            if t['cy'] > s['cy']:
                pts = [(s['cx'], s['y2']), (t['cx'], t['y1'])]
            else:
                pts = [(s['cx'], s['y1']), (t['cx'], t['y2'])]
        else:   # backwards without a channel named: go under the boxes
            y = max(s['y2'], t['y2']) + 14 + off
            pts = [(s['cx'], s['y2']), (s['cx'], y), (t['cx'], y), (t['cx'], t['y2'])]
        # No arrow may pass through a box other than its own two ends.
        for a, b in zip(pts, pts[1:]):
            for k, m in nodes.items():
                if m is s or m is t:
                    continue
                lo_x, hi_x = sorted((a[0], b[0])); lo_y, hi_y = sorted((a[1], b[1]))
                if hi_x > m['x1'] + 1 and lo_x < m['x2'] - 1 and hi_y > m['y1'] + 1 and lo_y < m['y2'] - 1:
                    WARNINGS.append(f"{flow.get('name', '?')}: arrow {e['f']}->{e['t']} crosses box {k}")
        d = 'M' + ' L'.join(f'{x:.1f},{y:.1f}' for x, y in pts)
        dash = ' stroke-dasharray="4 3"' if e.get('dash') else ''
        o.append(f'<path d="{d}" fill="none" stroke="#5b6b7c" stroke-width="1.3"{dash} marker-end="url(#ah)"/>')
        if e.get('label'):
            o.append(seg_label(pts, e['label'], e.get('ls')))

    for n in nodes.values():
        fill, stroke, tc, dashed = STYLE[n['kind']]
        x1, x2, y1, y2, cx, cy = n['x1'], n['x2'], n['y1'], n['y2'], n['cx'], n['cy']
        da = ' stroke-dasharray="5 3"' if dashed else ''
        if n['kind'] in ('start', 'end'):
            o.append(f'<rect x="{x1}" y="{y1}" width="{x2 - x1}" height="{y2 - y1}" rx="{(y2 - y1) / 2}" '
                     f'fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        elif n['kind'] == 'decision':
            pts = [(x1 + 12, y1), (x2 - 12, y1), (x2, cy), (x2 - 12, y2), (x1 + 12, y2), (x1, cy)]
            o.append(f'<polygon points="{" ".join(f"{a},{b}" for a, b in pts)}" fill="{fill}" '
                     f'stroke="{stroke}" stroke-width="1.5"/>')
        else:
            o.append(f'<rect x="{x1}" y="{y1}" width="{x2 - x1}" height="{y2 - y1}" rx="6" fill="{fill}" '
                     f'stroke="{stroke}" stroke-width="1.4"{da}/>')
        top = cy - (len(n['lines']) - 1) * LH / 2 + 3.6
        for k, t in enumerate(n['lines']):
            o.append(f'<text x="{cx}" y="{top + k * LH}" text-anchor="middle" font-size="{FS}" '
                     f'fill="{tc}" font-weight="{600 if k == 0 and n.get("bold") else 500}">{esc(t)}</text>')
        if n.get('num'):
            o.append(f'<circle cx="{x1 + 3}" cy="{y1 + 3}" r="8.5" fill="{ACCENT}" stroke="#ffffff" stroke-width="1.2"/>'
                     f'<text x="{x1 + 3}" y="{y1 + 6.4}" text-anchor="middle" font-size="9" font-weight="700" '
                     f'fill="#ffffff">{esc(n["num"])}</text>')
    o.append('</svg>')
    return '\n'.join(o)


def N(lane, col, text, kind='task', num=None, **kw):
    d = dict(lane=lane, col=col, text=text, kind=kind, num=num)
    d.update(kw)
    return d


def E(f, t, label='', **kw):
    d = dict(f=f, t=t, label=label)
    d.update(kw)
    return d


# ---------------------------------------------------------------- the phase strip
PHASES = [
    ('draft', 'Draft', 'HR'),
    ('kra_open', 'KRA Setting and Growth Planning', 'Employee · Manager'),
    ('mid_year_review', 'Mid-Year Review', 'Employee · Manager'),
    ('self_appraisal', 'Annual Review', 'Employee'),
    ('manager_eval', 'Manager Evaluation', 'Manager'),
    ('hod_eval', 'HOD Review', 'HOD'),
    ('calibration', 'Calibration', 'HR'),
    ('publish', 'Publish', 'HR'),
    ('closed', 'Closed', '—'),
]


def phase_strip():
    w, h, gap = 112, 64, 4
    W = len(PHASES) * (w + gap) + 10
    o = [f'<svg viewBox="0 0 {W} {h + 34}" width="{W}" height="{h + 34}" xmlns="http://www.w3.org/2000/svg" '
         f'font-family="Inter, sans-serif" class="flow">']
    for i, (key, label, who) in enumerate(PHASES):
        x = i * (w + gap)
        tip = 12
        pts = [(x, 0), (x + w - tip, 0), (x + w, h / 2), (x + w - tip, h), (x, h), (x + tip, h / 2)]
        if i == 0:
            pts[5] = (x, h / 2)
        fill = '#14212e' if key == 'closed' else ACCENT if key in ('draft', 'calibration', 'publish') else '#2b7a96'
        o.append(f'<polygon points="{" ".join(f"{a},{b}" for a, b in pts)}" fill="{fill}"/>')
        ls = wrap(label, 15)
        for k, t in enumerate(ls):
            o.append(f'<text x="{x + w / 2 + 3}" y="{h / 2 - (len(ls) - 1) * 6.5 + k * 13 + 4}" text-anchor="middle" '
                     f'font-size="10.2" font-weight="700" fill="#ffffff">{esc(t)}</text>')
        o.append(f'<text x="{x + w / 2}" y="{h + 16}" text-anchor="middle" font-size="9.3" fill="{MUTED}" '
                 f'font-weight="600">{esc(who)}</text>')
        o.append(f'<text x="{x + w / 2}" y="{h + 29}" text-anchor="middle" font-size="8.2" fill="#8a99a8" '
                 f'font-family="DejaVu Sans Mono, monospace">{esc(key)}</text>')
    o.append('</svg>')
    return '\n'.join(o)


def legend():
    items = [('start', 'Start / trigger'), ('task', 'A person does something'), ('decision', 'A decision or check'),
             ('system', 'The system does it'), ('notify', 'Someone is told (in app / email)'),
             ('ai', 'AI drafts text (never a rating)'), ('end', 'End')]
    w, h = 132, 34
    W = len(items) * (w + 12)
    o = [f'<svg viewBox="0 0 {W} {h + 4}" width="{W}" height="{h + 4}" xmlns="http://www.w3.org/2000/svg" '
         f'font-family="Inter, sans-serif" class="flow">']
    for i, (k, label) in enumerate(items):
        fill, stroke, tc, dashed = STYLE[k]
        x = i * (w + 12) + 2
        da = ' stroke-dasharray="5 3"' if dashed else ''
        if k in ('start', 'end'):
            o.append(f'<rect x="{x}" y="2" width="{w}" height="{h}" rx="{h / 2}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        elif k == 'decision':
            pts = [(x + 12, 2), (x + w - 12, 2), (x + w, 2 + h / 2), (x + w - 12, 2 + h), (x + 12, 2 + h), (x, 2 + h / 2)]
            o.append(f'<polygon points="{" ".join(f"{a},{b}" for a, b in pts)}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
        else:
            o.append(f'<rect x="{x}" y="2" width="{w}" height="{h}" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="1.4"{da}/>')
        ls = wrap(label, 22)
        for j, t in enumerate(ls):
            o.append(f'<text x="{x + w / 2}" y="{2 + h / 2 - (len(ls) - 1) * 5.5 + j * 11 + 3.5}" text-anchor="middle" '
                     f'font-size="9.4" fill="{tc}" font-weight="600">{esc(t)}</text>')
    o.append('</svg>')
    return '\n'.join(o)


# ---------------------------------------------------------------- content
# Each flow: id, title, why, who, where, flows (list of swimlanes with a
# caption), steps (num, who, what, result), rules, statuses.

FLOWS = []

# 1. Company setup ---------------------------------------------------------
FLOWS.append(dict(
    id='setup', title='Setting up the company',
    why='What HR does once on a new instance, and again at the start of each appraisal year, before employees can do anything.',
    who=['HR / Super Admin', 'System'],
    where='HR → Employees, HOD, HR Business Partners, KRA Library, Competency Framework, Career Pathing Matrix, RnR Administration, Settings, Cycles',
    diagrams=[dict(caption='Setting up: from an empty instance to an open cycle', flow=dict(
        lanes=['HR / Super Admin', 'System'],
        nodes={
            'b': N(0, 0, 'First-time setup: create the Super Admin', 'start', num=1),
            'c': N(0, 1, 'Import the employee master (CSV / Excel)', num=2),
            'd': N(1, 1, 'Check the file: a report row by row', 'system', num=3),
            'e': N(1, 2, 'Any errors?', 'decision', num=4),
            'f': N(0, 2, 'Fix the file', num=5),
            'g': N(0, 3, 'Load the file (commit)', num=6),
            'h': N(1, 3, 'Employees loaded, managers linked, roles granted, KRAs auto-assigned', 'system', num=7),
            'i': N(0, 4, 'Logins, HODs, HRBP remits, libraries, settings', num=8),
            'j': N(0, 5, 'Create the cycle (Draft): scale, bell curve, PIP threshold', num=9),
            'k': N(0, 6, 'Advance to KRA Setting', num=10),
            'l': N(1, 6, 'Everyone told: set your KRAs', 'notify', num=11),
        },
        edges=[E('b', 'c'), E('c', 'd'), E('d', 'e'), E('e', 'f', 'yes'),
               E('f', 'c', 'check again', via='above'), E('e', 'g', 'no', ls=0), E('g', 'h'),
               E('h', 'i'), E('i', 'j'), E('j', 'k'), E('k', 'l')],
    ))],
    steps=[
        (1, 'Super Admin', 'On a brand-new instance the sign-in page offers First-time setup. It creates one Super Admin.', 'Works only while the company has no employees; after that it is locked for good.'),
        (2, 'HR', 'Employees → Import: upload the employee master exported from the HR system.', 'Nothing is loaded yet.'),
        (3, 'System', 'Checks every row: name and email present, no duplicate emails, managers found (by email or name), no reporting loops, HOD consistent within a department.', 'A row-by-row report, plus a preview of manager/HOD roles and KRAs that would be given.'),
        (4, 'System', 'Errors in the report?', 'Yes → fix and check again. No → load.'),
        (6, 'HR', 'Load the file.', 'One transaction: all rows or none.'),
        (7, 'System', 'Adds or updates people by email, links managers, hands open work to a new manager, reopens a locked KRA sheet when someone\'s job changed, grants the manager and HOD roles, and copies library KRAs onto new joiners\' sheets as drafts.', 'Audited (EMPLOYEE_CSV_IMPORT).'),
        (8, 'HR', 'Logins (set a password for one person or many), department heads (HR → HOD), HRBP remits by location or HOD (HR → HR Business Partners), KRA Library, Competency Framework, Career Pathing Matrix, RnR award masters, Settings (email, timesheet calendar, company branding).', 'A password set by HR must be changed at first sign-in.'),
        (9, 'HR', 'HR → Cycles → create the cycle. It starts in Draft with the rating scale (A+ 5, A 4, B+ 3, B 2, C 1), the bell curve and a PIP threshold of 3.0, all editable.', 'Nothing is open to employees in Draft.'),
        (10, 'HR', 'Advance the cycle to KRA Setting and Growth Planning.', 'Phases move one step at a time (§1).'),
        (11, 'System', 'Every employee is told: set your KRAs and send them to your manager.', 'In-app notice.'),
    ],
    rules=[
        'The employee master is a <b>mirror</b> of the HR system: re-importing updates people by email. Email itself is never edited in the app, because logins and roles are keyed by it.',
        'Roles available on Employees → Manage: Employee, Manager, HOD, HR, HR Ops, Super Admin. The HRBP role is not yet in that list; until it is, it is set by the support team.',
        'An HOD sees a department only when HR has registered them as its head (HR → HOD). A role without a department gives an empty queue.',
        'Email starts in <b>simulated</b> mode: notices are logged, nothing is sent. HR switches it to live in Settings → Email after a test send.',
    ],
))

# 2. Sign-in ---------------------------------------------------------------
FLOWS.append(dict(
    id='signin', title='Signing in and passwords',
    why='How a person gets in for the first time, recovers a forgotten password, and is signed out when idle.',
    who=['Employee (any user)', 'HR', 'System'],
    where='Sign-in page; account menu → Change password; HR → Employees → Manage',
    diagrams=[
        dict(caption='First sign-in', flow=dict(
            lanes=['HR', 'Employee', 'System'],
            nodes={
                'a': N(0, 0, 'Sets a password for the person (one or many)', 'start', num=1),
                'b': N(1, 1, 'Signs in with email and password', num=2),
                'c': N(2, 2, 'Password right and person active?', 'decision', num=3),
                'r': N(1, 2, 'Refused, with the reason', 'notify'),
                'd': N(2, 3, 'Password set by HR?', 'decision', num=4),
                'e': N(1, 4, 'Chooses a new password (8+ characters)', num=5),
                'f': N(1, 5, 'Dashboard', 'end'),
            },
            edges=[E('a', 'b'), E('b', 'c'), E('c', 'r', 'no'), E('c', 'd', 'yes'), E('d', 'e', 'yes', ls=-2),
                   E('e', 'f'), E('d', 'f', 'no', route='hv', ls=0)],
        )),
        dict(caption='Forgotten password', flow=dict(
            lanes=['Employee', 'System'],
            nodes={
                'g': N(0, 0, 'Forgot password? Enters email', 'start', num=6),
                'i': N(0, 1, 'Page says: ask HR to reset it', 'notify'),
                'h': N(1, 1, 'Email switched on (live)?', 'decision', num=7),
                'j': N(1, 2, 'Emails a one-time code: 8 characters, 30 minutes', 'notify', num=8),
                'k': N(0, 3, 'Enters the code and a new password', num=9),
                'l': N(1, 4, 'Code right (5 tries)? Password changed', 'system'),
                'm': N(0, 5, 'Signs in', 'end'),
            },
            edges=[E('g', 'h'), E('h', 'i', 'no'), E('h', 'j', 'yes'), E('j', 'k'), E('k', 'l'), E('l', 'm')],
        )),
    ],
    steps=[
        (1, 'HR', 'Employees → Manage → set a password, or the bulk action for many people (unique, same, or name-based passwords).', 'The person must change it at first sign-in.'),
        (2, 'Employee', 'Signs in with email and password. Empty boxes are named before anything is sent.', ''),
        (3, 'System', 'Checks the password and that the person is an active employee.', 'Wrong password or an inactive/archived person: refused.'),
        (4, 'System', 'Was the password set by HR?', 'Yes → the change-password screen replaces the app until a new one is chosen.'),
        (5, 'Employee', 'Chooses a new password: at least 8 characters, different from the current one. Passwords are typed, not pasted.', 'Signed in.'),
        (6, 'Employee', 'Forgot password? on the sign-in page.', 'The answer is the same whether or not the address has an account.'),
        (7, 'System', 'Is email switched on (live)?', 'No → the page says to ask HR.'),
        (8, 'System', 'Emails a one-time 8-character code, valid 30 minutes. At most 3 requests an hour per address; a new request replaces the old code.', ''),
        (9, 'Employee', 'Enters the code and a new password (8+). Five wrong tries spend the code.', 'Password changed; audited (PASSWORD_RESET).'),
    ],
    rules=[
        'After <b>30 minutes</b> without a click, key or scroll in any PMS tab, the person is signed out; a warning appears 2 minutes before with <i>Stay signed in</i>. The sign-in page then says why.',
        'A session lasts 12 hours by default. A role change applies from the next sign-in.',
        'Removing someone (HR → Employees → Remove) makes them inactive: they can no longer sign in, and their records are kept.',
    ],
))

# 3. KRA -------------------------------------------------------------------
FLOWS.append(dict(
    id='kra', title='KRA setting and approval',
    why='How each employee\'s objectives (KRAs), their measures (KPIs) and weights are written, approved and, when needed, reopened.',
    who=['Employee', 'Manager', 'HR', 'System'],
    where='Self → My KRAs · Manager → Team KRA Sheets · HR → All Approvals, KRA Overview, KRA Library',
    diagrams=[dict(caption='The KRA sheet from draft to approved', flow=dict(
        lanes=['Employee', 'System', 'Manager', 'HR'],
        nodes={
            'b': N(0, 0, 'Write KRAs: title, KPI, weight, parameter', 'start', num=1),
            'c': N(1, 1, 'Weights total 100%?', 'decision', num=2),
            'd': N(0, 2, 'Submit to manager', num=3),
            'e': N(1, 2, 'Locked; manager told; growth plan opens', 'system', num=4),
            'f': N(2, 3, 'Review; may edit KRAs (audited)', num=5),
            'g': N(2, 4, 'Approve?', 'decision', num=6),
            'h': N(2, 5, 'Approve', dy=-34),
            'i': N(2, 5, 'Return with a comment', dy=34, num=7),
            'j': N(1, 6, 'Approved: locked to everyone', 'system', num=8),
            'l': N(3, 6, 'Job changed (department, designation, band)', 'start', num=10),
            'k': N(3, 7, 'HR reopens an approved sheet, with a comment', num=9),
            'r': N(1, 7, 'Returned; employee told the reason', 'notify'),
        },
        edges=[E('b', 'c'), E('c', 'b', 'no', via='below'), E('c', 'd', 'yes', ls=0), E('d', 'e'), E('e', 'f'), E('f', 'g'),
               E('g', 'h', 'yes', ls=-2), E('g', 'i', 'no', ls=-2), E('h', 'j', route='hv'), E('i', 'r'), E('l', 'r'),
               E('k', 'r'), E('r', 'b', 'edit and resubmit', ch=(0, 'top'), ls=1)],
    ))],
    steps=[
        (1, 'Employee', 'My KRAs: add KRAs from the KRA Library (matched to department and designation) or write them. Each has a title (150 characters), a KPI, a weight and a parameter.', 'Saved as a draft; editable until submitted.'),
        (2, 'System', 'Do the weights total exactly 100%?', 'No → submit is refused with the total shown.'),
        (3, 'Employee', 'Submit to manager.', ''),
        (4, 'System', 'The sheet locks for the employee (Submitted). The manager is told. Target achievements and Aspiring Career open for this employee (§5).', ''),
        (5, 'Manager', 'Team KRA Sheets → open the sheet. The manager may change KRAs; every change is recorded field by field and the employee is told.', 'Each KRA shows its timesheet hours and rating (§12).'),
        (6, 'Manager', 'Approve, or return.', 'Only the employee\'s own manager decides here; HR decides others from All Approvals.'),
        (7, 'Manager', 'Return with a comment (required — the employee must know why).', 'Returned: editable again; the employee resubmits.'),
        (8, 'System', 'Approved: locked to everyone.', 'Audited (KRA_APPROVED).'),
        (9, 'HR', 'HR reopens an approved sheet with a comment.', 'Returned to the employee.'),
        (10, 'System', 'A change of department, designation or band (edit or import) reopens a locked sheet automatically, with the reason.', 'The employee revises it for the new job.'),
    ],
    rules=[
        'The KRA sheet is open in every phase except Draft and Closed. It is the sheet\'s own status, not the phase, that locks it.',
        'In <b>Mid-Year Review, Annual Review and Manager Evaluation</b> the employee, their manager or HR can change an existing KRA\'s title, KPI and weight on the review screens: the same KRAs (none added or removed), weights still 100%, every change audited and the other person told. From HOD Review on, refused.',
        'Changing weights during a review recomputes the self rating and an unsubmitted manager rating; a submitted manager evaluation keeps the rating the manager signed.',
        'HR can enter a sheet on someone\'s behalf, or bulk-upload sheets (a dry run first; approved sheets are skipped).',
    ],
    statuses='Draft → Submitted → Approved, or Returned (back to the employee). Lists show “Not submitted” when no sheet exists yet.',
))

# 4. Growth ----------------------------------------------------------------
FLOWS.append(dict(
    id='growth', title='Growth plan and Aspiring Career',
    why='The employee\'s targets for the year (goals linked to KRAs) and career aspiration, short- and long-term.',
    who=['Employee', 'Manager', 'System'],
    where='Self → My Growth · Manager → Team Target Achievements',
    diagrams=[dict(caption='Target achievements: opened by the employee\'s own KRA submission', flow=dict(
        lanes=['Employee', 'System', 'Manager'],
        nodes={
            'a': N(0, 0, 'Submits KRA sheet', 'start'),
            'b': N(1, 0, 'Opens Target achievements and Aspiring Career for this person', 'system', num=1),
            'c': N(0, 1, 'Write goals: title, target date, the KRA each serves', num=2),
            'd': N(0, 2, 'Submit plan', num=3),
            'e': N(2, 3, 'Approve?', 'decision', num=4),
            'f': N(2, 4, 'Return with a comment', num=5),
            'g': N(1, 4, 'Approved: plan locked', 'system', num=6),
            'h': N(0, 5, 'Update progress on goals all year', num=7),
            'i': N(0, 6, 'Aspiring Career: short-term move and long-term goal', num=8),
        },
        edges=[E('a', 'b'), E('b', 'c'), E('c', 'd'), E('d', 'e'), E('e', 'g', 'yes', ls=-2), E('e', 'f', 'no', ls=0),
               E('f', 'c', 'editable until Calibration', ch=(2, 'bottom'), ls=1), E('g', 'h'), E('h', 'i')],
    ))],
    steps=[
        (1, 'System', 'Submitting the KRA sheet opens the growth plan and Aspiring Career for that employee, at once and with no HR action.', 'An employee who never submits KRAs gets no growth plan.'),
        (2, 'Employee', 'Target achievements: goals with a title, a target date and the KRA each goal serves.', 'Required: title and target date.'),
        (3, 'Employee', 'Submit the plan.', 'The manager is told.'),
        (4, 'Manager', 'Team Target Achievements → approve or return.', ''),
        (5, 'Manager', 'Return with a comment.', 'A returned plan is editable in any phase up to Calibration.'),
        (6, 'System', 'Approved: locked.', ''),
        (7, 'Employee', 'Progress on goals and milestones is updated all year, approved or not.', ''),
        (8, 'Employee', 'Aspiring Career, two tabs. <b>Short-Term</b>: the next move, chosen from the Career Pathing Matrix; its timeline is the matrix\'s. <b>Long-Term</b>: target role, experience, skills, plan and milestones; open through Manager Evaluation.', 'AI can suggest a role or draft a plan; it only fills blank fields.'),
    ],
    rules=[
        'After KRA Setting the growth plan stays open by phase through Annual Review; a submitted or approved plan stays locked.',
        'Expected timeline = the matrix\'s months for the whole path less the person\'s total experience, never below “Due now”.',
    ],
    statuses='Draft → Submitted → Approved, or Returned.',
))

# 5. Mid-year --------------------------------------------------------------
FLOWS.append(dict(
    id='midyear', title='Mid-Year Review',
    why='A checkpoint halfway through the year: the employee rates each KRA and reflects; the manager rates and signs it off.',
    who=['Employee', 'Manager', 'HR', 'System'],
    where='Self → Mid-Year Review · Manager → Team Mid-Year',
    diagrams=[dict(caption='Mid-Year Review: both halves, each signed', flow=dict(
        lanes=['HR', 'Employee', 'System', 'Manager'],
        nodes={
            'a': N(0, 0, 'Advance to Mid-Year Review', 'start', num=1),
            'b': N(2, 0, 'Employees and managers told; reminders from 1 Sep', 'notify'),
            'c': N(1, 1, 'Rate each KRA, write a reflection, answer the form', num=2),
            'd': N(2, 2, 'All KRAs rated and reflection written?', 'decision', num=3),
            'e': N(1, 3, 'Sign (submit)', num=4),
            'f': N(2, 3, 'Manager told; daily chase starts after 3 days', 'notify'),
            'g': N(3, 4, 'Rate each KRA, write a narrative', num=5),
            'h': N(3, 5, 'Sign off (all KRAs rated)', num=6),
            'i': N(1, 6, 'Employee told it is signed off', 'notify', num=7),
        },
        edges=[E('a', 'b'), E('b', 'c'), E('c', 'd'), E('d', 'c', 'no', via='below'),
               E('d', 'e', 'yes', ls=0), E('e', 'f'), E('f', 'g'), E('g', 'h'), E('h', 'i')],
    ))],
    steps=[
        (1, 'HR', 'HR → Cycles → advance to Mid-Year Review.', 'Employees and managers told; reminders start 1 September (employee) and the first Monday of September (manager), then the 15th, 20th, 25th and last Friday.'),
        (2, 'Employee', 'Rates each KRA on the cycle\'s scale, writes a reflection and answers HR\'s form questions. KRA, KPI and weight can be corrected here.', 'The overall is worked out when every KRA is rated.'),
        (3, 'System', 'Every KRA rated, reflection written, required questions answered?', 'No → the missing items are named.'),
        (4, 'Employee', 'Signs (submits). Locked for the employee.', ''),
        (5, 'Manager', 'Team Mid-Year: rates each KRA and writes a narrative. The manager can work on it at any point in the window.', ''),
        (6, 'Manager', 'Signs off: every KRA rated and a narrative written.', 'Locked.'),
        (7, 'System', 'The employee is told it is signed off.', 'The manager\'s ratings are shown to the employee only after the cycle is published.'),
    ],
    rules=[
        'The mid-year window opens at Mid-Year Review and stays open until the end of Annual Review, so HR can move the cycle on without shutting anyone out.',
        'From 3 days after the employee signs, the manager is chased every weekday until they sign off.',
    ],
    statuses='Each half: Not started → In progress → Submitted.',
))

# 6. Annual review (two diagrams) -----------------------------------------
FLOWS.append(dict(
    id='annual', title='Annual review: self, manager, HOD',
    why='The year-end rating chain. Each step is a phase HR opens; each rating locks when submitted.',
    who=['Employee', 'Manager', 'HOD', 'HR', 'System'],
    where='Self → Annual Review · Manager → Team Evaluation · HOD → HOD Review · HR → Cycles, PMS Completion Report',
    diagrams=[
        dict(caption='Part A: Annual Review and Manager Evaluation', flow=dict(
            lanes=['HR', 'Employee', 'Manager', 'System'],
            nodes={
                'a': N(0, 0, 'Advance to Annual Review', 'start', num=1),
                'b': N(1, 1, 'Rate each KRA, write, attach evidence', num=2),
                'c': N(1, 2, 'Submit (locked)', num=3),
                'd': N(3, 2, 'Manager told', 'notify'),
                'e': N(0, 3, 'Advance to Manager Evaluation', num=4),
                'f': N(2, 4, 'Rate every KRA; strengths, areas to improve; Potential (annual)', num=5),
                'g': N(2, 5, 'Submit (locked)', num=6),
                'h': N(0, 6, 'Change needed?', 'decision', num=7),
                'i': N(0, 7, 'Reopen with a reason', num=8),
                'j': N(3, 7, 'Manager told the reason', 'notify'),
                'k': N(3, 6, 'Waits for HOD Review', 'end'),
            },
            edges=[E('a', 'b'), E('b', 'c'), E('c', 'd'), E('d', 'e', 'later', dash=True, ls=1),
                   E('e', 'f'), E('f', 'g'), E('g', 'h'), E('h', 'k', 'no'),
                   E('h', 'i', 'yes'), E('i', 'j'), E('j', 'f', 'edit and resubmit', ch=(3, 'bottom'), ls=1)],
        )),
        dict(caption='Part B: HOD Review, then Calibration and Publish (§8)', flow=dict(
            lanes=['HR', 'HOD', 'System', 'Employee'],
            nodes={
                'a': N(0, 0, 'Advance to HOD Review', 'start', num=9),
                'b': N(2, 0, 'HODs told', 'notify'),
                'c': N(1, 1, 'Open the queue: own departments, manager-submitted only', num=10),
                'd': N(1, 2, 'Rate (1–5, half steps) and comment; Save', num=11),
                'e': N(1, 3, 'Ready to submit?', 'decision'),
                'f': N(1, 4, 'Submit (locked)', num=12),
                'g': N(0, 5, 'Advance to Calibration (§8)', num=13),
                'h': N(3, 6, 'Sees no other ratings until publish', 'end', num=14),
            },
            edges=[E('a', 'b'), E('b', 'c'), E('c', 'd'), E('d', 'e'), E('e', 'd', 'not yet', via='above'),
                   E('e', 'f', 'yes'), E('f', 'g'), E('g', 'h')],
        )),
    ],
    steps=[
        (1, 'HR', 'Advance to Annual Review (stored as self_appraisal).', 'Everyone told; reminders in March, then a chase 7 days after the phase opened for anyone who has not started.'),
        (2, 'Employee', 'Annual Review: rates each KRA, writes about the year and attaches evidence files (up to 10 MB each).', 'The overall self rating is the weighted average of the KRA ratings.'),
        (3, 'Employee', 'Submits. Locked permanently.', 'The manager is told.'),
        (4, 'HR', 'Advance to Manager Evaluation. Annual Review closes.', 'Managers told.'),
        (5, 'Manager', 'Team Evaluation: rates every KRA, with the employee\'s self rating, attached evidence and the timesheet rating beside each. Writes strengths and areas to improve (AI can draft them). On annual cycles, the Potential step: four questions, 1–5.', 'The overall is the weighted average of the KRA ratings.'),
        (6, 'Manager', 'Submits: every KRA must be rated. Only the employee\'s manager (or HR) submits.', 'Locked.'),
        (7, 'HR', 'Does a submitted evaluation need changing?', 'Only while Manager Evaluation is open; after that HR changes the rating in Calibration.'),
        (8, 'HR', 'PMS Completion Report → Reopen, with a reason.', 'The manager is told the reason, edits and resubmits. Audited.'),
        (9, 'HR', 'Advance to HOD Review.', 'HODs told.'),
        (10, 'HOD', 'HOD Review lists employees of the departments they head whose manager evaluation is submitted. Each shows self, manager and timesheet ratings per KRA.', 'An empty queue says why (no department, not yet the phase, nothing submitted).'),
        (11, 'HOD', 'Gives a rating (1–5 in half steps) and an optional comment; Save keeps it to finish later.', 'A saved rating is not used anywhere until submitted.'),
        (12, 'HOD', 'Submits. Locked; HR can change it only in Calibration, with a reason.', 'Never their own rating; another HOD or HR rates the HOD.'),
        (13, 'HR', 'Advance to Calibration (§8).', 'HR told.'),
        (14, 'Employee', 'Until publish the employee sees only their own rating; the manager\'s, HOD\'s and HR\'s are withheld.', ''),
    ],
    rules=[
        'A HOD can be shown more on the HOD Review tabs: <i>Team analysis</i> (their reporting line\'s progress and ratings) and <i>9-Box Grid (my team)</i>.',
        'The rating carried forward is the HOD\'s submitted rating if there is one, else the manager\'s submitted rating.',
    ],
    statuses='Annual Review: Not started → In progress → Submitted. Manager evaluation and HOD rating: Pending → Submitted.',
))

# 7. Calibration & publish -------------------------------------------------
FLOWS.append(dict(
    id='publish', title='Calibration and Publish',
    why='HR\'s company-wide review of the ratings, and what happens when the cycle is published.',
    who=['HR', 'System', 'Employee', 'Manager'],
    where='HR → Calibration, Cycles, 9-Box Grid, Super 50, Closure Letters, Increment Simulation',
    diagrams=[dict(caption='From Calibration to the published rating', flow=dict(
        lanes=['HR', 'System', 'Employee / Manager'],
        nodes={
            'a': N(0, 0, 'Calibration open', 'start'),
            'b': N(0, 1, 'Compare with the bell curve; budget (kitty)', num=1),
            'c': N(0, 2, 'Adjust a rating?', 'decision', num=2),
            'd': N(0, 3, 'Adjust, with a reason (audited)', num=3),
            'e': N(0, 4, 'Advance to Publish, then Publish', num=4),
            'f': N(1, 5, 'Final = HR adjustment, else HOD, else manager', 'system', num=5),
            'g': N(1, 6, 'Annual cycle?', 'decision', num=6),
            'h': N(1, 7, 'Super 50, 9-box, actions, PIPs, benefit tiers', 'system', num=7, dy=-36),
            'i': N(1, 7, 'Mid-year: a PIP for anyone below the threshold', 'system', dy=36),
            'j': N(2, 5, 'Rating published: Final Rating and My Rating open', 'notify', num=8),
        },
        edges=[E('a', 'b'), E('b', 'c'), E('c', 'd', 'yes'), E('c', 'e', 'no', via='above'), E('d', 'e'),
               E('e', 'f'), E('f', 'g'), E('g', 'h', 'yes', ls=-2), E('g', 'i', 'no', ls=-2), E('f', 'j', 'everyone')],
    ))],
    steps=[
        (1, 'HR', 'Calibration lists everyone with a submitted manager evaluation: manager, HOD and proposed ratings, the timesheet rollup (context only), and the 9-box. The bell curve chart compares the spread with the cycle\'s targets. With compensation access, HR also sees the kitty (budget) and pools.', ''),
        (2, 'HR', 'Change any rating?', ''),
        (3, 'HR', 'Adjust a rating with a reason (required). A 9-box band can be overridden too, also with a reason.', 'Audited (RATING_ADJUSTED); the latest adjustment counts.'),
        (4, 'HR', 'Advance to Publish, then press Publish.', 'Safe to repeat.'),
        (5, 'System', 'For each person: final rating = latest HR adjustment, else submitted HOD rating, else submitted manager rating. Writes the performance history with its letter, and a closure-letter record.', 'People with no submitted manager evaluation are not published.'),
        (6, 'System', 'Annual or mid-year cycle?', ''),
        (7, 'System', 'Annual: recomputes Super 50 (A or A+ for the last 3 years, A+ this year) and alerts HR about anyone leaving it; places everyone on the 9-box and creates each box\'s action; opens a PIP for (0,0) and for unplaced people below Low; adds (2,2) to the succession pool; escalates two years running in (0,0); sets Super 50 benefit tiers. Mid-year: opens a PIP for anyone below the cycle\'s PIP threshold.', 'Managers and HR get one digest each; nothing an employee is sent names a box.'),
        (8, 'System', 'Everyone published is told. Final Rating shows the chain (self → manager → HOD → HR → final); My Rating and Past Cycles open.', ''),
    ],
    rules=[
        'Ratings are stored as numbers and always shown as letters (A+, A, B+, B, C).',
        'Calibration\'s timesheet figures never feed the rating, the distribution or the budget.',
        'Increment Simulation models pay scenarios only; it never writes anybody\'s salary.',
        'After publish HR moves the cycle to Closed: everything becomes history and read-only.',
    ],
))

# 8. Competencies ----------------------------------------------------------
FLOWS.append(dict(
    id='competency', title='Competency assessment',
    why='Each person\'s competencies against the level their role requires: a self-assessment and the manager\'s assessment.',
    who=['Employee', 'Manager', 'HR', 'HOD'],
    where='Self → My Competencies · Manager → Team Competencies · HOD → Team Competencies · HR → Competency Framework, Competency Dashboard',
    diagrams=[dict(caption='Self and manager assessment, with HR reopen', flow=dict(
        lanes=['Employee', 'Manager', 'System', 'HR'],
        nodes={
            'a': N(3, 0, 'Framework: competencies and the level each role requires', 'start', num=1),
            'b': N(0, 1, 'Rate each competency 1–5; technical skills by tier', num=2),
            'c': N(0, 2, 'Submit (every row rated)', num=3),
            'd': N(1, 1, 'Rate each competency 1–5', num=4),
            'e': N(1, 2, 'Submit (every row rated)', num=5),
            'f': N(2, 3, 'Gaps vs required level; feeds 9-box potential', 'system', num=6),
            'g': N(3, 4, 'Reopen a submitted assessment, with a reason', num=7),
            'h': N(2, 5, 'Person told the reason; edits and resubmits', 'notify'),
        },
        edges=[E('a', 'b'), E('a', 'd'), E('b', 'c'), E('d', 'e'), E('c', 'f'), E('e', 'f'),
               E('f', 'g', 'if needed', dash=True, ls=1), E('g', 'h')],
    ))],
    steps=[
        (1, 'HR', 'Competency Framework: competencies by area, with the level each role requires.', ''),
        (2, 'Employee', 'My Competencies: rates each competency 1–5. Technical skills are recorded by tier (Primary, Secondary, Tertiary, Basic).', ''),
        (3, 'Employee', 'Submits. Every competency must be rated; a refused submit marks the blank ones.', 'Locked.'),
        (4, 'Manager', 'Team Competencies: rates each competency for each report.', 'The two halves are independent.'),
        (5, 'Manager', 'Submits.', 'Locked.'),
        (6, 'System', 'Gaps against the required level. On annual cycles the manager\'s submitted ratings are half of the 9-box potential score.', 'HR\'s Competency Dashboard and gaps export; HODs see every active employee of their departments, read-only.'),
        (7, 'HR', 'Competency Dashboard → Reopen a submitted assessment: pick self or manager side and give a reason.', 'The person is told the reason. Audited.'),
    ],
    rules=['Competencies are not tied to a cycle phase.'],
    statuses='Each side: Not started → In progress → Submitted.',
))

# 9. Connects --------------------------------------------------------------
FLOWS.append(dict(
    id='connects', title='Connects (1:1 conversations)',
    why='A record of conversations between two people, signed off by the other person, with reminders when none happen.',
    who=['Person who logs it', 'The other person', 'HR (if asked)', 'System'],
    where='Self → Connects · Manager / HOD / HRBP / HR → Team Connects',
    diagrams=[dict(caption='Logging and signing off a connect (5 and 6 run on their own)', flow=dict(
        lanes=['Person logging', 'System / AI', 'Other person', 'HR'],
        nodes={
            'a': N(0, 0, 'Log a connect: with whom, date, topic, discussion', 'start', num=1),
            'b': N(0, 1, 'Need HR in this connect?', 'decision', num=2),
            'd': N(1, 1, 'Saved; AI sorts into achievements, blockers, feedback', 'ai', num=3),
            'c': N(3, 2, 'The HR person picked is told and can read it', 'notify'),
            'e': N(2, 3, 'Signs it off (never the one who logged it)', num=4),
            'f': N(1, 4, 'Others in the connect told', 'notify'),
            'g': N(1, 5, 'Daily: no connect in 90 days, both reminded', 'system', num=5),
            'h': N(0, 5, 'Suggest training from the last 12 connects', 'ai', num=6),
        },
        edges=[E('a', 'b'), E('b', 'd', 'save'), E('b', 'c', 'yes', ls=1), E('d', 'e'), E('e', 'f')],
    ))],
    steps=[
        (1, 'Either', 'Logs a connect: who it was with (default: their manager; anyone can be picked), date (required), topic, what was discussed, linked KRAs and action items. A manager logs one with a report from Team Connects.', ''),
        (2, 'Either', '“Do you need HR as part of this connect?” Yes → pick one HR person (suggested: the HRBP whose remit covers the employee).', 'That person is told and can read it.'),
        (3, 'System', 'Saves at once; then AI sorts the discussion into Achievements, Blockers and Feedback (“Sorting…”, then “Sorted by AI”). If the AI fails the connect says why and offers Try again; the discussion is always kept as written.', ''),
        (4, 'Other person', 'Signs it off. The person who logged it never signs it off; the other person in it, or HR, does.', 'Everyone else in it is told.'),
        (5, 'System', 'Daily: a pair with no connect in 90 days are both reminded (again after 7 days if still none). A quarterly reminder also goes out the first Monday after each quarter.', ''),
        (6, 'Manager / HR', '<i>Suggest training</i>: AI proposes 3–6 trainings from the person\'s last 12 connects and their KRAs, each citing the connects it came from.', 'A draft; never a rating.'),
    ],
    rules=['Who sees connects: your own; Manager tab — direct reports; HOD — their reporting line; HRBP — their remit; HR — everyone.'],
))

# 10. MoM ------------------------------------------------------------------
FLOWS.append(dict(
    id='mom', title='Daily connects and minutes (MoM)',
    why='A manager\'s daily team call, its minutes and the action items that come out of it.',
    who=['Manager (organiser)', 'Attendees', 'Action-item owner', 'System'],
    where='Connects → MoM · Team Connects → MoM',
    diagrams=[dict(caption='From the daily call to tracked action items', flow=dict(
        lanes=['Manager', 'System / AI', 'Owner / attendees'],
        nodes={
            'a': N(0, 0, 'Save the team Meet link, time and attendees', 'start', num=1),
            'b': N(1, 1, 'Each working day: connect created; link sent 15 min before', 'system', num=2),
            'i': N(1, 2, '6 pm, no MoM: Missing; organiser told', 'notify', num=8),
            'c': N(0, 2, 'After the call: upload or paste the transcript, or type', num=3),
            'd': N(1, 3, 'AI drafts notes, action items, attendance', 'ai'),
            'e': N(0, 4, 'Notes, and owner and due date on every item?', 'decision', num=4),
            'f': N(0, 5, 'Publish', num=5),
            'g': N(2, 6, 'Attendees told; owners get their items', 'notify', num=6),
            'h': N(1, 7, 'Due / overdue reminders; owner\'s manager told at 3 days overdue', 'system', num=7),
        },
        edges=[E('a', 'b'), E('b', 'c'), E('b', 'i', dash=True), E('c', 'd'), E('d', 'e'),
               E('e', 'c', 'no', via='above'), E('e', 'f', 'yes'), E('f', 'g'), E('g', 'h')],
    ))],
    steps=[
        (1, 'Manager', 'Saves the team\'s Google Meet link, daily time and length, and the attendees (all direct reports unless narrowed). Saving the link switches daily connects on; removing it switches them off.', ''),
        (2, 'System', 'Every working day (Monday–Friday less HR\'s holidays): a connect is created and a reminder with the Meet link goes 15 minutes before.', ''),
        (3, 'Manager', 'After the call: uploads or pastes the Meet transcript (AI fills the minutes) or types them.', 'AI names owners and due dates only when they were said; marks “Low confidence” when the transcript is thin.'),
        (4, 'System', 'Notes written, and every action item has an owner and a due date?', 'Otherwise publish is refused.'),
        (5, 'Manager', 'Publishes. A published MoM can be edited or redone with AI later; changes are audited.', ''),
        (6, 'System', 'Attendees are told (nothing to acknowledge); each owner gets their items. Open items carry over to the next MoM until done.', ''),
        (7, 'System', 'Reminders when an item is due and overdue; the owner\'s manager is told at 3 days overdue.', ''),
        (8, 'System', 'At 6 pm a connect with no MoM and no transcript is marked Missing and the organiser told. It can still be written later, or marked “not held” with a reason.', ''),
    ],
    rules=['HR sees all MoMs, the daily report and the settings (transcript retention, 365 days by default).'],
))

# 11. Timesheet ------------------------------------------------------------
FLOWS.append(dict(
    id='timesheet', title='Timesheet to KRA',
    why='Turning logged hours into evidence per KRA: compliance, coverage and a timesheet rating shown beside the manager\'s.',
    who=['Employee', 'Manager', 'HR', 'System'],
    where='Self → Timesheet · Manager → Team Timesheet · HR → Timesheet',
    diagrams=[dict(caption='Upload, map, rate, close', flow=dict(
        lanes=['Employee', 'System', 'Manager', 'HR'],
        nodes={
            'a': N(0, 0, 'Upload a Zoho export or the filled template', 'start', num=1),
            'b': N(1, 1, 'Check the file: problems per row, total hours', 'system', num=2),
            'c': N(0, 2, 'Upload: replaces only the days in the file', num=3),
            'd': N(1, 3, 'Login hours % and hours matched to KRAs', 'system', num=4),
            'e': N(2, 4, 'Map unplaced items to a KRA, or exclude with a note', num=5),
            'f': N(1, 5, 'Timesheet rating per KRA, shown beside the ratings', 'system', num=6),
            'g': N(3, 6, 'Close the month (dry run first)', num=7),
            'h': N(2, 7, 'Override a closed month, with a reason', num=8),
            'i': N(1, 8, 'Rollup shown in Calibration, context only', 'end', num=9),
        },
        edges=[E('a', 'b'), E('b', 'c'), E('c', 'd'), E('d', 'e'), E('e', 'f'), E('f', 'g', 'month over', dash=True, ls=1),
               E('g', 'h'), E('h', 'i')],
    ))],
    steps=[
        (1, 'Employee', 'Uploads a Zoho Sprints export, or the Download template filled in by hand. HR can upload for everyone; anyone else loads only their own rows.', ''),
        (2, 'System', 'Check the file: every problem per row (missing owner or date, an ambiguous date like 05/09/2026, more than 24 hours a log…) and the total hours it will load.', 'Bad rows are not loaded; the rest are.'),
        (3, 'Employee', 'Uploads. A re-upload replaces only the days the file has logs for.', 'Audited.'),
        (4, 'System', 'Login hours % = hours logged ÷ (8 h × working days), graded Green / Amber / Red. Hours reach a KRA by: a mapping, else the KRA\'s own name, else its keywords, else unplaced.', ''),
        (5, 'Manager', 'Team Timesheet → KRA coverage: maps each unplaced work item to a KRA, or excludes it with a note.', 'The employee cannot map their own items.'),
        (6, 'System', 'Per KRA: effort % = hours ÷ expected hours (required hours × the KRA\'s weight share). A+ 100%+, A 80%+, B+ 70%+, B below.', 'Shown on My KRAs, Team KRA Sheets, Team Evaluation and HOD Review. Evidence, never the rating of record.'),
        (7, 'HR', 'Closes a finished month (a dry run first): a snapshot per person.', 'Audited.'),
        (8, 'Manager / HR', 'Overrides a closed month\'s score or grade with a reason.', 'Audited; shown as “overridden”.'),
        (9, 'System', 'The yearly rollup appears in Calibration as context only.', 'It never feeds the rating, the spread or the budget.'),
    ],
    rules=['HR sets the working-day calendar (period start day, holidays), hours per day and the rating bands in Timesheet → Settings.'],
))

# 12. PIP ------------------------------------------------------------------
FLOWS.append(dict(
    id='pip', title='Performance Improvement Plan (PIP)',
    why='A structured plan for someone whose performance needs to improve, with dated checkpoints.',
    who=['Manager', 'HR', 'Employee', 'System'],
    where='Manager → Improvement Plans (or the link on Team Evaluation) · Self → Improvement Plan',
    diagrams=[dict(caption='Opening, running and closing a plan', flow=dict(
        lanes=['Manager / HR', 'Employee', 'System'],
        nodes={
            'a': N(0, 0, 'Manager or HR opens a plan', 'start', num=1),
            's': N(2, 0, 'Or automatically at publish (§8)', 'start'),
            'b': N(0, 1, 'Concern, targeted areas, dated gates (all required)', num=2),
            'c': N(1, 2, 'Told; reads the plan (cannot edit)', 'notify', num=3),
            'd': N(0, 3, 'Weekly notes', num=4),
            'e': N(0, 4, 'Review each gate: met / not met, with a note', num=5),
            'f': N(0, 5, 'Close with a reason', num=6),
            'g': N(2, 6, 'Closed: successful, unsuccessful or withdrawn', 'end', num=7),
        },
        edges=[E('a', 'b'), E('s', 'b'), E('b', 'c'), E('c', 'd'), E('d', 'e'), E('e', 'f'), E('f', 'g')],
    ))],
    steps=[
        (1, 'Manager / HR', 'Opens a plan for a report from Improvement Plans or Team Evaluation. One plan per person per cycle.', 'Publish also opens one automatically (§8).'),
        (2, 'Manager / HR', 'Writes the performance concern, the targeted areas (each with what good looks like) and gates: dated checkpoints within the plan\'s dates.', 'All three are required.'),
        (3, 'Employee', 'Is told; reads the plan on Improvement Plan. The employee cannot edit it.', ''),
        (4, 'Manager / HR', 'Adds weekly notes. Never written by the person on the plan, even if they are HR.', ''),
        (5, 'Manager / HR', 'Reviews each gate as met or not met, with a note. A reviewed gate cannot be removed.', ''),
        (6, 'Manager / HR', 'Closes the plan with a reason.', ''),
        (7, 'System', 'Closed successful, unsuccessful or withdrawn. A closed plan is a record and cannot be changed.', 'Opening, edits, gate reviews and closing are audited and notified.'),
    ],
    rules=['If a later publish moves someone out of (0,0), an untouched automatic plan is withdrawn (the employee is told); one already started is handed to HR.'],
    statuses='Open → In progress → Closed (successful / unsuccessful / withdrawn).',
))

# 13. RnR ------------------------------------------------------------------
FLOWS.append(dict(
    id='rnr', title='Rewards & Recognition (RnR)',
    why='Award cycles, nominations by managers, and the approval chain HOD → HRBP → HR.',
    who=['HR', 'Manager (nominator)', 'HOD', 'HRBP', 'Employee'],
    where='HR → RnR Administration, RnR Final Approval · Manager → Nominate for RnR · HOD → RnR Approvals · HRBP → RnR Approvals · Self → People Hub',
    diagrams=[dict(caption='From nomination to award', flow=dict(
        lanes=['HR', 'Manager', 'System', 'HOD', 'HRBP'],
        nodes={
            'a': N(0, 0, 'Open an award cycle; quota frozen (3%)', 'start', num=1),
            'b': N(1, 1, 'Pick an award; see who qualifies and why not', num=2),
            'c': N(1, 2, 'Nominate a report, with justification', num=3),
            'd': N(3, 3, 'HOD approves?', 'decision', num=4),
            'e': N(4, 4, 'HRBP approves?', 'decision', num=5),
            'i': N(2, 4, 'Sent back or rejected: the nominator sees the reason', 'notify', num=9),
            'f': N(0, 5, 'HR final approval; quota check', 'decision', num=6),
            'g': N(2, 6, 'Final approved: nominee congratulated', 'notify', num=7),
            'h': N(0, 7, 'Mark awarded; winners on People Hub', 'end', num=8),
        },
        edges=[E('a', 'b'), E('b', 'c'), E('c', 'd'), E('d', 'e', 'yes', ls=-2), E('d', 'i', 'no', ls=-2), E('e', 'i', 'no'),
               E('e', 'f', 'yes', ls=-2), E('f', 'g', 'yes', ls=-2), E('g', 'h'),
               E('f', 'i', 'no', ch=(1, 'bottom'), sx=-30, tx=30, ls=1),
               E('i', 'c', 'resubmit if sent back', ch=(1, 'bottom'), ls=1)],
    ))],
    steps=[
        (1, 'HR', 'RnR Administration: award masters (eligibility, needs justification, counts towards quota), then a cycle (quarterly, half-yearly or annual) with nomination dates. Opening it freezes the headcount and the quota (3% by default); HR splits the quota across levels.', ''),
        (2, 'Manager', 'Nominate for RnR → picks an award. The page shows who on their team qualifies, and for everyone else the reason (e.g. tenure, an award already received). Eligibility cannot be changed on the page.', 'Eligibility comes from the employee master.'),
        (3, 'Manager', 'Nominates one of their own reports (or a team, for a team award), with justification, achievement and impact. Only between the cycle\'s open and close dates.', 'Pending HOD; the nominee\'s HOD is told.'),
        (4, 'HOD', 'RnR Approvals: approve, send back or reject (a reason is required for both). Only the nominee\'s own department\'s HOD; never a nomination they raised.', 'Approve → Pending HRBP.'),
        (5, 'HRBP', 'Approve, send back or reject, for people in their remit.', 'Approve → Pending HR.'),
        (6, 'HR', 'RnR Final Approval. The quota is checked here; going over needs an override reason, which is recorded. Loyalty awards sit outside the quota.', ''),
        (7, 'System', 'Final approved: the nominee is congratulated.', ''),
        (8, 'HR', 'Marks it awarded. Winners appear on People Hub from the award date.', ''),
        (9, 'System', 'Sent back or rejected: the nominator sees the reason on Your nominations. A sent-back nomination can be edited and resubmitted; a rejected one cannot.', ''),
    ],
    rules=['Experience windows are half-open: exactly 3.0 years falls into the 3+ award, never two.', 'Every action on a nomination is recorded in its history.'],
    statuses='Pending HOD → Pending HRBP → Pending HR → Final approved → Awarded; Sent back; Rejected.',
))

# 14. Super 50 benefits ----------------------------------------------------
FLOWS.append(dict(
    id='super50', title='Super 50 benefits',
    why='The benefits year for people on the Super 50 list: tiers, a budget claimed against bills, and its lapse.',
    who=['HR', 'Employee', 'System'],
    where='HR → Super 50, Super 50 Benefits · Self → My Super 50',
    diagrams=[dict(caption='Tiers, claims and the lapse', flow=dict(
        lanes=['HR', 'System', 'Employee'],
        nodes={
            'a': N(0, 0, 'Create the benefits year from the policy sheet', 'start', num=1),
            'b': N(1, 1, 'At annual publish: tier by consecutive years', 'system', num=2),
            'c': N(2, 2, 'Told the tier; claims against a hub, with the bill', num=3),
            'd': N(0, 3, 'HR approves?', 'decision', num=4),
            'e': N(2, 4, 'Returned with a reason', 'notify'),
            'f': N(1, 4, 'Approved; balance reduced', 'system'),
            'g': N(1, 5, '30 days before the end: one reminder', 'notify', num=5),
            'h': N(1, 6, 'Year closes; unclaimed money lapses', 'end', num=6),
        },
        edges=[E('a', 'b'), E('b', 'c'), E('c', 'd'), E('d', 'f', 'yes', ls=-1), E('d', 'e', 'no', ch=(2, 'top'), ls=0),
               E('f', 'g'), E('g', 'h')],
    ))],
    steps=[
        (1, 'HR', 'Super 50 Benefits: creates the year (e.g. 2026-27, based on the FY25-26 appraisal, 1 Jul – 30 Jun) with tiers, amounts, benefits and hubs.', ''),
        (2, 'System', 'When the annual cycle is published (or HR presses Set the tiers now): consecutive qualifying years → Super 50 (1), Twice (2), Elite (3+).', 'The person is told in the app and by email.'),
        (3, 'Employee', 'My Super 50: claims against a hub (Knowledge, Health, Personal, Tech) with the amount and the bill (PDF/image, 5 MB). Cannot exceed what is left after approved and waiting claims.', 'Can be withdrawn while waiting.'),
        (4, 'HR', 'Approves (the limit is re-checked) or returns with a reason. Nobody decides their own claim.', ''),
        (5, 'System', 'Once, 30 days before the end, everyone with money left is reminded.', ''),
        (6, 'System', 'The day after the end date the year closes; unclaimed money lapses.', ''),
    ],
    rules=['Twice and Elite choose an IIT/IIM programme from HR\'s catalogue; HR marks it completed. Every awardee can download a certificate.'],
))

# 15. Queries --------------------------------------------------------------
FLOWS.append(dict(
    id='queries', title='Queries',
    why='Questions raised to colleagues or to HR, answered in a thread.',
    who=['Person raising it', 'People it is raised to / HR', 'System'],
    where='Self → People Hub → Queries · HR → Queries',
    diagrams=[dict(caption='Raise, answer, close', flow=dict(
        lanes=['Raiser', 'System', 'Recipients / HR'],
        nodes={
            'a': N(0, 0, 'Raise: title, raise to, description', 'start', num=1),
            'b': N(1, 1, 'Recipients (or all of HR) told, in the app and by email', 'notify', num=2),
            'c': N(2, 2, 'Answer', num=3),
            'd': N(1, 3, 'Answered; raiser emailed', 'notify'),
            'e': N(0, 4, 'Reply needed?', 'decision', num=4),
            'f': N(0, 5, 'Close (anyone in it can)', num=5),
            'g': N(1, 6, 'Closed: no more replies', 'end'),
        },
        edges=[E('a', 'b'), E('b', 'c'), E('c', 'd'), E('d', 'e'), E('e', 'c', 'yes: open again', via='above', ls=1),
               E('e', 'f', 'no'), E('f', 'g')],
    ))],
    steps=[
        (1, 'Raiser', 'Raise query: Title, Raise to (one or more colleagues by name or email; leave empty for HR) and Description.', 'Status Open.'),
        (2, 'System', 'Each recipient is told in the app and by email; a query to HR tells everyone in HR.', ''),
        (3, 'Recipient / HR', 'Answers. HR answers from HR → Queries.', 'Status Answered; the raiser is emailed every answer.'),
        (4, 'Raiser', 'Replies if needed.', 'Status Open again; the others are told in the app.'),
        (5, 'Anyone in it', 'Closes it.', 'No more replies.'),
    ],
    rules=['Only the raiser, the people it is raised to and HR can open a query.'],
    statuses='Open → Answered → (Open again on the raiser\'s reply) → Closed.',
))

# 16. Surveys --------------------------------------------------------------
FLOWS.append(dict(
    id='surveys', title='Engagement surveys',
    why='Pulse, lifecycle, exit and other surveys: audience, anonymity and results.',
    who=['HR (engagement admin)', 'Employee', 'System'],
    where='HR → Engagement Surveys, New Hire Insights · Self → My Surveys',
    diagrams=[dict(caption='From template to results', flow=dict(
        lanes=['HR', 'System', 'Employee'],
        nodes={
            'a': N(0, 0, 'Create from a template; edit the questions', 'start', num=1),
            'b': N(0, 1, 'Audience: rules or tenure trigger; preview', num=2),
            'c': N(0, 2, 'Open', num=3),
            'x': N(1, 2, 'Tenure surveys: a daily sweep invites people as they reach the day', 'system'),
            'd': N(1, 3, 'Invitations; “survey open” notice', 'notify', num=4),
            'e': N(2, 4, 'Answers and submits', num=5),
            'f': N(1, 5, 'Stored without a name unless attributed', 'system', num=6),
            'g': N(0, 6, 'Close; results, eNPS, insights', 'end', num=7),
        },
        edges=[E('a', 'b'), E('b', 'c'), E('c', 'd'), E('x', 'd', dash=True), E('d', 'e'), E('e', 'f'), E('f', 'g')],
    ))],
    steps=[
        (1, 'HR', 'Engagement Surveys → create from a template (quarterly pulse, Day 1 to Day 90, manager about a new report, exit, stay interview, training needs…) or from scratch; edit the questions; choose anonymous or attributed.', 'Draft.'),
        (2, 'HR', 'Audience: departments, designations, bands, managers, a tenure window, or a tenure trigger (e.g. day 30 after joining). Preview shows who would get it.', ''),
        (3, 'HR', 'Opens the survey.', ''),
        (4, 'System', 'Creates one invitation per person and tells them (My Surveys). A tenure survey is swept daily and invites people as they reach the day.', 'Nobody is invited twice.'),
        (5, 'Employee', 'Answers and submits.', ''),
        (6, 'System', 'Completion is recorded on the invitation. The response carries no name unless the survey is attributed or the person chose to put their name to it.', 'A manager-about-report survey is never anonymous.'),
        (7, 'HR', 'Closes it. Results and eNPS; insights use attributed answers only. Exports withhold any group under 5 responses; an HRBP\'s are limited to their remit.', 'Deleting a survey asks first and is audited.'),
    ],
    rules=['External reviews (AmbitionBox, Glassdoor) come in by spreadsheet import into an import-only survey that invites nobody.'],
    statuses='Draft → Open → Closed.',
))

# 17. People changes --------------------------------------------------------
FLOWS.append(dict(
    id='changes', title='When someone\'s manager or job changes',
    why='What moves, what stays and what reopens when HR changes a reporting line or a job.',
    who=['HR', 'System', 'Old manager', 'New manager', 'Employee'],
    where='HR → Employees → Manage (edit profile), or a re-import of the employee master',
    diagrams=[dict(caption='Reporting-line and job changes', flow=dict(
        lanes=['HR', 'System', 'Managers / employee'],
        nodes={
            'a': N(0, 0, 'Changes manager, department, designation or band', 'start', num=1),
            'b': N(1, 1, 'Manager changed?', 'decision', num=2),
            'c': N(1, 2, 'KRA sheet, growth plan and unsubmitted work move to the new manager', 'system', num=3),
            'd': N(2, 3, 'Submitted reviews stay with the old manager, read-only', 'notify', num=4),
            'e': N(1, 4, 'Job changed?', 'decision', num=5),
            'f': N(1, 5, 'Locked KRA sheet, plan and mid-year reopened', 'system', num=6),
            'g': N(2, 6, 'Employee told; revises and resubmits', 'notify', num=7),
        },
        edges=[E('a', 'b'), E('b', 'c', 'yes'), E('c', 'd'), E('d', 'e'), E('b', 'e', 'no', ch=(0, 'bottom'), ls=1),
               E('e', 'f', 'yes'), E('f', 'g')],
    ))],
    steps=[
        (1, 'HR', 'Edits the person on Employees → Manage, or re-imports the master.', ''),
        (2, 'System', 'Did the manager change?', ''),
        (3, 'System', 'The KRA sheet and growth plan follow the employee to the new manager, whatever their state. A mid-year review, manager evaluation or competency assessment the old manager had not submitted also follows.', 'Team lists follow the employee master at once.'),
        (4, 'System', 'Work the old manager already submitted stays with them, marked “former report · read only”: they can open it, not change it.', 'The record keeps the manager it was submitted under.'),
        (5, 'System', 'Did department, designation or band change?', ''),
        (6, 'System', 'A locked KRA sheet, growth plan or mid-year review is reopened (Returned, reason: job changed).', ''),
        (7, 'System', 'The employee is told and revises for the new job.', ''),
    ],
    rules=['<i>Remove</i> (archive) takes a leaver off the lists and stops sign-in, keeping their records; HR can restore them. <i>Erase</i> deletes the person and everything attached to them for good, and asks HR to type ERASE first.'],
))

# 18. Reminders -------------------------------------------------------------
REMINDERS = [
    ('Phase opened', 'HR advances the cycle', 'KRA Setting, Mid-Year, Annual Review: everyone · Mid-Year, Manager Evaluation: managers · HOD Review: HODs · Calibration: HR'),
    ('Mid-year (employee)', '1 Sep, then 15th, 20th, 25th, last Friday', 'Employees, while Mid-Year Review is the phase'),
    ('Mid-year (manager)', 'First Monday of Sep, then the same dates', 'Managers, while Mid-Year Review is the phase'),
    ('Annual review', 'The same pattern in March', 'Employees, then managers, while Annual Review is the phase'),
    ('Chase the manager', 'Every weekday from 3 days after the employee submits', 'Manager, until they act (mid-year, annual, KRA approval, growth approval)'),
    ('Chase the employee', '7 days after the phase opened', 'Anyone who has not started their KRAs, mid-year or annual review'),
    ('Connect due', 'Daily check: no connect in 90 days (again after 7 days)', 'Employee and manager'),
    ('Quarterly connect', 'First Monday after each quarter', 'Employee and manager, unless they already had one'),
    ('Daily connect', '15 minutes before; Missing at 6 pm', 'Attendees; organiser'),
    ('Action item', 'Due, overdue; 3 days overdue', 'Owner; owner\'s manager'),
    ('Super 50 benefits', '30 days before the year ends', 'Awardees with money left'),
    ('Rating published', 'At publish', 'Everyone published'),
]

STATUSES = [
    ('KRA sheet', 'Draft → Submitted → Approved; Returned', 'Employee writes; manager decides; HR reopens'),
    ('Growth plan', 'Draft → Submitted → Approved; Returned', 'Same as the KRA sheet'),
    ('Mid-year (each half)', 'Not started → In progress → Submitted', 'Employee, then manager signs'),
    ('Annual Review', 'Not started → In progress → Submitted', 'Locks on submit'),
    ('Manager evaluation', 'Pending → Submitted', 'HR reopens with a reason'),
    ('HOD rating', 'Pending → Submitted', 'HR changes it only in Calibration'),
    ('Competency (each side)', 'Not started → In progress → Submitted', 'HR reopens with a reason'),
    ('Connect', 'Pending sign-off → Signed off', 'The other person (or HR) signs'),
    ('Daily connect / MoM', 'Scheduled → Draft ready → Published; Missing; Cancelled (not held)', 'Organiser or HR'),
    ('PIP', 'Open → In progress → Closed (successful / unsuccessful / withdrawn)', 'Manager or HR'),
    ('RnR nomination', 'Pending HOD → Pending HRBP → Pending HR → Final approved → Awarded; Sent back; Rejected', 'Each stage approves'),
    ('Query', 'Open → Answered → Closed', 'Raiser, recipients, HR'),
    ('Survey', 'Draft → Open → Closed', 'HR'),
    ('Super 50 claim', 'Submitted (waiting on HR) → Approved or Returned; Withdrawn', 'HR decides; the employee can withdraw while it waits'),
]

SCOPE = [
    ('Employee', 'Their own records'),
    ('Manager', 'Their direct reports (from the employee master)'),
    ('HOD', 'Everyone in the departments they head (HR → HOD)'),
    ('HRBP', 'Their remit: by location or by HOD (HR → HR Business Partners); company settings read-only'),
    ('HR / Super Admin', 'Everyone in the company'),
]


# ---------------------------------------------------------------- page
def faces():
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    out = []
    for w in (400, 500, 600, 700, 800):
        hits = sorted(glob.glob(f'{root}/frontend/dist/assets/inter-latin-{w}-normal-*.woff2'))
        if hits:
            b64 = base64.b64encode(open(hits[0], 'rb').read()).decode()
            out.append("@font-face{font-family:'Inter';font-weight:%d;src:url(data:font/woff2;base64,%s) format('woff2');}" % (w, b64))
    if not out:
        print('  ! frontend/dist not built — PDF will use a system sans')
    return '\n'.join(out)


def table(head, rows, cls=''):
    h = ''.join(f'<th>{x}</th>' for x in head)
    b = ''.join('<tr>' + ''.join(f'<td>{c}</td>' for c in r) + '</tr>' for r in rows)
    return f'<table class="{cls}"><thead><tr>{h}</tr></thead><tbody>{b}</tbody></table>'


def build():
    body = []
    toc = [('overview', '1. The appraisal year at a glance')] + \
          [(f['id'], f'{i + 2}. {f["title"]}') for i, f in enumerate(FLOWS)] + \
          [('reminders', f'{len(FLOWS) + 2}. Reminders and notices'),
           ('appendix', f'{len(FLOWS) + 3}. Statuses and who sees what')]
    body.append(f'''
<section class="cover">
  <div class="brand">Agentic PMS</div>
  <h1>Process Flows</h1>
  <p class="sub">How each process in the Performance Management System runs, step by step:
  who does what, in which order, what the system does and who is told.</p>
  <table class="meta"><tbody>
    <tr><td>For</td><td>HR, managers, QA and developers</td></tr>
    <tr><td>Application</td><td>https://pms.agentichumans.in · build {BUILD}</td></tr>
    <tr><td>Date</td><td>{DATE}</td></tr>
    <tr><td>Rules in detail</td><td>docs/LOGIC-BOOK.md (each rule names the file that enforces it)</td></tr>
  </tbody></table>
  <h3>Contents</h3>
  <ol class="toc">{''.join(f'<li><a href="#{a}">{esc(t)}</a></li>' for a, t in toc)}</ol>
  <h3>How to read the diagrams</h3>
  <p>Each diagram is a swimlane: one row per role, read left to right. The numbers on the boxes match the
  numbered steps in the table under the diagram. Text in <i>italics</i> is a screen or button name.</p>
  <figure class="legend">{legend()}</figure>
</section>''')

    # Overview
    rows = [
        ('<b>Draft</b><br><code>draft</code>', 'HR', 'HR creates the cycle and sets the rating scale, bell curve and PIP threshold. Nothing is open to employees.'),
        ('<b>KRA Setting and Growth Planning</b><br><code>kra_open</code>', 'Employee, manager', 'KRA sheets (§4). Submitting one\'s KRAs opens one\'s growth plan and Aspiring Career (§5).'),
        ('<b>Mid-Year Review</b><br><code>mid_year_review</code>', 'Employee, manager', 'Mid-year self and manager halves (§6); stays open through Annual Review. KRA, KPI and weights editable in the review.'),
        ('<b>Annual Review</b><br><code>self_appraisal</code>', 'Employee', 'Self rating per KRA, with evidence (§7).'),
        ('<b>Manager Evaluation</b><br><code>manager_eval</code>', 'Manager', 'Manager rating per KRA, strengths, areas to improve, Potential (annual). HR can reopen with a reason (§7).'),
        ('<b>HOD Review</b><br><code>hod_eval</code>', 'HOD', 'HOD rating for employees of their departments (§7).'),
        ('<b>Calibration</b><br><code>calibration</code>', 'HR', 'Adjust ratings with reasons; bell curve; budget; 9-box overrides (§8).'),
        ('<b>Publish</b><br><code>publish</code>', 'HR', 'Publish: final ratings, 9-box, Super 50, PIPs, closure letters (§8).'),
        ('<b>Closed</b><br><code>closed</code>', '—', 'History. Nothing editable.'),
    ]
    body.append(f'''
<section id="overview" class="flow-sec">
  <h2>1. The appraisal year at a glance</h2>
  <p class="lede">Everything in the appraisal hangs off one cycle and its phase. HR moves the phase on
  HR → <i>Cycles</i>, one step at a time (forward, or one step back), or cancels a cycle; each move is
  audited and tells the people it opens for.</p>
  <figure>{phase_strip()}<figcaption>The nine phases, and who acts in each</figcaption></figure>
  {table(['Phase', 'Who acts', 'What opens'], rows)}
  <p class="note"><b>Not tied to a phase:</b> competencies (§9), connects and minutes (§10, §11), timesheets (§12),
  improvement plans (§13), Rewards &amp; Recognition (§14), Super 50 benefits (§15), queries (§16) and surveys (§17).
  The KRA sheet itself is open in every phase except Draft and Closed; its own status locks it.</p>
</section>''')

    for i, f in enumerate(FLOWS):
        n = i + 2
        chips = ''.join(f'<span class="chip">{esc(w)}</span>' for w in f['who'])
        for k, d in enumerate(f['diagrams']):
            d['flow']['name'] = f"{f['id']}[{k}]"
        dias = ''.join(f'<figure>{swimlane(d["flow"])}<figcaption>{esc(d["caption"])}</figcaption></figure>'
                       for d in f['diagrams'])
        steps = table(['#', 'Who', 'What happens', 'Result'],
                      [(f'<span class="num">{s[0]}</span>', esc(s[1]), s[2], s[3]) for s in f['steps']], 'steps')
        rules = ''.join(f'<li>{r}</li>' for r in f.get('rules', []))
        st = f'<p class="statuses"><b>Statuses:</b> {esc(f["statuses"])}</p>' if f.get('statuses') else ''
        body.append(f'''
<section id="{f['id']}" class="flow-sec">
  <h2>{n}. {esc(f['title'])}</h2>
  <p class="lede">{esc(f['why'])}</p>
  <p class="where"><b>Who:</b> {chips} <span class="sep"></span><b>Where:</b> {esc(f['where'])}</p>
  {dias}
  <div class="detail">
  <h3>Steps</h3>
  {steps}
  {f'<h3>Rules</h3><ul>{rules}</ul>' if rules else ''}
  {st}
  </div>
</section>''')

    body.append(f'''
<section id="reminders" class="flow-sec">
  <h2>{len(FLOWS) + 2}. Reminders and notices</h2>
  <p class="lede">Sent by the system on a schedule. Every notice is in the bell; those marked for email
  also go by email once HR has switched email to live.</p>
  {table(['Reminder', 'When', 'Who gets it'], REMINDERS)}
  <p class="note">The fiscal year runs April to March. Reminders catch up if a day is missed, and each is sent once:
  the system keeps a ledger of what it already sent.</p>
</section>
<section id="appendix" class="flow-sec">
  <h2>{len(FLOWS) + 3}. Statuses and who sees what</h2>
  <h3>Statuses of each record</h3>
  {table(['Record', 'Statuses', 'Who moves it'], STATUSES)}
  <h3>Whose records each role sees</h3>
  {table(['Role', 'Sees'], SCOPE)}
  <p class="note">Which screens a person may open is set per page by HR's access table; the menu shows only those.
  Nobody sees their own 9-box placement. Ratings given by others are withheld from the employee until publish.</p>
</section>''')

    css = f'''
{faces()}
@page {{ size: A4 landscape; }}
:root {{ --ink:{INK}; --muted:{MUTED}; --line:#d8e0e8; --soft:#f4f7fa; --accent:{ACCENT}; --accent-soft:#e6f1f5; }}
* {{ box-sizing:border-box; }}
html {{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }}
body {{ font-family:Inter,system-ui,sans-serif; font-size:9.2pt; line-height:1.45; color:var(--ink); margin:0; }}
h1 {{ font-size:30pt; font-weight:800; letter-spacing:-.02em; margin:0 0 6pt; color:var(--accent); }}
h2 {{ font-size:15pt; font-weight:700; margin:0 0 6pt; padding-bottom:4pt; border-bottom:2.5pt solid var(--accent); color:var(--accent); }}
h3 {{ font-size:10.5pt; font-weight:700; margin:10pt 0 5pt; break-after:avoid; }}
.flow-sec {{ break-before:page; }}
.cover {{ }}
.brand {{ font-size:11pt; font-weight:700; color:var(--muted); letter-spacing:.06em; text-transform:uppercase; margin-top:6pt; }}
.sub {{ font-size:12pt; color:var(--muted); max-width:620pt; margin:0 0 10pt; }}
table.meta {{ width:auto; margin:0 0 6pt; font-size:9pt; }}
table.meta td {{ border:none; padding:1.5pt 14pt 1.5pt 0; background:none !important; }}
table.meta td:first-child {{ color:var(--muted); font-weight:600; }}
ol.toc {{ columns:3; column-gap:22pt; margin:0 0 6pt; padding-left:0; list-style:none; font-size:9.2pt; }}
ol.toc li {{ margin-bottom:2.5pt; break-inside:avoid; }}
ol.toc a {{ color:var(--ink); text-decoration:none; }}
.lede {{ font-size:10.2pt; margin:0 0 4pt; }}
.where {{ color:var(--muted); font-size:8.6pt; margin:0 0 8pt; }}
.where b {{ color:var(--ink); }}
.chip {{ display:inline-block; background:var(--accent-soft); color:var(--accent); border-radius:8pt; padding:0 6pt; margin:0 3pt 2pt 0; font-weight:600; font-size:8.2pt; }}
.sep {{ display:inline-block; width:10pt; }}
figure {{ margin:0 0 8pt; break-inside:avoid; text-align:center; }}
figure svg.flow {{ max-width:100%; height:auto; }}
figure.legend svg {{ max-width:100%; }}
figcaption {{ font-size:8.4pt; color:var(--muted); margin-top:3pt; font-weight:600; }}
.detail {{ break-before:auto; }}
table {{ width:100%; border-collapse:collapse; margin:0 0 8pt; font-size:8.6pt; }}
thead {{ display:table-header-group; }}
tr {{ break-inside:avoid; }}
th {{ background:var(--accent); color:#fff; font-weight:600; text-align:left; padding:4pt 6pt; font-size:8.3pt; }}
td {{ border-bottom:.5pt solid var(--line); padding:4pt 6pt; vertical-align:top; }}
tbody tr:nth-child(even) td {{ background:#fafcfd; }}
table.steps td:nth-child(1) {{ width:24pt; }}
table.steps td:nth-child(2) {{ width:92pt; font-weight:600; }}
table.steps td:nth-child(4) {{ width:250pt; color:#3a4a5a; }}
.num {{ display:inline-block; width:15pt; height:15pt; line-height:15pt; border-radius:50%; background:var(--accent); color:#fff; text-align:center; font-weight:700; font-size:8pt; }}
ul {{ margin:0 0 6pt; padding-left:14pt; }} li {{ margin-bottom:2pt; }}
.note {{ background:var(--soft); border-left:2.5pt solid var(--accent); padding:5pt 8pt; font-size:8.8pt; }}
.statuses {{ font-size:8.8pt; }}
code {{ font-family:'DejaVu Sans Mono',monospace; font-size:7.8pt; color:var(--muted); }}
'''
    page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Agentic PMS — Process Flows</title><style>{css}</style></head><body>
{''.join(body)}
</body></html>'''
    open(OUT, 'w', encoding='utf-8').write(page)
    print(f'html written: {len(FLOWS) + 3} sections -> {OUT}')
    for w in WARNINGS:
        print('  ! ' + w)


if __name__ == '__main__':
    build()
