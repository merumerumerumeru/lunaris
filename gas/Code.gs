/**
 * Project LUNARIS - Phase 2 NEXT
 * Google Apps Script Web API implementation.
 *
 * Important:
 * - Existing Sheets data is never migrated or rewritten by this code.
 * - No historical request_id/record_id/content_hash is generated.
 * - PROCESSING is treated as an unresolved state.
 * - retry_count / STALE / automatic timeout / automatic reprocessing are not implemented.
 */

const SHEET_NAMES = Object.freeze({
  DAILY: '01. 日次記録',
  EVENTS: '02. 重要イベント',
  API_HISTORY: '09. API処理履歴',
});

const API_HISTORY_HEADERS = Object.freeze([
  'request_id',
  'record_id',
  'content_hash',
  'processing_status',
  'received_at',
  'processed_at',
  'result_code',
  'error_message',
]);

const PROCESSING_STATUS = Object.freeze({
  RECEIVED: 'RECEIVED',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  DUPLICATE: 'DUPLICATE',
  CONFLICT: 'CONFLICT',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
});

const RESULT_CODE = Object.freeze({
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

/** Web API entry point. */
function doPost(e) {
  const receivedAt = new Date();
  let requestId = '';
  let recordId = '';

  try {
    const request = parseRequest_(e);
    requestId = request.request_id;
    recordId = request.record_id;

    // Authentication is deliberately isolated so the deployment secret can be
    // supplied through Script Properties without embedding it in source code.
    authenticate_(e);

    validateRequest_(request);
    const contentHash = buildContentHash_(request);

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(getLockTimeoutMs_())) {
      return jsonResponse_(503, {
        ok: false,
        result_code: RESULT_CODE.LOCK_TIMEOUT,
        message: 'Request could not acquire processing lock.',
        request_id: requestId,
        record_id: recordId,
      });
    }

    try {
      return processLockedRequest_(request, contentHash, receivedAt);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    const code = err && err.code ? err.code : RESULT_CODE.INTERNAL_ERROR;
    const status = err && err.httpStatus ? err.httpStatus : 500;
    return jsonResponse_(status, {
      ok: false,
      result_code: code,
      message: safeClientMessage_(err),
      request_id: requestId || undefined,
      record_id: recordId || undefined,
    });
  }
}

function processLockedRequest_(request, contentHash, receivedAt) {
  const historySheet = getRequiredSheet_(SHEET_NAMES.API_HISTORY);
  const existing = findApiHistoryByRequestId_(historySheet, request.request_id);

  if (existing) {
    if (existing.record_id !== request.record_id || existing.content_hash !== contentHash) {
      return finalizeResponse_(
        409,
        request,
        RESULT_CODE.REQUEST_CONFLICT,
        PROCESSING_STATUS.CONFLICT,
        'request_id is already associated with different request data.'
      );
    }

    if (existing.processing_status === PROCESSING_STATUS.PROCESSING) {
      const official = findOfficialRecord_(request.record_id, contentHash);
      if (official.exists && official.contentMatches) {
        updateHistory_(historySheet, existing.rowNumber, {
          processing_status: PROCESSING_STATUS.SUCCESS,
          processed_at: new Date(),
          result_code: RESULT_CODE.IDEMPOTENT,
          error_message: '',
        });
        return finalizeResponse_(200, request, RESULT_CODE.IDEMPOTENT, PROCESSING_STATUS.SUCCESS,
          'The logical request has already been registered.');
      }

      // Confirmed Phase 2 NEXT behavior: do not automatically register,
      // fail, delete, overwrite, or alter unresolved PROCESSING records.
      return finalizeResponse_(409, request, RESULT_CODE.PROCESSING_ERROR,
        PROCESSING_STATUS.PROCESSING,
        'The request remains unresolved and requires confirmation/reconciliation.');
    }

    if (existing.processing_status === PROCESSING_STATUS.SUCCESS) {
      return finalizeResponse_(200, request, RESULT_CODE.IDEMPOTENT,
        PROCESSING_STATUS.SUCCESS, 'Idempotent replay.');
    }

    if (existing.processing_status === PROCESSING_STATUS.DUPLICATE) {
      return finalizeResponse_(200, request, RESULT_CODE.DUPLICATE_RECORD,
        PROCESSING_STATUS.DUPLICATE, 'Duplicate record; no new registration.');
    }

    if (existing.processing_status === PROCESSING_STATUS.CONFLICT ||
        existing.processing_status === PROCESSING_STATUS.REJECTED) {
      return finalizeResponse_(409, request, existing.result_code || RESULT_CODE.REQUEST_CONFLICT,
        existing.processing_status, 'The logical request was previously rejected.');
    }

    // FAILED is not automatically retried. Phase 2 does not implement
    // automatic reprocessing.
    if (existing.processing_status === PROCESSING_STATUS.FAILED) {
      return finalizeResponse_(409, request, RESULT_CODE.PROCESSING_ERROR,
        PROCESSING_STATUS.FAILED, 'The request previously failed and requires review.');
    }
  }

  const recordMatch = findRecordById_(request.record_id);
  if (recordMatch.exists) {
    if (recordMatch.contentMatches) {
      appendApiHistory_(historySheet, {
        request_id: request.request_id,
        record_id: request.record_id,
        content_hash: contentHash,
        processing_status: PROCESSING_STATUS.DUPLICATE,
        received_at: receivedAt,
        processed_at: new Date(),
        result_code: RESULT_CODE.DUPLICATE_RECORD,
        error_message: '',
      });
      return finalizeResponse_(200, request, RESULT_CODE.DUPLICATE_RECORD,
        PROCESSING_STATUS.DUPLICATE, 'Duplicate record; no new registration.');
    }

    return finalizeResponse_(409, request, RESULT_CODE.RECORD_CONFLICT,
      PROCESSING_STATUS.CONFLICT, 'record_id is already associated with different content.');
  }

  // Record a logical request as PROCESSING before attempting official storage.
  appendApiHistory_(historySheet, {
    request_id: request.request_id,
    record_id: request.record_id,
    content_hash: contentHash,
    processing_status: PROCESSING_STATUS.PROCESSING,
    received_at: receivedAt,
    processed_at: '',
    result_code: '',
    error_message: '',
  });

  try {
    registerOfficialRecord_(request, contentHash);

    updateLatestHistoryForRequest_(historySheet, request.request_id, {
      processing_status: PROCESSING_STATUS.SUCCESS,
      processed_at: new Date(),
      result_code: RESULT_CODE.CREATED,
      error_message: '',
    });

    return finalizeResponse_(201, request, RESULT_CODE.CREATED,
      PROCESSING_STATUS.SUCCESS, 'Record created successfully.');
  } catch (err) {
    // Do not fabricate a recovery result. Leave the request explicitly failed
    // only when the implementation can confirm that official storage failed.
    updateLatestHistoryForRequest_(historySheet, request.request_id, {
      processing_status: PROCESSING_STATUS.FAILED,
      processed_at: new Date(),
      result_code: RESULT_CODE.STORAGE_ERROR,
      error_message: safeLogMessage_(err),
    });
    throw apiError_(500, RESULT_CODE.STORAGE_ERROR, 'Official record storage failed.');
  }
}

/**
 * Official record storage intentionally uses existing headers only.
 * No sheet/column is created here. Field mapping is driven by existing header
 * names, and unsupported fields are not invented or written elsewhere.
 */
function registerOfficialRecord_(request, contentHash) {
  const sheet = getRequiredSheet_(SHEET_NAMES.DAILY);
  const headers = getHeaders_(sheet);
  if (headers.length === 0) {
    throw apiError_(500, RESULT_CODE.STORAGE_ERROR, 'Daily record sheet has no header row.');
  }

  const row = headers.map(function(header) {
    const value = resolveField_(request, header, contentHash);
    return value === undefined ? '' : serializeCellValue_(value);
  });

  // Refuse silent registration when none of the request fields can be mapped.
  if (!row.some(function(value) { return value !== ''; })) {
    throw apiError_(500, RESULT_CODE.STORAGE_ERROR,
      'Daily record field mapping is not configured for the existing sheet headers.');
  }

  sheet.appendRow(row);

  // Important-event persistence is only attempted when the existing event
  // sheet exposes compatible headers. No sheet/column is created dynamically.
  if (Array.isArray(request.events) && request.events.length > 0) {
    registerEvents_(request.events, request, contentHash);
  }
}

function registerEvents_(events, request, contentHash) {
  const sheet = getRequiredSheet_(SHEET_NAMES.EVENTS);
  const headers = getHeaders_(sheet);
  if (headers.length === 0) {
    throw apiError_(500, RESULT_CODE.STORAGE_ERROR, 'Event sheet has no header row.');
  }

  events.forEach(function(event) {
    const row = headers.map(function(header) {
      const value = resolveEventField_(event, request, header, contentHash);
      return value === undefined ? '' : serializeCellValue_(value);
    });
    if (!row.some(function(value) { return value !== ''; })) {
      throw apiError_(500, RESULT_CODE.STORAGE_ERROR,
        'Important-event field mapping is not configured for the existing sheet headers.');
    }
    sheet.appendRow(row);
  });
}

function findOfficialRecord_(recordId, contentHash) {
  const match = findRecordById_(recordId);
  return {
    exists: match.exists,
    contentMatches: match.exists && match.contentHash === contentHash,
  };
}

function findRecordById_(recordId) {
  const sheet = getRequiredSheet_(SHEET_NAMES.DAILY);
  const headers = getHeaders_(sheet);
  const idColumn = findHeaderIndex_(headers, 'record_id');
  if (idColumn < 0) {
    return { exists: false, contentHash: null, contentMatches: false };
  }

  const values = getDataRows_(sheet);
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][idColumn]) === recordId) {
      const storedHash = extractStoredContentHash_(headers, values[i]);
      return { exists: true, contentHash: storedHash, contentMatches: false };
    }
  }
  return { exists: false, contentHash: null, contentMatches: false };
}

function findApiHistoryByRequestId_(sheet, requestId) {
  const headers = getHeaders_(sheet);
  const requestColumn = findHeaderIndex_(headers, 'request_id');
  if (requestColumn < 0) {
    throw apiError_(500, RESULT_CODE.STORAGE_ERROR,
      'API processing history is missing request_id header.');
  }

  const rows = getDataRows_(sheet);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][requestColumn]) === requestId) {
      const object = {};
      headers.forEach(function(header, index) { object[header] = rows[i][index]; });
      object.rowNumber = i + 2;
      return object;
    }
  }
  return null;
}

function appendApiHistory_(sheet, entry) {
  const headers = getHeaders_(sheet);
  ensureRequiredHeaders_(headers, API_HISTORY_HEADERS);
  const row = headers.map(function(header) {
    return entry[header] === undefined ? '' : entry[header];
  });
  sheet.appendRow(row);
}

function updateHistory_(sheet, rowNumber, changes) {
  const headers = getHeaders_(sheet);
  const current = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  Object.keys(changes).forEach(function(key) {
    const index = findHeaderIndex_(headers, key);
    if (index >= 0) current[index] = changes[key];
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([current]);
}

function updateLatestHistoryForRequest_(sheet, requestId, changes) {
  const existing = findApiHistoryByRequestId_(sheet, requestId);
  if (!existing) {
    throw apiError_(500, RESULT_CODE.STORAGE_ERROR,
      'API processing history entry was not found for request_id.');
  }
  updateHistory_(sheet, existing.rowNumber, changes);
}

function validateRequest_(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw apiError_(400, RESULT_CODE.INVALID_REQUEST, 'Request JSON must be an object.');
  }
  ['api_version', 'request_id', 'record_id', 'template_version', 'record'].forEach(function(key) {
    if (!(key in request)) {
      throw apiError_(400, RESULT_CODE.INVALID_REQUEST, 'Required field is missing: ' + key);
    }
  });
  validateId_(request.request_id, 'REQ-');
  validateId_(request.record_id, 'REC-');
  if (request.events !== undefined && !Array.isArray(request.events)) {
    throw apiError_(400, RESULT_CODE.INVALID_REQUEST, 'events must be an array when supplied.');
  }
  if (Array.isArray(request.events)) {
    request.events.forEach(function(event) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw apiError_(400, RESULT_CODE.INVALID_REQUEST, 'Each event must be an object.');
      }
      if (!('event_id' in event)) {
        throw apiError_(400, RESULT_CODE.INVALID_REQUEST, 'event_id is required for each event.');
      }
      validateId_(event.event_id, 'EVT-');
    });
  }
}

function validateId_(value, prefix) {
  if (typeof value !== 'string' || !new RegExp('^' + prefix + '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$').test(value)) {
    throw apiError_(400, RESULT_CODE.INVALID_ID, 'Invalid identifier format.');
  }
}

function buildContentHash_(request) {
  const target = {
    template_version: request.template_version,
    record: request.record,
    events: request.events === undefined ? [] : request.events,
  };
  const canonical = canonicalize_(target);
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    canonical,
    Utilities.Charset.UTF_8
  );
  return digest.map(function(byte) {
    const v = byte < 0 ? byte + 256 : byte;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

function canonicalize_(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!isFinite(value)) throw apiError_(400, RESULT_CODE.INVALID_REQUEST, 'Non-finite number is not allowed.');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map(canonicalize_).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function(key) {
      return JSON.stringify(key) + ':' + canonicalize_(value[key]);
    }).join(',') + '}';
  }
  throw apiError_(400, RESULT_CODE.INVALID_REQUEST, 'Unsupported JSON value.');
}

function authenticate_(e) {
  const props = PropertiesService.getScriptProperties();
  const expected = props.getProperty('LUNARIS_API_KEY');
  if (!expected) {
    throw apiError_(500, RESULT_CODE.INTERNAL_ERROR, 'API authentication is not configured.');
  }
  const headers = e && e.headers ? e.headers : {};
  const supplied = headers['X-Lunaris-API-Key'] || headers['x-lunaris-api-key'] || '';
  if (!supplied || !constantTimeEqual_(String(supplied), String(expected))) {
    throw apiError_(401, RESULT_CODE.AUTH_FAILED, 'Authentication failed.');
  }
}

function constantTimeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function parseRequest_(e) {
  if (!e || !e.postData || typeof e.postData.contents !== 'string') {
    throw apiError_(400, RESULT_CODE.INVALID_REQUEST, 'JSON request body is required.');
  }
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    throw apiError_(400, RESULT_CODE.INVALID_REQUEST, 'Invalid JSON.');
  }
}

function resolveField_(request, header, contentHash) {
  if (header === 'record_id') return request.record_id;
  if (header === 'request_id') return request.request_id;
  if (header === 'content_hash') return contentHash;
  if (header === 'template_version') return request.template_version;
  if (header === 'api_version') return request.api_version;
  if (header === 'events') return request.events;
  if (header.indexOf('record.') === 0) return getPath_(request.record, header.substring(7));
  if (header.indexOf('record_') === 0) return getPath_(request.record, header.substring(7));
  return undefined;
}

function resolveEventField_(event, request, header, contentHash) {
  if (header === 'event_id') return event.event_id;
  if (header === 'record_id') return request.record_id;
  if (header === 'request_id') return request.request_id;
  if (header === 'content_hash') return contentHash;
  if (header.indexOf('event.') === 0) return getPath_(event, header.substring(6));
  if (header.indexOf('event_') === 0) return getPath_(event, header.substring(6));
  return undefined;
}

function getPath_(object, path) {
  return path.split('.').reduce(function(current, key) {
    return current === undefined || current === null ? undefined : current[key];
  }, object);
}

function serializeCellValue_(value) {
  if (value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function extractStoredContentHash_(headers, row) {
  const index = findHeaderIndex_(headers, 'content_hash');
  return index >= 0 ? String(row[index]) : null;
}

function getRequiredSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw apiError_(500, RESULT_CODE.STORAGE_ERROR, 'Spreadsheet is not available.');
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw apiError_(500, RESULT_CODE.STORAGE_ERROR, 'Required sheet is missing.');
  return sheet;
}

function getHeaders_(sheet) {
  if (sheet.getLastColumn() === 0) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
}

function getDataRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  return sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
}

function findHeaderIndex_(headers, name) {
  return headers.indexOf(name);
}

function ensureRequiredHeaders_(headers, required) {
  required.forEach(function(header) {
    if (findHeaderIndex_(headers, header) < 0) {
      throw apiError_(500, RESULT_CODE.STORAGE_ERROR,
        'API processing history is missing required header.');
    }
  });
}

function getLockTimeoutMs_() {
  const value = PropertiesService.getScriptProperties().getProperty('LUNARIS_LOCK_TIMEOUT_MS');
  const parsed = Number(value || 5000);
  return isFinite(parsed) && parsed >= 0 ? parsed : 5000;
}

function finalizeResponse_(status, request, resultCode, processingStatus, message) {
  return jsonResponse_(status, {
    ok: status >= 200 && status < 300,
    result_code: resultCode,
    processing_status: processingStatus,
    message: message,
    request_id: request.request_id,
    record_id: request.record_id,
  });
}

function jsonResponse_(status, body) {
  // GAS ContentService cannot set arbitrary HTTP status codes. The status is
  // retained internally for logging/debugging, while the deployed web app
  // returns JSON through ContentService. HTTP mapping must be verified during
  // deployment/acceptance testing rather than assumed here.
  body.http_status = status;
  return ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

function apiError_(httpStatus, code, message) {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  error.code = code;
  return error;
}

function safeClientMessage_(err) {
  if (!err || !err.code) return 'Internal processing error.';
  if (err.code === RESULT_CODE.AUTH_FAILED) return 'Authentication failed.';
  if (err.code === RESULT_CODE.INVALID_REQUEST || err.code === RESULT_CODE.INVALID_ID) return err.message;
  if (err.code === RESULT_CODE.LOCK_TIMEOUT) return 'Request could not acquire processing lock.';
  return err.message || 'Processing failed.';
}

function safeLogMessage_(err) {
  if (!err) return '';
  return String(err.message || err).substring(0, 500);
}
