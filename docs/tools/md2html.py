#!/usr/bin/env python3
"""Markdown -> print-ready HTML, for the PMS testing guide.

Purpose-built rather than a library: no markdown package is available here,
and the guide uses a small, known subset — headings, tables, fenced code,
blockquotes, lists, hr, and inline bold/code/links. Handling exactly that
subset is more predictable than pulling in a general parser and fighting its
table rendering, which is the part that actually matters: tables are most of
this document and they must repeat their header row across page breaks.
"""
import html, re, sys

src, out, title = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(src, encoding='utf-8').read().split('\n')

def inline(t):
    """Inline spans.

    Code spans are lifted out to sentinels FIRST, then the rest is escaped
    and formatted, then the code is put back. Formatting the segments
    between backticks instead — the obvious approach — breaks any bold that
    CONTAINS a code span, because the opening and closing ** land in
    different segments. The guide does that constantly
    ("**No user holds the `hr` role.**"), so it is the normal case here,
    not an edge one.
    """
    codes = []

    def stash(m):
        codes.append('<code>' + html.escape(m.group(1)) + '</code>')
        return f'\x00{len(codes) - 1}\x00'

    t = re.sub(r'`([^`]+)`', stash, t)
    e = html.escape(t)
    e = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', e)
    e = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', e)
    e = re.sub(r'(?<![\w*])\*([^*]+)\*(?![\w*])', r'<em>\1</em>', e)
    return re.sub(r'\x00(\d+)\x00', lambda m: codes[int(m.group(1))], e)

body, toc = [], []
i, in_code, in_table, in_quote, in_list = 0, False, False, False, False

def close_blocks():
    global in_table, in_quote, in_list
    if in_table: body.append('</tbody></table>'); in_table = False
    if in_quote: body.append('</blockquote>'); in_quote = False
    if in_list:  body.append('</ul>'); in_list = False

while i < len(lines):
    ln = lines[i]

    if ln.startswith('```'):
        if not in_code:
            close_blocks(); body.append('<pre><code>'); in_code = True
        else:
            body.append('</code></pre>'); in_code = False
        i += 1; continue
    if in_code:
        body.append(html.escape(ln)); i += 1; continue

    # Table: a header row followed by a |---|---| separator.
    if ln.startswith('|') and i + 1 < len(lines) and re.match(r'^\|[\s:|-]+\|$', lines[i + 1]):
        close_blocks()
        cells = [c.strip() for c in ln.strip('|').split('|')]
        body.append('<table><thead><tr>' +
                    ''.join(f'<th>{inline(c)}</th>' for c in cells) +
                    '</tr></thead><tbody>')
        in_table = True
        i += 2
        continue
    if in_table:
        if ln.startswith('|'):
            cells = [c.strip() for c in ln.strip('|').split('|')]
            body.append('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in cells) + '</tr>')
            i += 1; continue
        body.append('</tbody></table>'); in_table = False

    if ln.startswith('>'):
        close_blocks()
        quoted = []
        while i < len(lines) and lines[i].startswith('>'):
            quoted.append(lines[i].lstrip('>').strip())
            i += 1
        # Blank-line-separated paragraphs within one quote; each is joined
        # before formatting so bold can span its lines.
        body.append('<blockquote>')
        buf = []
        for q in quoted + ['']:
            if q:
                buf.append(q)
            elif buf:
                body.append('<p>' + inline(' '.join(buf)) + '</p>'); buf = []
        body.append('</blockquote>')
        continue

    m = re.match(r'^(#{1,4})\s+(.*)$', ln)
    if m:
        close_blocks()
        lvl, txt = len(m.group(1)), m.group(2)
        if lvl == 1:
            body.append(f'<h1>{inline(txt)}</h1>')
        else:
            anchor = 'sec-' + re.sub(r'[^a-z0-9]+', '-', txt.lower()).strip('-')
            # Each top-level section starts a new page: a guide this size is
            # read section by section, and a heading stranded at the foot of a
            # page is what makes a printed guide hard to use.
            cls = ' class="newpage"' if lvl == 2 else ''
            body.append(f'<h{lvl} id="{anchor}"{cls}>{inline(txt)}</h{lvl}>')
            if lvl == 2:
                toc.append((anchor, txt))
        i += 1; continue

    if re.match(r'^(-{3,}|\*{3,})$', ln.strip()):
        close_blocks(); i += 1; continue          # the --- rules are section separators; the h2 page break replaces them

    m = re.match(r'^[-*]\s+(.*)$', ln)
    if m:
        if not in_list:
            close_blocks(); body.append('<ul>'); in_list = True
        body.append('<li>' + inline(m.group(1)) + '</li>'); i += 1; continue

    m = re.match(r'^(\d+)\.\s+(.*)$', ln)
    if m:
        if not in_list:
            close_blocks(); body.append('<ul class="num">'); in_list = True
        body.append('<li>' + inline(m.group(2)) + '</li>'); i += 1; continue

    if ln.strip() == '':
        if in_list: body.append('</ul>'); in_list = False
        i += 1; continue

    close_blocks()
    # Consecutive non-blank lines are one paragraph (markdown soft wrap).
    para = [ln]
    while i + 1 < len(lines) and lines[i + 1].strip() and not re.match(
            r'^(\||#{1,4}\s|```|>\s|[-*]\s|\d+\.\s|-{3,}$)', lines[i + 1]):
        i += 1; para.append(lines[i])
    # A run of bold-label lines ("**Product:** …", "**As of:** …") is a
    # metadata block whose line breaks carry meaning; ordinary prose is
    # soft-wrapped and must be rejoined. A line that does NOT open with a
    # label continues the one above it, so a wrapped label keeps its line.
    if para[0].lstrip().startswith('**') and sum(
            1 for x in para if x.lstrip().startswith('**')) > 1:
        groups = []
        for x in para:
            if x.lstrip().startswith('**') or not groups:
                groups.append([x])
            else:
                groups[-1].append(x)
        body.append('<p>' + '<br>'.join(inline(' '.join(g)) for g in groups) + '</p>')
    else:
        body.append('<p>' + inline(' '.join(para)) + '</p>')
    i += 1

close_blocks()
if in_code: body.append('</code></pre>')

toc_html = '\n'.join(
    f'<li><a href="#{a}"><span>{html.escape(t)}</span></a></li>' for a, t in toc)

# The title block and contents go in front of the body, after the h1 that
# the markdown itself supplies.
for n, l in enumerate(body):
    if l.startswith('<h1>'):
        body.insert(n + 1, f'<div class="toc"><h2>Contents</h2><ul>{toc_html}</ul></div>')
        break

def _faces():
    """@font-face rules for Inter, built from the product's OWN build output.

    Google Fonts is not reachable from the build sandbox, and a webfont that
    fails to load silently ships the PDF in DejaVu fallbacks — which is
    exactly what the first render of this guide did. Embedding the woff2
    files that frontend/dist already contains makes the output identical
    everywhere and needs no network at all.

    If the frontend has not been built, this returns nothing and the PDF
    falls back to a system sans — readable, just not the product's face.
    """
    import base64, glob, os
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    out = []
    for w in (400, 500, 600, 700, 800):
        hits = sorted(glob.glob(f'{root}/frontend/dist/assets/inter-latin-{w}-normal-*.woff2'))
        if not hits:
            continue
        b64 = base64.b64encode(open(hits[0], 'rb').read()).decode()
        out.append("@font-face{font-family:'Inter';font-style:normal;font-weight:%d;"
                   "font-display:block;src:url(data:font/woff2;base64,%s) format('woff2');}"
                   % (w, b64))
    if not out:
        print('  ! frontend/dist not built — PDF will use a system sans')
    return '\n'.join(out)


FACES = _faces()

open(out, 'w', encoding='utf-8').write(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>
/* Inter embedded from the product's own build output. Google Fonts is not
   reachable from the build sandbox, and a webfont that fails to load ships
   the PDF in DejaVu fallbacks — which is what the first render did. */
{FACES}
</style>
<style>
  :root {{
    --ink:#14212e; --muted:#5b6b7c; --line:#d8e0e8; --soft:#f4f7fa;
    --accent:#0f5f7a; --accent-soft:#e6f1f5; --warn:#8a5a00; --warn-soft:#fdf4e3;
  }}
  * {{ box-sizing:border-box; }}
  html {{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }}
  body {{ font-family:Inter,system-ui,sans-serif; font-size:9.3pt; line-height:1.5;
         color:var(--ink); margin:0; }}
  h1 {{ font-size:23pt; font-weight:800; letter-spacing:-.02em; margin:0 0 4pt;
        color:var(--accent); }}
  h2 {{ font-size:14pt; font-weight:700; letter-spacing:-.01em; margin:0 0 8pt;
        padding-bottom:5pt; border-bottom:2.5pt solid var(--accent); color:var(--accent); }}
  h3 {{ font-size:11pt; font-weight:700; margin:14pt 0 5pt; color:var(--ink); }}
  h4 {{ font-size:9.6pt; font-weight:700; margin:11pt 0 4pt; }}
  h2.newpage {{ break-before:page; }}
  h2.newpage:first-of-type {{ break-before:auto; }}
  h2,h3,h4 {{ break-after:avoid; }}
  p {{ margin:0 0 6pt; }}
  a {{ color:var(--accent); text-decoration:none; }}
  code {{ font-family:'DejaVu Sans Mono','Liberation Mono',monospace; font-size:8.3pt;
          background:var(--soft); border:.5pt solid var(--line);
          border-radius:2.5pt; padding:.5pt 3pt; white-space:nowrap; }}
  pre {{ background:#10202c; color:#e4eef5; border-radius:4pt; padding:8pt 10pt;
         margin:0 0 9pt; break-inside:avoid; }}
  pre code {{ background:none; border:none; color:inherit; font-size:8pt;
              white-space:pre; padding:0; line-height:1.45; }}
  table {{ width:100%; border-collapse:collapse; margin:0 0 10pt; font-size:8.5pt; }}
  thead {{ display:table-header-group; }}   /* repeat the header on every page */
  tr {{ break-inside:avoid; }}
  th {{ background:var(--accent); color:#fff; font-weight:600; text-align:left;
        padding:4.5pt 6pt; font-size:8.2pt; letter-spacing:.01em; }}
  td {{ border-bottom:.5pt solid var(--line); padding:4.5pt 6pt; vertical-align:top; }}
  tbody tr:nth-child(even) td {{ background:#fafcfd; }}
  td:first-child {{ white-space:nowrap; }}
  blockquote {{ background:var(--warn-soft); border-left:2.5pt solid #d9a53a;
                border-radius:0 3pt 3pt 0; padding:6pt 9pt; margin:0 0 9pt;
                break-inside:avoid; }}
  blockquote p {{ margin:0 0 3pt; }} blockquote p:last-child {{ margin:0; }}
  ul {{ margin:0 0 8pt; padding-left:15pt; }}
  li {{ margin-bottom:2.5pt; }}
  ul.num {{ list-style:decimal; }}
  .cover {{ border:1.5pt solid var(--accent); border-radius:5pt; padding:14pt 16pt;
            margin-bottom:14pt; background:var(--accent-soft); }}
  .cover p {{ margin:0 0 3pt; font-size:9pt; }}
  .toc {{ break-after:page; }}
  .toc h2 {{ margin-bottom:9pt; }}
  .toc ul {{ list-style:none; padding:0; column-count:2; column-gap:20pt; }}
  .toc li {{ margin-bottom:4pt; font-size:9pt; break-inside:avoid; }}
  .toc a {{ color:var(--ink); }}
</style></head><body>
{chr(10).join(body)}
</body></html>""")
print(f'html written: {len(toc)} sections')
