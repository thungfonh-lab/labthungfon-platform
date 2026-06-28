/**
 * backupService.js — new feature, not in the original GAS system.
 *
 * Setup.gs created an empty "Backups" Drive folder placeholder but nothing ever
 * wrote into it. This implements the actual backup: copy the whole spreadsheet
 * file (every sheet, full fidelity) into a Drive folder via the Drive API.
 *
 * SETUP REQUIRED (one-time, by a human with a real Google Drive — service accounts
 * have no usable storage quota of their own):
 *   1. In your own Google Drive, create a folder (e.g. "labthungfon Backups").
 *   2. Share that folder with the service account's client_email
 *      (Editor access) — same email already shared on the spreadsheet.
 *   3. Copy the folder's ID from its URL and set it as GOOGLE_BACKUP_FOLDER_ID.
 * Without that env var, createBackup()/listBackups() throw a clear setup error
 * instead of a confusing Drive API permission error.
 */

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const gs = require('./googleSheets');

let _driveClient = null;

function getDriveClient() {
  if (_driveClient) return _driveClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');
  const key = JSON.parse(raw);
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  _driveClient = google.drive({ version: 'v3', auth });
  return _driveClient;
}

function getBackupFolderId() {
  const id = process.env.GOOGLE_BACKUP_FOLDER_ID;
  if (!id) {
    throw new Error(
      'ยังไม่ได้ตั้งค่าโฟลเดอร์สำรองข้อมูล — สร้างโฟลเดอร์ใน Google Drive ของคุณ, แชร์สิทธิ์ Editor ' +
      'ให้บัญชี service account, แล้วตั้งค่า GOOGLE_BACKUP_FOLDER_ID เป็น ID ของโฟลเดอร์นั้น'
    );
  }
  return id;
}

function timestamp_() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

/** Copies the live spreadsheet (all sheets, full fidelity) into the backup folder. */
async function createBackup() {
  const drive = getDriveClient();
  const folderId = getBackupFolderId();
  const spreadsheetId = gs.getSpreadsheetId();
  const name = 'Backup_labthungfon_' + timestamp_();
  const res = await drive.files.copy({
    fileId: spreadsheetId,
    requestBody: { name, parents: [folderId] },
    fields: 'id, name, createdTime, webViewLink'
  });
  return res.data;
}

async function listBackups() {
  const drive = getDriveClient();
  const folderId = getBackupFolderId();
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    orderBy: 'createdTime desc',
    fields: 'files(id, name, createdTime, webViewLink, size)',
    pageSize: 50
  });
  return res.data.files || [];
}

async function deleteBackup(fileId) {
  const drive = getDriveClient();
  await drive.files.delete({ fileId });
  return { ok: true };
}

/** Keeps only the most recent `keep` backups, trashing the rest — called after each
 *  scheduled backup so the folder doesn't grow forever. */
async function pruneBackups(keep) {
  const n = Number(keep) > 0 ? Number(keep) : 14;
  const all = await listBackups();
  const toDelete = all.slice(n);
  for (const f of toDelete) await deleteBackup(f.id);
  return { deleted: toDelete.length, kept: Math.min(all.length, n) };
}

module.exports = { createBackup, listBackups, deleteBackup, pruneBackups };
