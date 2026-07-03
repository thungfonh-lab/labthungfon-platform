const express = require('express');
const { wrap, ok, getToken } = require('../helpers');
const authService = require('../../lib/authService');
const dataService = require('../../lib/dataService');
const auditService = require('../../lib/auditService');
const { invalidateCalCache } = require('./schedule');

const router = express.Router();

// ---------------- On-call (api_addOnCall/api_updateOnCall/api_deleteOnCall/api_getOnCallList) ----------------

// POST /api/oncall — api_addOnCall(token, year, month, entry)
router.post('/oncall', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'collect', true);
  const { year, month, entry } = req.body;
  const id = await dataService.addOnCallRecord(year, month, entry.pid, entry, session.user.userId);
  invalidateCalCache(year, month);
  await auditService.logAction(session.user.userId, 'CREATE', 'OnCallRecords', id, null, entry);
  ok(res, { id });
}));

// PUT /api/oncall/:txId — api_updateOnCall(token, year, month, txId, entry)
router.put('/oncall/:txId', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'collect', true);
  const { year, month, entry } = req.body;
  const { txId } = req.params;
  const result = await dataService.updateTransactionById(txId, entry.pid, entry);
  invalidateCalCache(year, month);
  await auditService.logAction(session.user.userId, 'UPDATE', 'OnCallRecords', txId, null, entry);
  ok(res, result);
}));

// DELETE /api/oncall/:txId — api_deleteOnCall(token, year, month, txId)
router.delete('/oncall/:txId', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'collect', true);
  const year = +req.query.year, month = +req.query.month;
  const { txId } = req.params;
  await dataService.deleteTransactionById(txId);
  invalidateCalCache(year, month);
  await auditService.logAction(session.user.userId, 'DELETE', 'OnCallRecords', txId, null, null);
  ok(res, { ok: true });
}));

// GET /api/oncall — api_getOnCallList(token, year, month)
router.get('/oncall', wrap(async (req, res) => {
  authService.requireSession(getToken(req));
  const year = +req.query.year, month = +req.query.month;
  ok(res, { oncall: await dataService.getOnCallRecords(year, month), people: await dataService.getPeople() });
}));

// ---------------- Availability (api_addAvailability/api_listAvailability/api_deleteAvailability) ----------------

// POST /api/availability — api_addAvailability(token, year, month, entry)
router.post('/availability', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'collect', true);
  const { year, month, entry } = req.body;
  const id = await dataService.addAvailability(year, month, entry.pid, entry, session.user.userId);
  invalidateCalCache(year, month);
  await auditService.logAction(session.user.userId, 'CREATE', 'Availability', id, null, entry);
  ok(res, { id });
}));

// GET /api/availability — api_listAvailability(token, year, month)
router.get('/availability', wrap(async (req, res) => {
  authService.requireSession(getToken(req));
  const year = +req.query.year, month = +req.query.month;
  ok(res, await dataService.getAvailability(year, month));
}));

// DELETE /api/availability/:txId — api_deleteAvailability(token, year, month, txId)
router.delete('/availability/:txId', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'collect', true);
  const year = +req.query.year, month = +req.query.month;
  const { txId } = req.params;
  await dataService.deleteTransactionById(txId);
  invalidateCalCache(year, month);
  await auditService.logAction(session.user.userId, 'DELETE', 'Availability', txId, null, null);
  ok(res, { ok: true });
}));

// ---------------- Overrides (api_addOverride) ----------------

// POST /api/overrides — api_addOverride(token, year, month, entry)
router.post('/overrides', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'override', false);
  const { year, month, entry } = req.body;
  if (entry.type === 'manual-remove') await dataService.removeAssignment(year, month, entry.day, entry.shift, entry.from);
  else if (entry.type === 'manual-swap') {
    await dataService.removeAssignment(year, month, entry.day, entry.shift, entry.from);
    await dataService.addAssignment(year, month, entry.day, entry.shift, entry.to);
  } else await dataService.addAssignment(year, month, entry.day, entry.shift, entry.to);
  await dataService.addOverride(year, month, entry, session.user.userId);
  invalidateCalCache(year, month);
  await auditService.logAction(session.user.userId, 'UPDATE', 'Overrides', 'day-' + entry.day, null, entry);
  ok(res, { ok: true });
}));

module.exports = router;
