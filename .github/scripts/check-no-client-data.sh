#!/usr/bin/env bash
# Fails when the repository holds client data.
#
# WHY (31 Oct 2026): two spreadsheets of a client's employee records sat in
# docs/ for five weeks while this repository was public. Client data lives
# with the client, never in git. CI runs this before the tests; run it by
# hand with:  bash .github/scripts/check-no-client-data.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0

# 1. No spreadsheets or CSV exports, except the synthetic samples in tools/.
bad=$(git ls-files '*.xlsx' '*.xls' '*.csv' | grep -v -E '^tools/sample-employees\.(csv|xlsx)$' || true)
if [ -n "$bad" ]; then
  echo "::error::Spreadsheet or CSV files are not allowed in the repository (client data stays with the client):"
  echo "$bad"
  fail=1
fi

# 2. No addresses at a client's email domain. Add each client's domain here.
CLIENT_DOMAINS='mindgate\.(in|com)'
hits=$(git grep -I -l -i -E "[A-Za-z0-9._%+-]+@(${CLIENT_DOMAINS})" -- . ':!**/node_modules/**' || true)
if [ -n "$hits" ]; then
  echo "::error::Client email addresses found — use example.com / example.in in docs and tests:"
  echo "$hits"
  fail=1
fi

[ "$fail" -eq 0 ] && echo "No client data found."
exit "$fail"
