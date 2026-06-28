/**
 * AuditService.gs — new in this modernization (Restriction allows adding Audit).
 * Logs CREATE/UPDATE/DELETE/LOGIN/LOGOUT/APPROVE/REJECT/GENERATE/PUBLISH/EXPORT/ALERT.
 */

var AuditService = (function () {

  function logAction(userId, action, module, entityRef, before, after) {
    var id = Utilities.getUuid();
    DataService.appendRow(SHEETS.AUDIT, {
      id: id,
      userId: userId || '',
      action: action,
      module: module,
      entityRef: String(entityRef || ''),
      before: before ? JSON.stringify(before) : '',
      after: after ? JSON.stringify(after) : '',
      timestamp: new Date().toISOString()
    });
    return id;
  }

  function getAuditLogs(filters) {
    filters = filters || {};
    var rows = DataService.readAll(SHEETS.AUDIT);
    return rows.filter(function (r) {
      if (filters.userId && r.userId !== filters.userId) return false;
      if (filters.module && r.module !== filters.module) return false;
      if (filters.action && r.action !== filters.action) return false;
      if (filters.since && new Date(r.timestamp) < new Date(filters.since)) return false;
      return true;
    }).sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
  }

  return { logAction: logAction, getAuditLogs: getAuditLogs };
})();
