/**
 * api/index.js — Express entrypoint. Mounts all routes, enables CORS.
 * Works both as a local `node api/index.js` server and as a Vercel serverless
 * function (Express app exported as the default handler).
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const gs = require('../lib/googleSheets');

const authRoutes = require('./routes/auth').router;
const scheduleRoutes = require('./routes/schedule').router;
const masterdataRoutes = require('./routes/masterdata');
const transactionsRoutes = require('./routes/transactions');
const reportsRoutes = require('./routes/reports');
const adminRoutes = require('./routes/admin');
const cronRoutes = require('./routes/cron');

const app = express();

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map((s) => s.trim()) }));
app.use(express.json({ limit: '10mb' }));

// Vercel can reuse a warm serverless instance across unrelated HTTP requests, unlike
// GAS where every execution was a fresh process — without this, lib/googleSheets.js's
// per-process readAll cache could serve a later request's reads from before an
// earlier request's write, even though that write correctly invalidated its own
// instance's copy. See resetCaches()'s comment in lib/googleSheets.js.
app.use((req, res, next) => { gs.resetCaches(); next(); });

app.get('/api/health', (req, res) => res.json({ success: true, data: { ok: true }, message: null }));

app.use('/api/auth', authRoutes);
app.use('/api', scheduleRoutes); // /api/bootstrap, /api/schedule/*, /api/stations
app.use('/api', masterdataRoutes); // /api/master/:category, /api/crud, /api/settings, /api/shifts, /api/setup-bundle, /api/holidays
app.use('/api', transactionsRoutes); // /api/oncall, /api/availability, /api/overrides
app.use('/api', reportsRoutes); // /api/reports/:kind[/export]
app.use('/api', adminRoutes); // /api/permissions, /api/users, /api/audit-logs, /api/backups
app.use('/api', cronRoutes); // /api/cron/backup, /api/cron/audit-purge (Vercel Cron only)

// Fallback 404 in the same envelope shape.
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'ไม่พบ endpoint นี้', statusCode: 404 });
});

// Generic error handler (catches sync throws Express itself might surface).
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 400;
  res.status(statusCode).json({ success: false, error: err.message || String(err), statusCode });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`labthungfon Platform API listening on http://localhost:${port}`);
  });
}

module.exports = app;
