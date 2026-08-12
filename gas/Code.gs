/** Project LUNARIS / Phase 2 NEXT */

const SHEETS = Object.freeze({
  DAILY: '01. 日次記録',
  EVENTS: '02. 重要イベント',
  API_HISTORY: '09. API処理履歴',
});

const STATUS = Object.freeze({
  RECEIVED: 'RECEIVED',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  DUPLICATE: 'DUPLICATE',
  CONFLICT: 'CONFLICT',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
});

const RESULT = Object.freeze({
  CREATED: 'CREATED',
  IDEMPOTENT: 'IDEMPOTENT',
  DUPLICATE_RECORD: 'DUPLICATE_RECORD',
  RECORD_CONFLICT: 'RECORD_CONFLICT',
  REQUEST_CONFLICT: 'REQUEST_CONFLICT',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_ID: 'INVALID_ID',
  AUTH_FAILED: 'AUTH_FAILED',
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  STORAGE_ERROR: 'STORAGE_ERROR',
  PROCESSING_ERROR: 'PROCESSING_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

const API_HISTORY_HEADERS = [
  'request_id', 'record_id', 'content_hash', 'processing_status',
  'received_at', 'processed_at', 'result_code', 'error_message'
];

function doPost(e) {
  let request = null;
  try {
    request = parseJson_(e);
    authenticate_(e);
    validateRequest_(request);
    const hash = contentHash_(request);

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(lockTimeoutMs_())) {
      return response_(503, false, RESULT.LOCK_TIMEOUT, STATUS.REJECTED,
        'Processing lock could not be acquired.', request);
    }
    try {
      return processLocked_(request, hash, new Date());
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return response_(err.httpStatus || 500, false,
      err.code || RESULT.INTERNAL_ERROR, STATUS.REJECTED,
      clientMessage_(err), request || {});
  }
}

function processLocked_(request, hash, receivedAt) {
  const history = sheet_(SHEETS.API_HISTORY);
  requireHeaders_(history, API_HISTORY_HEADERS);

  const byRequest = findHistoryByRequest_(history, request.request_id);
  if (byRequest) {
    if (String(byRequest.record_id) !== request.record_id ||
        String(byRequest.content_hash) !== hash) {
      return response_(409, false, RESULT.REQUEST_CONFLICT, STATUS.CONFLICT,
        'request_id is associated with different request data.', request);
    }

    if (byRequest.processing_status === STATUS.PROCESSING) {
      // PROCESSING is unresolved. Never auto-register, overwrite, delete,
      // or convert it to FAILED solely because a resend arrived.
      const official = reconcileOfficialRecord_(request.record_id, hash, history);
      if (official.exists && official.contentMatches) {
        updateHistory_(history, byRequest.row, {
          processing_status: STATUS.SUCCESS,
          processed_at: new Date(),
          result_code: RESULT.IDEMPOTENT,
          error_message: ''
        });
        return response_(200, true, RESULT.IDEMPOTENT, STATUS.SUCCESS,
          'Existing official record confirmed; no new registration.', request);
      }
      return response_(409, false, RESULT.PROCESSING_ERROR, STATUS.PROCESSING,
        'PROCESSING remains unresolved and requires confirmation/reconciliation.', request);
    }

    if (byRequest.processing_status === STATUS.SUCCESS) {
      return response_(200, true, RESULT.IDEMPOTENT, STATUS.SUCCESS,
        'Idempotent replay; no new registration.', request);
    }
    if (byRequest.processing_status === STATUS.DUPLICATE) {
      return response_(200, true, RESULT.DUPLICATE_RECORD, STATUS.DUPLICATE,
        'Duplicate record; no new registration.', request);
    }
    return response_(409, false,
      byRequest.result_code || RESULT.PROCESSING_ERROR,
      byRequest.processing_status || STATUS.FAILED,
      'The logical request is not eligible for automatic reprocessing.', request);
  }

  const record = reconcileOfficialRecord_(request.record_id, hash, history);
  if (record.exists) {
    if (record.contentMatches) {
      appendHistory_(history, {
        request_id: request.request_id,
        record_id: request.record_id,
        content_hash: hash,
        processing_status: STATUS.DUPLICATE,
        received_at: receivedAt,
        processed_at: new Date(),
        result_code: RESULT.DUPLICATE_RECORD,
        error_message: ''
      });
      return response_(200, true, RESULT.DUPLICATE_RECORD, STATUS.DUPLICATE,
        'Existing record has identical content; no new registration.', request);
    }
    return response_(409, false, RESULT.RECORD_CONFLICT, STATUS.CONFLICT,
      'record_id already exists with different or unreconcilable content.', request);
  }

  // One logical request = one API history row.
  appendHistory_(history, {
    request_id: request.request_id,
    record_id: request.record_id,
    content_hash: hash,
    processing_status: STATUS.PROCESSING,
    received_at: receivedAt,
    processed_at: '',
    result_code: '',
    error_message: ''
  });

  try {
    appendOfficialRecord_(request, hash);
    updateLatestHistory_(history, request.request_id, {
      processing_status: STATUS.SUCCESS,
      processed_at: new Date(),
      result_code: RESULT.CREATED,
      error_message: ''
    });
    return response_(201, true, RESULT.CREATED, STATUS.SUCCESS,
      'Record created successfully.', request);
  } catch (err) {
    updateLatestHistory_(history, request.request_id, {
      processing_status: STATUS.FAILED,
      processed_at: new Date(),
      result_code: RESULT.STORAGE_ERROR,
      error_message: safeLog_(err)
    });
    throw apiError_(500, RESULT.STORAGE_ERROR, 'Official record storage failed.');
  }
}

function reconcileOfficialRecord_(recordId, hash, history) {
  // API-created records can be reconciled authoritatively from API history.
  const headers = headers_(history);
  const rid = headers.indexOf('record_id');
  const ch = headers.indexOf('content_hash');
  if (rid < 0 || ch < 0) throw apiError_(500, RESULT.STORAGE_ERROR,
    'API processing history lacks record reconciliation columns.');

  const rows = data_(history);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][rid]) === recordId) {
      return { exists: true, contentMatches: String(rows[i][ch]) === hash };
    }
  }

  // Existing/non-API records may not have a content_hash. Their presence is
  // authoritative for conflict prevention, but equality cannot be inferred.
  const daily = sheet_(SHEETS.DAILY);
  const dailyHeaders = headers_(daily);
  const dailyRid = dailyHeaders.indexOf('record_id');
  if (dailyRid < 0) return { exists: false, contentMatches: false };
  const dailyHash = dailyHeaders.indexOf('content_hash');
  const dailyRows = data_(daily);
  for (let i = 0; i < dailyRows.length; i++) {
    if (String(dailyRows[i][dailyRid]) === recordId) {
      return {
        exists: true,
        contentMatches: dailyHash >= 0 && String(dailyRows[i][dailyHash]) === hash
      };
    }
  }
  return { exists: false, contentMatches: false };
}

function appendOfficialRecord_(request, hash) {
  const daily = sheet_(SHEETS.DAILY);
  const hs = headers_(daily);
  if (!hs.length) throw apiError_(500, RESULT.STORAGE_ERROR,
    'Daily record sheet has no header row.');
  const row = hs.map(function(h) { return serialize_(resolve_(request, h, hash)); });
  if (!row.some(function(v) { return v !== ''; })) {
    throw apiError_(500, RESULT.STORAGE_ERROR,
      'No existing daily-record header matches the API payload.');
  }
  daily.appendRow(row);

  if (Array.isArray(request.events) && request.events.length) {
    const events = sheet_(SHEETS.EVENTS);
    const eh = headers_(events);
    if (!eh.length) throw apiError_(500, RESULT.STORAGE_ERROR,
      'Important-event sheet has no header row.');
    request.events.forEach(function(event) {
      const erow = eh.map(function(h) { return serialize_(resolveEvent_(event, request, h, hash)); });
      if (!erow.some(function(v) { return v !== ''; })) {
        throw apiError_(500, RESULT.STORAGE_ERROR,
          'No existing event header matches the API payload.');
      }
      events.appendRow(erow);
    });
  }
}

function parseJson_(e) {
  if (!e || !e.postData || typeof e.postData.contents !== 'string') {
    throw apiError_(400, RESULT.INVALID_REQUEST, 'JSON request body is required.');
  }
  try { return JSON.parse(e.postData.contents); }
  catch (_) { throw apiError_(400, RESULT.INVALID_REQUEST, 'Invalid JSON.'); }
}

function validateRequest_(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r))
    throw apiError_(400, RESULT.INVALID_REQUEST, 'Request JSON must be an object.');
  ['api_version','request_id','record_id','template_version','record'].forEach(function(k) {
    if (!(k in r)) throw apiError_(400, RESULT.INVALID_REQUEST, 'Required field is missing: ' + k);
  });
  id_(r.request_id, 'REQ-');
  id_(r.record_id, 'REC-');
  if (r.events !== undefined && !Array.isArray(r.events))
    throw apiError_(400, RESULT.INVALID_REQUEST, 'events must be an array.');
  (r.events || []).forEach(function(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e) || !('event_id' in e))
      throw apiError_(400, RESULT.INVALID_REQUEST, 'Each event requires event_id.');
    id_(e.event_id, 'EVT-');
  });
}

function id_(value, prefix) {
  const re = new RegExp('^' + prefix + '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
  if (typeof value !== 'string' || !re.test(value))
    throw apiError_(400, RESULT.INVALID_ID, 'Invalid identifier format.');
}

function contentHash_(r) {
  const target = { template_version: r.template_version, record: r.record, events: r.events || [] };
  const canonical = canonical_(target);
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, canonical, Utilities.Charset.UTF_8);
  return bytes.map(function(b) { b = b < 0 ? b + 256 : b; return ('0' + b.toString(16)).slice(-2); }).join('');
}

function canonical_(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!isFinite(v)) throw apiError_(400, RESULT.INVALID_REQUEST, 'Non-finite number is not allowed.');
    return JSON.stringify(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return '[' + v.map(canonical_).join(',') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).sort().map(function(k) {
    return JSON.stringify(k) + ':' + canonical_(v[k]);
  }).join(',') + '}';
  throw apiError_(400, RESULT.INVALID_REQUEST, 'Unsupported JSON value.');
}

function authenticate_(e) {
  const expected = PropertiesService.getScriptProperties().getProperty('LUNARIS_API_KEY');
  if (!expected) throw apiError_(500, RESULT.INTERNAL_ERROR, 'API authentication is not configured.');
  const h = e && e.headers ? e.headers : {};
  const supplied = h['X-Lunaris-API-Key'] || h['x-lunaris-api-key'] || '';
  if (!supplied || !same_(String(supplied), String(expected)))
    throw apiError_(401, RESULT.AUTH_FAILED, 'Authentication failed.');
}

function same_(a,b) {
  if (a.length !== b.length) return false;
  let x = 0; for (let i=0;i<a.length;i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function findHistoryByRequest_(sheet, requestId) {
  const hs = headers_(sheet), idx = hs.indexOf('request_id');
  if (idx < 0) throw apiError_(500, RESULT.STORAGE_ERROR, 'request_id header is missing.');
  const rows = data_(sheet);
  for (let i=0;i<rows.length;i++) if (String(rows[i][idx]) === requestId) {
    const o = { row: i + 2 };
    hs.forEach(function(h,j){ o[h] = rows[i][j]; });
    return o;
  }
  return null;
}

function appendHistory_(sheet, entry) {
  requireHeaders_(sheet, API_HISTORY_HEADERS);
  const hs = headers_(sheet);
  sheet.appendRow(hs.map(function(h){ return entry[h] === undefined ? '' : entry[h]; }));
}

function updateLatestHistory_(sheet, requestId, changes) {
  const item = findHistoryByRequest_(sheet, requestId);
  if (!item) throw apiError_(500, RESULT.STORAGE_ERROR, 'API history row not found.');
  updateHistory_(sheet, item.row, changes);
}

function updateHistory_(sheet, row, changes) {
  const hs = headers_(sheet), values = sheet.getRange(row,1,1,hs.length).getValues()[0];
  Object.keys(changes).forEach(function(k){ const i=hs.indexOf(k); if(i>=0) values[i]=changes[k]; });
  sheet.getRange(row,1,1,hs.length).setValues([values]);
}

function resolve_(r, h, hash) {
  if (h==='request_id') return r.request_id;
  if (h==='record_id') return r.record_id;
  if (h==='content_hash') return hash;
  if (h==='api_version') return r.api_version;
  if (h==='template_version') return r.template_version;
  if (h==='events') return r.events;
  if (h.indexOf('record.')===0) return path_(r.record,h.substring(7));
  if (h.indexOf('record_')===0) return path_(r.record,h.substring(7));
  return undefined;
}

function resolveEvent_(e,r,h,hash) {
  if(h==='event_id') return e.event_id;
  if(h==='request_id') return r.request_id;
  if(h==='record_id') return r.record_id;
  if(h==='content_hash') return hash;
  if(h.indexOf('event.')===0) return path_(e,h.substring(6));
  if(h.indexOf('event_')===0) return path_(e,h.substring(6));
  return undefined;
}

function path_(o,p) { return p.split('.').reduce(function(v,k){ return v==null ? undefined : v[k]; },o); }
function serialize_(v) { return v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : v); }
function sheet_(name) { const ss=SpreadsheetApp.getActiveSpreadsheet(); if(!ss) throw apiError_(500,RESULT.STORAGE_ERROR,'Spreadsheet unavailable.'); const s=ss.getSheetByName(name); if(!s) throw apiError_(500,RESULT.STORAGE_ERROR,'Required sheet is missing.'); return s; }
function headers_(s) { return s.getLastColumn() ? s.getRange(1,1,1,s.getLastColumn()).getValues()[0].map(String) : []; }
function data_(s) { const n=s.getLastRow(); return n<=1 ? [] : s.getRange(2,1,n-1,s.getLastColumn()).getValues(); }
function requireHeaders_(s,required) { const hs=headers_(s); required.forEach(function(h){if(hs.indexOf(h)<0) throw apiError_(500,RESULT.STORAGE_ERROR,'Required API history header is missing.');}); }
function lockTimeoutMs_(){ const n=Number(PropertiesService.getScriptProperties().getProperty('LUNARIS_LOCK_TIMEOUT_MS')||5000); return isFinite(n)&&n>=0?n:5000; }
function response_(httpStatus,ok,code,status,message,r){ return ContentService.createTextOutput(JSON.stringify({ok:ok,http_status:httpStatus,result_code:code,processing_status:status,message:message,request_id:r.request_id||undefined,record_id:r.record_id||undefined})).setMimeType(ContentService.MimeType.JSON); }
function apiError_(httpStatus,code,message){ const e=new Error(message); e.httpStatus=httpStatus; e.code=code; return e; }
function clientMessage_(e){ if(e.code===RESULT.AUTH_FAILED)return'Authentication failed.'; return e.message||'Processing failed.'; }
function safeLog_(e){ return String(e && (e.message||e) || '').substring(0,500); }
