# docs/tools — regenerating the testing guide PDF

`docs/E2E-TESTING-GUIDE.md` is the **source of truth**. The PDF beside it is
generated from that markdown, so edit the markdown and re-render — never
edit the PDF.

```bash
# 1. markdown -> print-ready HTML
python3 docs/tools/md2html.py \
        docs/E2E-TESTING-GUIDE.md /tmp/e2e-print.html \
        "Agentic PMS — End-to-End Testing Guide"

# 2. HTML -> PDF (Chromium print)
SP=/tmp node docs/tools/e2e-topdf.js
cp /tmp/Agentic-PMS-E2E-Testing-Guide.pdf docs/
```

## What you need

- **python3** — no packages; `md2html.py` deliberately has no dependencies.
- **playwright-core** and a Chromium build. Neither is a dependency of this
  repo, because they are only needed to regenerate this one file and adding
  them would make every `npm ci` pull a browser driver nobody else uses.
  Point the script at them:

  ```bash
  PW=/path/to/node_modules/playwright-core \
  CHROME=/path/to/chrome \
  SP=/tmp node docs/tools/e2e-topdf.js
  ```

- **`frontend/dist` built.** The PDF embeds Inter from the product's own
  build output (`frontend/dist/assets/inter-latin-*.woff2`). Google Fonts is
  not reachable from the build sandbox, and a webfont that fails to load
  silently ships the PDF in DejaVu fallbacks — which is exactly what the
  first render of this guide did. If `frontend/dist` is missing, the script
  says so and falls back to a system sans.

## Why a hand-rolled markdown converter

No markdown package is available in the build sandbox, and the guide uses a
small, known subset. The part that actually matters is tables — they are
most of the document, and they must repeat their header row across page
breaks (`thead { display: table-header-group }`) and never split a row.
Controlling that directly beat fighting a general parser's table output.

Two things it handles that a naive converter gets wrong, both of which bit
the first render:

- **bold containing inline code** — `**No user holds the \`hr\` role.**`.
  Splitting on backticks first puts the opening and closing `**` in
  different segments, so the bold never closes. Code spans are lifted to
  sentinels before formatting instead.
- **bold spanning a soft-wrapped line break.** Lines are joined into a
  paragraph *before* inline formatting runs, not after.
