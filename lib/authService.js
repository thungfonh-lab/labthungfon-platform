/**
 * authService.js — session-based auth + RBAC.
 * Ports original can()/canU() permission logic 1:1:
 *   individual override (Users.permsOverride) > role default (Permissions sheet)
 *   admin (role === 'admin') always passes.
 *
 * ARCHITECTURE DEVIATION #1 (documented in README): the original GAS AuthService
 * stored sessions server-side in CacheService.getScriptCache(), keyed by an opaque
 * UUID token. On Vercel serverless that per-instance cache is unsafe (cold starts /
 * multiple instances don't share it), so this port instead issues a signed,
 * self-contained JWT: signing {userId, name, email, role, exp} with HMAC-SHA256
 * (JWT_SECRET env var), 8h expiry — same SESSION_TTL_SEC as the original.
 * Validating a session = verifying signature + exp, no server-side store needed.
 * KNOWN LIMITATION: because the token is stateless, logout cannot revoke it
 * server-side without a blocklist (not implemented here) — see logout() below.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const dataService = require('./dataService');

const SESSION_TTL_SEC = 8 * 60 * 60; // 8 hours — matches AuthService.gs SESSION_TTL_SEC

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

/** Ported byte-identical from AuthService.gs hashPassword_: sha256(salt+':'+plain) hex.
 *  Must stay exactly this scheme so existing Users sheet rows keep working. */
function hashPassword(plain, salt) {
  return crypto.createHash('sha256').update(salt + ':' + plain).digest('hex');
}

async function login(email, password) {
  const user = await dataService.findUserByEmailRaw(email);
  const isActive = user && (user.active === true || user.active === 'TRUE' || user.active === 'true');
  if (!user || !isActive) {
    throw new Error('ไม่พบบัญชีผู้ใช้ หรือบัญชีถูกปิดใช้งาน');
  }
  const computed = hashPassword(password, user.salt);
  if (computed !== user.passwordHash) {
    throw new Error('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  }
  const payload = { userId: user.userId, name: user.name, email: user.email, role: user.role };
  const token = jwt.sign(payload, getJwtSecret(), { expiresIn: SESSION_TTL_SEC });
  return { token, user: payload };
}

/** Stateless tokens can't be revoked server-side without a blocklist (not implemented
 *  in this migration — see README "Known limitations"). Logout is therefore a no-op
 *  success response; the frontend discards its locally stored token, matching the
 *  original's UX even though the old token would technically still validate until
 *  it expires (max 8h window). */
async function logout() {
  return { ok: true };
}

function getSession(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getJwtSecret());
    return { user: { userId: payload.userId, name: payload.name, email: payload.email, role: payload.role } };
  } catch (e) {
    return null;
  }
}

function requireSession(token) {
  const session = getSession(token);
  if (!session) {
    const err = new Error('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่');
    err.statusCode = 401;
    throw err;
  }
  return session;
}

async function can(user, action) {
  if (user.role === 'admin') return true;

  const fullUser = await dataService.findUserById(user.userId);
  if (fullUser && fullUser.permsOverride) {
    try {
      const overrides = JSON.parse(fullUser.permsOverride);
      if (Object.prototype.hasOwnProperty.call(overrides, action)) {
        return !!overrides[action];
      }
    } catch (e) { /* malformed override JSON: fall through to role default */ }
  }

  const rolePerm = await dataService.getPermission(user.role, action);
  return !!rolePerm;
}

async function requirePermission(user, action, allowCollectFallback) {
  if (await can(user, action)) return true;
  if (allowCollectFallback && await can(user, 'collect')) return true;
  const err = new Error('คุณไม่มีสิทธิ์ดำเนินการนี้ (' + action + ')');
  err.statusCode = 401;
  throw err;
}

async function getEffectivePermissions(user) {
  const actions = ['publish', 'override', 'viewAllPay', 'editPay', 'manageSettings', 'collect'];
  const result = {};
  for (const a of actions) result[a] = await can(user, a);
  return result;
}

module.exports = {
  SESSION_TTL_SEC,
  hashPassword,
  login,
  logout,
  getSession,
  requireSession,
  can,
  requirePermission,
  getEffectivePermissions
};
