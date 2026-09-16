# Change request — "sheet: submitted" → "sheet: submitted to manager"

**Screen:** My KRAs (`/my/kras`)
**Element:** the status chip in the page header, next to the cycle chip
**Type:** display text only — no data, API or schema change
**Size:** one line, or six if done properly (see Option B)

---

## 1. What the user sees, and what they want

| | |
|---|---|
| **Now** | `sheet: submitted` |
| **Wanted** | `sheet: submitted to manager` |

The reason is plain: *"submitted"* on its own does not tell the employee where
the sheet went. Once it is submitted the page is read-only, and the employee's
next question is always "submitted to whom, and what happens now?". Naming the
manager answers it in the chip.

---

## 2. Where it is

**File:** `frontend/src/pages/MyKRASheetPage.jsx`
**Line:** 131 (inside the page header `div`)

```jsx
<span className={`chip ${data.sheet.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : data.sheet.status === 'returned' ? 'bg-rose-100 text-rose-700' : 'bg-navy-50 text-navy-600'}`}>sheet: {data.sheet.status}</span>
```

The chip prints `data.sheet.status` **raw, straight from the database**. That
is the whole cause: `pms.kra_sheets.status` holds the machine value, and the
page shows it to the employee without translating it.

`pms.kra_sheets.status` has exactly four values
(`server/migrations/003-performance-schema.js`, line 33):

```
draft | submitted | approved | returned
```

So `submitted` is not a one-off — all four are raw machine words on this chip.

---

## 3. What must NOT change

> The database value stays `submitted`. This is a **label** change and nothing
> else.

Three places compare the raw status to decide behaviour. If any of them is
"tidied up" to match the new wording, the page breaks:

| File | Line | Compares | Breaks if changed |
|---|---|---|---|
| `frontend/src/pages/MyKRASheetPage.jsx` | 57 | `status === 'approved' \|\| status === 'submitted'` | the sheet stops locking after submission — the employee could edit a submitted sheet |
| `frontend/src/pages/TeamKraSheetsPage.jsx` | 32, 87 | `status === 'submitted'` | the manager's pending count goes to zero and the Approve/Return buttons disappear |
| `frontend/src/pages/KraOrgOverviewPage.jsx` | 212 | `status === 'approved'` | HR loses the reopen control |

Also unchanged: `server/migrations/`, `pms.kra_sheets`, every endpoint under
`/api/v1/performance`, and the API response shape. **No migration runs for
this change.**

---

## 4. Two ways to do it

### Option A — exactly what was asked (one line)

Replace the chip text on line 131:

```jsx
// before
>sheet: {data.sheet.status}</span>

// after
>sheet: {data.sheet.status === 'submitted' ? 'submitted to manager' : data.sheet.status}</span>
```

Done. `submitted` now reads `sheet: submitted to manager`; the other three are
untouched.

### Option B — the same fix, done consistently (recommended)

Option A leaves `draft`, `approved` and `returned` as raw machine words on the
same chip, which is the same defect with a different value. The codebase
already has the pattern for this: `phaseLabel()` in
`frontend/src/utils/api.jsx` (line 30) translates cycle phases for display,
and this very page already uses it one chip to the left.

**Step 1** — add a sibling helper in `frontend/src/utils/api.jsx`, directly
below `phaseLabel` / `phaseColor`:

```js
export const sheetStatusLabel = (s) => ({
  draft:     'draft',
  submitted: 'submitted to manager',
  approved:  'approved by manager',
  returned:  'returned by manager',
}[s] || s);
```

The `|| s` fallback matters — it matches `phaseLabel`'s behaviour, so an
unmapped value degrades to the raw word instead of rendering blank.

**Step 2** — import it in `frontend/src/pages/MyKRASheetPage.jsx` (line 3):

```js
import { api, phaseLabel, phaseColor, sheetStatusLabel } from '../utils/api';
```

**Step 3** — use it on line 131:

```jsx
>sheet: {sheetStatusLabel(data.sheet.status)}</span>
```

Resulting chip text:

| Status in the database | Chip reads |
|---|---|
| `draft` | sheet: draft |
| `submitted` | **sheet: submitted to manager** |
| `approved` | sheet: approved by manager |
| `returned` | sheet: returned by manager |

The chip colours stay exactly as they are — green for approved, rose for
returned, navy otherwise. Only the words change.

---

## 5. Elsewhere the same raw status is shown

Out of scope for this request — listed so the decision is deliberate, not
accidental:

| Screen | File | Line | Shows |
|---|---|---|---|
| Team KRA Sheets | `frontend/src/pages/TeamKraSheetsPage.jsx` | 54 | `{s.status}` raw |
| KRA Overview (HR) | `frontend/src/pages/KraOrgOverviewPage.jsx` | 124 | `{e.status.replace('_', ' ')}` |

Both are manager/HR audiences, where "submitted" is unambiguous — they are the
manager. Leave them as they are unless HR asks. If Option B is taken, changing
them later is a one-line edit each, because the helper already exists.

---

## 6. How to verify

1. Sign in as an employee whose sheet is **not yet submitted**, open
   **My KRAs**. Chip reads `sheet: draft`.
2. Make the weights total 100 and submit. Chip reads
   **`sheet: submitted to manager`**, and the KRA fields go read-only.
3. Sign in as that employee's manager, open **Team KRA Sheets**. The employee
   still appears in the pending count, and Approve / Return are both available
   — this proves the status value itself was not touched.
4. Return the sheet. Back on the employee's My KRAs, the chip is rose and reads
   `sheet: returned by manager` (Option B) or `sheet: returned` (Option A), and
   the manager's comment banner appears below it.
5. Approve it. Chip is green.

No server restart is needed for any of this; it is frontend only.

---

## 7. Shipping it

This is a **frontend** change, so unlike an environment-variable change it does
need a build:

```bash
# from the repo root
cd frontend && npm run build
```

Then deploy the built bundle the way this instance normally receives one:

- **systemd (EC2):** `deploy/service/install.sh` already does this — it builds
  with `VITE_API_URL` unset and rsyncs `frontend/dist/` into
  `/var/www/agentic-pms`, then reloads nginx. The API service does not need
  restarting.
- **Docker:** rebuild and recreate the web container; the API and database
  containers are untouched.
- **Render:** the frontend service redeploys on push; the API service needs
  nothing.

> `VITE_API_URL` must stay **unset** on EC2. It is read at build time, and
> setting it makes the bundle call an absolute URL instead of the same-origin
> `/api/v1`. Nothing about this change requires it.

---

## 8. Checklist

- [ ] Option A or Option B agreed before coding (B recommended).
- [ ] Only display text changed; no `status === '…'` comparison edited.
- [ ] No file under `server/` modified.
- [ ] Chip verified at all four statuses.
- [ ] Manager's Team KRA Sheets queue still shows the sheet as pending after
      submission.
- [ ] Frontend rebuilt and redeployed; API not restarted.

---

*Agentic PMS · Mindgate Solutions — change request. Raised from a My KRAs
screenshot; scope is the one status chip on that page.*
