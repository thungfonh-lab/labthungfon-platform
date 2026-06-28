const express = require('express');
const { wrap, ok, getToken } = require('../helpers');
const authService = require('../../lib/authService');
const dataService = require('../../lib/dataService');
const businessService = require('../../lib/businessService');
const cacheService = require('../../lib/cacheService');
const lockService = require('../../lib/lockService');
const auditService = require('../../lib/auditService');
const { buildBootstrap } = require('./auth');

const router = express.Router();

const BALANCE_TOLERANCES = [0, 650, 1300];
function calCacheKey(kind, year, month) { return kind + '_' + year + '_' + month; }
function invalidateCalCache(year, month) {
  cacheService.remove(calCacheKey('cal', year, month));
  cacheService.remove(calCacheKey('workload', year, month));
  BALANCE_TOLERANCES.forEach((t) => cacheService.remove(calCacheKey('bal_' + t, year, month)));
}

// GET /api/bootstrap — api_bootstrap(token)
router.get('/bootstrap', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  ok(res, await buildBootstrap(session.user));
}));

// POST /api/schedule/generate — api_generateSchedule(token, year, month)
router.post('/schedule/generate', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'publish', true);
  const { year, month } = req.body;
  const result = await lockService.run('schedule_' + year + '_' + month, async () => {
    const r = await businessService.generateSchedule(year, month);
    invalidateCalCache(year, month);
    await auditService.logAction(session.user.userId, 'GENERATE', 'Schedules', year + '-' + month, null, { violations: r.ruleViolations.length });
    return r;
  });
  ok(res, result);
}));

// POST /api/schedule/save — api_saveSchedule(token, year, month, assignments, status)
router.post('/schedule/save', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'collect', true);
  const { year, month, assignments, status } = req.body;
  const result = await lockService.run('schedule_' + year + '_' + month, async () => {
    const before = await dataService.getScheduleAssignments(year, month);
    const r = await businessService.saveSchedule(year, month, assignments, status);
    invalidateCalCache(year, month);
    await auditService.logAction(session.user.userId, 'UPDATE', 'Schedules', year + '-' + month, { count: before.length }, { count: assignments.length, status });
    return r;
  });
  ok(res, result);
}));

// POST /api/schedule/publish — api_publishSchedule(token, year, month)
router.post('/schedule/publish', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'publish', false);
  const { year, month } = req.body;
  const result = await businessService.publishSchedule(year, month);
  invalidateCalCache(year, month);
  await auditService.logAction(session.user.userId, 'APPROVE', 'Schedules', year + '-' + month, null, { status: 'published' });
  ok(res, result);
}));

// GET /api/schedule/duty-roster — api_getDutyRoster(token, year, month)
router.get('/schedule/duty-roster', wrap(async (req, res) => {
  authService.requireSession(getToken(req));
  const { year, month } = req.query;
  ok(res, await dataService.getDutyRoster(+year, +month));
}));

// POST /api/schedule/duty-roster — api_setDutyRoster(token, year, month, type, includedIds)
router.post('/schedule/duty-roster', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'manageSettings', false);
  const { year, month, type, includedIds } = req.body;
  const key = type === 'clinic' ? 'includedClinic' : 'included';
  const existing = (await dataService.getDutyRoster(year, month)) || {};
  const patch = { [key]: includedIds };
  const merged = Object.assign({}, existing, patch);
  await dataService.setDutyRoster(year, month, merged, session.user.userId);
  await auditService.logAction(session.user.userId, 'UPDATE', 'DutyRoster', year + '-' + month, null, patch);
  ok(res, { ok: true });
}));

// GET /api/schedule/calendar — api_loadCalendar(token, year, month)
router.get('/schedule/calendar', wrap(async (req, res) => {
  authService.requireSession(getToken(req));
  const year = +req.query.year, month = +req.query.month;
  const result = await cacheService.getOrCompute(calCacheKey('cal', year, month), 45, () => businessService.loadCalendar(year, month));
  ok(res, result);
}));

// GET /api/schedule/workload — api_calculateWorkload(token, year, month)
router.get('/schedule/workload', wrap(async (req, res) => {
  authService.requireSession(getToken(req));
  const year = +req.query.year, month = +req.query.month;
  const result = await cacheService.getOrCompute(calCacheKey('workload', year, month), 45, () => businessService.calculateWorkload(year, month));
  ok(res, result);
}));

// GET /api/schedule/balance — api_getBalance(token, year, month, tolerance)
router.get('/schedule/balance', wrap(async (req, res) => {
  authService.requireSession(getToken(req));
  const year = +req.query.year, month = +req.query.month;
  const tolerance = req.query.tolerance ? +req.query.tolerance : 650;
  const result = await cacheService.getOrCompute(calCacheKey('bal_' + (tolerance || 650), year, month), 45, () => businessService.calculateBalance(year, month, tolerance));
  ok(res, result);
}));

// POST /api/schedule/balance/approve-swap — api_approveBalanceSwap(token, year, month, ovId, unId, shift)
router.post('/schedule/balance/approve-swap', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'override', false);
  const { year, month, ovId, unId, shift } = req.body;
  const result = await lockService.run('schedule_' + year + '_' + month, async () => {
    const r = await businessService.approveBalanceSwap(year, month, ovId, unId, shift);
    invalidateCalCache(year, month);
    await auditService.logAction(session.user.userId, 'UPDATE', 'Overrides', 'balance-swap-day-' + r.day, null, { ovId, unId, shift });
    return r;
  });
  ok(res, result);
}));

// GET /api/stations — api_getStationsForMonth(token, year, month)
router.get('/stations', wrap(async (req, res) => {
  authService.requireSession(getToken(req));
  const year = +req.query.year, month = +req.query.month;
  ok(res, businessService.rotateStationsForMonth(await dataService.getStations(), year, month));
}));

module.exports = { router, invalidateCalCache };
