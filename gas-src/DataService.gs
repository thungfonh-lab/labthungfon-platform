/**
 * DataService.gs — Repository layer. All Sheets access goes through here.
 * Maps generic Sheets rows back into the original CFG/DATA shapes from
 * labthungfon-platform-v4_43.html so BusinessService.gs can stay logic-identical.
 */

var DataService = (function () {

  function getSheet_(name) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
    if (!sheet) throw new Error('ไม่พบ Sheet: ' + name + ' — กรุณารัน runFullSetup() ก่อน');
    return sheet;
  }

  /* Per-execution header memo — header rows never change at runtime, so unlike
   * _readAllCache this never needs invalidation. Avoids a getRange().getValues()
   * round trip on every single appendRow()/updateRow_() call (e.g. generateSchedule's
   * post-balance pass writing ~12 override log rows one at a time). */
  var _headerCache = {};
  function getHeaders_(sheet, sheetName) {
    if (!_headerCache[sheetName]) _headerCache[sheetName] = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    return _headerCache[sheetName];
  }

  /* Per-execution memo cache: a single web request (e.g. api_loadCalendar)
   * often calls readAll() on the same sheet multiple times via different
   * getters (people/holidays both read MASTER; overrides/oncall/violations
   * all read TRANSACTIONS). Apps Script executions are stateless between
   * requests, so this cache naturally resets every call — no staleness risk,
   * just dedupes the full-sheet re-reads within one request. Any write
   * (appendRow/updateRow_/deleteRow_) invalidates the relevant sheet's entry. */
  var _readAllCache = {};

  function readAll(sheetName) {
    if (_readAllCache[sheetName]) return _readAllCache[sheetName];
    var sheet = getSheet_(sheetName);
    var range = sheet.getDataRange().getValues();
    var rows = [];
    if (range.length >= 2) {
      var headers = range[0];
      for (var r = 1; r < range.length; r++) {
        var row = range[r];
        if (row.join('') === '') continue;
        var obj = {};
        for (var c = 0; c < headers.length; c++) obj[headers[c]] = row[c];
        obj.__rowIndex = r + 1; // 1-based sheet row, for in-place updates
        rows.push(obj);
      }
    }
    _readAllCache[sheetName] = rows;
    return rows;
  }

  function invalidateReadAllCache_(sheetName) { delete _readAllCache[sheetName]; }

  function appendRow(sheetName, obj) {
    var sheet = getSheet_(sheetName);
    var headers = getHeaders_(sheet, sheetName);
    var row = headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
    sheet.appendRow(row);
    invalidateReadAllCache_(sheetName);
    return obj;
  }

  function updateRow_(sheetName, rowIndex, obj) {
    var sheet = getSheet_(sheetName);
    var headers = getHeaders_(sheet, sheetName);
    var row = headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
    sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
    invalidateReadAllCache_(sheetName);
    return obj;
  }

  function deleteRow_(sheetName, rowIndex) {
    getSheet_(sheetName).deleteRow(rowIndex);
    invalidateReadAllCache_(sheetName);
  }

  function batchAppend(sheetName, objs) {
    if (!objs.length) return;
    var sheet = getSheet_(sheetName);
    invalidateReadAllCache_(sheetName);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var rows = objs.map(function (obj) { return headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; }); });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  }

  function parseJsonSafe_(v, fallback) {
    if (v === '' || v === null || v === undefined) return fallback;
    try { return JSON.parse(v); } catch (e) { return fallback; }
  }

  /* ---------------- Settings (CFG top-level scalar fields) ---------------- */

  function getSettings() {
    var rows = readAll(SHEETS.SETTINGS);
    var cfg = {};
    rows.forEach(function (r) {
      var v = r.value;
      if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else if (typeof v === 'string' && v.match(/^\{.*\}$|^\[.*\]$/)) v = parseJsonSafe_(v, v);
      cfg[r.key] = v;
    });
    return cfg;
  }

  function saveSettings(patch) {
    var sheet = getSheet_(SHEETS.SETTINGS);
    var rows = readAll(SHEETS.SETTINGS);
    var byKey = {};
    rows.forEach(function (r) { byKey[r.key] = r; });
    Object.keys(patch).forEach(function (key) {
      var value = typeof patch[key] === 'object' ? JSON.stringify(patch[key]) : patch[key];
      if (byKey[key]) {
        sheet.getRange(byKey[key].__rowIndex, 2).setValue(value);
        invalidateReadAllCache_(SHEETS.SETTINGS);
      } else {
        appendRow(SHEETS.SETTINGS, { key: key, value: value });
      }
    });
    return getSettings();
  }

  /* ---------------- MasterData (People / Stations / Shifts / Rates / RateOvr / Holidays) ---------------- */

  function getMasterByCategory_(category) {
    return readAll(SHEETS.MASTER)
      .filter(function (r) { return r.category === category; })
      .map(function (r) {
        var data = parseJsonSafe_(r.data, {});
        data.id = data.id || r.id;
        data.__rowIndex = r.__rowIndex;
        return data;
      });
  }

  function getMasterRecord(category, id) {
    return getMasterByCategory_(category).filter(function (r) { return r.id === id; })[0] || null;
  }

  function getPeople() { return getMasterByCategory_(MASTER_CATEGORY.PEOPLE); }
  function getStations() { return getMasterByCategory_(MASTER_CATEGORY.STATION); }
  function getShifts() { return getMasterByCategory_(MASTER_CATEGORY.SHIFT); }
  function getRateOverrides() { return getMasterByCategory_(MASTER_CATEGORY.RATE_OVERRIDE); }

  function getRates() {
    var settings = getSettings();
    var rates = settings.rates || { MT: { ch: 650, b: 650, d0: 325, d1: 325, n: 0 }, LA: { ch: 0, b1: 400, n: 0 } };
    /* migrate เวร ด แบบเก่า (อัตราเดียว 'd') → 2 ช่วงเวลา 'd0'/'d1' ถ้ายังไม่เคยตั้งค่าแยก
       (เก็บ d เดิมไว้เผื่อโค้ดอื่นยังอ้างถึง แต่ rateFor_ จะมองหา d0/d1 เท่านั้น) */
    if (rates.MT && rates.MT.d !== undefined && rates.MT.d0 === undefined) {
      rates.MT.d0 = rates.MT.d; rates.MT.d1 = rates.MT.d;
    }
    return rates;
  }

  function getHolidays(year, month) {
    return getMasterByCategory_(MASTER_CATEGORY.HOLIDAY)
      .filter(function (h) { return h.year === year && h.month === month; });
  }

  function getHolidaysForYear(year) {
    return getMasterByCategory_(MASTER_CATEGORY.HOLIDAY).filter(function (h) { return h.year === year; });
  }

  /** Fixed-date Thai statutory holidays (same Gregorian date every year) — month is 0-indexed. */
  var THAI_FIXED_HOLIDAYS_ = [
    { month: 0, day: 1, name: 'วันขึ้นปีใหม่' },
    { month: 3, day: 6, name: 'วันจักรี' },
    { month: 3, day: 13, name: 'วันสงกรานต์' },
    { month: 3, day: 14, name: 'วันสงกรานต์' },
    { month: 3, day: 15, name: 'วันสงกรานต์' },
    { month: 4, day: 1, name: 'วันแรงงานแห่งชาติ' },
    { month: 4, day: 4, name: 'วันฉัตรมงคล' },
    { month: 5, day: 3, name: 'วันเฉลิมพระชนมพรรษาสมเด็จพระราชินี' },
    { month: 6, day: 28, name: 'วันเฉลิมพระชนมพรรษาพระบาทสมเด็จพระเจ้าอยู่หัว' },
    { month: 7, day: 12, name: 'วันแม่แห่งชาติ' },
    { month: 9, day: 13, name: 'วันคล้ายวันสวรรคต ร.9' },
    { month: 9, day: 23, name: 'วันปิยมหาราช' },
    { month: 11, day: 5, name: 'วันพ่อแห่งชาติ' },
    { month: 11, day: 10, name: 'วันรัฐธรรมนูญ' },
    { month: 11, day: 31, name: 'วันสิ้นปี' }
  ];
  /** Lunar/Buddhist-calendar holidays shift every year and are only confirmed by the
   *  annual cabinet resolution — only years verified against the published government
   *  calendar are listed here. Other years still get all fixed-date holidays seeded;
   *  the lunar ones must be added manually (the UI flags which years were skipped). */
  /* วันหยุดจันทรคติ (เลื่อนทุกปี) — อ้างอิงประกาศ/ปฏิทินราชการ month เป็น 0-indexed
     ปีที่ไม่มีในตารางนี้ ระบบยังเติมวันหยุดวันที่ตายตัวให้ได้ แต่ต้องเพิ่มวันจันทรคติเอง (seedThaiHolidays คืน hasLunarTable:false) */
  var THAI_LUNAR_HOLIDAYS_ = {
    2567: [{ month: 1, day: 24, name: 'วันมาฆบูชา' }, { month: 4, day: 22, name: 'วันวิสาขบูชา' }, { month: 6, day: 20, name: 'วันอาสาฬหบูชา' }, { month: 6, day: 21, name: 'วันเข้าพรรษา' }],
    2568: [{ month: 1, day: 12, name: 'วันมาฆบูชา' }, { month: 4, day: 11, name: 'วันวิสาขบูชา' }, { month: 6, day: 10, name: 'วันอาสาฬหบูชา' }, { month: 6, day: 11, name: 'วันเข้าพรรษา' }],
    2569: [{ month: 2, day: 3, name: 'วันมาฆบูชา' }, { month: 4, day: 31, name: 'วันวิสาขบูชา' }, { month: 6, day: 29, name: 'วันอาสาฬหบูชา' }, { month: 6, day: 30, name: 'วันเข้าพรรษา' }],
    2570: [{ month: 1, day: 21, name: 'วันมาฆบูชา' }, { month: 4, day: 20, name: 'วันวิสาขบูชา' }, { month: 6, day: 18, name: 'วันอาสาฬหบูชา' }, { month: 6, day: 19, name: 'วันเข้าพรรษา' }],
    2571: [{ month: 1, day: 10, name: 'วันมาฆบูชา' }, { month: 4, day: 9, name: 'วันวิสาขบูชา' }, { month: 6, day: 6, name: 'วันอาสาฬหบูชา' }, { month: 6, day: 7, name: 'วันเข้าพรรษา' }],
    2572: [{ month: 1, day: 28, name: 'วันมาฆบูชา' }, { month: 4, day: 27, name: 'วันวิสาขบูชา' }, { month: 6, day: 25, name: 'วันอาสาฬหบูชา' }, { month: 6, day: 26, name: 'วันเข้าพรรษา' }],
    2573: [{ month: 1, day: 18, name: 'วันมาฆบูชา' }, { month: 4, day: 17, name: 'วันวิสาขบูชา' }, { month: 6, day: 15, name: 'วันอาสาฬหบูชา' }, { month: 6, day: 16, name: 'วันเข้าพรรษา' }]
  };

  /** Seeds Thai government holidays into the existing holiday master-data records for
   *  one Buddhist year, skipping days already present so re-running (or the per-month
   *  manual edits) never duplicates entries. Still fully editable/removable afterward
   *  via the normal ตั้งค่า > วันหยุดราชการ table. */
  function seedThaiHolidays(year) {
    var existing = getHolidaysForYear(year);
    var existingKey = {};
    existing.forEach(function (h) { existingKey[h.month + '_' + h.day] = true; });
    var toAdd = THAI_FIXED_HOLIDAYS_.concat(THAI_LUNAR_HOLIDAYS_[year] || []);
    var added = 0;
    toAdd.forEach(function (h) {
      var key = h.month + '_' + h.day;
      if (existingKey[key]) return;
      existingKey[key] = true;
      crudMasterData(MASTER_CATEGORY.HOLIDAY, 'create', { year: year, month: h.month, day: h.day, name: h.name });
      added++;
    });
    return { added: added, hasLunarTable: !!THAI_LUNAR_HOLIDAYS_[year] };
  }

  function crudMasterData(category, op, payload) {
    if (op === 'create') {
      var id = category + '_' + Utilities.getUuid();
      payload.id = id;
      appendRow(SHEETS.MASTER, { id: id, category: category, data: JSON.stringify(payload), updatedAt: new Date().toISOString() });
      return payload;
    }
    if (op === 'update') {
      var existing = getMasterRecord(category, payload.id);
      if (!existing) throw new Error('ไม่พบข้อมูล id=' + payload.id);
      updateRow_(SHEETS.MASTER, existing.__rowIndex, { id: payload.id, category: category, data: JSON.stringify(payload), updatedAt: new Date().toISOString() });
      return payload;
    }
    if (op === 'delete') {
      var rec = getMasterRecord(category, payload.id);
      if (rec) deleteRow_(SHEETS.MASTER, rec.__rowIndex);
      return { id: payload.id, deleted: true };
    }
    throw new Error('ไม่รู้จัก operation: ' + op);
  }

  /** Updates several MasterData rows of the same category in one pass (single sheet
   *  read instead of N separate getMasterRecord+updateRow_ round trips per item). */
  function crudMasterDataBulk(category, payloads) {
    var sheet = getSheet_(SHEETS.MASTER);
    var rows = sheet.getDataRange().getValues();
    var byId = {};
    payloads.forEach(function (p) { byId[p.id] = p; });
    var now = new Date().toISOString();
    for (var i = 1; i < rows.length; i++) {
      var id = rows[i][0], cat = rows[i][1];
      if (cat === category && byId[id]) {
        sheet.getRange(i + 1, 1, 1, 4).setValues([[id, category, JSON.stringify(byId[id]), now]]);
      }
    }
    invalidateReadAllCache_(SHEETS.MASTER);
    return payloads;
  }

  /* ---------------- Transactions (Availability / OnCall / PayAdj / Overrides / RuleViolations / TrailInfo) ---------------- */

  function getTransactions_(category, year, month, pid) {
    return readAll(SHEETS.TRANSACTIONS).filter(function (r) {
      if (r.category !== category) return false;
      if (year !== undefined && r.year !== year) return false;
      if (month !== undefined && r.month !== month) return false;
      if (pid !== undefined && r.pid !== pid) return false;
      return true;
    }).map(function (r) {
      var data = parseJsonSafe_(r.data, {});
      data.__rowIndex = r.__rowIndex;
      data.__txId = r.id;
      return data;
    });
  }

  function addTransaction_(category, year, month, pid, data, createdBy) {
    var id = category + '_' + Utilities.getUuid();
    appendRow(SHEETS.TRANSACTIONS, {
      id: id, category: category, year: year, month: month, pid: pid || '',
      data: JSON.stringify(data), createdAt: new Date().toISOString(), createdBy: createdBy || ''
    });
    return id;
  }

  /** Writes several transaction rows in one sheet call instead of one appendRow
   *  per item (used by generateSchedule's post-balance pass, which can log up to
   *  ~12 override/violation entries per run — was the main cause of "สร้างตารางเวร
   *  โหลดนาน" since each was a separate Apps Script round trip). */
  function addTransactionsBulk_(items) {
    if (!items.length) return;
    var now = new Date().toISOString();
    var rows = items.map(function (it) {
      return {
        id: it.category + '_' + Utilities.getUuid(), category: it.category, year: it.year, month: it.month,
        pid: it.pid || '', data: JSON.stringify(it.data), createdAt: now, createdBy: it.createdBy || ''
      };
    });
    batchAppend(SHEETS.TRANSACTIONS, rows);
  }

  function getAvailability(year, month) { return getTransactions_(TX_CATEGORY.AVAILABILITY, year, month); }
  function addAvailability(year, month, pid, entry, createdBy) { return addTransaction_(TX_CATEGORY.AVAILABILITY, year, month, pid, entry, createdBy); }

  function getOnCallRecords(year, month) { return getTransactions_(TX_CATEGORY.ONCALL, year, month); }
  function addOnCallRecord(year, month, pid, entry, createdBy) { return addTransaction_(TX_CATEGORY.ONCALL, year, month, pid, entry, createdBy); }

  function getPayAdjustments(year, month) { return getTransactions_(TX_CATEGORY.PAY_ADJ, year, month); }
  function setPayAdjustment(year, month, pid, shiftMap, createdBy) { return addTransaction_(TX_CATEGORY.PAY_ADJ, year, month, pid, shiftMap, createdBy); }

  function getOverrides(year, month) { return getTransactions_(TX_CATEGORY.OVERRIDE, year, month); }
  function addOverride(year, month, entry, createdBy) { return addTransaction_(TX_CATEGORY.OVERRIDE, year, month, null, entry, createdBy); }
  function addOverridesBulk(year, month, entries, createdBy) {
    addTransactionsBulk_(entries.map(function (entry) {
      return { category: TX_CATEGORY.OVERRIDE, year: year, month: month, pid: null, data: entry, createdBy: createdBy };
    }));
  }
  /** Removes only the auto-generated balance-swap/cross-month-unlock log entries from a
   *  previous สร้างตารางเวร run, leaving manual-override entries the user added intact.
   *  Called before re-logging a fresh generation's swaps so re-running generate doesn't
   *  accumulate duplicate entries forever. */
  function clearAutoOverrides(year, month) {
    var sheet = getSheet_(SHEETS.TRANSACTIONS);
    var AUTO_TYPES = ['balance-swap', 'cross-month-unlock'];
    var rows = getTransactions_(TX_CATEGORY.OVERRIDE, year, month).filter(function (o) { return AUTO_TYPES.indexOf(o.type) > -1; });
    if (rows.length) deleteRowsBulk_(sheet, rows.map(function (o) { return o.__rowIndex; }));
    invalidateReadAllCache_(SHEETS.TRANSACTIONS);
  }

  /** เคลียร์ตารางเวรเดือนนี้ทั้งหมด (Schedules + ประวัติ Override ทุกชนิด + ข้อควรตรวจสอบ + trailInfo)
   *  ให้เหมือนไม่เคยกด "สร้างตารางเวร" มาก่อน — ไม่แตะ availability/oncall/payAdj/dutyRoster
   *  เพราะเป็นข้อมูล/ตั้งค่าที่ผู้ใช้กรอกแยกจากผลลัพธ์การจัดตาราง ไม่ใช่สิ่งที่ generate สร้างขึ้น */
  function clearSchedule(year, month) {
    var schSheet = getSheet_(SHEETS.SCHEDULES);
    var schRows = getScheduleAssignments(year, month);
    if (schRows.length) { deleteRowsBulk_(schSheet, schRows.map(function (r) { return r.__rowIndex; })); invalidateReadAllCache_(SHEETS.SCHEDULES); }

    var CLEAR_CATEGORIES = [TX_CATEGORY.OVERRIDE, TX_CATEGORY.RULE_VIOLATION, TX_CATEGORY.TRAIL_INFO];
    var txSheet = getSheet_(SHEETS.TRANSACTIONS);
    var txRows = readAll(SHEETS.TRANSACTIONS).filter(function (r) {
      return r.year === year && r.month === month && CLEAR_CATEGORIES.indexOf(r.category) > -1;
    });
    if (txRows.length) { deleteRowsBulk_(txSheet, txRows.map(function (r) { return r.__rowIndex; })); invalidateReadAllCache_(SHEETS.TRANSACTIONS); }

    return { deletedSchedules: schRows.length, deletedTransactions: txRows.length };
  }

  /** ท้าย generateSchedule(): trailInfo + ruleViolations + auto-overrides ทั้งหมดล้วน
   *  อยู่ใน sheet TRANSACTIONS เดียวกัน — เดิมเรียก setTrailInfo/clearRuleViolations/addRuleViolations/
   *  clearAutoOverrides/addOverridesBulk แยกกัน 5 ครั้ง แต่ละครั้งที่มีการเขียน (write) จะ invalidate
   *  _readAllCache ของ TRANSACTIONS ทำให้ฟังก์ชันถัดไปที่ต้องอ่านก่อนเขียน (setTrailInfo, clearRuleViolations,
   *  clearAutoOverrides) ต้องอ่านชีตใหม่ทุกครั้ง (cascade re-read) ฟังก์ชันนี้อ่าน TRANSACTIONS ครั้งเดียว
   *  แล้วรวมการเขียนทั้งหมดเป็น update/append(trailInfo) + delete(รวม) + append(รวม) */
  function finalizeGenerateWrites(year, month, trailInfo, ruleViolations, overrides, createdBy) {
    var AUTO_TYPES = ['balance-swap', 'cross-month-unlock'];
    var rows = readAll(SHEETS.TRANSACTIONS);
    var existingTrail = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].category === TX_CATEGORY.TRAIL_INFO && rows[i].year === year && rows[i].month === month) { existingTrail = rows[i]; break; }
    }
    var toDelete = rows.filter(function (r) {
      if (r.year !== year || r.month !== month) return false;
      if (r.category === TX_CATEGORY.RULE_VIOLATION) return true;
      if (r.category === TX_CATEGORY.OVERRIDE) return AUTO_TYPES.indexOf(parseJsonSafe_(r.data, {}).type) > -1;
      return false;
    });

    if (existingTrail) {
      updateRow_(SHEETS.TRANSACTIONS, existingTrail.__rowIndex, {
        id: existingTrail.id, category: TX_CATEGORY.TRAIL_INFO, year: year, month: month,
        pid: trailInfo.lastPid || '', data: JSON.stringify(trailInfo), createdAt: new Date().toISOString(), createdBy: createdBy || ''
      });
    } else {
      addTransaction_(TX_CATEGORY.TRAIL_INFO, year, month, trailInfo.lastPid, trailInfo, createdBy);
    }
    if (toDelete.length) {
      var sheet = getSheet_(SHEETS.TRANSACTIONS);
      deleteRowsBulk_(sheet, toDelete.map(function (r) { return r.__rowIndex; }));
      invalidateReadAllCache_(SHEETS.TRANSACTIONS);
    }

    var bulkItems = ruleViolations.map(function (v) {
      return { category: TX_CATEGORY.RULE_VIOLATION, year: year, month: month, pid: v.pid, data: v, createdBy: createdBy };
    }).concat(overrides.map(function (o) {
      return { category: TX_CATEGORY.OVERRIDE, year: year, month: month, pid: null, data: o, createdBy: createdBy };
    }));
    if (bulkItems.length) addTransactionsBulk_(bulkItems);
  }

  function getRuleViolations(year, month) { return getTransactions_(TX_CATEGORY.RULE_VIOLATION, year, month); }
  function clearRuleViolations(year, month) {
    var sheet = getSheet_(SHEETS.TRANSACTIONS);
    var rows = getTransactions_(TX_CATEGORY.RULE_VIOLATION, year, month);
    if (rows.length) deleteRowsBulk_(sheet, rows.map(function (r) { return r.__rowIndex; }));
    invalidateReadAllCache_(SHEETS.TRANSACTIONS);
  }
  function addRuleViolations(year, month, violations, createdBy) {
    addTransactionsBulk_(violations.map(function (v) {
      return { category: TX_CATEGORY.RULE_VIOLATION, year: year, month: month, pid: v.pid, data: v, createdBy: createdBy };
    }));
  }

  /** Read a single transaction row by its id (used to check ownership — pid — before edit/delete). */
  function getTransactionById(txId) {
    return readAll(SHEETS.TRANSACTIONS).filter(function (r) { return r.id === txId; })[0] || null;
  }

  /** Delete a single transaction row by its id (availability/oncall entries — fixes missing delete buttons). */
  function deleteTransactionById(txId) {
    var sheet = getSheet_(SHEETS.TRANSACTIONS);
    var rec = readAll(SHEETS.TRANSACTIONS).filter(function (r) { return r.id === txId; })[0];
    if (rec) { sheet.deleteRow(rec.__rowIndex); invalidateReadAllCache_(SHEETS.TRANSACTIONS); }
  }

  /** Update a single transaction row's data/pid in place (on-call/availability "แก้ไข" button —
   *  keeps the same id/category/year/month/createdAt/createdBy, only overwrites the editable fields). */
  function updateTransactionById_(txId, pid, data) {
    var rec = readAll(SHEETS.TRANSACTIONS).filter(function (r) { return r.id === txId; })[0];
    if (!rec) throw new Error('ไม่พบรายการ id=' + txId);
    updateRow_(SHEETS.TRANSACTIONS, rec.__rowIndex, {
      id: rec.id, category: rec.category, year: rec.year, month: rec.month,
      pid: pid || '', data: JSON.stringify(data), createdAt: rec.createdAt, createdBy: rec.createdBy
    });
    return Object.assign({}, data, { __txId: rec.id });
  }

  function getTrailInfo(year, month) {
    var rows = getTransactions_(TX_CATEGORY.TRAIL_INFO, year, month);
    return rows[0] || null;
  }
  function setTrailInfo(year, month, info, createdBy) {
    var sheet = getSheet_(SHEETS.TRANSACTIONS);
    var existing = getTrailInfo(year, month);
    if (existing) {
      updateRow_(SHEETS.TRANSACTIONS, existing.__rowIndex, {
        id: existing.__txId, category: TX_CATEGORY.TRAIL_INFO, year: year, month: month,
        pid: info.lastPid || '', data: JSON.stringify(info), createdAt: new Date().toISOString(), createdBy: createdBy || ''
      });
    } else {
      addTransaction_(TX_CATEGORY.TRAIL_INFO, year, month, info.lastPid, info, createdBy);
    }
  }

  /** เจ้าหน้าที่ที่เลือกขึ้นเวรในเดือนนั้น — null ถ้ายังไม่ตั้ง (ใช้ทุกคนตามค่าเดิม) */
  function getDutyRoster(year, month) {
    var rows = getTransactions_(TX_CATEGORY.DUTY_ROSTER, year, month);
    return rows[0] || null;
  }
  function setDutyRoster(year, month, data, createdBy) {
    var existing = getDutyRoster(year, month);
    if (existing) {
      updateRow_(SHEETS.TRANSACTIONS, existing.__rowIndex, {
        id: existing.__txId, category: TX_CATEGORY.DUTY_ROSTER, year: year, month: month,
        pid: '', data: JSON.stringify(data), createdAt: new Date().toISOString(), createdBy: createdBy || ''
      });
    } else {
      addTransaction_(TX_CATEGORY.DUTY_ROSTER, year, month, null, data, createdBy);
    }
  }

  /* ---------------- Schedules ---------------- */

  function getScheduleAssignments(year, month) {
    return readAll(SHEETS.SCHEDULES).filter(function (r) { return r.year === year && r.month === month; });
  }

  function getScheduleStatus(year, month) {
    var rows = getScheduleAssignments(year, month);
    return rows.length ? (rows[0].status || 'draft') : 'none';
  }

  /** Deletes a set of (possibly non-contiguous) sheet rows using as few deleteRows()
   *  calls as possible — merges consecutive row indices into single-range deletes
   *  instead of one deleteRow() per row (was the main cause of "สร้างตารางเวร โหลดนาน":
   *  re-generating a month could delete 100+ rows one Apps Script call at a time). */
  function deleteRowsBulk_(sheet, rowIndices) {
    var sorted = rowIndices.slice().sort(function (a, b) { return b - a; }); // descending
    var i = 0;
    while (i < sorted.length) {
      var runEnd = sorted[i], runStart = runEnd, j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === runStart - 1) { runStart = sorted[j + 1]; j++; }
      sheet.deleteRows(runStart, runEnd - runStart + 1);
      i = j + 1;
    }
  }

  function saveScheduleAssignments(year, month, assignments, status, updatedBy) {
    var sheet = getSheet_(SHEETS.SCHEDULES);
    var existing = getScheduleAssignments(year, month);
    if (existing.length) deleteRowsBulk_(sheet, existing.map(function (r) { return r.__rowIndex; }));
    invalidateReadAllCache_(SHEETS.SCHEDULES);

    /* เก็บเฉพาะคอลัมน์ที่ระบบใช้จริง (year/month/day/shiftType/pid/status) — เดิมเก็บ source/updatedAt/updatedBy
       ด้วยแต่ไม่มีส่วนไหนอ่านค่าเหล่านั้นเลย ตัดออกเพื่อให้ชีต Schedules เล็กลง โหลดเร็วขึ้น (ดู slimSchedules ใน Setup.gs) */
    var rows = assignments.map(function (a) {
      return { year: year, month: month, day: a.day, shiftType: a.shiftType, pid: a.pid, status: status };
    });
    batchAppend(SHEETS.SCHEDULES, rows);
    return rows;
  }

  /** ตั้งแต่รองรับหลายคนต่อ 1 เวร/1 วัน — day+shiftType ไม่ใช่ unique key อีกต่อไป
   *  (หลาย row วัน+เวรเดียวกัน คนละ pid = หลายคนอยู่เวรพร้อมกัน) ใช้แทน setAssignment เดิม
   *  ที่เคย "หา row เดียวแล้วเขียนทับ" ซึ่งทำให้เพิ่มคนใหม่ = เตะคนเดิมออกเสมอ */
  function addAssignment(year, month, day, shiftType, pid) {
    if (!pid) return { added: false };
    var rows = getScheduleAssignments(year, month);
    var dup = rows.some(function (r) { return r.day === day && r.shiftType === shiftType && r.pid === pid; });
    if (dup) return { added: false };
    var status = rows.length ? (rows[0].status || 'draft') : 'draft';
    appendRow(SHEETS.SCHEDULES, { year: year, month: month, day: day, shiftType: shiftType, pid: pid, status: status });
    return { added: true };
  }

  function removeAssignment(year, month, day, shiftType, pid) {
    var rows = getScheduleAssignments(year, month);
    var existing = rows.filter(function (r) { return r.day === day && r.shiftType === shiftType && r.pid === pid; })[0];
    if (existing) deleteRow_(SHEETS.SCHEDULES, existing.__rowIndex);
    return { removed: !!existing };
  }

  function setScheduleStatus(year, month, status) {
    var sheet = getSheet_(SHEETS.SCHEDULES);
    var rows = getScheduleAssignments(year, month);
    if (!rows.length) return;
    var col = headerIndex_(sheet, 'status') + 1;
    var minRow = rows.reduce(function (m, r) { return Math.min(m, r.__rowIndex); }, Infinity);
    var maxRow = rows.reduce(function (m, r) { return Math.max(m, r.__rowIndex); }, -Infinity);
    var range = sheet.getRange(minRow, col, maxRow - minRow + 1, 1);
    var values = range.getValues();
    rows.forEach(function (r) { values[r.__rowIndex - minRow][0] = status; });
    range.setValues(values);
    invalidateReadAllCache_(SHEETS.SCHEDULES);
  }

  function headerIndex_(sheet, headerName) {
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    return headers.indexOf(headerName);
  }

  /* ---------------- Archive / cleanup ---------------- */

  function isBefore_(year, month, beforeYear, beforeMonth) {
    var y = Number(year), m = Number(month);
    return y < beforeYear || (y === beforeYear && m < beforeMonth);
  }

  /** นับแถวที่จะถูกลบถ้า archive จริง (preview ก่อนยืนยัน) */
  function previewArchive(beforeYear, beforeMonth) {
    var tx = readAll(SHEETS.TRANSACTIONS).filter(function (r) { return isBefore_(r.year, r.month, beforeYear, beforeMonth); }).length;
    var sch = readAll(SHEETS.SCHEDULES).filter(function (r) { return isBefore_(r.year, r.month, beforeYear, beforeMonth); }).length;
    return { transactions: tx, schedules: sch };
  }

  /** ลบข้อมูล Transactions + Schedules ที่เก่ากว่า beforeYear/beforeMonth ออกจาก sheet */
  function archiveOldData(beforeYear, beforeMonth) {
    var txSheet = getSheet_(SHEETS.TRANSACTIONS);
    var txRows = readAll(SHEETS.TRANSACTIONS).filter(function (r) { return isBefore_(r.year, r.month, beforeYear, beforeMonth); });
    if (txRows.length) { deleteRowsBulk_(txSheet, txRows.map(function (r) { return r.__rowIndex; })); invalidateReadAllCache_(SHEETS.TRANSACTIONS); }

    var schSheet = getSheet_(SHEETS.SCHEDULES);
    var schRows = readAll(SHEETS.SCHEDULES).filter(function (r) { return isBefore_(r.year, r.month, beforeYear, beforeMonth); });
    if (schRows.length) { deleteRowsBulk_(schSheet, schRows.map(function (r) { return r.__rowIndex; })); invalidateReadAllCache_(SHEETS.SCHEDULES); }

    return { deletedTransactions: txRows.length, deletedSchedules: schRows.length };
  }

  /* ---------------- Users / login accounts ---------------- */

  /** List all login accounts (without passwordHash/salt — those never go to the client). */
  function listUsers() {
    return readAll(SHEETS.USERS).map(function (u) {
      return { userId: u.userId, name: u.name, email: u.email, role: u.role, active: u.active === true, createdAt: u.createdAt };
    });
  }

  function findUserByEmailRaw_(email) {
    return readAll(SHEETS.USERS).filter(function (u) { return String(u.email).toLowerCase() === String(email).toLowerCase(); })[0] || null;
  }

  /** Creates a login account for a staff member. plainPassword is a one-time temp
   *  password the admin shares with that person; they cannot change it themselves
   *  yet (no self-service change-password flow), so pick something easy to relay. */
  function createUser(name, email, role, plainPassword) {
    if (findUserByEmailRaw_(email)) throw new Error('มีบัญชีอีเมลนี้อยู่แล้ว: ' + email);
    var userId = 'u_' + Utilities.getUuid();
    var salt = Utilities.getUuid();
    var hash = AuthService.hashPassword_(plainPassword, salt);
    appendRow(SHEETS.USERS, {
      userId: userId, name: name, email: email, role: role, passwordHash: hash, salt: salt,
      permsOverride: '', active: true, createdAt: new Date().toISOString()
    });
    return { userId: userId, name: name, email: email, role: role, active: true };
  }

  function setUserActive(userId, active) {
    var sheet = getSheet_(SHEETS.USERS);
    var rec = readAll(SHEETS.USERS).filter(function (u) { return u.userId === userId; })[0];
    if (!rec) throw new Error('ไม่พบบัญชี');
    sheet.getRange(rec.__rowIndex, headerIndex_(sheet, 'active') + 1).setValue(active);
    invalidateReadAllCache_(SHEETS.USERS);
  }

  function resetUserPassword(userId, newPlainPassword) {
    var sheet = getSheet_(SHEETS.USERS);
    var rec = readAll(SHEETS.USERS).filter(function (u) { return u.userId === userId; })[0];
    if (!rec) throw new Error('ไม่พบบัญชี');
    var salt = Utilities.getUuid();
    var hash = AuthService.hashPassword_(newPlainPassword, salt);
    sheet.getRange(rec.__rowIndex, headerIndex_(sheet, 'passwordHash') + 1).setValue(hash);
    sheet.getRange(rec.__rowIndex, headerIndex_(sheet, 'salt') + 1).setValue(salt);
    invalidateReadAllCache_(SHEETS.USERS);
  }

  /* ---------------- Permissions ---------------- */

  function getPermission(role, action) {
    var rows = readAll(SHEETS.PERMISSIONS);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].roleId === role && rows[i].action === action) return rows[i].allowed === true || rows[i].allowed === 'true' || rows[i].allowed === 'TRUE';
    }
    return false;
  }

  function getAllPermissions() { return readAll(SHEETS.PERMISSIONS); }

  /** Used by the role-permission matrix in the ตั้งค่า > สิทธิ์การใช้งาน section. */
  function setPermission(role, action, allowed) {
    var sheet = getSheet_(SHEETS.PERMISSIONS);
    var rows = getAllPermissions();
    var existing = rows.filter(function (r) { return r.roleId === role && r.action === action; })[0];
    if (existing) {
      sheet.getRange(existing.__rowIndex, headerIndex_(sheet, 'allowed') + 1).setValue(allowed);
      invalidateReadAllCache_(SHEETS.PERMISSIONS);
    } else {
      appendRow(SHEETS.PERMISSIONS, { roleId: role, action: action, allowed: allowed });
    }
  }

  return {
    readAll: readAll, appendRow: appendRow, batchAppend: batchAppend,
    listUsers: listUsers, createUser: createUser, setUserActive: setUserActive, resetUserPassword: resetUserPassword,
    getSettings: getSettings, saveSettings: saveSettings,
    getPeople: getPeople, getStations: getStations, getShifts: getShifts,
    getRates: getRates, getRateOverrides: getRateOverrides, getHolidays: getHolidays,
    getHolidaysForYear: getHolidaysForYear, seedThaiHolidays: seedThaiHolidays,
    getMasterRecord: getMasterRecord, crudMasterData: crudMasterData,
    getAvailability: getAvailability, addAvailability: addAvailability,
    getOnCallRecords: getOnCallRecords, addOnCallRecord: addOnCallRecord, deleteTransactionById: deleteTransactionById,
    getTransactionById: getTransactionById,
    updateTransactionById_: updateTransactionById_,
    getPayAdjustments: getPayAdjustments, setPayAdjustment: setPayAdjustment,
    getOverrides: getOverrides, addOverride: addOverride, addOverridesBulk: addOverridesBulk, clearAutoOverrides: clearAutoOverrides,
    clearSchedule: clearSchedule,
    getRuleViolations: getRuleViolations, clearRuleViolations: clearRuleViolations, addRuleViolations: addRuleViolations,
    finalizeGenerateWrites: finalizeGenerateWrites,
    getTrailInfo: getTrailInfo, setTrailInfo: setTrailInfo,
    getDutyRoster: getDutyRoster, setDutyRoster: setDutyRoster,
    getScheduleAssignments: getScheduleAssignments, getScheduleStatus: getScheduleStatus,
    saveScheduleAssignments: saveScheduleAssignments, setScheduleStatus: setScheduleStatus,
    addAssignment: addAssignment, removeAssignment: removeAssignment,
    getPermission: getPermission, getAllPermissions: getAllPermissions, setPermission: setPermission,
    crudMasterDataBulk: crudMasterDataBulk,
    previewArchive: previewArchive, archiveOldData: archiveOldData
  };
})();
