# labthungfon Platform — Deployment Guide

Source of truth: `labthungfon-platform-v4_43.html`. Business logic in
`BusinessService.gs` / `ReportService.gs` is a direct, line-referenced port —
do not change scoring order, tolerances (`maxC`, `tol=650`, `maxPass=12`), or
the 3 rule-violation checks without re-validating against the original.

## 1. Create the bound Spreadsheet + Apps Script project

1. Create a new Google Sheet — this becomes the database (Sheets backend).
2. Extensions → Apps Script. Note the Script ID (Project Settings).
3. Locally: `npm install -g @google/clasp` (if not installed), `clasp login`.
4. Put your real Script ID into `gas-src/.clasp.json`.
5. From `gas-src/`: `clasp push`.

## 2. Provision the database (one-time)

1. Open the Apps Script editor → select `Setup.gs` → run `runFullSetup`.
   Grant the requested OAuth scopes (Sheets, Drive).
   This creates all 9 Sheets (`Users, Roles, Permissions, MasterData,
   Transactions, Schedules, ReportsCache, AuditLogs, Settings`), seeds
   default roles/permissions (matching the original `CFG.rolePerms`), default
   settings, and the Drive folder tree (`labthungfon-platform-data/{Exports,
   Backups,Attachments}`).
2. Run `seedAdminUser('you@yourhospital.go.th', 'a-strong-temporary-password')`
   once from the editor (select function from dropdown → Run). Delete or
   comment out this call afterwards — do not leave a password in source.
3. In the `MasterData` sheet, import the original `CFG.people` / `CFG.stations`
   / `CFG.shifts` / `CFG.rateOvr` arrays from `labthungfon-platform-v4_43.html`
   (lines ~1607-1622) as rows via the Admin UI (เจ้าหน้าที่ / จุดปฏิบัติงาน /
   ประเภทเวร / อัตราพิเศษ tabs) once logged in, or bulk-paste JSON rows
   directly into the sheet for the initial migration.
4. In `Settings`, fill `rates` (`CFG.rates`) and the scalar fields
   (`org, hosp, prov, maxC, dist, ht, clinicHT, laB, laA, laB2, clinicLa,
   colDay, pubDay, chEmail, chLine, chCal, lineToken, calId, signH, signHT,
   signD, signDT`) to match the original `DEF` config exactly.

## 3. Deploy the web app

1. Apps Script editor → Deploy → New deployment → type "Web app".
2. Execute as: **User accessing the web app** (so MailApp/permissions reflect
   the logged-in user) — or "Me" if you want a shared service identity.
   `appsscript.json` ships with `executeAs: USER_DEPLOYING`; adjust if needed.
3. Who has access: **Anyone within [your Workspace domain]** (matches the
   "Google Workspace First" requirement — do not set "Anyone" publicly).
4. Copy the Web app URL and distribute to staff.

## 4. Re-deploying after changes

```
clasp push          # push code changes
clasp deploy         # create a new versioned deployment (or use the editor UI)
```

`clasp push` alone updates the **HEAD** deployment used by "Test deployments"
but a production web app URL stays pinned to its deployment version — run
`clasp deploy` (or Deploy → Manage deployments → Edit → New version) to push
changes live.

## 5. Security checklist before go-live

- [ ] Remove/disable `seedAdminUser` call after first use.
- [ ] Confirm `appsscript.json` webapp `access` is restricted to your domain.
- [ ] Rotate the admin password after first login (no "change password" UI
      yet — update `Users.passwordHash`/`salt` via `AuthService.hashPassword_`
      from the script editor, or build a self-service flow as a follow-up).
- [ ] Verify `Permissions` sheet matches intended role defaults before
      onboarding non-admin staff — `can()`/`canU()` logic falls back to
      `false` (deny) if a role/action pair is missing, so an empty
      Permissions sheet is fail-closed, not fail-open.
- [ ] Set `CFG`-equivalent `chLine`/`lineToken` only once a real LINE
      Notify/Messaging API channel is provisioned — leaving it blank keeps
      `NotificationService.sendLine_` a no-op, same as the original demo mode.

## 6. Performance notes

- `api_getReport` results are cached for 300s via `AppCache` (CacheService
  chunking, bypasses the 100KB/value cap). Cache is **not** invalidated on
  `generateSchedule`/`saveSchedule` — acceptable staleness window is 5
  minutes; lower `AppCache` TTL in `Code.gs` if tighter freshness is required.
- `generateSchedule`/`saveSchedule`/`publishSchedule` are wrapped in
  `LockService_run` keyed by `schedule_{year}_{month}` to prevent concurrent
  writes to the same month from two users.
- `DataService.saveScheduleAssignments` does a full delete+batch-append for
  the month rather than per-cell writes, to minimize Sheets API calls.

## 7. What was intentionally NOT changed

Per the modernization brief's Restriction list, the following are ported
1:1 from the source HTML and must stay behaviorally identical:

- `generateSchedule()` — cross-month lock, pick() scoring, post-balance pass
  (tol=650, maxPass=12), 3 rule-violation checks (`maxC`, `d_n_overlap`,
  `fri_block_split`).
- `calculateWorkload()` — `collectPay()` shift-bucketing + `payAdj` override
  precedence.
- `rateFor()` — override scoring `(pid?2:0)+(from?1:0)`, highest score wins.
- `can()`/`canU()` — individual `perms` override > role default; `admin`
  always passes.
- All 7 original report layouts (`repOT`, `repN`, `repPay`, `repPayPerson`,
  `repShiftSummary`, `repTeamOverview`, `repOcRec`) and their Word/Excel
  export MIME-blob pattern.

New, additive-only systems: `AuditService`, Backup via Drive folders
(snapshot job not yet scheduled — see Future Expansion), `AppCache`
chunking, `LockService` concurrency, RBAC session auth replacing the dropdown
demo login.
