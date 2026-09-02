/**
 * backupService.js — new feature, not in the original GAS system.
 *
 * Setup.gs created an empty "Backups" Drive folder placeholder but nothing ever
 * wrote into it. An earlier version of this service tried to back up via the
 * Drive API (files.copy into a folder shared by the user) — that failed with
 * "The user's Drive storage quota has been exceeded": service accounts have no
 * Drive storage of their own, and Drive API file copies are always OWNED by
 * whoever performs the copy (the service account), regardless of which folder
 * they're placed in. Personal (non-Workspace) Google accounts have no Shared
 * Drives or domain-wide delegation to work around that, so this is a hard wall
 * for this deployment.
 *
 * Instead, backups are stored as plain data INSIDE the same spreadsheet, in a
 * dedicated "Backups" sheet (auto-created on first use). This needs no Drive
 * API and no extra permissions — it's the exact same Sheets read/write path
 * every other feature already uses successfully. A snapshot is a JSON dump of
 * every data sheet, chunked across rows (a single cell caps at 50,000 chars).
 */

const gs = require('./googleSheets');

const BACKUP_SHEET = 'Backups';
const BACKUP_HEADERS = ['backupId', 'createdAt', 'seq', 'totalChunks', 'data'];
const CHUNK_SIZE = 45000; // chars per cell, leaves headroom under the 50,000 cap
/* ReportsCache ถูกตัดออก — เป็นชีตที่ไม่มีโค้ดไหนอ่าน/เขียนแล้ว (เหลือค้างจากดีไซน์เดิม) จึงไม่ต้องสำรอง */
const DATA_SHEETS = ['Users', 'Roles', 'Permissions', 'MasterData', 'Transactions', 'Schedules', 'AuditLogs', 'Settings'];

let _ensured = false;

/** Creates the Backups sheet (with header row) if it doesn't exist yet. */
async function ensureBackupSheet() {
  if (_ensured) return;
  const sheets = gs.getSheetsClient();
  const spreadsheetId = gs.getSpreadsheetId();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === BACKUP_SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: BACKUP_SHEET } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${BACKUP_SHEET}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [BACKUP_HEADERS] }
    });
    gs.invalidateReadAllCache(BACKUP_SHEET);
  }
  _ensured = true;
}

/** Dumps every data sheet (minus the internal __rowIndex bookkeeping field) into one JSON object. */
async function snapshotData() {
  const dump = {};
  for (const name of DATA_SHEETS) {
    const rows = await gs.readAll(name);
    dump[name] = rows.map((r) => {
      const copy = Object.assign({}, r);
      delete copy.__rowIndex;
      return copy;
    });
  }
  return dump;
}

/** Reads & dumps every data sheet, chunks it, and appends it as new Backups rows. */
async function createBackup() {
  await ensureBackupSheet();
  const json = JSON.stringify(await snapshotData());
  const chunks = [];
  for (let i = 0; i < json.length; i += CHUNK_SIZE) chunks.push(json.slice(i, i + CHUNK_SIZE));
  const backupId = 'bk_' + Date.now();
  const createdAt = new Date().toISOString();
  await gs.batchAppend(BACKUP_SHEET, chunks.map((chunk, seq) => ({
    backupId, createdAt, seq, totalChunks: chunks.length, data: chunk
  })));
  return { id: backupId, createdAt, totalChunks: chunks.length, sizeBytes: json.length };
}

/** Lists backups (newest first), one entry per backupId — metadata only, no chunk reassembly. */
async function listBackups() {
  await ensureBackupSheet();
  const rows = await gs.readAll(BACKUP_SHEET);
  const byId = {};
  rows.forEach((r) => {
    if (!byId[r.backupId]) byId[r.backupId] = { id: r.backupId, createdAt: r.createdAt, totalChunks: r.totalChunks, sizeBytes: 0 };
    byId[r.backupId].sizeBytes += (r.data || '').length;
  });
  return Object.values(byId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** Reassembles one backup's full JSON text (for download), ordered by chunk seq. */
async function downloadBackup(backupId) {
  await ensureBackupSheet();
  const rows = (await gs.readAll(BACKUP_SHEET))
    .filter((r) => r.backupId === backupId)
    .sort((a, b) => a.seq - b.seq);
  if (!rows.length) throw new Error('ไม่พบ backup id=' + backupId);
  return rows.map((r) => r.data).join('');
}

async function deleteBackup(backupId) {
  await ensureBackupSheet();
  const rows = await gs.readAll(BACKUP_SHEET);
  const toDelete = rows.filter((r) => r.backupId === backupId);
  if (toDelete.length) await gs.deleteRowsBulk(BACKUP_SHEET, toDelete.map((r) => r.__rowIndex));
  return { ok: true, rowsDeleted: toDelete.length };
}

/** Keeps only the most recent `keep` backups, deleting the rest — called after each
 *  scheduled backup so the sheet doesn't grow forever. */
async function pruneBackups(keep) {
  const n = Number(keep) > 0 ? Number(keep) : 14;
  const all = await listBackups();
  const toDelete = all.slice(n);
  for (const b of toDelete) await deleteBackup(b.id);
  return { deleted: toDelete.length, kept: Math.min(all.length, n) };
}

/** วิเคราะห์การใช้พื้นที่รายชีต (สำหรับหน้าตั้งค่า) — ช่วยดูว่าชีตไหนโตเร็ว/เสี่ยงทำให้ช้า
 *  bytes เป็นค่าประมาณ (นับความยาวอักขระในทุกเซลล์) พอเทียบสัดส่วนกันได้ */
async function getStorageStats() {
  const ALL_SHEETS = DATA_SHEETS.concat([BACKUP_SHEET]);
  const sheets = [];
  let totalBytes = 0;
  let auditOldest = null, auditNewest = null, backupCount = 0;
  for (const name of ALL_SHEETS) {
    let rows;
    try { rows = await gs.readAll(name); } catch (e) { continue; } /* ชีตอาจยังไม่ถูกสร้าง */
    let bytes = 0;
    rows.forEach((r) => {
      Object.keys(r).forEach((k) => { if (k !== '__rowIndex') bytes += String(r[k] == null ? '' : r[k]).length; });
    });
    totalBytes += bytes;
    sheets.push({ name, rows: rows.length, bytes });
    if (name === 'AuditLogs') {
      rows.forEach((r) => {
        const t = new Date(r.timestamp).getTime();
        if (!isNaN(t)) {
          if (auditOldest === null || t < auditOldest) auditOldest = t;
          if (auditNewest === null || t > auditNewest) auditNewest = t;
        }
      });
    }
    if (name === BACKUP_SHEET) {
      const ids = {}; rows.forEach((r) => { ids[r.backupId] = 1; }); backupCount = Object.keys(ids).length;
    }
  }
  sheets.sort((a, b) => b.bytes - a.bytes);
  return {
    sheets, totalBytes, backupCount,
    auditOldest: auditOldest ? new Date(auditOldest).toISOString() : null,
    auditNewest: auditNewest ? new Date(auditNewest).toISOString() : null
  };
}

module.exports = { createBackup, listBackups, downloadBackup, deleteBackup, pruneBackups, getStorageStats };
