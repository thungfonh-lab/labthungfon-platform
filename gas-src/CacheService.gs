/**
 * CacheService.gs — chunking wrapper around GAS CacheService.
 * GAS CacheService caps each value at 100KB; large payloads (e.g. a full
 * month's calendar bundle or a rendered report) are split into chunks.
 */

var AppCache = (function () {
  var CHUNK_SIZE = 90000; // chars, leaves headroom under the 100KB cap
  var DEFAULT_TTL = 1800; // 30 minutes

  function put(key, value, ttlSec) {
    var cache = CacheService.getScriptCache();
    var json = JSON.stringify(value);
    var chunks = [];
    for (var i = 0; i < json.length; i += CHUNK_SIZE) chunks.push(json.slice(i, i + CHUNK_SIZE));

    var ttl = ttlSec || DEFAULT_TTL;
    var payload = {};
    payload[key + ':meta'] = String(chunks.length);
    chunks.forEach(function (chunk, idx) { payload[key + ':' + idx] = chunk; });
    cache.putAll(payload, ttl);
  }

  function get(key) {
    var cache = CacheService.getScriptCache();
    var meta = cache.get(key + ':meta');
    if (!meta) return null;
    var count = parseInt(meta, 10);
    var keys = [];
    for (var i = 0; i < count; i++) keys.push(key + ':' + i);
    var parts = cache.getAll(keys);
    var json = '';
    for (var j = 0; j < count; j++) {
      var part = parts[key + ':' + j];
      if (part === undefined) return null; // expired mid-chunk, treat as miss
      json += part;
    }
    try { return JSON.parse(json); } catch (e) { return null; }
  }

  function remove(key) {
    var cache = CacheService.getScriptCache();
    var meta = cache.get(key + ':meta');
    if (!meta) return;
    var count = parseInt(meta, 10);
    var keys = [key + ':meta'];
    for (var i = 0; i < count; i++) keys.push(key + ':' + i);
    cache.removeAll(keys);
  }

  function getOrCompute(key, ttlSec, computeFn) {
    var cached = get(key);
    if (cached !== null) return cached;
    var fresh = computeFn();
    put(key, fresh, ttlSec);
    return fresh;
  }

  return { put: put, get: get, remove: remove, getOrCompute: getOrCompute };
})();

/** Cache key helper for report payloads, reused by ReportService/Code.gs. */
function reportCacheKey_(kind, year, month, pid) {
  return 'report_' + kind + '_' + year + '_' + month + '_' + (pid || 'all');
}
