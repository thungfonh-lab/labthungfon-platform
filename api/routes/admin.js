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

// ---------------- Backups (new — copies the live spreadsheet into a Drive folder) ----------------

// GET /api/backups — list backup files in the configured Drive folder
router.get('/backups', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  ok(res, await backupService.listBackups());
}));

// POST /api/backups — create a backup now, then prune to the last `keep` (default 14)
router.post('/backups', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const file = await backupService.createBackup();
  await backupService.pruneBackups(req.body.keep);
  await auditService.logAction(session.user.userId, 'CREATE', 'Backups', file.id, null, { name: file.name });
  ok(res, file);
}));

// DELETE /api/backups/:fileId — remove a single backup file
router.delete('/backups/:fileId', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  await backupService.deleteBackup(req.params.fileId);
  await auditService.logAction(session.user.userId, 'DELETE', 'Backups', req.params.fileId, null, null);
  ok(res, { ok: true });
}));

module.exports = router;
