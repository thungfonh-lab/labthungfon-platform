/**
 * AuthService.gs — session-based auth + RBAC.
 * Ports original can()/canU() permission logic 1:1:
 *   individual override (Users.permsOverride) > role default (Permissions sheet)
 *   admin (role === 'admin') always passes.
 */

var AuthService = (function () {
  var SESSION_TTL_SEC = 8 * 60 * 60; // 8 hours

  function hashPassword_(plain, salt) {
    var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + plain);
    return raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  }

  function findUserByEmail_(email) {
    var rows = DataService.readAll(SHEETS.USERS);
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].email).toLowerCase() === String(email).toLowerCase()) return rows[i];
    }
    return null;
  }

  function findUserById_(userId) {
    var rows = DataService.readAll(SHEETS.USERS);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].userId === userId) return rows[i];
    }
    return null;
  }

  function login(email, password) {
    var user = findUserByEmail_(email);
    if (!user || user.active !== true) {
      throw new Error('ไม่พบบัญชีผู้ใช้ หรือบัญชีถูกปิดใช้งาน');
    }
    var computed = hashPassword_(password, user.salt);
    if (computed !== user.passwordHash) {
      throw new Error('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    }
    var token = Utilities.getUuid();
    var cache = CacheService.getScriptCache();
    cache.put('session_' + token, JSON.stringify({
      userId: user.userId, name: user.name, email: user.email, role: user.role
    }), SESSION_TTL_SEC);

    /* ตามฟีดแบ็ก: ไม่เก็บ audit log ของ LOGIN เพื่อให้ล็อกอินเร็วขึ้น (ตัด sheet write 1 ครั้งต่อการล็อกอิน)
       และไม่ทำให้ชีต AuditLogs โตจนหน้า audit โหลดช้า */
    return {
      token: token,
      user: { userId: user.userId, name: user.name, email: user.email, role: user.role }
    };
  }

  function logout(token) {
    CacheService.getScriptCache().remove('session_' + token);
    /* ไม่เก็บ audit log ของ LOGOUT เช่นเดียวกับ LOGIN */
    return { ok: true };
  }

  function getSession(token) {
    if (!token) return null;
    var raw = CacheService.getScriptCache().get('session_' + token);
    if (!raw) return null;
    return { user: JSON.parse(raw) };
  }

  function requireSession(token) {
    var session = getSession(token);
    if (!session) throw new Error('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่');
    return session;
  }

  /**
   * Ported from original `can(pid, action)` / `canU(action)`:
   * individual override > role default. Admin always true.
   */
  function can(user, action) {
    if (user.role === 'admin') return true;

    var fullUser = findUserById_(user.userId);
    if (fullUser && fullUser.permsOverride) {
      try {
        var overrides = JSON.parse(fullUser.permsOverride);
        if (Object.prototype.hasOwnProperty.call(overrides, action)) {
          return !!overrides[action];
        }
      } catch (e) { /* malformed override JSON: fall through to role default */ }
    }

    var rolePerm = DataService.getPermission(user.role, action);
    return !!rolePerm;
  }

  function requirePermission(user, action, allowCollectFallback) {
    if (can(user, action)) return true;
    if (allowCollectFallback && can(user, 'collect')) return true;
    throw new Error('คุณไม่มีสิทธิ์ดำเนินการนี้ (' + action + ')');
  }

  function getEffectivePermissions(user) {
    var actions = ['publish', 'override', 'viewAllPay', 'editPay', 'manageSettings', 'collect'];
    var result = {};
    actions.forEach(function (a) { result[a] = can(user, a); });
    return result;
  }

  return {
    hashPassword_: hashPassword_,
    login: login,
    logout: logout,
    getSession: getSession,
    requireSession: requireSession,
    can: can,
    requirePermission: requirePermission,
    getEffectivePermissions: getEffectivePermissions
  };
})();
