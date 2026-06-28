/**
 * googleSheets.js — Sheets v4 client + low-level read/write helpers.
 * Ported from DataService.gs's getSheet_/readAll/appendRow/updateRow_/deleteRow_/batchAppend.
 *
 * SpreadsheetApp's per-sheet object model doesn't exist in the REST API, so every
 * "sheet" here is just a named range addressed as `'SheetName'!A1:..` via the
 * Sheets v4 API. We keep the same per-execution caches DataService.gs used
 * (header memo + readAll memo) but scoped to the lifetime of one process/request,
 * which is the closest equivalent on a serverless instance.
 *
 * IMPORTANT: the client is built lazily — requiring this module must never throw,
 * even if GOOGLE_SERVICE_ACCOUNT_KEY / GOOGLE_SHEETS_ID are unset (e.g. at
 * `require('./api/index.js')` sanity-check time). The error only surfaces when a
 * route actually tries to use the Sheets API.
 */

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

let _sheetsClient = null;
let _spreadsheetId = null;

function getSpreadsheetId() {
  if (!_spreadsheetId) _spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!_spreadsheetId) throw new Error('GOOGLE_SHEETS_ID is not set');
  return _spreadsheetId;
}

function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');
  let key;
  try {
    key = JSON.parse(raw);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON: ' + e.message);
  }
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

/* ---------------- column helpers ---------------- */

function colLetter(n) {
  // 1-indexed column number -> A1 letter(s)
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* ---------------- per-process caches (mirrors DataService.gs) ---------------- */

const _headerCache = {};
const _readAllCache = {};

function invalidateReadAllCache(sheetName) {
  delete _readAllCache[sheetName];
}

async function getHeaders(sheetName) {
  if (_headerCache[sheetName]) return _headerCache[sheetName];
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `'${sheetName}'!1:1`
  });
  const headers = (res.data.values && res.data.values[0]) || [];
  _headerCache[sheetName] = headers;
  return headers;
}

/** Mirrors DataService.gs readAll(): returns array of row objects keyed by header,
 *  with __rowIndex (1-based sheet row, for in-place updates) attached. */
async function readAll(sheetName) {
  if (_readAllCache[sheetName]) return _readAllCache[sheetName];
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `'${sheetName}'`,
    /* UNFORMATTED_VALUE mirrors SpreadsheetApp.getValues()'s native types (numbers as
       numbers, booleans as booleans) — the v4 API defaults to FORMATTED_VALUE, which
       returns every cell as a display string (e.g. "2569" instead of 2569) and broke
       every strict (===) year/month/day/boolean comparison ported from DataService.gs. */
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const range = res.data.values || [];
  const rows = [];
  if (range.length >= 2) {
    const headers = range[0];
    for (let r = 1; r < range.length; r++) {
      const row = range[r] || [];
      if (row.join('') === '') continue;
      const obj = {};
      for (let c = 0; c < headers.length; c++) obj[headers[c]] = row[c] !== undefined ? row[c] : '';
      obj.__rowIndex = r + 1;
      rows.push(obj);
    }
  }
  _readAllCache[sheetName] = rows;
  return rows;
}

async function appendRow(sheetName, obj) {
  const sheets = getSheetsClient();
  const headers = await getHeaders(sheetName);
  const row = headers.map((h) => (obj[h] !== undefined ? obj[h] : ''));
  await sheets.spreadsheets.values.append({
    spreadsheetId: getSpreadsheetId(),
    range: `'${sheetName}'!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
  invalidateReadAllCache(sheetName);
  return obj;
}

async function updateRow(sheetName, rowIndex, obj) {
  const sheets = getSheetsClient();
  const headers = await getHeaders(sheetName);
  const row = headers.map((h) => (obj[h] !== undefined ? obj[h] : ''));
  const lastCol = colLetter(row.length);
  await sheets.spreadsheets.values.update({
    spreadsheetId: getSpreadsheetId(),
    range: `'${sheetName}'!A${rowIndex}:${lastCol}${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [row] }
  });
  invalidateReadAllCache(sheetName);
  return obj;
}

/** Updates a single cell by 1-based row/col, used for small targeted patches
 *  (e.g. Settings sheet value column, Users.active toggle) instead of rewriting
 *  the whole row — mirrors the equivalent getRange(...).setValue() calls in
 *  DataService.gs. */
async function updateCell(sheetName, rowIndex, colIndex1Based, value) {
  const sheets = getSheetsClient();
  const col = colLetter(colIndex1Based);
  await sheets.spreadsheets.values.update({
    spreadsheetId: getSpreadsheetId(),
    range: `'${sheetName}'!${col}${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] }
  });
  invalidateReadAllCache(sheetName);
}

async function getSheetIdByName(sheetName) {
  const sheets = getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: getSpreadsheetId() });
  const sheet = (meta.data.sheets || []).find((s) => s.properties.title === sheetName);
  if (!sheet) throw new Error('ไม่พบ Sheet: ' + sheetName);
  return sheet.properties.sheetId;
}

/** Deletes a single row (1-based). For bulk deletes, prefer deleteRowsBulk
 *  (fewer API calls, matches DataService.gs's deleteRowsBulk_ intent). */
async function deleteRow(sheetName, rowIndex) {
  await deleteRowsBulk(sheetName, [rowIndex]);
}

/** Deletes a set of (possibly non-contiguous) sheet rows using as few batchUpdate
 *  requests as possible — merges consecutive row indices into single-range deletes,
 *  ported from DataService.gs's deleteRowsBulk_. */
async function deleteRowsBulk(sheetName, rowIndices) {
  if (!rowIndices.length) return;
  const sheets = getSheetsClient();
  const sheetId = await getSheetIdByName(sheetName);
  const sorted = rowIndices.slice().sort((a, b) => b - a); // descending
  const requests = [];
  let i = 0;
  while (i < sorted.length) {
    let runEnd = sorted[i], runStart = runEnd, j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === runStart - 1) { runStart = sorted[j + 1]; j++; }
    requests.push({
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: runStart - 1, endIndex: runEnd }
      }
    });
    i = j + 1;
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSpreadsheetId(),
    requestBody: { requests }
  });
  invalidateReadAllCache(sheetName);
}

/** Appends several rows in one call — ported from DataService.gs batchAppend. */
async function batchAppend(sheetName, objs) {
  if (!objs.length) return;
  const sheets = getSheetsClient();
  const headers = await getHeaders(sheetName);
  const rows = objs.map((obj) => headers.map((h) => (obj[h] !== undefined ? obj[h] : '')));
  await sheets.spreadsheets.values.append({
    spreadsheetId: getSpreadsheetId(),
    range: `'${sheetName}'!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows }
  });
  invalidateReadAllCache(sheetName);
}

module.exports = {
  getSheetsClient,
  getSpreadsheetId,
  readAll,
  appendRow,
  updateRow,
  updateCell,
  deleteRow,
  deleteRowsBulk,
  batchAppend,
  getHeaders,
  invalidateReadAllCache,
  colLetter
};
