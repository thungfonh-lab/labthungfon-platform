# labthungfon Platform — Node/Express API (migrated from Google Apps Script)

This is a 1:1 functional port of the original Google Apps Script backend
(`gas-src/*.gs`) to a Node.js/Express backend deployable as Vercel serverless
functions, backed by the same Google Sheet via the Sheets v4 REST API. The
frontend (`gas-src/*.html`) now calls this REST API via `fetch()` instead of
`google.script.run`.

All business logic (scheduling algorithm, payroll/balance math, report
rendering, audit logging) is ported faithfully from the `.gs` files. Only two
architecture pieces were deliberately changed — see "Architecture deviations"
below.

## Project layout

```
api/
  index.js              Express app — mounts all routes, CORS, JSON body parsing.
  helpers.js            Response envelope + getToken() + async route wrapper.
  routes/
    auth.js              /api/auth/login, /api/auth/logout
    schedule.js           /api/bootstrap, /api/schedule/*, /api/stations
    masterdata.js         /api/master/:category, /api/crud, /api/settings, /api/shifts,
                           /api/setup-bundle, /api/holidays*
    transactions.js       /api/oncall*, /api/availability*, /api/overrides
    reports.js            /api/reports/:kind, /api/reports/:kind/export[.xlsx]
    admin.js              /api/permissions, /api/users*, /api/audit-logs
lib/
  googleSheets.js        Low-level Sheets v4 client + readAll/appendRow/updateRow/
                          deleteRow/batchAppend helpers (ported from DataService.gs).
  dataService.js         Settings/master data/transactions/schedules/users/permissions.
  authService.js         Login, JWT session issue/verify, RBAC can()/requirePermission().
  businessService.js     Scheduling algorithm, payroll/balance calculations.
  reportService.js       Report HTML rendering + Excel export.
  notificationService.js Email (nodemailer) + LINE Notify.
  auditService.js        Audit log read/write.
  lockService.js         Settings-sheet-row-based mutex (see deviation #2).
  cacheService.js        In-memory report/calendar cache (per warm instance).
gas-src/                 Original Apps Script source + frontend HTML (now updated
                         to call the REST API instead of google.script.run).
.env.example
vercel.json
package.json
```

## Environment variables

Copy `.env.example` to `.env` for local dev (never commit `.env`):

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | yes | Full JSON contents of the service account key file, **as a single-line JSON string**. Never commit the key file itself — see `.gitignore`. |
| `GOOGLE_SHEETS_ID` | yes | Spreadsheet ID (`1FB4LEHlrT29cxi0tn8S-2UztTQt8FGQifkN79higYP4` for this deployment). |
| `JWT_SECRET` | yes | Long random string used to sign session tokens (HMAC-SHA256 via `jsonwebtoken`). |
| `CORS_ORIGIN` | no | Comma-separated list of allowed origins, or `*` (default) to allow all. |
| `MAIL_HOST` / `MAIL_PORT` / `MAIL_SECURE` / `MAIL_USER` / `MAIL_PASS` / `MAIL_FROM` | no | SMTP settings for nodemailer (NotificationService email sends). If `MAIL_HOST` is unset, email sends are silently skipped (matches the original's `chEmail` settings-gated behavior degrading gracefully). |
| `LINE_TOKEN` | no | LINE Notify token. If unset, the per-organization `settings.lineToken` value (stored in the Settings sheet, configurable from ตั้งค่า > การแจ้งเตือน) is used instead. |
| `PORT` | no | Local dev port for `node api/index.js` (default 3000). |

The service account key file already exists at
`labthungfon-platform-b32d2fe81fd5.json` in the project root — it is listed in
`.gitignore` and must never be committed or pasted into any tracked file. To
populate `GOOGLE_SERVICE_ACCOUNT_KEY` locally, take that file's contents and
minify it to one line (e.g. `node -e "console.log(JSON.stringify(require('./labthungfon-platform-b32d2fe81fd5.json')))"`) and paste the result as the env var value.

## Local development

```bash
npm install
cp .env.example .env   # fill in real values
node api/index.js      # or: npm run dev
# Express listens on http://localhost:3000 by default
```

Alternatively, `vercel dev` can be used if the Vercel CLI is installed and
linked to a project — it will respect the same `.env` file and `vercel.json`
routing.

The frontend (`gas-src/*.html`) auto-detects `localhost`/`127.0.0.1` and points
`API_URL` at `http://localhost:3000` (see `script-core.html`). Since these are
no longer served by Apps Script's `doGet`, serve them with any static file
server for local testing (e.g. `npx serve gas-src`), or open `index.html`
directly with `file://` for quick checks (cross-origin fetch to localhost:3000
works fine as long as `CORS_ORIGIN=*` or includes the file origin).

## Vercel deployment

1. Push this project to a Git repository (the project root is not yet a git
   repo as of this migration — initialize one when ready).
2. In the Vercel dashboard, import the repository.
3. Under **Settings > Environment Variables**, add every variable from the
   table above (`GOOGLE_SERVICE_ACCOUNT_KEY`, `GOOGLE_SHEETS_ID`, `JWT_SECRET`,
   and optionally the `MAIL_*`/`LINE_TOKEN`/`CORS_ORIGIN` vars). Paste the
   service account key JSON as one line into `GOOGLE_SERVICE_ACCOUNT_KEY`.
4. Deploy: `vercel --prod` (or let the dashboard's Git integration deploy on
   push). `vercel.json` routes all `/api/*` requests to `api/index.js`.
5. Update the frontend's `<meta name="api-url" content="...">` tag in
   `gas-src/index.html` to the deployed Vercel URL (e.g.
   `https://labthungfon-platform.vercel.app`) before hosting the static
   frontend anywhere other than `localhost`.

## Architecture deviations from the original GAS backend

The migration spec called for exactly two deliberate architecture changes;
everything else is ported faithfully.

### 1. Sessions: stateless signed JWT instead of GAS CacheService

The original `AuthService.gs` stored sessions in `CacheService.getScriptCache()`
keyed by an opaque UUID token — that cache is per-script-instance and unsafe to
rely on across Vercel serverless cold starts / multiple concurrent instances.

This port instead issues a signed, self-contained JWT on login: the payload
`{userId, name, email, role, exp}` is signed with HMAC-SHA256 using the
`JWT_SECRET` env var (`jsonwebtoken` package), with an 8 hour expiry — the same
duration as the original's `SESSION_TTL_SEC = 8 * 60 * 60`. Validating a
session is just `jwt.verify()` (signature + expiry check) — no server-side
session store is needed at all.

**Known limitation:** because the token is stateless, **logout cannot revoke
it server-side** without maintaining a token blocklist (not implemented in
this migration). `POST /api/auth/logout` is therefore a no-op success
response — the frontend discards its locally stored token (same as before),
but a captured/leaked token would technically remain valid until its 8-hour
expiry even after "logout". This is documented again as a code comment in
`lib/authService.js`.

### 2. Locking: Settings-sheet row instead of GAS LockService

The original `LockService.gs` used `LockService.getScriptLock()`, which is
also per-script-instance and unavailable outside the Apps Script runtime.

This port implements a simple lock as a row in the **Settings** sheet (key
`lock_<lockKey>`, value = JSON `{heldAt, expiresAt}`). Acquiring the lock
checks for an existing non-expired lock row; if none, it writes one with a
~20 second TTL (matching the original's default `tryLock(timeoutMs || 15000)`
poll window) and proceeds. Releasing clears the row's value.

**Known limitation:** this is **best-effort, not perfectly atomic** — there is
a small race window between the read-check and the write-acquire where two
concurrent requests could both believe they acquired the lock (no atomic
compare-and-swap primitive is available via the Sheets values API the way
`LockService.getScriptLock()` provided natively in Apps Script). For this
app's actual concurrency level (a handful of staff occasionally generating or
saving one month's schedule at a time, not a high-throughput system), this is
judged close enough to the original's purpose — preventing two users from
generating/saving the *same* month's schedule simultaneously — to be
acceptable. Documented again as a code comment in `lib/lockService.js`.

## Backups & audit log retention (new features, not in the original GAS system)

The original system created an empty "Backups" Drive folder placeholder
(`Setup.gs`'s `setupDriveFolders_()`) but never actually wrote anything into
it, and `AuditLogs` grew forever with no cleanup. Both are now implemented:

### Backups

`lib/backupService.js` copies the **entire live spreadsheet** (every sheet,
full fidelity) into a Google Drive folder via the Drive API.

**One-time setup required** (service accounts have no usable Drive storage
quota of their own, so the destination folder must belong to a real account):
1. In your own Google Drive, create a folder (e.g. "labthungfon Backups").
2. Share it with the service account's `client_email` (Editor access) — the
   same email already shared on the spreadsheet.
3. Copy the folder ID from its URL (`drive.google.com/drive/folders/<ID>`)
   and set it as `GOOGLE_BACKUP_FOLDER_ID`.

Without that env var, `GET/POST /api/backups` return a clear Thai setup error
instead of a confusing Drive permission error.

- `GET /api/backups` — list backups (newest first)
- `POST /api/backups` — create one now, then prune to the last `keep` (default 14)
- `DELETE /api/backups/:fileId` — remove a single backup
- A Vercel Cron job (`/api/cron/backup`, daily 19:00 UTC = 02:00 Thai time)
  runs this automatically — see `vercel.json`'s `crons` array.
- UI: ตั้งค่า → "สำรองข้อมูล & Audit Log" accordion section.

### Audit log purge

`auditService.purgeOldLogs(olderThanDays)` deletes `AuditLogs` rows older
than the given threshold (default 90 days).

- `POST /api/audit-logs/purge` — body `{ olderThanDays }`, requires `manageSettings`
- A weekly Vercel Cron job (`/api/cron/audit-purge`, Sunday 19:00 UTC) purges
  anything older than 90 days automatically.
- UI: same accordion section as backups, with a day-count input + confirm button.

### Cron auth

Both `/api/cron/*` routes only accept Vercel's auto-injected
`Authorization: Bearer ${CRON_SECRET}` header (sent automatically when the
`CRON_SECRET` env var is set on the project) — set `CRON_SECRET` to any long
random string in both Vercel's env vars and nowhere else; there is no other
way to call these two routes.

**Vercel plan note:** Cron Jobs need at least the Hobby plan's cron
allowance (2 jobs, daily-or-less frequency) — both jobs here qualify (one
daily, one weekly), but confirm your plan supports cron jobs at all before
relying on the automatic schedule; the manual buttons in ตั้งค่า work
regardless.

## Gaps / known approximations (honesty section)

- **Excel export fidelity**: the original `exportExcel()` built an HTML blob
  with an `.xls` MIME type (Excel happily opens HTML tables saved with that
  extension/MIME, preserving all inline styles). `reportService.exportExcel()`
  reproduces this exact approach 1:1 (same HTML, same MIME type, same
  filename pattern) so the download behavior is byte-for-byte equivalent to
  the original. A second, additive endpoint
  (`GET /api/reports/:kind/export.xlsx`) was also added per the migration spec
  to produce a *real* `.xlsx` via `exceljs` — but since the source report is
  HTML (tables/divs/styling, not structured cell data), this second export is
  a simplified plain-text dump of the report content into one workbook sheet,
  not a faithful re-derivation of the original's visual layout. Treat the
  `.xls`-via-HTML export as the fidelity-preserving one; the `.xlsx` is a
  best-effort additive convenience.
- **Locking and sessions**: see "Architecture deviations" above — both are
  intentional, documented tradeoffs, not oversights.
- **Cache**: `cacheService.js` is a plain in-memory `Map` per the migration
  spec (no GAS-style 100KB chunking needed). On Vercel, this means cache
  state does **not** persist across cold starts or between concurrent
  serverless instances — every cold start is effectively a cache miss, which
  recomputes correctly (no staleness risk) but loses the "speeds up clicking
  between menus" benefit the original's persistent CacheService gave within
  its 30s–5min TTL windows on a long-lived Apps Script instance. Acceptable
  given the spec's explicit guidance not to over-engineer this.
- **`avOffSimple_`**: the original `BusinessService.gs` had a stub
  `avOffSimple_()` that always returned `false` (a no-op leftover from a
  refactor, per its own inline comment). It is omitted from the port (its
  call site relied only on the `checkConsec` guard, which is preserved) —
  this changes nothing behaviorally, since the stub never returned anything
  but `false` in the original either.

## Manual testing checklist

Run through this checklist against a real Google Sheet (the spreadsheet ID
configured in `GOOGLE_SHEETS_ID`) after `runFullSetup()`/`seedDemoData()`
equivalent data exists (or reuse the existing production sheet for a staging
check).

- [ ] **Login** — `POST /api/auth/login` with a valid Users-sheet email/password
      returns `{token, user, bootstrap}`; wrong password / inactive account
      returns the exact Thai error messages from the original.
- [ ] **Logout** — `POST /api/auth/logout` returns `{ok: true}` without error.
- [ ] **Bootstrap** — `GET /api/bootstrap` (with a valid token) returns
      `{user, permissions, settings, people}`; missing/expired/invalid token
      returns 401 with the session-expired Thai message.
- [ ] **Generate schedule** — `POST /api/schedule/generate` produces the same
      shape of result (`assign`, `clinicMt`, `clinicLa`, `laB`, `ruleViolations`,
      `postBalanceSwaps`) as the original for a test month; verify the
      generated assignments match the same algorithm output for a known
      input (cross-check against a previously generated GAS run if available).
- [ ] **Save schedule** — `POST /api/schedule/save` persists assignments and
      updates `Schedules` sheet rows correctly (old rows replaced, not
      duplicated).
- [ ] **Publish schedule** — `POST /api/schedule/publish` flips status to
      `published`; requires `publish` permission (403/401 without it).
- [ ] **CRUD master data** (people/station/shift/rateOvr) via `POST /api/crud`
      — create/update/delete each category and confirm `MasterData` sheet rows
      change as expected.
- [ ] **Availability CRUD** — add via `POST /api/availability`, list via
      `GET /api/availability`, delete via `DELETE /api/availability/:txId`.
- [ ] **On-call CRUD** — add/update/delete/list via `/api/oncall*` endpoints.
- [ ] **Holidays CRUD + seed** — add, list, delete, and
      `POST /api/holidays/seed-thai` (verify Thai fixed + lunar-table holidays
      seed correctly, no duplicates on re-run).
- [ ] **Settings save** — `POST /api/settings` patches the `Settings` sheet
      (spot check both new keys and overwriting existing keys).
- [ ] **User management** — create user, set active/inactive, reset password
      (verify the new password hash matches `sha256(salt+':'+password)` and
      can log in), set/unset person link.
- [ ] **Permission matrix** — `GET`/`POST /api/permissions` reflects and
      updates the `Permissions` sheet; verify role-default vs. per-user
      `permsOverride` precedence still works (admin always passes regardless).
- [ ] **Audit log viewing** — `GET /api/audit-logs` with filters
      (`userId`/`module`/`action`/`since`) returns matching rows sorted newest
      first.
- [ ] **Excel export download** — `GET /api/reports/:kind/export` returns a
      file envelope (`filename`, `mimeType`, `base64`) the frontend's existing
      `downloadBase64()` can still decode and download unchanged; spot check
      a couple of report kinds (`pay`, `otsheet`, `teamoverview`).
- [ ] **Frontend smoke test** — serve `gas-src/` statically, point it at a
      running local API (`localhost:3000`), and click through: login →
      dashboard → ตารางเวร (setup/collect/grid/reports/oncall/balance) →
      ผู้ดูแลระบบ (users/modules) → logout. Confirm every Thai string renders
      unchanged and every button/action still triggers the same toast/UI
      feedback as before.
