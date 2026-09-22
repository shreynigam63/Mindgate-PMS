# docs/tools — regenerating the PDFs

The **markdown in `docs/` is the source of truth.** The PDFs beside it are
generated from it, so edit the markdown and re-render — never edit a PDF.

Two documents are published this way:

| Markdown | PDF |
|---|---|
| `docs/E2E-TESTING-GUIDE.md` | `docs/Agentic-PMS-E2E-Testing-Guide.pdf` |
| `docs/CHANGE-LOG-SEP-2026.md` | `docs/Agentic-PMS-Change-Log-Sep-2026.pdf` |

## Rendering

Two steps: markdown → print-ready HTML, then HTML → PDF via Chromium.

```bash
# The testing guide
python3 docs/tools/md2html.py \
        docs/E2E-TESTING-GUIDE.md /tmp/guide.html \
        "Agentic PMS — End-to-End Testing Guide"

IN=/tmp/guide.html \
OUT=$PWD/docs/Agentic-PMS-E2E-Testing-Guide.pdf \
FOOTER="Agentic PMS — End-to-End Testing Guide" \
  node docs/tools/topdf.js
```

```bash
# The change log
python3 docs/tools/md2html.py \
        docs/CHANGE-LOG-SEP-2026.md /tmp/changelog.html \
        "Agentic PMS — Change Log, September 2026"

IN=/tmp/changelog.html \
OUT=$PWD/docs/Agentic-PMS-Change-Log-Sep-2026.pdf \
FOOTER="Agentic PMS — Changes shipped 17–22 September 2026" \
  node docs/tools/topdf.js
```

`IN` and `OUT` must be **absolute** paths — Chromium loads the input as a
`file://` URL.

## What you need

- **python3** — no packages. `md2html.py` deliberately has no dependencies.
- **playwright-core** and a Chromium build. Neither is a dependency of this
  repo, because they are only needed to regenerate these files and adding
  them would make every `npm ci` pull a browser driver nobody else uses.
  The script searches for playwright and tells you what to do if it cannot
  find one; override either with:

  ```bash
  PW=/path/to/node_modules/playwright-core CHROME=/path/to/chrome ...
  ```

- **`frontend/dist` built.** The PDF embeds Inter from the product's own
  build output (`frontend/dist/assets/inter-latin-*.woff2`). Google Fonts is
  not reachable from the build sandbox, and a webfont that fails to load
  silently ships the PDF in DejaVu fallbacks — which is exactly what the
  first render of the testing guide did. If `frontend/dist` is missing, the
  script says so and falls back to a system sans.

## Why a hand-rolled markdown converter

No markdown package is available in the build sandbox, and these documents
use a small, known subset. The part that actually matters is tables — they
are most of both documents, and they must repeat their header row across
page breaks (`thead { display: table-header-group }`) and never split a row.
Controlling that directly beat fighting a general parser's table output.

Two things it handles that a naive converter gets wrong, both of which bit
the first render:

- **bold containing inline code** — `**No user holds the \`hr\` role.**`.
  Splitting on backticks first puts the opening and closing `**` in
  different segments, so the bold never closes. Code spans are lifted to
  sentinels before formatting instead.
- **bold spanning a soft-wrapped line break.** Lines are joined into a
  paragraph *before* inline formatting runs, not after. Blockquotes gather
  their whole quote first, for the same reason.

## Layout decisions worth knowing

- Every `##` section starts on a fresh page. These are reference documents
  read section by section, and a heading stranded at the foot of a page is
  what makes a printed guide hard to use.
- A two-column contents page is generated from the `##` headings.
- The first column of every table is `white-space: nowrap`, which keeps test
  IDs and commit hashes on one line.
