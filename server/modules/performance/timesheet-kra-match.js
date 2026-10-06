// Which logged hour belongs to which KRA.
//
// Phase 2 of the Zoho timesheet rating engine. Pure: no db, no express,
// so every rule here is tested against a literal, the same split as
// timesheet-rules.js and kra-keywords.js.
//
// THIS MODULE ATTRIBUTES HOURS. It does not score and it does not grade
// — that is timesheet-kra-score.js, deliberately separate, because the
// attribution has to be inspectable and arguable on its own before any
// number hangs off it.
//
// -------------------------------------------------------------------
// THE ORDER OF PRECEDENCE, and why it is this way round
//
//   1. an explicit mapping   a human said "this item is that KRA"
//   2. the KRA's own name    the item is NAMED after a KRA on the sheet
//   3. a keyword match       the KRA's own words appear in the text
//   4. nothing               and it says so
//
// (2) was added on 6 Oct, after a client upload in which the item names
// had been changed to KRA titles — "Code review, security & architectural
// compliance", "Client escalation response & resolution" — and the screen
// still said 0% mapped. Nothing matched on a KRA's title then, only on its
// keywords, so naming an item after the KRA it serves did nothing. A title
// is a stronger signal than a keyword: somebody chose to write it there.
//
// A mapping beats a keyword because it is a fact somebody asserted,
// where a keyword is a guess about somebody else's free text. Running
// the spec's keyword-only formula over a real client month gave 0%
// coverage; forcing the keywords to fit afterwards gave 14% AND put 88
// hours of delivery work under "Training and team Upskill", because one
// keyword happened to appear in an unrelated story name. The engine
// must be able to be silent, and must never be confidently wrong.
//
// AMBIGUITY IS NOT RESOLVED, IT IS REPORTED. When an entry's text
// matches the keywords of two KRAs, this module attributes it to
// NEITHER and names both candidates. Picking the first, the longest
// match or the heaviest KRA would all be arbitrary, and arbitrary here
// means hours quietly landing on the wrong objective. A human resolves
// it by mapping the item once, which is cheap and permanent.
//
// HOURS ARE SUMMED IN INTEGER HUNDREDTHS. The column is numeric(6,2)
// and the shares feed a percentage that feeds, eventually, a rating.
// 0.1 + 0.2 discipline, the same rule as money in paise: exact in
// integers, divided only at the edge.

// ---- text matching ------------------------------------------------------

// Substring matching is wrong here: "rca" would match "sarcastic", and
// on a real export that is not hypothetical — item names are full of
// product codes and run-together words. A keyword matches only at
// non-alphanumeric boundaries, which also lets a multi-word phrase
// ("cross-team support") match naturally.
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function containsPhrase(haystack, phrase) {
  const p = String(phrase || '').trim().toLowerCase();
  if (!p) return false;
  // \b is unreliable at the edges of a phrase starting or ending in a
  // non-word character, so the boundary is spelled out.
  const re = new RegExp(`(^|[^a-z0-9])${esc(p)}($|[^a-z0-9])`, 'i');
  return re.test(String(haystack || '').toLowerCase());
}

// The text a keyword is matched against. Item name and description
// only.
//
// NOT the sprint, and not the project: every log in a sprint shares one
// sprint name, so a keyword that happened to appear in it would tag the
// entire month at a stroke. That is precisely the confidently-wrong
// failure this module exists to avoid.
const haystackOf = (e) => `${e.item_name || ''} \u0000 ${e.description || ''}`;

// The key an item is mapped by. The export's own id when it has one —
// stable across renames — and the lowercased name when it does not.
//
// ONE ID, SEVERAL NAMES. The same client upload reused one Item Id
// (U5P-I58) for rows named "GFF Activities" and rows renamed to a KRA
// title. Grouped by id alone, every row took the first row's name and the
// renamed ones vanished into it. So when an id carries more than one name
// in the window, each name becomes its own item, keyed `id::name`. A
// mapping saved against the bare id still applies to all of them (see
// attribute), so nothing mapped before this change is lost.
const normName = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').toLowerCase();
function itemKeyOf(e, splitIds = null) {
  const id = String(e.item_id == null ? '' : e.item_id).trim().toLowerCase();
  if (id && splitIds && splitIds.has(id)) return `${id}::${normName(e.item_name)}`;
  if (id) return id;
  return String(e.item_name == null ? '' : e.item_name).trim().replace(/\s+/g, ' ').toLowerCase();
}

// ---- hours in integer hundredths ----------------------------------------

const h100 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const toHours = (n) => Math.round(n) / 100;

// ---- the attribution ----------------------------------------------------

/**
 * @param {object[]} entries  one person's timesheet rows for one window.
 *        Uses item_id, item_name, description, hours, log_date.
 * @param {object[]} kras     that person's KRAs: {id, title, weight, keywords[]}
 * @param {object[]} map      rows from pms.timesheet_kra_map:
 *        {item_key, decision:'kra'|'excluded', kra_id, note}
 * @returns {{items:object[], by_kra:object[], totals:object, unscorable:object[]}}
 */
function attribute(entries, kras, map = []) {
  const byKey = new Map();
  for (const m of map) byKey.set(String(m.item_key || '').toLowerCase(), m);

  const kraById = new Map();
  for (const k of kras) kraById.set(String(k.id), k);

  // WHETHER A KRA IS TRACKED IS A DECLARATION, NOT AN INFERENCE, and it
  // defaults to true. See 065: the first version inferred it — a KRA
  // counted as trackable once something had been mapped to it — which
  // made it trackable BY RECEIVING HOURS, so coverage came out at 100%
  // whenever anything at all was mapped. One hour against one of three
  // equal KRAs reported full coverage. A metric that cannot fall is not
  // a metric.
  //
  // Opting out is the rare, deliberate case: "CSAT Score" is measured
  // from quarterly client feedback and nobody will ever log an hour
  // named after it, so counting it as an uncovered zero every month
  // would mark good people down forever.

  // Group the rows by item first. A month is tens of items and hundreds
  // of rows, and every decision — mapped, keyword, ambiguous — is a
  // property of the ITEM, not of each log against it. Grouping also
  // means the screen can offer "map this item" once instead of once per
  // row.
  const namesById = new Map();
  for (const e of entries) {
    const id = String(e.item_id == null ? '' : e.item_id).trim().toLowerCase();
    if (!id) continue;
    if (!namesById.has(id)) namesById.set(id, new Set());
    namesById.get(id).add(normName(e.item_name));
  }
  const splitIds = new Set([...namesById].filter(([, n]) => n.size > 1).map(([id]) => id));

  const items = new Map();
  for (const e of entries) {
    const key = itemKeyOf(e, splitIds);
    if (!items.has(key)) {
      items.set(key, {
        item_key: key,
        base_key: itemKeyOf(e),
        item_id: e.item_id || null,
        item_label: e.item_name || '(no item name)',
        item_type: e.item_type || null,
        hours100: 0,
        logs: 0,
        first_log: e.log_date || null,
        last_log: e.log_date || null,
        texts: new Set(),
      });
    }
    const it = items.get(key);
    it.hours100 += h100(e.hours);
    it.logs += 1;
    if (e.log_date && (!it.first_log || e.log_date < it.first_log)) it.first_log = e.log_date;
    if (e.log_date && (!it.last_log || e.log_date > it.last_log)) it.last_log = e.log_date;
    if (e.description) it.texts.add(String(e.description));
  }

  const out = [];
  for (const it of items.values()) {
    const hay = `${it.item_label} \u0000 ${[...it.texts].join(' \u0000 ')}`;
    const row = {
      item_key: it.item_key,
      item_id: it.item_id,
      item_label: it.item_label,
      item_type: it.item_type,
      hours: toHours(it.hours100),
      hours100: it.hours100,
      logs: it.logs,
      first_log: it.first_log,
      last_log: it.last_log,
      how: 'unmapped',
      kra_id: null,
      kra_title: null,
      candidates: [],
      note: null,
      matched_keywords: [],
    };

    // A mapping on this exact item wins; then the KRA's own name; then a
    // mapping saved on the bare id before the id was split; then keywords.
    const own = byKey.get(it.item_key);
    const label = normName(it.item_label);
    const titled = own ? [] : kras.filter((k) => {
      const t = normName(k.title);
      return t && (label === t || (t.length >= 12 && containsPhrase(label, t)));
    });
    const m = own || (titled.length ? null : (it.base_key !== it.item_key ? byKey.get(it.base_key) : null));
    if (titled.length === 1) {
      row.how = 'title';
      row.kra_id = String(titled[0].id);
      row.kra_title = titled[0].title;
    } else if (titled.length > 1) {
      row.how = 'ambiguous';
      row.candidates = titled.map((k) => ({ kra_id: String(k.id), kra_title: k.title, keywords: [] }));
    } else if (m && m.decision === 'excluded') {
      row.how = 'excluded';
      row.note = m.note || null;
    } else if (m && m.kra_id && kraById.has(String(m.kra_id))) {
      row.how = 'mapped';
      row.kra_id = String(m.kra_id);
      row.kra_title = kraById.get(String(m.kra_id)).title;
      row.note = m.note || null;
    } else {
      // A mapping pointing at a KRA that no longer exists is treated as
      // no mapping — the sheet was rewritten under it — rather than
      // dropped silently or crashed on.
      if (m && m.kra_id) row.stale_mapping = true;
      const hits = [];
      for (const k of kras) {
        const words = (k.keywords || []).filter((w) => containsPhrase(hay, w));
        if (words.length) hits.push({ kra_id: String(k.id), kra_title: k.title, keywords: words });
      }
      if (hits.length === 1) {
        row.how = 'keyword';
        row.kra_id = hits[0].kra_id;
        row.kra_title = hits[0].kra_title;
        row.matched_keywords = hits[0].keywords;
      } else if (hits.length > 1) {
        // Named, not guessed. See the header.
        row.how = 'ambiguous';
        row.candidates = hits;
      }
    }
    out.push(row);
  }
  out.sort((a, b) => b.hours100 - a.hours100 || a.item_label.localeCompare(b.item_label));

  // ---- roll up to the KRAs ----------------------------------------------
  const per = new Map();
  for (const k of kras) {
    per.set(String(k.id), {
      kra_id: String(k.id),
      title: k.title,
      weight: Number(k.weight) || 0,
      keywords: k.keywords || [],
      hours100: 0,
      items: 0,
      scorable: k.timesheet_tracked !== false,
      untracked_reason: k.timesheet_tracked === false ? (k.timesheet_untracked_reason || null) : null,
    });
  }
  let logged = 0; let excluded = 0; let unmapped = 0; let ambiguous = 0; let attributed = 0;
  for (const r of out) {
    logged += r.hours100;
    if (r.how === 'excluded') { excluded += r.hours100; continue; }
    if (r.how === 'unmapped') { unmapped += r.hours100; continue; }
    if (r.how === 'ambiguous') { ambiguous += r.hours100; continue; }
    const p = per.get(r.kra_id);
    if (p) { p.hours100 += r.hours100; p.items += 1; attributed += r.hours100; }
  }

  // The denominator is what was logged MINUS what was deliberately
  // excluded. Leaving excluded hours in would mark a person down for
  // time the company asked them to spend, which is the fastest way to
  // make a reporting tool into a grievance.
  const considered = logged - excluded;
  const by_kra = [...per.values()]
    .map((p) => ({
      kra_id: p.kra_id,
      title: p.title,
      weight: p.weight,
      keywords: p.keywords,
      scorable: p.scorable,
      untracked_reason: p.untracked_reason,
      items: p.items,
      hours: toHours(p.hours100),
      // Share of the hours that WERE attributed, not of everything
      // logged: it answers "of the work we could place, how much went
      // here", which is the only question the shares can honestly
      // answer while most hours are unplaced.
      share_pct: attributed ? Math.round((p.hours100 / attributed) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.hours - a.hours || b.weight - a.weight || a.title.localeCompare(b.title));

  return {
    items: out,
    by_kra,
    // Marked as not measurable from timesheets. Named on screen with
    // the reason, so an exclusion is visible rather than a silent hole
    // in the denominator.
    unscorable: by_kra.filter((k) => !k.scorable)
      .map((k) => ({ kra_id: k.kra_id, title: k.title, weight: k.weight, reason: k.untracked_reason })),
    // Tracked, but nothing landed on it this window. THE actual finding
    // a manager acts on: an objective that carries weight and saw no
    // logged work. Distinct from the line above, which is a KRA nobody
    // ever expected to see here.
    uncovered: by_kra.filter((k) => k.scorable && k.hours === 0)
      .map((k) => ({ kra_id: k.kra_id, title: k.title, weight: k.weight })),
    totals: {
      logged: toHours(logged),
      considered: toHours(considered),
      attributed: toHours(attributed),
      excluded: toHours(excluded),
      unmapped: toHours(unmapped),
      ambiguous: toHours(ambiguous),
      items: out.length,
      // The number that decides whether any of this is trustworthy yet.
      mapped_pct: considered > 0 ? Math.round((attributed / considered) * 1000) / 10 : 0,
    },
  };
}

// ---- the value-add scan -------------------------------------------------
//
// The spec's A+ trigger: task notes mentioning Automation, Critical Fix,
// Patent and so on.
//
// IT IS SELF-DECLARED AND GAMEABLE, and this function does not pretend
// otherwise. It returns the hits WITH the text that triggered them and
// the item they came from, so a manager reads what the person actually
// wrote rather than a number derived from it. Nothing here decides a
// grade on its own — see the scoring module, where its weight is
// configuration and its evidence travels with it.
function valueAdd(entries, words = []) {
  const list = (words || []).map((w) => String(w).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return { hits: [], hours: 0, words: [], entries: 0 };
  const hits = new Map();
  let hours100 = 0;
  let n = 0;
  for (const e of entries) {
    const hay = haystackOf(e);
    const found = list.filter((w) => containsPhrase(hay, w));
    if (!found.length) continue;
    n += 1;
    hours100 += h100(e.hours);
    for (const w of found) {
      if (!hits.has(w)) hits.set(w, { keyword: w, hours100: 0, logs: 0, examples: [] });
      const x = hits.get(w);
      x.hours100 += h100(e.hours);
      x.logs += 1;
      const ex = String(e.item_name || '').trim();
      if (ex && x.examples.length < 5 && !x.examples.includes(ex)) x.examples.push(ex);
    }
  }
  return {
    hits: [...hits.values()]
      .map((x) => ({ keyword: x.keyword, hours: toHours(x.hours100), logs: x.logs, examples: x.examples }))
      .sort((a, b) => b.hours - a.hours || a.keyword.localeCompare(b.keyword)),
    hours: toHours(hours100),
    entries: n,
    words: list,
  };
}

module.exports = { attribute, valueAdd, containsPhrase, itemKeyOf, haystackOf };
