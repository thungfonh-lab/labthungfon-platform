/**
 * LockService.gs — concurrency control wrapper around GAS LockService.
 * Used by Code.gs around generateSchedule/saveSchedule/publish to prevent
 * two users from writing the same month's schedule simultaneously.
 */

function LockService_run(key, fn, timeoutMs) {
  var lock = LockService.getScriptLock();
  var ok = lock.tryLock(timeoutMs || 15000);
  if (!ok) {
    throw new Error('ระบบกำลังประมวลผลข้อมูลส่วนนี้อยู่ กรุณาลองใหม่อีกครั้งในอีกสักครู่ (lock: ' + key + ')');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
