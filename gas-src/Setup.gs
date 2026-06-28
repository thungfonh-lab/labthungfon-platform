/**
 * Setup.gs — One-time / idempotent provisioning.
 * Run runFullSetup() once from the Apps Script editor (or a custom menu item)
 * to create all Sheets, headers, default roles/permissions, settings and Drive folders.
 */

var DRIVE_ROOT_FOLDER_NAME = 'labthungfon-platform-data';

function runFullSetup() {
  setupSheets_();
  setupDefaultRoles_();
  setupDefaultPermissions_();
  setupDefaultSettings_();
  setupDriveFolders_();
  SpreadsheetApp.getActive().toast('Setup complete', 'labthungfon Platform', 5);
}

function setupSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var schema = {};
  schema[SHEETS.USERS] = ['userId', 'name', 'email', 'role', 'passwordHash', 'salt', 'permsOverride', 'active', 'createdAt'];
  schema[SHEETS.ROLES] = ['roleId', 'roleName', 'description'];
  schema[SHEETS.PERMISSIONS] = ['roleId', 'action', 'allowed'];
  schema[SHEETS.MASTER] = ['id', 'category', 'data', 'updatedAt', 'updatedBy'];
  schema[SHEETS.TRANSACTIONS] = ['id', 'category', 'year', 'month', 'pid', 'data', 'createdAt', 'createdBy'];
  schema[SHEETS.SCHEDULES] = ['year', 'month', 'day', 'shiftType', 'pid', 'status'];
  schema[SHEETS.REPORTS_CACHE] = ['reportKey', 'payload', 'generatedAt', 'expiresAt'];
  schema[SHEETS.AUDIT] = ['id', 'userId', 'action', 'module', 'entityRef', 'before', 'after', 'timestamp'];
  schema[SHEETS.SETTINGS] = ['key', 'value'];

  Object.keys(schema).forEach(function (sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }
    var headers = schema[sheetName];
    var existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    var needsHeader = existing.join('') === '';
    if (needsHeader) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    }
  });

  var defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }
}

/* =========================================================================
 * Maintenance functions — รันได้จากเมนู Run ใน Apps Script editor
 * (ตั้งชื่อโดยไม่มี _ ต่อท้าย เพราะ Apps Script จะซ่อนฟังก์ชันที่ลงท้ายด้วย _ จากเมนู Run)
 * ========================================================================= */

/**
 * ลบคอลัมน์ที่ไม่ได้ใช้ออกจากชีต Schedules ที่ติดตั้งไปแล้ว (source/updatedAt/updatedBy)
 * เพื่อให้ readAll(Schedules) อ่านข้อมูลน้อยลง โหลดเร็วขึ้น. ปลอดภัยกับชีตที่ตัดไปแล้ว (ไม่เจอคอลัมน์จะข้าม).
 */
function slimSchedules() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SCHEDULES);
  if (!sheet) return 'ไม่พบชีต Schedules';
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var DROP = ['source', 'updatedAt', 'updatedBy'];
  // ลบจากคอลัมน์ขวาสุดไปซ้าย เพื่อไม่ให้ index ของคอลัมน์ที่เหลือเลื่อน
  var indices = [];
  headers.forEach(function (h, i) { if (DROP.indexOf(h) > -1) indices.push(i + 1); });
  indices.sort(function (a, b) { return b - a; });
  indices.forEach(function (col) { sheet.deleteColumn(col); });
  return 'ตัด ' + indices.length + ' คอลัมน์ออกจากชีต Schedules แล้ว';
}

/**
 * ลบข้อมูลตารางเวร "ทั้งหมด" (เก็บเฉพาะแถวหัวตาราง) — ใช้ตอนต้องการเคลียร์เพื่อตรวจสอบการเก็บข้อมูล
 * เดือนที่ลบจะกลับเป็น "ยังไม่มีตารางเวร" แล้วกดสร้างใหม่ได้ตามปกติ (รวมถึงเดือนที่เคยประกาศใช้แล้วด้วย).
 */
function clearAllSchedules() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SCHEDULES);
  if (!sheet) return 'ไม่พบชีต Schedules';
  var last = sheet.getLastRow();
  if (last > 1) sheet.deleteRows(2, last - 1); // เก็บแถวหัวตาราง (แถว 1) ไว้
  return 'ลบข้อมูลตารางเวรทั้งหมดแล้ว (เหลือเฉพาะหัวตาราง)';
}

/**
 * ลบเฉพาะตารางเวรที่ยังเป็น "ดราฟ" (status = draft) เก็บที่ "ประกาศใช้แล้ว" (published) ไว้
 * เพื่อให้ชีตเล็กลง ไม่โหลดข้อมูลเยอะ. ใช้วิธีอ่านทั้งหมด → เขียนเฉพาะที่ published กลับ (เร็ว ไม่ลบทีละแถว).
 */
function clearDraftSchedules() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SCHEDULES);
  if (!sheet) return 'ไม่พบชีต Schedules';
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 'ไม่มีข้อมูลให้ลบ';
  var headers = values[0];
  var statusCol = headers.indexOf('status');
  if (statusCol < 0) return 'ไม่พบคอลัมน์ status';
  var kept = [];
  for (var r = 1; r < values.length; r++) {
    if (values[r].join('') === '') continue;
    if (String(values[r][statusCol]) !== 'draft') kept.push(values[r]);
  }
  var removed = (values.length - 1) - kept.length;
  if (sheet.getLastRow() > 1) sheet.deleteRows(2, sheet.getLastRow() - 1);
  if (kept.length) sheet.getRange(2, 1, kept.length, headers.length).setValues(kept);
  return 'ลบตารางเวรที่เป็นดราฟ ' + removed + ' แถว เหลือที่ประกาศใช้ ' + kept.length + ' แถว';
}

function setupDefaultRoles_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ROLES);
  var existing = sheet.getDataRange().getValues();
  if (existing.length > 1) return; // already seeded

  var rows = [
    ['admin', 'Administrator', 'สิทธิ์เต็มทุกอย่างของระบบ'],
    ['HT', 'หัวหน้าหน่วย', 'อนุมัติ/เผยแพร่ตารางเวร, ดูและแก้ไขค่าตอบแทนทั้งหมด'],
    ['MT', 'นักเทคนิคการแพทย์', 'เก็บข้อมูลเวรของตนเอง'],
    ['LA', 'ผู้ช่วยห้องปฏิบัติการ', 'เก็บข้อมูลเวรของตนเอง']
  ];
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function setupDefaultPermissions_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PERMISSIONS);
  var existing = sheet.getDataRange().getValues();
  if (existing.length > 1) return; // already seeded

  var rows = [];
  Object.keys(DEFAULT_ROLE_PERMS).forEach(function (role) {
    var actions = DEFAULT_ROLE_PERMS[role];
    Object.keys(actions).forEach(function (action) {
      rows.push([role, action, actions[action]]);
    });
  });
  // admin: implicit true for every action used in DEFAULT_ROLE_PERMS.HT, kept explicit for auditability
  Object.keys(DEFAULT_ROLE_PERMS.HT).forEach(function (action) {
    rows.push(['admin', action, true]);
  });
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function setupDefaultSettings_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SETTINGS);
  var existing = sheet.getDataRange().getValues();
  if (existing.length > 1) return; // already seeded

  var defaults = {
    org: '', hosp: '', prov: '', logo: '',
    themeColor: '#0c447c', themeAcc: '#1d9e75',
    dist: 'equal', ht: 'no', clinicHT: 'no', maxC: 4,
    laB: 'b1', laA: 'no', laB2: 'no', clinicLa: 'yes',
    colDay: 25, pubDay: 28,
    chEmail: true, chLine: false, chCal: false,
    lineToken: '', calId: '',
    signH: '', signHT: '', signD: '', signDT: '',
    rates: JSON.stringify({ MT: { ch: 650, b: 650, d: 325, n: 0 }, LA: { ch: 0, b1: 400, n: 0 } })
  };
  var rows = Object.keys(defaults).map(function (k) { return [k, typeof defaults[k] === 'object' ? JSON.stringify(defaults[k]) : defaults[k]]; });
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

function setupDriveFolders_() {
  var folders = DriveApp.getFoldersByName(DRIVE_ROOT_FOLDER_NAME);
  var root = folders.hasNext() ? folders.next() : DriveApp.createFolder(DRIVE_ROOT_FOLDER_NAME);
  ['Exports', 'Backups', 'Attachments'].forEach(function (name) {
    var it = root.getFoldersByName(name);
    if (!it.hasNext()) root.createFolder(name);
  });
  PropertiesService.getScriptProperties().setProperty('ROOT_FOLDER_ID', root.getId());
  return root.getId();
}

function getRootFolder_() {
  var id = PropertiesService.getScriptProperties().getProperty('ROOT_FOLDER_ID');
  return id ? DriveApp.getFolderById(id) : DriveApp.getFolderById(setupDriveFolders_());
}

function getSubFolder_(name) {
  var root = getRootFolder_();
  var it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

/**
 * Seed an initial admin user. Call manually once with a real email/password,
 * then delete this call from any production script trigger.
 */
function seedAdminUser(email, plainPassword) {
  var salt = Utilities.getUuid();
  var hash = AuthService.hashPassword_(plainPassword, salt);
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.USERS);
  sheet.appendRow(['admin', 'System Administrator', email, 'admin', hash, salt, '', true, new Date().toISOString()]);
}

/**
 * Run this ONCE from the Apps Script editor (select createFirstAdmin from the
 * function dropdown, then Run) to create the first login. Change ADMIN_EMAIL/
 * ADMIN_PASSWORD below before running, then change the password from inside
 * the app afterwards. Safe to re-run check: skips if the email already exists.
 */
function createFirstAdmin() {
  var ADMIN_EMAIL = 'waritsara.pyc@gmail.com';
  var ADMIN_PASSWORD = 'ChangeMe123!';

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.USERS);
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][2]).toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
      SpreadsheetApp.getActive().toast('มีบัญชีนี้อยู่แล้ว: ' + ADMIN_EMAIL, 'labthungfon Platform', 5);
      return;
    }
  }
  seedAdminUser(ADMIN_EMAIL, ADMIN_PASSWORD);
  SpreadsheetApp.getActive().toast('สร้างบัญชี admin แล้ว: ' + ADMIN_EMAIL + ' / รหัสผ่านชั่วคราว: ' + ADMIN_PASSWORD, 'labthungfon Platform', 10);
}

/**
 * Restores the 5 fixed shift types (ช/บ/ด/น/บ1) if missing. These are NOT
 * freely add/removable — the scheduling algorithm references their ids
 * (ch/b/d/n/b1) directly — only name/color/short label are editable via
 * the ตั้งค่า > ประเภทเวร page. Safe to re-run: no-op if already present.
 */
function restoreShiftTypes() {
  seedDemoShifts_();
  SpreadsheetApp.getActive().toast('คืนค่าประเภทเวรเรียบร้อย', 'labthungfon Platform', 5);
}

/**
 * Clears ALL test schedule/transaction data (generated schedules, overrides,
 * rule violations, on-call, availability, pay adjustments) for one specific
 * year/month — use this to wipe out leftover dev-testing data for a month
 * before treating it as a clean real-data month. Does NOT touch other months,
 * Users, MasterData, or Settings. Edit YEAR/MONTH below (Buddhist year, month
 * 0=ม.ค....11=ธ.ค. to match the app's internal numbering) then Run.
 */
function clearMonthTestData() {
  var YEAR = 2569;
  var MONTH = 6; // 0-indexed: 6 = กรกฎาคม

  var schedSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SCHEDULES);
  var schedRows = schedSheet.getDataRange().getValues();
  for (var i = schedRows.length - 1; i >= 1; i--) {
    if (schedRows[i][0] === YEAR && schedRows[i][1] === MONTH) schedSheet.deleteRow(i + 1);
  }

  var txSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.TRANSACTIONS);
  var txRows = txSheet.getDataRange().getValues();
  for (var j = txRows.length - 1; j >= 1; j--) {
    if (txRows[j][2] === YEAR && txRows[j][3] === MONTH) txSheet.deleteRow(j + 1);
  }

  SpreadsheetApp.getActive().toast('ล้างข้อมูลทดสอบของเดือน ' + (MONTH + 1) + '/' + YEAR + ' เรียบร้อย', 'labthungfon Platform', 6);
}

/**
 * Clears the seeded demo people/stations/shifts and org settings so you can
 * fill in real data from scratch via the ตั้งค่า page. Does NOT touch Users,
 * Schedules, Transactions, or AuditLogs.
 */
function clearDemoMasterData() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MASTER);
  var rows = sheet.getDataRange().getValues();
  var keepCategories = [MASTER_CATEGORY.RATE_OVERRIDE, MASTER_CATEGORY.HOLIDAY];
  var rowsToDelete = [];
  for (var i = rows.length - 1; i >= 1; i--) {
    var category = rows[i][1];
    if (category === MASTER_CATEGORY.PEOPLE || category === MASTER_CATEGORY.STATION) {
      rowsToDelete.push(i + 1);
    }
  }
  rowsToDelete.forEach(function (rowNum) { sheet.deleteRow(rowNum); });

  var settingsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SETTINGS);
  var keys = ['org', 'hosp', 'prov', 'logo', 'signH', 'signHT', 'signD', 'signDT', 'shiftDisabled', 'labs', 'units'];
  var settingsRows = settingsSheet.getDataRange().getValues();
  for (var j = settingsRows.length - 1; j >= 1; j--) {
    if (keys.indexOf(settingsRows[j][0]) !== -1) settingsSheet.deleteRow(j + 1);
  }

  SpreadsheetApp.getActive().toast('ล้างข้อมูลตัวอย่าง (people/station/shift/org) เรียบร้อย — กรอกข้อมูลจริงผ่านหน้าตั้งค่าได้เลย', 'labthungfon Platform', 8);
}

/**
 * Seed demo data — ported verbatim from the original DEF config in
 * labthungfon-platform-v4_43.html (lines 1594-1636): DEFAULT_SHIFTS,
 * CFG.stations, CFG.people, CFG.rates, org/signature settings.
 * Safe to re-run: skips categories that already have rows.
 */
function seedDemoData() {
  seedDemoShifts_();
  seedDemoStations_();
  seedDemoPeople_();
  seedDemoOrgSettings_();
  SpreadsheetApp.getActive().toast('Demo data seeded', 'labthungfon Platform', 5);
}

function alreadySeeded_(category) {
  return DataService.readAll(SHEETS.MASTER).some(function (r) { return r.category === category; });
}

function seedDemoShifts_() {
  if (alreadySeeded_(MASTER_CATEGORY.SHIFT)) return;
  var shifts = [
    { id: 'ch', name: 'ปฏิบัติงาน (08.00 – 16.00 น.) วันหยุด/นักขัตฤกษ์', short: 'ช', color: '#0a4f47', bg: '#d9ebe8' },
    { id: 'b', name: 'ปฏิบัติงานนอกเวลา (16.00 – 24.00 น.)', short: 'บ', color: '#2f5fa0', bg: '#e7eef8' },
    { id: 'd', name: 'ปฏิบัติงาน On call (24.00 – 08.00 น.)', short: 'ด', color: '#7a5618', bg: '#f7ecd6' },
    { id: 'n', name: 'ปฏิบัติงานนอกเวลา คลินิก (07.00 – 08.00 น.)', short: 'น', color: '#6b4e16', bg: '#ede0c4' },
    { id: 'b1', name: 'ปฏิบัติงานนอกเวลา ผู้ช่วย (16.00 – 20.00 น.)', short: 'บ1', color: '#7a4fa0', bg: '#efe7f7' }
  ];
  shifts.forEach(function (s) {
    DataService.appendRow(SHEETS.MASTER, {
      id: 'shift_' + s.id, category: MASTER_CATEGORY.SHIFT,
      data: JSON.stringify(Object.assign({ id: s.id }, s)), updatedAt: new Date().toISOString()
    });
  });
}

function seedDemoStations_() {
  if (alreadySeeded_(MASTER_CATEGORY.STATION)) return;
  var stations = [
    { id: 's1', name: 'จุดที่ 1 ด่านหน้า เก็บสิ่งส่งตรวจ', assigned: ['p1'], rotate: false, rotateWith: null },
    { id: 's2', name: 'จุดที่ 2 เตรียมสิ่งส่งตรวจ 1', assigned: ['p4'], rotate: false, rotateWith: null },
    { id: 's3', name: 'จุดที่ 3 เตรียมสิ่งส่งตรวจ 2', assigned: ['p5'], rotate: false, rotateWith: null },
    { id: 's4', name: 'จุดที่ 4 Chem Immune Bloodbank', assigned: ['p2'], rotate: true, rotateWith: 's5' },
    { id: 's5', name: 'จุดที่ 5 Hemato Micro Micross', assigned: ['p3'], rotate: true, rotateWith: 's4' }
  ];
  stations.forEach(function (s) {
    DataService.appendRow(SHEETS.MASTER, {
      id: 'station_' + s.id, category: MASTER_CATEGORY.STATION,
      data: JSON.stringify(Object.assign({ id: s.id }, s)), updatedAt: new Date().toISOString()
    });
  });
}

function seedDemoPeople_() {
  if (alreadySeeded_(MASTER_CATEGORY.PEOPLE)) return;
  var people = [
    { id: 'p1', pfx: 'ทนพญ.', name: 'ภัทรวดี พรพาเจริญ', short: 'ภัทรวดี', role: 'HT', title: 'หัวหน้านักเทคนิคการแพทย์', phone: '099-2511653', email: 'phattarawadi@hospital.go.th', priority: 1, active: true },
    { id: 'p2', pfx: 'ทนพ.', name: 'อภิวัฒน์ ทานะ', short: 'อภิวัฒน์', role: 'MT', title: 'นักเทคนิคการแพทย์', phone: '093-0737022', email: 'apiwat@hospital.go.th', priority: 2, active: true },
    { id: 'p3', pfx: 'ทนพญ.', name: 'เบญญาภา ธรา', short: 'เบญญาภา', role: 'MT', title: 'นักเทคนิคการแพทย์', phone: '093-3238117', email: 'benyapha@hospital.go.th', priority: 3, active: true },
    { id: 'p4', pfx: 'นาย', name: 'เสวียน เทียมราช', short: 'เสวียน', role: 'LA', title: 'ผู้ช่วย', phone: '', email: 'sawian@hospital.go.th', priority: 4, active: true },
    { id: 'p5', pfx: 'นาง', name: 'ศิริกัลยา อมาตยกุล', short: 'ศิริกัลยา', role: 'LA', title: 'ผู้ช่วย', phone: '', email: 'sirikanlaya@hospital.go.th', priority: 5, active: true }
  ];
  people.forEach(function (p) {
    DataService.appendRow(SHEETS.MASTER, {
      id: 'people_' + p.id, category: MASTER_CATEGORY.PEOPLE,
      data: JSON.stringify(Object.assign({ id: p.id }, p)), updatedAt: new Date().toISOString()
    });
  });
}

function seedDemoOrgSettings_() {
  var current = DataService.getSettings();
  if (current.org) return; // already configured
  DataService.saveSettings({
    org: 'กลุ่มงานเทคนิคการแพทย์', hosp: 'โรงพยาบาลทุ่งฝน', prov: 'อำเภอทุ่งฝน จังหวัดอุดรธานี', logo: 'MT',
    themeColor: '#0f6e63', themeAcc: '#b8842b',
    dist: 'equal', ht: 'yes', clinicHT: 'yes', maxC: 4, laB: 'A', laA: 'p5', laB2: 'p4', clinicLa: 'auto',
    shiftDisabled: { n_mt: [], n_la: [], ch: [], b: [], d: [], b1: [] },
    labs: ['CBC', 'Coagulation (PT/PTT)', 'Electrolyte', 'BUN/Cr', 'Glucose (DTX)', 'Blood gas', 'Cardiac enzyme', 'Cross match', 'Urinalysis', 'LFT'],
    units: ['ER', 'IPD', 'OPD', 'LR'],
    signH: 'ทนพญ.ภัทรวดี พรพาเจริญ', signHT: 'หัวหน้ากลุ่มงานเทคนิคการแพทย์',
    signD: 'นายแพทย์ ........................', signDT: 'ผู้อำนวยการโรงพยาบาลทุ่งฝน',
    colDay: 20, pubDay: 25, chEmail: true, chLine: false, chCal: false,
    rates: { MT: { ch: 650, b: 650, d0: 325, d1: 325, n: 0 }, LA: { ch: 330, b1: 165, n: 0 } }
  });
}

