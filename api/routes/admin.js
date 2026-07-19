const express = require('express');
const { wrap, ok, getToken } = require('../helpers');
const authService = require('../../lib/authService');
const dataService = require('../../lib/dataService');
const auditService = require('../../lib/auditService');
const backupService = require('../../lib/backupService');

const router = express.Router();

function parseUserPersonMap(settings) {
  const m = settings.userPersonMap;
  if (!m) return {};
  if (typeof m === 'object') return m;
  try { return JSON.parse(m); } catch (e) { return {}; }
}

// ---------------- Permissions ----------------

// GET /api/permissions — api_listPermissions(token)
router.get('/permissions', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  ok(res, await dataService.getAllPermissions());
}));

// POST /api/permissions — api_setPermission(token, role, action, allowed)
router.post('/permissions', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const { role, action, allowed } = req.body;
  await dataService.setPermission(role, action, allowed);
  await auditService.logAction(session.user.userId, 'UPDATE', 'Permissions', role + '.' + action, null, { allowed });
  ok(res, { ok: true });
}));

// ---------------- Users ----------------

// GET /api/users — api_listUsers(token)
router.get('/users', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const users = await dataService.listUsers();
  const settings = await dataService.getSettings();
  const map = parseUserPersonMap(settings);
  users.forEach((u) => { u.personId = map[u.userId] || ''; });
  ok(res, users);
}));

// POST /api/users — api_createUser(token, name, email, role, plainPassword)
router.post('/users', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const { name, email, role, plainPassword } = req.body;
  const result = await dataService.createUser(name, email, role, plainPassword, authService.hashPassword);
  await auditService.logAction(session.user.userId, 'CREATE', 'Users', result.userId, null, { email, role });
  ok(res, result);
}));

// POST /api/users/:userId — api_updateUser(token, userId, patch)
router.post('/users/:userId', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const { userId } = req.params;
  const { name, email, role } = req.body;
  const result = await dataService.updateUser(userId, { name, email, role });
  await auditService.logAction(session.user.userId, 'UPDATE', 'Users', userId, null, { name, email, role });
  ok(res, result);
}));

// POST /api/users/:userId/set-person — api_setUserPerson(token, userId, personId)
router.post('/users/:userId/set-person', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const { userId } = req.params;
  const { personId } = req.body;
  const settings = await dataService.getSettings();
  const map = parseUserPersonMap(settings);
  if (personId) map[userId] = personId; else delete map[userId];
  await dataService.saveSettings({ userPersonMap: JSON.stringify(map) });
  await auditService.logAction(session.user.userId, 'UPDATE', 'Users', userId, null, { personId });
  ok(res, { ok: true });
}));

// POST /api/users/:userId/set-active — api_setUserActive(token, userId, active)
router.post('/users/:userId/set-active', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const { userId } = req.params;
  const { active } = req.body;
  await dataService.setUserActive(userId, active);
  await auditService.logAction(session.user.userId, 'UPDATE', 'Users', userId, null, { active });
  ok(res, { ok: true });
}));

// POST /api/users/:userId/reset-password — api_resetUserPassword(token, userId, newPlainPassword)
router.post('/users/:userId/reset-password', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const { userId } = req.params;
  const { newPlainPassword } = req.body;
  await dataService.resetUserPassword(userId, newPlainPassword, authService.hashPassword);
  await auditService.logAction(session.user.userId, 'UPDATE', 'Users', userId, null, { passwordReset: true });
  ok(res, { ok: true });
}));

// ---------------- Archive / cleanup ----------------

function calcArchiveCutoff(keepMonths) {
  const now = new Date();
  const totalMonths = now.getFullYear() * 12 + now.getMonth() - keepMonths; // getMonth() = 0-based ทำให้ current month ไม่ถูกลบ
  return { year: Math.floor(totalMonths / 12), month: (totalMonths % 12) + 1 };
}

// GET /api/archive/preview — api_previewArchive(token, keepMonths)
router.get('/archive/preview', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const cutoff = calcArchiveCutoff(Number(req.query.keepMonths));
  const preview = await dataService.previewArchive(cutoff.year, cutoff.month);
  preview.cutoffYear = cutoff.year;
  preview.cutoffMonth = cutoff.month;
  ok(res, preview);
}));

// POST /api/archive — api_archiveOldData(token, keepMonths)
router.post('/archive', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const cutoff = calcArchiveCutoff(Number(req.body.keepMonths));
  const result = await dataService.archiveOldData(cutoff.year, cutoff.month);
  await auditService.logAction(session.user.userId, 'DELETE', 'Archive', 'keepMonths=' + req.body.keepMonths, null, result);
  ok(res, result);
}));

// ---------------- Audit logs ----------------

// GET /api/audit-logs — api_getAuditLogs(token, filters)
router.get('/audit-logs', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const filters = { userId: req.query.userId, module: req.query.module, action: req.query.action, since: req.query.since };
  ok(res, await auditService.getAuditLogs(filters));
}));

// POST /api/audit-logs/purge — new: deletes AuditLogs rows older than body.olderThanDays (default 90)
router.post('/audit-logs/purge', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const result = await auditService.purgeOldLogs(req.body.olderThanDays);
  await auditService.logAction(session.user.userId, 'DELETE', 'AuditLogs', 'purge', null, result);
  ok(res, result);
}));

// ---------------- Backups (new — JSON snapshot of every data sheet, stored in-sheet) ----------------

// GET /api/backups — list backup metadata (newest first)
router.get('/backups', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  ok(res, await backupService.listBackups());
}));

// POST /api/backups — create a backup now, then prune to the last `keep` (default 14)
router.post('/backups', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const backup = await backupService.createBackup();
  await backupService.pruneBackups(req.body.keep);
  await auditService.logAction(session.user.userId, 'CREATE', 'Backups', backup.id, null, backup);
  ok(res, backup);
}));

// GET /api/backups/:backupId/download — reassemble one backup, base64-encoded (same
// {filename, mimeType, base64} envelope reportService.exportExcel uses, so the
// frontend's existing downloadBase64() helper handles this without a new code path).
router.get('/backups/:backupId/download', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const json = await backupService.downloadBackup(req.params.backupId);
  ok(res, {
    filename: req.params.backupId + '.json',
    mimeType: 'application/json',
    base64: Buffer.from(json, 'utf8').toString('base64')
  });
}));

// DELETE /api/backups/:backupId — remove a single backup
router.delete('/backups/:backupId', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  await backupService.deleteBackup(req.params.backupId);
  await auditService.logAction(session.user.userId, 'DELETE', 'Backups', req.params.backupId, null, null);
  ok(res, { ok: true });
}));

module.exports = router;
