/**
 * lockService.js — concurrency control, replacing GAS LockService.getScriptLock().
 *
 * ARCHITECTURE DEVIATION #2 (documented in README): GAS LockService was per-instance
 * and isn't available on Vercel serverless. This port instead stores a lock as a row
 * in the Settings sheet (key `lock_<lockKey>`, value = JSON {heldAt, expiresAt}).
 * Acquire = check/write that row with a short TTL (15s default, matching the original's
 * tryLock(timeoutMs || 15000)); release = delete/clear the row.
 * KNOWN LIMITATION: this is best-effort, NOT perfectly atomic (a race between the
 * read-check and the write-acquire is possible under high concurrency) — but it
 * matches the original's purpose (prevent two users generating/saving the same
 * month's schedule at once) closely enough for this app's actual concurrency level
 * (a handful of staff, not a high-throughput system). See README for details.
 */

const gs = require('./googleSheets');

const SHEETS_SETTINGS = 'Settings';
const DEFAULT_TIMEOUT_MS = 15000; // matches LockService.gs's tryLock(timeoutMs || 15000)
const LOCK_TTL_MS = 20000; // a little longer than the timeout so a held lock doesn't expire mid-use

async function findLockRow(lockKey) {
  const rows = await gs.readAll(SHEETS_SETTINGS);
  return rows.filter((r) => r.key === 'lock_' + lockKey)[0] || null;
}

async function tryAcquire(lockKey) {
  const existing = await findLockRow(lockKey);
  if (existing) {
    let info = null;
    try { info = JSON.parse(existing.value); } catch (e) { /* corrupt lock row: treat as free */ }
    if (info && info.expiresAt && info.expiresAt > Date.now()) {
      return false; // still held by someone else
    }
    // expired or corrupt — overwrite it (best-effort, not atomic)
    const headers = await gs.getHeaders(SHEETS_SETTINGS);
    await gs.updateCell(SHEETS_SETTINGS, existing.__rowIndex, 2, JSON.stringify({ heldAt: Date.now(), expiresAt: Date.now() + LOCK_TTL_MS }));
    return true;
  }
  await gs.appendRow(SHEETS_SETTINGS, { key: 'lock_' + lockKey, value: JSON.stringify({ heldAt: Date.now(), expiresAt: Date.now() + LOCK_TTL_MS }) });
  return true;
}

async function release(lockKey) {
  const existing = await findLockRow(lockKey);
  if (existing) {
    await gs.updateCell(SHEETS_SETTINGS, existing.__rowIndex, 2, '');
  }
}

/** Ported from LockService_run(key, fn, timeoutMs): polls tryAcquire until the
 *  timeout elapses, runs fn(), always releases. */
async function run(key, fn, timeoutMs) {
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  let acquired = false;
  while (Date.now() < deadline) {
    acquired = await tryAcquire(key);
    if (acquired) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!acquired) {
    const err = new Error('ระบบกำลังประมวลผลข้อมูลส่วนนี้อยู่ กรุณาลองใหม่อีกครั้งในอีกสักครู่ (lock: ' + key + ')');
    err.statusCode = 400;
    throw err;
  }
  try {
    return await fn();
  } finally {
    await release(key);
  }
}

module.exports = { run, tryAcquire, release };
