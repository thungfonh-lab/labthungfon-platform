const express = require('express');
const { wrap, ok, getToken } = require('../helpers');
const authService = require('../../lib/authService');
const reportService = require('../../lib/reportService');
const cacheService = require('../../lib/cacheService');
const auditService = require('../../lib/auditService');

const router = express.Router();

// GET /api/reports/:kind — api_getReport(token, kind, year, month, pid)
router.get('/reports/:kind', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  const { kind } = req.params;
  const year = +req.query.year, month = +req.query.month, pid = req.query.pid || null;
  if (['pay', 'payLandscape', 'payPerson', 'teamOverview'].indexOf(kind) > -1) {
    await authService.requirePermission(session.user, 'viewAllPay', true);
  }
  const cacheKey = cacheService.reportCacheKey(kind, year, month, pid);
  const result = await cacheService.getOrCompute(cacheKey, 300, () => reportService.renderReport(kind, year, month, pid));
  ok(res, result);
}));

// GET /api/reports/:kind/export — api_exportExcel(token, kind, year, month, pid)
// Returns the same base64+filename+mimeType envelope shape the original frontend's
// downloadBase64() expects, so script-schedule.html's existing Blob-download logic
// works unchanged. (The .xlsx-via-exceljs variant is also available, see exportExcelXlsx.)
router.get('/reports/:kind/export', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  const { kind } = req.params;
  const year = +req.query.year, month = +req.query.month, pid = req.query.pid || null;
  await auditService.logAction(session.user.userId, 'EXPORT', 'Reports', kind + '-' + year + '-' + month, null, null);
  const file = await reportService.exportExcel(kind, year, month, pid);
  ok(res, file);
}));

// GET /api/reports/:kind/export.xlsx — real .xlsx binary download (exceljs), per spec.
router.get('/reports/:kind/export.xlsx', wrap(async (req, res) => {
  const session = authService.requireSession(getToken(req));
  const { kind } = req.params;
  const year = +req.query.year, month = +req.query.month, pid = req.query.pid || null;
  await auditService.logAction(session.user.userId, 'EXPORT', 'Reports', kind + '-' + year + '-' + month, null, null);
  const file = await reportService.exportExcelXlsx(kind, year, month, pid);
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
  res.send(file.buffer);
}));

module.exports = router;
