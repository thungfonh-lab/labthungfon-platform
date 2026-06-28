const express = require('express');
const { wrap, ok, getToken } = require('../helpers');
const authService = require('../../lib/authService');
const dataService = require('../../lib/dataService');
const auditService = require('../../lib/auditService');
const { invalidateCalCache } = require('./schedule');

const router = express.Router();

// GET /api/master/:category — api_listMaster(token, category)
router.get('/master/:category', wrap(async (req, res) => {
  authService.requireSession(getToken(req));
  const getters = {
    people: dataService.getPeople,
    station: dataService.getStations,
    shift: dataService.getShifts,
    rateOvr: dataService.getRateOverrides
  };
  const fn = getters[req.params.category];
  if (!fn) { const e = new Error('ไม่รู้จัก category: ' + req.params.category); throw e; }
  ok(res, await fn());
}));

// POST /api/crud — api_crud(token, entity, op, payload)
router.post('/crud', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const { entity, op, payload } = req.body;
  const before = (op === 'update' || op === 'delete') ? await dataService.getMasterRecord(entity, payload.id) : null;
  const result = await dataService.crudMasterData(entity, op, payload);
  await auditService.logAction(session.user.userId, op.toUpperCase(), entity, payload.id || result.id, before, payload);
  ok(res, result);
}));

// POST /api/settings — api_saveSettings(token, patch)
router.post('/settings', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const { patch } = req.body;
  const before = await dataService.getSettings();
  const result = await dataService.saveSettings(patch);
  await auditService.logAction(session.user.userId, 'UPDATE', 'Settings', 'org', before, patch);
  ok(res, result);
}));

// POST /api/shifts — api_updateShifts(token, shifts)
router.post('/shifts', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const { shifts } = req.body;
  const result = await dataService.crudMasterDataBulk(dataService.MASTER_CATEGORY.SHIFT, shifts);
  await auditService.logAction(session.user.userId, 'UPDATE', 'Shifts', 'bulk', null, { count: shifts.length });
  ok(res, result);
}));

// GET /api/setup-bundle — api_getSetupBundle(token, year, month)
router.get('/setup-bundle', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const year = +req.query.year, month = +req.query.month;
  ok(res, {
    settings: await dataService.getSettings(),
    people: await dataService.getPeople(),
    stations: await dataService.getStations(),
    shifts: await dataService.getShifts(),
    rateOvr: await dataService.getRateOverrides(),
    holidays: await dataService.getHolidays(year, month),
    permissions: await dataService.getAllPermissions()
  });
}));

// ---------------- Holidays ----------------

// GET /api/holidays — api_listHolidays(token, year, month)
router.get('/holidays', wrap(async (req, res) => {
  authService.requireSession(getToken(req));
  const year = +req.query.year, month = +req.query.month;
  ok(res, await dataService.getHolidays(year, month));
}));

// POST /api/holidays — api_addHoliday(token, year, month, entry)
router.post('/holidays', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const { year, month, entry } = req.body;
  entry.year = year; entry.month = month;
  const result = await dataService.crudMasterData(dataService.MASTER_CATEGORY.HOLIDAY, 'create', entry);
  invalidateCalCache(year, month);
  await auditService.logAction(session.user.userId, 'CREATE', 'Holidays', result.id, null, entry);
  ok(res, result);
}));

// POST /api/holidays/seed-thai — api_seedThaiHolidays(token, year)
router.post('/holidays/seed-thai', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const { year } = req.body;
  const result = await dataService.seedThaiHolidays(year);
  for (let m = 0; m < 12; m++) invalidateCalCache(year, m);
  await auditService.logAction(session.user.userId, 'CREATE', 'Holidays', 'seed-' + year, null, result);
  ok(res, result);
}));

// DELETE /api/holidays/:id — api_deleteHoliday(token, year, month, id)
router.delete('/holidays/:id', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const year = +req.query.year, month = +req.query.month;
  const { id } = req.params;
  await dataService.crudMasterData(dataService.MASTER_CATEGORY.HOLIDAY, 'delete', { id });
  invalidateCalCache(year, month);
  await auditService.logAction(session.user.userId, 'DELETE', 'Holidays', id, null, null);
  ok(res, { ok: true });
}));

module.exports = router;
