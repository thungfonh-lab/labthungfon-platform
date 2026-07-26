const express = require('express');
const { wrap, ok, getToken } = require('../helpers');
const authService = require('../../lib/authService');
const dataService = require('../../lib/dataService');
const auditService = require('../../lib/auditService');
const { invalidateCalCache } = require('./schedule');

const router = express.Router();

/** Ported from parseUserPersonMap_()/myPersonId_()/requireOwnPersonOrAdmin_() in Code.gs. */
function parseUserPersonMap(settings) {
  const m = settings.userPersonMap;
  if (!m) return {};
  if (typeof m === 'object') return m;
  try { return JSON.parse(m); } catch (e) { return {}; }
}
async function myPersonId(session) {
  const settings = await dataService.getSettings();
  return parseUserPersonMap(settings)[session.user.userId] || '';
}
/** ตามฟีดแบ็ก: หน้าบันทึก on-call/วันลา ให้แก้ไข/ลบได้แค่ของตัวเอง (เห็นของคนอื่นได้ แต่แก้ไม่ได้) ยกเว้นแอดมิน */
async function requireOwnPersonOrAdmin(session, pid) {
  if (session.user.role === 'admin') return;
  const mine = await myPersonId(session);
  if (!mine || mine !== pid) throw new Error('แก้ไข/ลบได้เฉพาะรายการของตัวเองเท่านั้น');
}

// ---------------- On-call (api_addOnCall/api_updateOnCall/api_deleteOnCall/api_getOnCallList) ----------------

// POST /api/oncall — api_addOnCall(token, year, month, entry)
router.post('/oncall', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'collect', true);
  const { year, month, entry } = req.body;
  // บังคับ pid เป็นของตัวเองเสมอ ยกเว้นแอดมิน — กันแก้ request ฝั่ง client แล้วบันทึกแทนคนอื่น
  if (session.user.role !== 'admin') {
    const mine = await myPersonId(session);
    if (!mine) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับเจ้าหน้าที่ กรุณาติดต่อผู้ดูแลระบบ');
    entry.pid = mine;
  }
  const id = await dataService.addOnCallRecord(year, month, entry.pid, entry, session.user.userId);
  invalidateCalCache(year, month);
  await auditService.logAction(session.user.userId, 'CREATE', 'OnCallRecords', id, null, entry);
  ok(res, { id });
}));

// PUT /api/oncall/:txId — api_updateOnCall(token, year, month, txId, entry) — แก้ได้เฉพาะของตัวเอง ยกเว้นแอดมิน
router.put('/oncall/:txId', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'collect', true);
  const { year, month, entry } = req.body;
  const { txId } = req.params;
  const existing = await dataService.getTransactionById(txId);
  if (!existing) throw new Error('ไม่พบรายการ id=' + txId);
  await requireOwnPersonOrAdmin(session, existing.pid);
  if (session.user.role !== 'admin') entry.pid = existing.pid; // กันเปลี่ยนเจ้าของรายการ
  const result = await dataService.updateTransactionById(txId, entry.pid, entry);
  invalidateCalCache(year, month);
  await auditService.logAction(session.user.userId, 'UPDATE', 'OnCallRecords', txId, null, entry);
  ok(res, result);
}));

// DELETE /api/oncall/:txId — api_deleteOnCall(token, year, month, txId) — ลบได้เฉพาะของตัวเอง ยกเว้นแอดมิน
router.delete('/oncall/:txId', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'collect', true);
  const year = +req.query.year, month = +req.query.month;
  const { txId } = req.params;
  const existing = await dataService.getTransactionById(txId);
  if (existing) await requireOwnPersonOrAdmin(session, existing.pid);
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
  // บังคับ pid เป็นของตัวเองเสมอ ยกเว้นแอดมิน (เหมือน POST /oncall)
  if (session.user.role !== 'admin') {
    const mine = await myPersonId(session);
    if (!mine) throw new Error('บัญชีนี้ยังไม่ได้ผูกกับเจ้าหน้าที่ กรุณาติดต่อผู้ดูแลระบบ');
    entry.pid = mine;
  }
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

// DELETE /api/availability/:txId — api_deleteAvailability(token, year, month, txId) — ลบได้เฉพาะของตัวเอง ยกเว้นแอดมิน
router.delete('/availability/:txId', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  await authService.requirePermission(session.user, 'collect', true);
  const year = +req.query.year, month = +req.query.month;
  const { txId } = req.params;
  const existing = await dataService.getTransactionById(txId);
  if (existing) await requireOwnPersonOrAdmin(session, existing.pid);
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
