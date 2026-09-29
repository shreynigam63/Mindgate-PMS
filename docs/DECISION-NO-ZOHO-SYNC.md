# Decision: no live Zoho sync

**29 Sep 2026.** Client instruction: *"drop phase 5 as there should be no
zoho sync for now."*

## What this decides

The Zoho timesheet rating engine was planned in five phases. Phases 1–4
are built and deployed. **Phase 5 — a live Zoho Sprints API sync
replacing the monthly upload — is dropped.** Timesheet data reaches the
system by **file upload only**, and that is the intended mechanism, not a
stopgap.

## What was actually built for phase 5

Nothing. It existed only as a line in the phasing proposal. There is no
OAuth code, no credential handling, no scheduler, no `ZOHO_*`
environment variable, and no settings key anywhere in the repository —
verified by search across `server/`, `frontend/` and `deploy/` before
writing this note. Dropping it therefore removed no code and required no
migration.

## What the upload path is

`POST /api/v1/pms/timesheet/upload`, from **Self → Timesheet**. It takes
the Zoho Sprints export as it comes: the header row is found wherever it
sits, only the uploader's own rows are loaded, and re-uploading the same
export changes nothing because a batch replaces the date window it
covers. See `server/modules/performance/timesheet-rules.js`.

Everything downstream — keyword matching, item→KRA mapping, coverage
reporting, settled months, the calibration rollup — reads
`pms.timesheet_entries` and neither knows nor cares how the rows got
there. **A sync, if it is ever wanted, would be a new way to fill that
one table and would change nothing else.** That is why dropping it costs
nothing now and would cost little to revisit.

## What was checked, for the record

Outbound network from the PoC box does reach Zoho —
`accounts.zoho.com` returned 200 and `sprints.zoho.com` returned 302 on
26 Sep. So the decision is not a technical limitation; it is a choice.
What was never configured is a Zoho account with API access, an OAuth
client id and secret, a refresh token, and the Sprints scope.

## Consequences to be aware of

- **Submission timeliness cannot be derived.** The compliance rule counts
  days that carry a log, not whether a sheet was *submitted or locked by
  the 3rd*. The export carries `approval_status` and `approved_by`, which
  may make it inferable, but a criterion worded as "100% on-time
  submission" needs a submission timestamp that the file may not carry.
  This was flagged before phases 1–4 were built and remains open.
- **Data is as fresh as the last upload.** Every timesheet screen defaults
  to the latest period that actually has logs rather than the calendar's
  current month, precisely because an upload lands after the month it
  covers.
