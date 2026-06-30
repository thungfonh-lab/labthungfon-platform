/**
 * cacheService.js — ported from CacheService.gs's AppCache wrapper, simplified.
 * In this Node context, a plain in-memory Map is fine for report-cache purposes:
 * a cache miss just recomputes, and there's no 100KB-per-value cap to work around
 * (that was a GAS CacheService limitation, not applicable here). On a serverless
 * platform this cache only lives for the duration of one warm instance — a cold
 * start is simply a cache miss, which is an acceptable, documented tradeoff.
 */

const _store = new Map();

function put(key, value, ttlSec) {
  const ttl = (ttlSec || 1800) * 1000;
  _store.set(key, { value, expiresAt: Date.now() + ttl });
}

function get(key) {
  const entry = _store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _store.delete(key); return null; }
  return entry.value;
}

function remove(key) {
  _store.delete(key);
}

function removePrefix(prefix) {
  for (const key of _store.keys()) {
    if (key.startsWith(prefix)) _store.delete(key);
  }
}

async function getOrCompute(key, ttlSec, computeFn) {
  const cached = get(key);
  if (cached !== null) return cached;
  const fresh = await computeFn();
  put(key, fresh, ttlSec);
  return fresh;
}

function reportCacheKey(kind, year, month, pid) {
  return 'report_' + kind + '_' + year + '_' + month + '_' + (pid || 'all');
}

module.exports = { put, get, remove, removePrefix, getOrCompute, reportCacheKey };
