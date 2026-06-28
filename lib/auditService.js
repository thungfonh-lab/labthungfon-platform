/**
 * auditService.js — ported 1:1 from AuditService.gs.
 * Logs CREATE/UPDATE/DELETE/LOGIN/LOGOUT/APPROVE/REJECT/GENERATE/PUBLISH/EXPORT/ALERT.
 */

const crypto = require('crypto');
const gs = require('./googleSheets');

const SHEETS_AUDIT = 'AuditLogs';

async function logAction(userId, action, module, entityRef, before, after) {
  const id = crypto.randomUUID();
  await gs.appendRow(SHEETS_AUDIT, {
    id,
    userId: userId || '',
    action,
    module,
    entityRef: String(entityRef || ''),
    before: before ? JSON.stringify(before) : '',
    after: after ? JSON.stringify(after) : '',
    timestamp: new Date().toISOString()
  });
  return id;
}

async function getAuditLogs(filters) {
  filters = filters || {};
  const rows = await gs.readAll(SHEETS_AUDIT);
  return rows.filter((r) => {
    if (filters.userId && r.userId !== filters.userId) return false;
    if (filters.module && r.module !== filters.module) return false;
    if (filters.action && r.action !== filters.action) return false;
    if (filters.since && new Date(r.timestamp) < new Date(filters.since)) return false;
    return true;
  }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

module.exports = { logAction, getAuditLogs };
