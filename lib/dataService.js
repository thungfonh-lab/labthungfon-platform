/**
 * dataService.js — Repository layer. All Sheets access goes through here.
 * Ported 1:1 from DataService.gs. Maps generic Sheets rows back into the
 * original CFG/DATA shapes so businessService.js can stay logic-identical.
 */

const gs = require('./googleSheets');

const SHEETS = {
  USERS: 'Users',
  ROLES: 'Roles',
  PERMISSIONS: 'Permissions',
  MASTER: 'MasterData',
  TRANSACTIONS: 'Transactions',
  SCHEDULES: 'Schedules',
  REPORTS_CACHE: 'ReportsCache',
  AUDIT: 'AuditLogs',
  SETTINGS: 'Settings'
};

const MASTER_CATEGORY = {
  PEOPLE: 'people',
  STATION: 'station',
  SHIFT: 'shift',
  RATE: 'rate',
  RATE_OVERRIDE: 'rateOvr',
  HOLIDAY: 'holiday'
};

const TX_CATEGORY = {
  AVAILABILITY: 'availability',
  ONCALL: 'oncall',
  PAY_ADJ: 'payAdj',
  OVERRIDE: 'override',
  RULE_VIOLATION: 'ruleViolation',
  TRAIL_INFO: 'trailInfo',
  DUTY_ROSTER: 'dutyRoster'
};

function uuid() {
  // crypto.randomUUID is available in Node 16.17+/18+
  return require('crypto').randomUUID();
}

function parseJsonSafe(v, fallback) {
  if (v === '' || v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

/* ---------------- Settings ---------------- */

async function getSettings() {
  const rows = await gs.readAll(SHEETS.SETTINGS);
  const cfg = {};
  rows.forEach((r) => {
    let v = r.value;
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (typeof v === 'string' && /^\{.*\}$|^\[.*\]$/.test(v)) v = parseJsonSafe(v, v);
    cfg[r.key] = v;
  });
  return cfg;
}

async function saveSettings(patch) {
  const rows = await gs.readAll(SHEETS.SETTINGS);
  const byKey = {};
  rows.forEach((r) => { byKey[r.key] = r; });
  for (const key of Object.keys(patch)) {
    const value = typeof patch[key] === 'object' ? JSON.stringify(patch[key]) : patch[key];
    if (byKey[key]) {
      await gs.updateCell(SHEETS.SETTINGS, byKey[key].__rowIndex, 2, value);
    } else {
      await gs.appendRow(SHEETS.SETTINGS, { key, value });
    }
  }
  return getSettings();
}

/* ---------------- MasterData ---------------- */

async function getMasterByCategory(category) {
  const rows = await gs.readAll(SHEETS.MASTER);
  return rows
    .filter((r) => r.category === category)
    .map((r) => {
      const data = parseJsonSafe(r.data, {});
      data.id = data.id || r.id;
      data.__rowIndex = r.__rowIndex;
      return data;
    });
}

async function getMasterRecord(category, id) {
  const rows = await getMasterByCategory(category);
  return rows.filter((r) => r.id === id)[0] || null;
}

async function getPeople() { return getMasterByCategory(MASTER_CATEGORY.PEOPLE); }
async function getStations() { return getMasterByCategory(MASTER_CATEGORY.STATION); }
async function getShifts() { return getMasterByCategory(MASTER_CATEGORY.SHIFT); }
async function getRateOverrides() { return getMasterByCategory(MASTER_CATEGORY.RATE_OVERRIDE); }

async function getRates() {
  const settings = await getSettings();
  let rates = settings.rates || { MT: { ch: 650, b: 650, d0: 325, d1: 325, n: 0 }, LA: { ch: 0, b1: 400, n: 0 } };
  if (rates.MT && rates.MT.d !== undefined && rates.MT.d0 === undefined) {
    rates.MT.d0 = rates.MT.d; rates.MT.d1 = rates.MT.d;
  }
  return rates;
}

async function getHolidays(year, month) {
  const rows = await getMasterByCategory(MASTER_CATEGORY.HOLIDAY);
  return rows.filter((h) => h.year === year && h.month === month);
}

async function getHolidaysForYear(year) {
  const rows = await getMasterByCategory(MASTER_CATEGORY.HOLIDAY);
  return rows.filter((h) => h.year === year);
}

const THAI_FIXED_HOLIDAYS = [
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
const THAI_LUNAR_HOLIDAYS = {
  2567: [{ month: 1, day: 24, name: 'วันมาฆบูชา' }, { month: 4, day: 22, name: 'วันวิสาขบูชา' }, { month: 6, day: 20, name: 'วันอาสาฬหบูชา' }, { month: 6, day: 21, name: 'วันเข้าพรรษา' }],
  2568: [{ month: 1, day: 12, name: 'วันมาฆบูชา' }, { month: 4, day: 11, name: 'วันวิสาขบูชา' }, { month: 6, day: 10, name: 'วันอาสาฬหบูชา' }, { month: 6, day: 11, name: 'วันเข้าพรรษา' }]
};

async function seedThaiHolidays(year) {
  const existing = await getHolidaysForYear(year);
  const existingKey = {};
  existing.forEach((h) => { existingKey[h.month + '_' + h.day] = true; });
  const toAdd = THAI_FIXED_HOLIDAYS.concat(THAI_LUNAR_HOLIDAYS[year] || []);
  let added = 0;
  for (const h of toAdd) {
    const key = h.month + '_' + h.day;
    if (existingKey[key]) continue;
    existingKey[key] = true;
    await crudMasterData(MASTER_CATEGORY.HOLIDAY, 'create', { year, month: h.month, day: h.day, name: h.name });
    added++;
  }
  return { added, hasLunarTable: !!THAI_LUNAR_HOLIDAYS[year] };
}

async function crudMasterData(category, op, payload) {
  if (op === 'create') {
    const id = category + '_' + uuid();
    payload.id = id;
    await gs.appendRow(SHEETS.MASTER, { id, category, data: JSON.stringify(payload), updatedAt: new Date().toISOString() });
    return payload;
  }
  if (op === 'update') {
    const existing = await getMasterRecord(category, payload.id);
    if (!existing) throw new Error('ไม่พบข้อมูล id=' + payload.id);
    await gs.updateRow(SHEETS.MASTER, existing.__rowIndex, { id: payload.id, category, data: JSON.stringify(payload), updatedAt: new Date().toISOString() });
    return payload;
  }
  if (op === 'delete') {
    const rec = await getMasterRecord(category, payload.id);
    if (rec) await gs.deleteRow(SHEETS.MASTER, rec.__rowIndex);
    return { id: payload.id, deleted: true };
  }
  throw new Error('ไม่รู้จัก operation: ' + op);
}

async function crudMasterDataBulk(category, payloads) {
  const sheets = gs.getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: gs.getSpreadsheetId(), range: `'${SHEETS.MASTER}'` });
  const rows = res.data.values || [];
  const byId = {};
  payloads.forEach((p) => { byId[p.id] = p; });
  const now = new Date().toISOString();
  const updates = [];
  for (let i = 1; i < rows.length; i++) {
    const id = rows[i][0], cat = rows[i][1];
    if (cat === category && byId[id]) {
      updates.push({ range: `'${SHEETS.MASTER}'!A${i + 1}:D${i + 1}`, values: [[id, category, JSON.stringify(byId[id]), now]] });
    }
  }
  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: gs.getSpreadsheetId(),
      requestBody: { valueInputOption: 'RAW', data: updates }
    });
  }
  gs.invalidateReadAllCache(SHEETS.MASTER);
  return payloads;
}

/* ---------------- Transactions ---------------- */

async function getTransactions(category, year, month, pid) {
  const rows = await gs.readAll(SHEETS.TRANSACTIONS);
  return rows.filter((r) => {
    if (r.category !== category) return false;
    if (year !== undefined && r.year !== year) return false;
    if (month !== undefined && r.month !== month) return false;
    if (pid !== undefined && r.pid !== pid) return false;
    return true;
  }).map((r) => {
    const data = parseJsonSafe(r.data, {});
    data.__rowIndex = r.__rowIndex;
    data.__txId = r.id;
    return data;
  });
}

async function addTransaction(category, year, month, pid, data, createdBy) {
  const id = category + '_' + uuid();
  await gs.appendRow(SHEETS.TRANSACTIONS, {
    id, category, year, month, pid: pid || '',
    data: JSON.stringify(data), createdAt: new Date().toISOString(), createdBy: createdBy || ''
  });
  return id;
}

async function addTransactionsBulk(items) {
  if (!items.length) return;
  const now = new Date().toISOString();
  const rows = items.map((it) => ({
    id: it.category + '_' + uuid(), category: it.category, year: it.year, month: it.month,
    pid: it.pid || '', data: JSON.stringify(it.data), createdAt: now, createdBy: it.createdBy || ''
  }));
  await gs.batchAppend(SHEETS.TRANSACTIONS, rows);
}

async function getAvailability(year, month) { return getTransactions(TX_CATEGORY.AVAILABILITY, year, month); }
async function addAvailability(year, month, pid, entry, createdBy) { return addTransaction(TX_CATEGORY.AVAILABILITY, year, month, pid, entry, createdBy); }

async function getOnCallRecords(year, month) { return getTransactions(TX_CATEGORY.ONCALL, year, month); }
async function addOnCallRecord(year, month, pid, entry, createdBy) { return addTransaction(TX_CATEGORY.ONCALL, year, month, pid, entry, createdBy); }

async function getPayAdjustments(year, month) { return getTransactions(TX_CATEGORY.PAY_ADJ, year, month); }
async function setPayAdjustment(year, month, pid, shiftMap, createdBy) { return addTransaction(TX_CATEGORY.PAY_ADJ, year, month, pid, shiftMap, createdBy); }

async function getOverrides(year, month) { return getTransactions(TX_CATEGORY.OVERRIDE, year, month); }
async function addOverride(year, month, entry, createdBy) { return addTransaction(TX_CATEGORY.OVERRIDE, year, month, null, entry, createdBy); }
async function addOverridesBulk(year, month, entries, createdBy) {
  await addTransactionsBulk(entries.map((entry) => ({ category: TX_CATEGORY.OVERRIDE, year, month, pid: null, data: entry, createdBy })));
}

async function clearAutoOverrides(year, month) {
  const AUTO_TYPES = ['balance-swap', 'cross-month-unlock'];
  const rows = (await getTransactions(TX_CATEGORY.OVERRIDE, year, month)).filter((o) => AUTO_TYPES.indexOf(o.type) > -1);
  if (rows.length) await gs.deleteRowsBulk(SHEETS.TRANSACTIONS, rows.map((o) => o.__rowIndex));
}

/** ท้าย generateSchedule(): trailInfo + ruleViolations + auto-overrides ทั้งหมดล้วน
 *  อยู่ใน sheet TRANSACTIONS เดียวกัน — เดิมเรียก setTrailInfo/clearRuleViolations/addRuleViolations/
 *  clearAutoOverrides/addOverridesBulk แยกกัน 5 ครั้ง แต่ละครั้งที่มีการเขียน (write) จะ invalidate
 *  _readAllCache ของ TRANSACTIONS ทำให้ฟังก์ชันถัดไปที่ต้องอ่านก่อนเขียน (setTrailInfo, clearRuleViolations,
 *  clearAutoOverrides) ต้องยิง Sheets API อ่านใหม่ทุกครั้ง (cascade re-read) — รวมแล้ว generate 1 ครั้ง
 *  อ่าน TRANSACTIONS ซ้ำ 3 รอบโดยไม่จำเป็น จนชน "Read requests per minute per user" quota เมื่อ generate
 *  หลายเดือนติดกันในเวลาสั้นๆ ฟังก์ชันนี้อ่าน TRANSACTIONS ครั้งเดียว (ใช้ cache ที่ยัง warm จากการอ่าน
 *  ก่อนหน้าในคำร้องเดียวกัน เช่น getAvailability/getTrailInfo(prevMonth)/getDutyRoster) แล้วรวมการเขียน
 *  ทั้งหมดเป็น update/append(trailInfo) + delete(รวม) + append(รวม) = 3 การเขียน แทนที่จะอ่าน 3 + เขียน 5 */
async function finalizeGenerateWrites(year, month, trailInfo, ruleViolations, overrides, createdBy) {
  const AUTO_TYPES = ['balance-swap', 'cross-month-unlock'];
  const rows = await gs.readAll(SHEETS.TRANSACTIONS);
  const existingTrail = rows.find((r) => r.category === TX_CATEGORY.TRAIL_INFO && r.year === year && r.month === month);
  const toDelete = rows.filter((r) => {
    if (r.year !== year || r.month !== month) return false;
    if (r.category === TX_CATEGORY.RULE_VIOLATION) return true;
    if (r.category === TX_CATEGORY.OVERRIDE) return AUTO_TYPES.indexOf(parseJsonSafe(r.data, {}).type) > -1;
    return false;
  });

  if (existingTrail) {
    await gs.updateRow(SHEETS.TRANSACTIONS, existingTrail.__rowIndex, {
      id: existingTrail.id, category: TX_CATEGORY.TRAIL_INFO, year, month,
      pid: trailInfo.lastPid || '', data: JSON.stringify(trailInfo), createdAt: new Date().toISOString(), createdBy: createdBy || ''
    });
  } else {
    await addTransaction(TX_CATEGORY.TRAIL_INFO, year, month, trailInfo.lastPid, trailInfo, createdBy);
  }
  if (toDelete.length) await gs.deleteRowsBulk(SHEETS.TRANSACTIONS, toDelete.map((r) => r.__rowIndex));

  const bulkItems = ruleViolations.map((v) => ({ category: TX_CATEGORY.RULE_VIOLATION, year, month, pid: v.pid, data: v, createdBy }))
    .concat(overrides.map((o) => ({ category: TX_CATEGORY.OVERRIDE, year, month, pid: null, data: o, createdBy })));
  if (bulkItems.length) await addTransactionsBulk(bulkItems);
}

async function getRuleViolations(year, month) { return getTransactions(TX_CATEGORY.RULE_VIOLATION, year, month); }
async function clearRuleViolations(year, month) {
  const rows = await getTransactions(TX_CATEGORY.RULE_VIOLATION, year, month);
  if (rows.length) await gs.deleteRowsBulk(SHEETS.TRANSACTIONS, rows.map((r) => r.__rowIndex));
}
async function addRuleViolations(year, month, violations, createdBy) {
  await addTransactionsBulk(violations.map((v) => ({ category: TX_CATEGORY.RULE_VIOLATION, year, month, pid: v.pid, data: v, createdBy })));
}

async function deleteTransactionById(txId) {
  const rows = await gs.readAll(SHEETS.TRANSACTIONS);
  const rec = rows.filter((r) => r.id === txId)[0];
  if (rec) await gs.deleteRow(SHEETS.TRANSACTIONS, rec.__rowIndex);
}

async function updateTransactionById(txId, pid, data) {
  const rows = await gs.readAll(SHEETS.TRANSACTIONS);
  const rec = rows.filter((r) => r.id === txId)[0];
  if (!rec) throw new Error('ไม่พบรายการ id=' + txId);
  await gs.updateRow(SHEETS.TRANSACTIONS, rec.__rowIndex, {
    id: rec.id, category: rec.category, year: rec.year, month: rec.month,
    pid: pid || '', data: JSON.stringify(data), createdAt: rec.createdAt, createdBy: rec.createdBy
  });
  return Object.assign({}, data, { __txId: rec.id });
}

async function getTrailInfo(year, month) {
  const rows = await getTransactions(TX_CATEGORY.TRAIL_INFO, year, month);
  return rows[0] || null;
}
async function setTrailInfo(year, month, info, createdBy) {
  const existing = await getTrailInfo(year, month);
  if (existing) {
    await gs.updateRow(SHEETS.TRANSACTIONS, existing.__rowIndex, {
      id: existing.__txId, category: TX_CATEGORY.TRAIL_INFO, year, month,
      pid: info.lastPid || '', data: JSON.stringify(info), createdAt: new Date().toISOString(), createdBy: createdBy || ''
    });
  } else {
    await addTransaction(TX_CATEGORY.TRAIL_INFO, year, month, info.lastPid, info, createdBy);
  }
}

async function getDutyRoster(year, month) {
  const rows = await getTransactions(TX_CATEGORY.DUTY_ROSTER, year, month);
  return rows[0] || null;
}
async function setDutyRoster(year, month, data, createdBy) {
  const existing = await getDutyRoster(year, month);
  if (existing) {
    await gs.updateRow(SHEETS.TRANSACTIONS, existing.__rowIndex, {
      id: existing.__txId, category: TX_CATEGORY.DUTY_ROSTER, year, month,
      pid: '', data: JSON.stringify(data), createdAt: new Date().toISOString(), createdBy: createdBy || ''
    });
  } else {
    await addTransaction(TX_CATEGORY.DUTY_ROSTER, year, month, null, data, createdBy);
  }
}

/* ---------------- Schedules ---------------- */

async function getScheduleAssignments(year, month) {
  const rows = await gs.readAll(SHEETS.SCHEDULES);
  return rows.filter((r) => r.year === year && r.month === month);
}

async function getScheduleStatus(year, month) {
  const rows = await getScheduleAssignments(year, month);
  return rows.length ? (rows[0].status || 'draft') : 'none';
}

async function saveScheduleAssignments(year, month, assignments, status) {
  const existing = await getScheduleAssignments(year, month);
  if (existing.length) await gs.deleteRowsBulk(SHEETS.SCHEDULES, existing.map((r) => r.__rowIndex));
  const rows = assignments.map((a) => ({ year, month, day: a.day, shiftType: a.shiftType, pid: a.pid, status }));
  await gs.batchAppend(SHEETS.SCHEDULES, rows);
  return rows;
}

/** ตั้งแต่รองรับหลายคนต่อ 1 เวร/1 วัน — day+shiftType ไม่ใช่ unique key อีกต่อไป
 *  (หลาย row วัน+เวรเดียวกัน คนละ pid = หลายคนอยู่เวรพร้อมกัน) ใช้แทน setAssignment เดิม
 *  ที่เคย "หา row เดียวแล้วเขียนทับ" ซึ่งทำให้เพิ่มคนใหม่ = เตะคนเดิมออกเสมอ */
async function addAssignment(year, month, day, shiftType, pid) {
  if (!pid) return { added: false };
  const rows = await getScheduleAssignments(year, month);
  const dup = rows.some((r) => r.day === day && r.shiftType === shiftType && r.pid === pid);
  if (dup) return { added: false };
  const status = rows.length ? (rows[0].status || 'draft') : 'draft';
  await gs.appendRow(SHEETS.SCHEDULES, { year, month, day, shiftType, pid, status });
  return { added: true };
}

async function removeAssignment(year, month, day, shiftType, pid) {
  const rows = await getScheduleAssignments(year, month);
  const existing = rows.filter((r) => r.day === day && r.shiftType === shiftType && r.pid === pid)[0];
  if (existing) await gs.deleteRow(SHEETS.SCHEDULES, existing.__rowIndex);
  return { removed: !!existing };
}

async function setScheduleStatus(year, month, status) {
  const rows = await getScheduleAssignments(year, month);
  if (!rows.length) return;
  const headers = await gs.getHeaders(SHEETS.SCHEDULES);
  const col = headers.indexOf('status') + 1;
  const sheets = gs.getSheetsClient();
  const minRow = rows.reduce((m, r) => Math.min(m, r.__rowIndex), Infinity);
  const maxRow = rows.reduce((m, r) => Math.max(m, r.__rowIndex), -Infinity);
  const colLetter = gs.colLetter(col);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: gs.getSpreadsheetId(),
    range: `'${SHEETS.SCHEDULES}'!${colLetter}${minRow}:${colLetter}${maxRow}`
  });
  const values = (res.data.values || []).map((v) => v.slice());
  while (values.length < maxRow - minRow + 1) values.push(['']);
  rows.forEach((r) => { values[r.__rowIndex - minRow] = [status]; });
  await sheets.spreadsheets.values.update({
    spreadsheetId: gs.getSpreadsheetId(),
    range: `'${SHEETS.SCHEDULES}'!${colLetter}${minRow}:${colLetter}${maxRow}`,
    valueInputOption: 'RAW',
    requestBody: { values }
  });
  gs.invalidateReadAllCache(SHEETS.SCHEDULES);
}

/* ---------------- Users ---------------- */

async function listUsers() {
  const rows = await gs.readAll(SHEETS.USERS);
  return rows.map((u) => ({ userId: u.userId, name: u.name, email: u.email, role: u.role, active: u.active === true || u.active === 'TRUE' || u.active === 'true', createdAt: u.createdAt }));
}

async function findUserByEmailRaw(email) {
  const rows = await gs.readAll(SHEETS.USERS);
  return rows.filter((u) => String(u.email).toLowerCase() === String(email).toLowerCase())[0] || null;
}

async function findUserById(userId) {
  const rows = await gs.readAll(SHEETS.USERS);
  return rows.filter((u) => u.userId === userId)[0] || null;
}

async function createUser(name, email, role, plainPassword, hashPasswordFn) {
  if (await findUserByEmailRaw(email)) throw new Error('มีบัญชีอีเมลนี้อยู่แล้ว: ' + email);
  const userId = 'u_' + uuid();
  const salt = uuid();
  const hash = hashPasswordFn(plainPassword, salt);
  await gs.appendRow(SHEETS.USERS, {
    userId, name, email, role, passwordHash: hash, salt,
    permsOverride: '', active: true, createdAt: new Date().toISOString()
  });
  return { userId, name, email, role, active: true };
}

async function setUserActive(userId, active) {
  const rec = await findUserById(userId);
  if (!rec) throw new Error('ไม่พบบัญชี');
  const headers = await gs.getHeaders(SHEETS.USERS);
  await gs.updateCell(SHEETS.USERS, rec.__rowIndex, headers.indexOf('active') + 1, active);
}

async function resetUserPassword(userId, newPlainPassword, hashPasswordFn) {
  const rec = await findUserById(userId);
  if (!rec) throw new Error('ไม่พบบัญชี');
  const salt = uuid();
  const hash = hashPasswordFn(newPlainPassword, salt);
  const headers = await gs.getHeaders(SHEETS.USERS);
  await gs.updateCell(SHEETS.USERS, rec.__rowIndex, headers.indexOf('passwordHash') + 1, hash);
  await gs.updateCell(SHEETS.USERS, rec.__rowIndex, headers.indexOf('salt') + 1, salt);
}

/* ---------------- Permissions ---------------- */

async function getPermission(role, action) {
  const rows = await gs.readAll(SHEETS.PERMISSIONS);
  for (const r of rows) {
    if (r.roleId === role && r.action === action) return r.allowed === true || r.allowed === 'true' || r.allowed === 'TRUE';
  }
  return false;
}

async function getAllPermissions() { return gs.readAll(SHEETS.PERMISSIONS); }

async function setPermission(role, action, allowed) {
  const rows = await getAllPermissions();
  const existing = rows.filter((r) => r.roleId === role && r.action === action)[0];
  if (existing) {
    const headers = await gs.getHeaders(SHEETS.PERMISSIONS);
    await gs.updateCell(SHEETS.PERMISSIONS, existing.__rowIndex, headers.indexOf('allowed') + 1, allowed);
  } else {
    await gs.appendRow(SHEETS.PERMISSIONS, { roleId: role, action, allowed });
  }
}

module.exports = {
  SHEETS, MASTER_CATEGORY, TX_CATEGORY,
  readAll: gs.readAll, appendRow: gs.appendRow,
  getSettings, saveSettings,
  getPeople, getStations, getShifts, getRates, getRateOverrides,
  getHolidays, getHolidaysForYear, seedThaiHolidays,
  getMasterRecord, crudMasterData, crudMasterDataBulk,
  getAvailability, addAvailability,
  getOnCallRecords, addOnCallRecord, deleteTransactionById, updateTransactionById,
  getPayAdjustments, setPayAdjustment,
  getOverrides, addOverride, addOverridesBulk, clearAutoOverrides,
  getRuleViolations, clearRuleViolations, addRuleViolations, finalizeGenerateWrites,
  getTrailInfo, setTrailInfo,
  getDutyRoster, setDutyRoster,
  getScheduleAssignments, getScheduleStatus, saveScheduleAssignments, setScheduleStatus,
  addAssignment, removeAssignment,
  listUsers, findUserByEmailRaw, findUserById, createUser, setUserActive, resetUserPassword,
  getPermission, getAllPermissions, setPermission
};
