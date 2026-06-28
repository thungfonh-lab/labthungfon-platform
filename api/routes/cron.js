/**
 * cron.js — endpoints invoked by Vercel Cron Jobs (configured in vercel.json's
 * `crons` array), not by the frontend. Vercel automatically sends
 * `Authorization: Bearer ${CRON_SECRET}` on cron-triggered requests when the
 * CRON_SECRET project env var is set — that's the only auth these routes accept
 * (no user session, since cron has none).
 */

const express = require('express');
const { wrap, ok } = require('../helpers');
const backupService = require('../../lib/backupService');
const auditService = require('../../lib/auditService');

const router = express.Router();

function requireCronSecret(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) throw new Error('CRON_SECRET is not set — refusing to run cron endpoint');
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got !== expected) {
    const err = new Error('Unauthorized cron request');
    err.statusCode = 401;
    throw err;
  }
}

// GET /api/cron/backup — daily: copy the spreadsheet, keep the last 14 backups
router.get('/cron/backup', wrap(async (req, res) => {
  requireCronSecret(req);
  const file = await backupService.createBackup();
  const prune = await backupService.pruneBackups(14);
  ok(res, { backup: file, prune });
}));

// GET /api/cron/audit-purge — weekly: delete AuditLogs rows older than 90 days
router.get('/cron/audit-purge', wrap(async (req, res) => {
  requireCronSecret(req);
  ok(res, await auditService.purgeOldLogs(90));
}));

module.exports = router;
