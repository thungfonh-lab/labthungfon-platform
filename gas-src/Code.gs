/**
 * Code.gs — Entry point + global constants + thin API router.
 * Ported from labthungfon-platform-v4_43.html (Source of Truth).
 * All business logic kept in BusinessService.gs / ReportService.gs.
 */

var SHEETS = {
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

var MASTER_CATEGORY = {
  PEOPLE: 'people',         // CFG.people[]
  STATION: 'station',       // CFG.stations[]
  SHIFT: 'shift',           // CFG.shifts[]
  RATE: 'rate',             // CFG.rates[role][shift]
  RATE_OVERRIDE: 'rateOvr', // CFG.rateOvr[]
  HOLIDAY: 'holiday'        // DATA.holidays[]
};

var TX_CATEGORY = {
  AVAILABILITY: 'availability', // DATA.availability
  ONCALL: 'oncall',             // DATA.oncall
  PAY_ADJ: 'payAdj',            // DATA.payAdj
  OVERRIDE: 'override',         // DATA.overrides
  RULE_VIOLATION: 'ruleViolation', // DATA.ruleViolations
  TRAIL_INFO: 'trailInfo',      // DATA.trailInfo (1 row per year/month)
  DUTY_ROSTER: 'dutyRoster'     // เจ้าหน้าที่ที่ขึ้นเวรได้ในเดือนนั้น (1 row per year/month)
};

/* ตามฟีดแบ็ก: ไม่ใช้บทบาท "หัวหน้า (HT)" เป็นตัวให้สิทธิ์อีกต่อไป — ย้ายสิทธิ์ publish/override/
   viewAllPay/editPay ไปที่ MT แทน ส่วน manageSettings ให้เฉพาะ admin เท่านั้น (ใช้สำหรับ seed
   ติดตั้งใหม่เท่านั้น — ระบบที่ตั้งค่าไปแล้วต้องไปแก้ที่ ตั้งค่า > สิทธิ์การใช้งาน โดยตรง) */
var DEFAULT_ROLE_PERMS = {
  HT: { publish: false, override: false, viewAllPay: false, editPay: false, manageSettings: false, collect: true },
  MT: { publish: true, override: true, viewAllPay: true, editPay: true, manageSettings: false, collect: true },
  LA: { publish: false, override: false, viewAllPay: false, editPay: false, manageSettings: false, collect: true }
};

function doGet(e) {
  var page = e && e.parameter && e.parameter.page;
  var tmpl = HtmlService.createTemplateFromFile('index');
  return tmpl.evaluate()
    .setTitle('labthungfon Platform')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ============== API LAYER (called via google.script.run) ============== */
/* Every API function validates the session token first, then delegates. */

function api_login(email, password) {
  var res = AuthService.login(email, password);
  /* รวม bootstrap มากับผลล็อกอินใน round trip เดียว — เดิมหน้าเว็บเรียก api_login แล้วตามด้วย
     api_bootstrap (2 รอบ) ทำให้ล็อกอินช้า ตอนนี้ส่ง bootstrap กลับมาเลย เหลือ round trip เดียว */
  res.bootstrap = buildBootstrap_({ user: res.user });
  return res;
}

function api_logout(token) {
  return AuthService.logout(token);
}

function buildBootstrap_(session) {
  var settings = DataService.getSettings();
  var user = session.user;
  user.personId = parseUserPersonMap_(settings)[user.userId] || ''; // เจ้าหน้าที่ที่ผูกกับบัญชีนี้
  return {
    user: user,
    permissions: AuthService.getEffectivePermissions(session.user),
    settings: settings,
    people: DataService.getPeople()
  };
}

function api_bootstrap(token) {
  var session = AuthService.requireSession(token);
  return buildBootstrap_(session);
}

/** map บัญชีผู้ใช้ → person id (เก็บใน Settings.userPersonMap เพื่อเลี่ยงการเพิ่มคอลัมน์ใน Users sheet).
 *  getSettings() แปลง JSON string เป็น object ให้แล้ว จึงต้องรองรับทั้ง object และ string (กัน double-parse) */
function parseUserPersonMap_(settings) {
  settings = settings || DataService.getSettings();
  var m = settings.userPersonMap;
  if (!m) return {};
  if (typeof m === 'object') return m;
  try { return JSON.parse(m); } catch (e) { return {}; }
}

function api_generateSchedule(token, year, month) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'publish', true); // generate allowed for collect role too; see BusinessService
  return LockService_run('schedule_' + year + '_' + month, function () {
    var result = BusinessService.generateSchedule(year, month);
    invalidateCalCache_(year, month);
    AuditService.logAction(session.user.userId, 'GENERATE', 'Schedules', year + '-' + month, null, { violations: result.ruleViolations.length });
    return result;
  });
}

function api_saveSchedule(token, year, month, assignments, status) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'collect', true);
  return LockService_run('schedule_' + year + '_' + month, function () {
    var before = DataService.getScheduleAssignments(year, month);
    var result = BusinessService.saveSchedule(year, month, assignments, status, session.user.userId);
    invalidateCalCache_(year, month);
    AuditService.logAction(session.user.userId, 'UPDATE', 'Schedules', year + '-' + month, { count: before.length }, { count: assignments.length, status: status });
    return result;
  });
}

/** ตามฟีดแบ็ก: เผยแพร่ตารางแค่เปลี่ยนสถานะ ไม่ต้องส่งอีเมล/LINE แจ้งเตือนอีกต่อไป
 *  (เดิมส่งผ่าน trigger แยกหลังบ้าน แต่ก็ยังต้องขอสิทธิ์ ScriptApp.newTrigger โดยไม่จำเป็น) */
function api_publishSchedule(token, year, month) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'publish', false);
  var result = BusinessService.publishSchedule(year, month);
  invalidateCalCache_(year, month);
  AuditService.logAction(session.user.userId, 'APPROVE', 'Schedules', year + '-' + month, null, { status: 'published' });
  return result;
}

/** เจ้าหน้าที่ MT/HT คนไหนจะถูกนับเข้าพูลขึ้นเวรของเดือนนั้น แยกเก็บ 2 รายการ
 *  included = ช/บ/ด, includedClinic = น คลินิก (คนละชุดกันได้ เช่น ขึ้น น แต่ไม่ขึ้น ชบด)
 *  ถ้ายังไม่ตั้งรายการใด (null) แปลว่าใช้ทุกคน MT/HT ที่ active ตามค่าเดิม */
function api_getDutyRoster(token, year, month) {
  AuthService.requireSession(token);
  return DataService.getDutyRoster(year, month);
}
function api_setDutyRoster(token, year, month, type, includedIds) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  var key = type === 'clinic' ? 'includedClinic' : 'included';
  var existing = DataService.getDutyRoster(year, month) || {};
  var patch = {};
  patch[key] = includedIds;
  var merged = Object.assign({}, existing, patch);
  DataService.setDutyRoster(year, month, merged, session.user.userId);
  AuditService.logAction(session.user.userId, 'UPDATE', 'DutyRoster', year + '-' + month, null, patch);
  return { ok: true };
}

function api_loadCalendar(token, year, month) {
  AuthService.requireSession(token);
  return AppCache.getOrCompute(calCacheKey_('cal', year, month), 45, function () {
    return BusinessService.loadCalendar(year, month);
  });
}

function api_calculateWorkload(token, year, month) {
  AuthService.requireSession(token);
  return AppCache.getOrCompute(calCacheKey_('workload', year, month), 45, function () {
    return BusinessService.calculateWorkload(year, month);
  });
}

/** ตั้งค่า/สมดุลเวร — ported from renderBalance(). Tolerance changes the swap-pair
 *  set, so it's part of the cache key (cheap: a handful of distinct values per month). */
function api_getBalance(token, year, month, tolerance) {
  AuthService.requireSession(token);
  return AppCache.getOrCompute(calCacheKey_('bal_' + (tolerance || 650), year, month), 45, function () {
    return BusinessService.calculateBalance(year, month, tolerance);
  });
}

function api_approveBalanceSwap(token, year, month, ovId, unId, shift) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'override', false);
  return LockService_run('schedule_' + year + '_' + month, function () {
    var result = BusinessService.approveBalanceSwap(year, month, ovId, unId, shift, session.user.userId);
    invalidateCalCache_(year, month);
    AuditService.logAction(session.user.userId, 'UPDATE', 'Overrides', 'balance-swap-day-' + result.day, null, { ovId: ovId, unId: unId, shift: shift });
    return result;
  });
}

function calCacheKey_(kind, year, month) { return kind + '_' + year + '_' + month; }
/** Invalidate the short-lived calendar/workload cache after any mutation to a month's data. */
var BALANCE_TOLERANCES_ = [0, 650, 1300]; // matches bpTolSel options
function invalidateCalCache_(year, month) {
  AppCache.remove(calCacheKey_('cal', year, month));
  AppCache.remove(calCacheKey_('workload', year, month));
  BALANCE_TOLERANCES_.forEach(function (t) { AppCache.remove(calCacheKey_('bal_' + t, year, month)); });
}

function api_getReport(token, kind, year, month, pid) {
  var session = AuthService.requireSession(token);
  if (kind === 'pay' || kind === 'payLandscape' || kind === 'payPerson' || kind === 'teamOverview') {
    AuthService.requirePermission(session.user, 'viewAllPay', true);
  }
  var cacheKey = reportCacheKey_(kind, year, month, pid);
  return AppCache.getOrCompute(cacheKey, 300, function () {
    return ReportService.renderReport(kind, year, month, pid);
  });
}

function api_exportExcel(token, kind, year, month, pid) {
  var session = AuthService.requireSession(token);
  AuditService.logAction(session.user.userId, 'EXPORT', 'Reports', kind + '-' + year + '-' + month, null, null);
  return ReportService.exportExcel(kind, year, month, pid);
}

function api_addOnCall(token, year, month, entry) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'collect', true);
  var id = DataService.addOnCallRecord(year, month, entry.pid, entry, session.user.userId);
  invalidateCalCache_(year, month);
  AuditService.logAction(session.user.userId, 'CREATE', 'OnCallRecords', id, null, entry);
  return { id: id };
}

/** Edit an existing on-call record in place (เมนู On Call > ปุ่มแก้ไข). */
function api_updateOnCall(token, year, month, txId, entry) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'collect', true);
  var result = DataService.updateTransactionById_(txId, entry.pid, entry);
  invalidateCalCache_(year, month);
  AuditService.logAction(session.user.userId, 'UPDATE', 'OnCallRecords', txId, null, entry);
  return result;
}

/** Delete a single on-call record (fixes missing delete button — original renderOcTbl()/delOC()). */
function api_deleteOnCall(token, year, month, txId) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'collect', true);
  DataService.deleteTransactionById(txId);
  invalidateCalCache_(year, month);
  AuditService.logAction(session.user.userId, 'DELETE', 'OnCallRecords', txId, null, null);
  return { ok: true };
}

/** หน้าบันทึก On-call เดิมใช้ api_loadCalendar (ทั้งตาราง: Schedules/Holidays/RuleViolations/
 *  Overrides/OnCall/People) แค่เพื่อรีเฟรชรายการ on-call เล็กๆ ทำให้ทุกครั้งที่เพิ่ม/แก้/ลบ 1 รายการ
 *  ต้องอ่านชีตใหญ่ๆทั้งหมดที่ไม่เกี่ยวข้องไปด้วย — endpoint นี้อ่านแค่ on-call + people ที่ใช้แสดงผลจริง */
function api_getOnCallList(token, year, month) {
  AuthService.requireSession(token);
  return { oncall: DataService.getOnCallRecords(year, month), people: DataService.getPeople() };
}

function api_addAvailability(token, year, month, entry) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'collect', true);
  var id = DataService.addAvailability(year, month, entry.pid, entry, session.user.userId);
  invalidateCalCache_(year, month);
  AuditService.logAction(session.user.userId, 'CREATE', 'Availability', id, null, entry);
  return { id: id };
}

function api_listAvailability(token, year, month) {
  AuthService.requireSession(token);
  return DataService.getAvailability(year, month);
}

/** Delete a single availability/leave record (used by the "เก็บวันลา" tab). */
function api_deleteAvailability(token, year, month, txId) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'collect', true);
  DataService.deleteTransactionById(txId);
  invalidateCalCache_(year, month);
  AuditService.logAction(session.user.userId, 'DELETE', 'Availability', txId, null, null);
  return { ok: true };
}

function api_listHolidays(token, year, month) {
  AuthService.requireSession(token);
  return DataService.getHolidays(year, month);
}

/** Ported from openOvr()/applyOvr() (manual grid override, lines ~2522-2545 of source). */
function api_addOverride(token, year, month, entry) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'override', false);
  DataService.setAssignment(year, month, entry.day, entry.shift, entry.to, session.user.userId);
  DataService.addOverride(year, month, entry, session.user.userId);
  invalidateCalCache_(year, month);
  AuditService.logAction(session.user.userId, 'UPDATE', 'Overrides', 'day-' + entry.day, null, entry);
  return { ok: true };
}

function api_listMaster(token, category) {
  AuthService.requireSession(token);
  var getters = {
    people: DataService.getPeople,
    station: DataService.getStations,
    shift: DataService.getShifts,
    rateOvr: DataService.getRateOverrides
  };
  var fn = getters[category];
  if (!fn) throw new Error('ไม่รู้จัก category: ' + category);
  return fn();
}

/** จุดปฏิบัติงานที่ตั้ง "หมุนเวียน" ไว้ — สลับ assigned กับจุดคู่ทุกเดือนคู่/คี่ (ดู rotateStationsForMonth_) */
function api_getStationsForMonth(token, year, month) {
  AuthService.requireSession(token);
  return BusinessService.rotateStationsForMonth_(DataService.getStations(), year, month);
}

function api_saveSettings(token, patch) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  var before = DataService.getSettings();
  var result = DataService.saveSettings(patch);
  bumpSettingsVersion_(); // invalidate cached reports (org/hosp/prov/signatures/reportTitles/labs affect renderReport())
  AuditService.logAction(session.user.userId, 'UPDATE', 'Settings', 'org', before, patch);
  return result;
}

/** Single round-trip bulk update for the ตั้งค่า > ประเภทเวร "save all" button
 *  (was N separate api_crud calls, one per shift row — slow on every save). */
function api_updateShifts(token, shifts) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  var result = DataService.crudMasterDataBulk(MASTER_CATEGORY.SHIFT, shifts);
  AuditService.logAction(session.user.userId, 'UPDATE', 'Shifts', 'bulk', null, { count: shifts.length });
  return result;
}

function api_crud(token, entity, op, payload) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  var before = op === 'update' || op === 'delete' ? DataService.getMasterRecord(entity, payload.id) : null;
  var result = DataService.crudMasterData(entity, op, payload);
  AuditService.logAction(session.user.userId, op.toUpperCase(), entity, payload.id || result.id, before, payload);
  return result;
}

/** Combines bootstrap+station+shift+rateOvr+holidays+permissions into one round trip
 *  for the ตั้งค่า page — cuts 6 separate Apps Script cold-start round trips down to 1
 *  (fixes "คลิกเข้าเมนูยังช้า" on the heaviest screen). */
function api_getSetupBundle(token, year, month) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  return {
    settings: DataService.getSettings(),
    people: DataService.getPeople(),
    stations: DataService.getStations(),
    shifts: DataService.getShifts(),
    rateOvr: DataService.getRateOverrides(),
    holidays: DataService.getHolidays(year, month),
    permissions: DataService.getAllPermissions()
  };
}

function api_listPermissions(token) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  return DataService.getAllPermissions();
}

function api_setPermission(token, role, action, allowed) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  DataService.setPermission(role, action, allowed);
  AuditService.logAction(session.user.userId, 'UPDATE', 'Permissions', role + '.' + action, null, { allowed: allowed });
  return { ok: true };
}

function api_addHoliday(token, year, month, entry) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  entry.year = year; entry.month = month;
  var result = DataService.crudMasterData(MASTER_CATEGORY.HOLIDAY, 'create', entry);
  invalidateCalCache_(year, month);
  AuditService.logAction(session.user.userId, 'CREATE', 'Holidays', result.id, null, entry);
  return result;
}

/** ตั้งค่า > วันหยุดราชการ — "เติมวันหยุดราชการอัตโนมัติ" button. Seeds the whole
 *  Buddhist year at once (holidays aren't month-scoped in the original either —
 *  Songkran/New Year span month boundaries) so one click covers all 12 months. */
function api_seedThaiHolidays(token, year) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  var result = DataService.seedThaiHolidays(year);
  for (var m = 0; m < 12; m++) invalidateCalCache_(year, m);
  AuditService.logAction(session.user.userId, 'CREATE', 'Holidays', 'seed-' + year, null, result);
  return result;
}

function api_deleteHoliday(token, year, month, id) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  DataService.crudMasterData(MASTER_CATEGORY.HOLIDAY, 'delete', { id: id });
  invalidateCalCache_(year, month);
  AuditService.logAction(session.user.userId, 'DELETE', 'Holidays', id, null, null);
  return { ok: true };
}

/* ---------------- User account management (ผู้ดูแลระบบ > บัญชีผู้ใช้) ---------------- */

function api_listUsers(token) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  var users = DataService.listUsers();
  var map = parseUserPersonMap_();
  users.forEach(function (u) { u.personId = map[u.userId] || ''; });
  return users;
}

/** ผูก/ยกเลิกการผูกบัญชีผู้ใช้กับเจ้าหน้าที่ (ส่ง personId ว่างเพื่อยกเลิก) */
function api_setUserPerson(token, userId, personId) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  var map = parseUserPersonMap_();
  if (personId) map[userId] = personId; else delete map[userId];
  DataService.saveSettings({ userPersonMap: JSON.stringify(map) });
  AuditService.logAction(session.user.userId, 'UPDATE', 'Users', userId, null, { personId: personId });
  return { ok: true };
}

function api_createUser(token, name, email, role, plainPassword) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  var result = DataService.createUser(name, email, role, plainPassword);
  AuditService.logAction(session.user.userId, 'CREATE', 'Users', result.userId, null, { email: email, role: role });
  return result;
}

function api_setUserActive(token, userId, active) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  DataService.setUserActive(userId, active);
  AuditService.logAction(session.user.userId, 'UPDATE', 'Users', userId, null, { active: active });
  return { ok: true };
}

function api_resetUserPassword(token, userId, newPlainPassword) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  DataService.resetUserPassword(userId, newPlainPassword);
  AuditService.logAction(session.user.userId, 'UPDATE', 'Users', userId, null, { passwordReset: true });
  return { ok: true };
}

function api_getAuditLogs(token, filters) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  return AuditService.getAuditLogs(filters);
}

/** คำนวณ cutoff year/month จาก keepMonths แล้วนับแถวที่จะถูกลบ (preview ก่อนยืนยัน) */
function api_previewArchive(token, keepMonths) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  var cutoff = calcArchiveCutoff_(keepMonths);
  var preview = DataService.previewArchive(cutoff.year, cutoff.month);
  preview.cutoffYear = cutoff.year;
  preview.cutoffMonth = cutoff.month;
  return preview;
}

/** ลบข้อมูลเก่าจริง (admin only) */
function api_archiveOldData(token, keepMonths) {
  var session = AuthService.requireSession(token);
  AuthService.requirePermission(session.user, 'manageSettings', false);
  var cutoff = calcArchiveCutoff_(keepMonths);
  var result = DataService.archiveOldData(cutoff.year, cutoff.month);
  AuditService.logAction(session.user.userId, 'DELETE', 'Archive', 'keepMonths=' + keepMonths, null, result);
  return result;
}

function calcArchiveCutoff_(keepMonths) {
  var now = new Date();
  var totalMonths = now.getFullYear() * 12 + now.getMonth() - keepMonths; // getMonth() = 0-based, ทำให้ current month ไม่ถูกลบ
  return { year: Math.floor(totalMonths / 12), month: totalMonths % 12 + 1 };
}
