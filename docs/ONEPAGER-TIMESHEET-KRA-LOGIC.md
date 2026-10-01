# How timesheet hours are mapped to KRAs

**Agentic PMS · Mindgate** — the rule behind every number on the KRA coverage screen. It reports coverage; it does not produce a rating.

### 1 · How a logged hour finds its KRA

Rows are grouped into **work items** first, so an item is decided once, not once per log — then, in strict order:

| | Rule | Why it ranks there |
|---|---|---|
| **1** | **Explicit mapping** — a human said "this item serves that KRA" | A fact somebody asserted |
| **2** | **Keyword match** — the KRA's own words appear in the item text | A guess about someone else's free text |
| **3** | **Nothing**, and the screen says so | The engine is allowed to be silent |

A mapping beats a keyword because on the client's own month the keyword-only formula gave **0% coverage**, and forcing keywords to fit put 88 hours of delivery work under *Training and team Upskill*. Keywords match **item name and description only** — never the sprint or project, where one word would tag a whole month — and only at word boundaries, so `rca` cannot match `sarcastic`.

**Ambiguity is reported, not resolved.** An item matching two KRAs goes to **neither**, and both are named — choosing the first, longest or heaviest would be arbitrary, and arbitrary means hours on the wrong objective. A manager resolves it with one dropdown.

**Two escape hatches.** *Not KRA work* removes an item from the denominator and **requires a reason on screen**. *Not measured from timesheets* marks a KRA hours can never cover, so it is reported separately rather than sitting as a permanent zero.

### 2 · What the numbers mean

Denominator throughout: **considered = logged − excluded**.

| Number | How it is computed |
|---|---|
| **Hours placed** | attributed ÷ considered. Ambiguous and unmapped hours are not attributed |
| **KRA coverage** | covered weight ÷ scorable weight — **by weight, never by count** |
| **Effort alignment** | 1 − ( Σ of abs(actual share − target share) ) ÷ 2 |
| **Score** | coverage × 50% + compliance × 30% + value-add × 20% |

**Coverage is weighted because counting rewards breadth over value**: every hour in one KRA scored 14%, an hour each across seven scored 100%. **Alignment exists because coverage cannot see proportion** — one hour on a 40% KRA and a hundred on a 5% one is full coverage. Alignment is blank, not zero, when nothing is placed. Every weight, threshold and band lives in a **table, not in code**.

### 3 · A worked example, on real rows

144 hours · two items · seven KRAs, one not measurable from timesheets.

| Step | Result |
|---|---|
| *Tap N Pay* matches **two** KRAs on keywords | ambiguous — 40h to neither, both named |
| Hours placed | **72.2%** — below the 80% minimum, so **no score**, and the reason is printed |
| Manager maps *Tap N Pay* to *TD, BD analysis* | one dropdown, one save |
| Hours placed → coverage → alignment | **100%** → 20÷50 = **40%** → 1−(1.2÷2) = **40%** |
| Compliance **85.7%** → score | **B** |

Alignment stays at 40% at 100% placed, because 104 of the 144 hours sat on a single 10% KRA — the number doing its job.

### 4 · The gate

A score appears only when **HR has switched auto-scoring on** *and* **mapped hours reach the minimum** (80% by default). Otherwise the screen prints one plain sentence per missing thing: a grade computed on a fraction of the evidence is not a measurement, it is an argument.

Closing a month **snapshots** its figures with the configuration that produced them. The rollup weights percentages **by the hours behind them**, not by month, and a manager may override a settled month with a recorded reason. **It does not feed the proposed rating, the distribution or the increment kitty** — and the screen says so.
