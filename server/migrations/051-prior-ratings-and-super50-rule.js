// 051 — prior-year appraisal ratings, and the Super 50 rule as data.
//
// Asked for on 24 Sep: "please configure logic of super 50 where
// ratings will be derived from last three annual reviews and ratings
// should be A or A+ with current year ratings as A+."
//
// THE RULE WAS ALREADY THAT. What was wrong is that it could never
// produce anybody here, and nothing on screen said why.
//
// A three-year rule needs three years. This instance has 1,398
// employees, six cycles and ZERO published ones — so the window is
// empty for everyone, Super 50 shows an empty list, and the only
// explanation on the page is "No one currently qualifies", which reads
// like nobody is good enough rather than like the system has no history
// to read.
//
// pms.prior_ratings is that history, loaded from whatever the client
// appraised on before this product existed. It is deliberately NOT
// fabricated cycles: inventing pms.cycles rows for FY24 and FY25 would
// put phantom cycles in every cycle dropdown, every report and every
// phase query in the product, to satisfy one rule. A separate table
// that only the Super 50 window reads costs nothing else.
//
// The two are UNIONed by fiscal year when the rule runs, and a real
// published cycle always wins over an imported row for the same year —
// see super50History() in the performance module.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.prior_ratings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    employee_id uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    -- Free text, because a client's own label for a year ("FY24-25",
    -- "2024") is what their old records carry and re-keying it is how
    -- import errors happen. Ordering is by sort_year below.
    fiscal_year text NOT NULL,
    -- The grade as they recorded it, kept verbatim so the import is
    -- auditable against the file it came from...
    grade text,
    -- ...and the numeric value it maps to on the cycle's rating scale,
    -- which is what the rule actually compares. Both, because a grade
    -- with no value cannot be compared and a value with no grade cannot
    -- be checked by a human.
    rating numeric(3,1) NOT NULL,
    -- Derived from fiscal_year at import: the leading 4-digit year, so
    -- "FY24-25" and "2024" both sort as 2024. Stored rather than parsed
    -- in the query, so the ordering is visible and fixable.
    sort_year int NOT NULL,
    source text NOT NULL DEFAULT 'import',
    imported_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, employee_id, fiscal_year))`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_prior_ratings_emp
                    ON pms.prior_ratings (tenant_id, employee_id, sort_year DESC)`);
};
