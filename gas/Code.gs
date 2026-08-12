/** Project LUNARIS / Phase 2 NEXT */
const S={DAILY:'01. 日次記録',EVENTS:'02. 重要イベント',HISTORY:'09. API処理履歴'};
const ST={RECEIVED:'RECEIVED',PROCESSING:'PROCESSING',SUCCESS:'SUCCESS',DUPLICATE:'DUPLICATE',CONFLICT:'CONFLICT',REJECTED:'REJECTED',FAILED:'FAILED'};
const RC={CREATED:'CREATED',IDEMPOTENT:'IDEMPOTENT',DUPLICATE_RECORD:'DUPLICATE_RECORD',RECORD_CONFLICT:'RECORD_CONFLICT',REQUEST_CONFLICT:'REQUEST_CONFLICT',INVALID_REQUEST:'INVALID_REQUEST',INVALID_ID:'INVALID_ID',AUTH_FAILED:'AUTH_FAILED',LOCK_TIMEOUT:'LOCK_TIMEOUT',STORAGE_ERROR:'STORAGE_ERROR',PROCESSING_ERROR:'PROCESSING_ERROR',INTERNAL_ERROR:'INTERNAL_ERROR'};
const HISTORY_HEADERS=['request_id','record_id','content_hash','processing_status','received_at','processed_at','result_code','error_message'];

function doPost(e){
  let r=null;
  try{
    r=parse_(e); auth_(e); validate_(r); const h=hash_(r);
    const lock=LockService.getScriptLock();
    if(!lock.tryLock(lockMs_())) return out_(503,false,RC.LOCK_TIMEOUT,ST.REJECTED,'Processing lock could not be acquired.',r);
    try{return locked_(r,h,new Date());}finally{lock.releaseLock();}
  }catch(x){return out_(x.httpStatus||500,false,x.code||RC.INTERNAL_ERROR,ST.REJECTED,msg_(x),r||{});}
}

function locked_(r,h,receivedAt){
  const history=sheet_(S.HISTORY); requireHeaders_(history,HISTORY_HEADERS);
  const old=findRequest_(history,r.request_id);
  if(old){
    if(String(old.record_id)!==r.record_id||String(old.content_hash)!==h)
      return out_(409,false,RC.REQUEST_CONFLICT,ST.CONFLICT,'request_id is associated with different request data.',r);
    if(old.processing_status===ST.PROCESSING){
      const official=reconcile_(r.record_id,h,history);
      if(official.exists&&official.contentMatches){
        update_(history,old.row,{processing_status:ST.SUCCESS,processed_at:new Date(),result_code:RC.IDEMPOTENT,error_message:''});
        return out_(200,true,RC.IDEMPOTENT,ST.SUCCESS,'Existing official record confirmed; no new registration.',r);
      }
      return out_(409,false,RC.PROCESSING_ERROR,ST.PROCESSING,'PROCESSING remains unresolved and requires confirmation/reconciliation.',r);
    }
    if(old.processing_status===ST.SUCCESS) return out_(200,true,RC.IDEMPOTENT,ST.SUCCESS,'Idempotent replay; no new registration.',r);
    if(old.processing_status===ST.DUPLICATE) return out_(200,true,RC.DUPLICATE_RECORD,ST.DUPLICATE,'Duplicate record; no new registration.',r);
    return out_(409,false,old.result_code||RC.PROCESSING_ERROR,old.processing_status||ST.FAILED,'The logical request is not eligible for automatic reprocessing.',r);
  }

  const existing=reconcile_(r.record_id,h,history);
  if(existing.exists){
    if(existing.contentMatches){
      appendHistory_(history,{request_id:r.request_id,record_id:r.record_id,content_hash:h,processing_status:ST.DUPLICATE,received_at:receivedAt,processed_at:new Date(),result_code:RC.DUPLICATE_RECORD,error_message:''});
      return out_(200,true,RC.DUPLICATE_RECORD,ST.DUPLICATE,'Existing record has identical content; no new registration.',r);
    }
    return out_(409,false,RC.RECORD_CONFLICT,ST.CONFLICT,'record_id already exists with different or unreconcilable content.',r);
  }

  appendHistory_(history,{request_id:r.request_id,record_id:r.record_id,content_hash:h,processing_status:ST.PROCESSING,received_at:receivedAt,processed_at:'',result_code:'',error_message:''});
  try{
    appendOfficial_(r,h);
    updateLatest_(history,r.request_id,{processing_status:ST.SUCCESS,processed_at:new Date(),result_code:RC.CREATED,error_message:''});
    return out_(201,true,RC.CREATED,ST.SUCCESS,'Record created successfully.',r);
  }catch(x){
    // The official result is unknown. Keep PROCESSING; do not manufacture FAILED.
    updateLatest_(history,r.request_id,{processing_status:ST.PROCESSING,processed_at:'',result_code:RC.STORAGE_ERROR,error_message:safeLog_(x)});
    return out_(500,false,RC.STORAGE_ERROR,ST.PROCESSING,'Official record storage result is unresolved; confirmation/reconciliation is required.',r);
  }
}

function reconcile_(recordId,h,history){
  const hh=headers_(history),ri=hh.indexOf('record_id'),hi=hh.indexOf('content_hash');
  if(ri<0||hi<0) throw err_(500,RC.STORAGE_ERROR,'API processing history lacks reconciliation columns.');
  const rows=data_(history);
  for(let i=0;i<rows.length;i++) if(String(rows[i][ri])===recordId) return {exists:true,contentMatches:String(rows[i][hi])===h};
  const daily=sheet_(S.DAILY),dh=headers_(daily),di=dh.indexOf('record_id');
  if(di<0) return {exists:false,contentMatches:false};
  const dhi=dh.indexOf('content_hash'),dr=data_(daily);
  for(let i=0;i<dr.length;i++) if(String(dr[i][di])===recordId) return {exists:true,contentMatches:dhi>=0&&String(dr[i][dhi])===h};
  return {exists:false,contentMatches:false};
}

function appendOfficial_(r,h){
  const daily=sheet_(S.DAILY),dh=headers_(daily); if(!dh.length) throw err_(500,RC.STORAGE_ERROR,'Daily record sheet has no header row.');
  const row=dh.map(x=>cell_(resolve_(r,x,h))); if(!row.some(x=>x!=='')) throw err_(500,RC.STORAGE_ERROR,'No existing daily-record header matches the API payload.');
  daily.appendRow(row);
  if(Array.isArray(r.events)&&r.events.length){
    const es=sheet_(S.EVENTS),eh=headers_(es); if(!eh.length) throw err_(500,RC.STORAGE_ERROR,'Important-event sheet has no header row.');
    r.events.forEach(e=>{const er=eh.map(x=>cell_(resolveEvent_(e,r,x,h)));if(!er.some(x=>x!==''))throw err_(500,RC.STORAGE_ERROR,'No existing event header matches the API payload.');es.appendRow(er);});
  }
}

function parse_(e){if(!e||!e.postData||typeof e.postData.contents!=='string')throw err_(400,RC.INVALID_REQUEST,'JSON request body is required.');try{return JSON.parse(e.postData.contents);}catch(_){throw err_(400,RC.INVALID_REQUEST,'Invalid JSON.');}}
function validate_(r){
  if(!r||typeof r!=='object'||Array.isArray(r))throw err_(400,RC.INVALID_REQUEST,'Request JSON must be an object.');
  ['api_version','request_id','record_id','template_version','record'].forEach(k=>{if(!(k in r))throw err_(400,RC.INVALID_REQUEST,'Required field is missing: '+k);});
  id_(r.request_id,'REQ-');id_(r.record_id,'REC-');
  if(r.events!==undefined&&!Array.isArray(r.events))throw err_(400,RC.INVALID_REQUEST,'events must be an array.');
  (r.events||[]).forEach(e=>{if(!e||typeof e!=='object'||Array.isArray(e)||!('event_id'in e))throw err_(400,RC.INVALID_REQUEST,'Each event requires event_id.');id_(e.event_id,'EVT-');});
}
function id_(v,p){if(typeof v!=='string'||!new RegExp('^'+p+'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$').test(v))throw err_(400,RC.INVALID_ID,'Invalid identifier format.');}
function hash_(r){const target={template_version:r.template_version,record:r.record,events:r.events||[]},c=canon_(target),b=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,c,Utilities.Charset.UTF_8);return b.map(x=>{x=x<0?x+256:x;return('0'+x.toString(16)).slice(-2);}).join('');}
function canon_(v){if(v===null)return'null';if(typeof v==='string')return JSON.stringify(v);if(typeof v==='number'){if(!isFinite(v))throw err_(400,RC.INVALID_REQUEST,'Non-finite number is not allowed.');return JSON.stringify(v);}if(typeof v==='boolean')return v?'true':'false';if(Array.isArray(v))return'['+v.map(canon_).join(',')+']';if(typeof v==='object')return'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon_(v[k])).join(',')+'}';throw err_(400,RC.INVALID_REQUEST,'Unsupported JSON value.');}
function auth_(e){const expected=PropertiesService.getScriptProperties().getProperty('LUNARIS_API_KEY');if(!expected)throw err_(500,RC.INTERNAL_ERROR,'API authentication is not configured.');const h=e&&e.headers?e.headers:{},given=h['X-Lunaris-API-Key']||h['x-lunaris-api-key']||'';if(!given||!same_(String(given),String(expected)))throw err_(401,RC.AUTH_FAILED,'Authentication failed.');}
function same_(a,b){if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;}
function findRequest_(s,id){const h=headers_(s),i=h.indexOf('request_id');if(i<0)throw err_(500,RC.STORAGE_ERROR,'request_id header is missing.');const rows=data_(s);for(let n=0;n<rows.length;n++)if(String(rows[n][i])===id){const o={row:n+2};h.forEach((x,j)=>o[x]=rows[n][j]);return o;}return null;}
function appendHistory_(s,e){requireHeaders_(s,HISTORY_HEADERS);const h=headers_(s);s.appendRow(h.map(x=>e[x]===undefined?'':e[x]));}
function updateLatest_(s,id,c){const x=findRequest_(s,id);if(!x)throw err_(500,RC.STORAGE_ERROR,'API history row not found.');update_(s,x.row,c);}
function update_(s,row,c){const h=headers_(s),v=s.getRange(row,1,1,h.length).getValues()[0];Object.keys(c).forEach(k=>{const i=h.indexOf(k);if(i>=0)v[i]=c[k];});s.getRange(row,1,1,h.length).setValues([v]);}
function resolve_(r,h,hash){if(h==='request_id')return r.request_id;if(h==='record_id')return r.record_id;if(h==='content_hash')return hash;if(h==='api_version')return r.api_version;if(h==='template_version')return r.template_version;if(h==='events')return r.events;if(h.indexOf('record.')===0)return path_(r.record,h.substring(7));if(h.indexOf('record_')===0)return path_(r.record,h.substring(7));return undefined;}
function resolveEvent_(e,r,h,hash){if(h==='event_id')return e.event_id;if(h==='request_id')return r.request_id;if(h==='record_id')return r.record_id;if(h==='content_hash')return hash;if(h.indexOf('event.')===0)return path_(e,h.substring(6));if(h.indexOf('event_')===0)return path_(e,h.substring(6));return undefined;}
function path_(o,p){return p.split('.').reduce((v,k)=>v==null?undefined:v[k],o);}
function cell_(v){return v===undefined||v===null?'':typeof v==='object'?JSON.stringify(v):v;}
function sheet_(name){const ss=SpreadsheetApp.getActiveSpreadsheet();if(!ss)throw err_(500,RC.STORAGE_ERROR,'Spreadsheet unavailable.');const s=ss.getSheetByName(name);if(!s)throw err_(500,RC.STORAGE_ERROR,'Required sheet is missing.');return s;}
function headers_(s){return s.getLastColumn()?s.getRange(1,1,1,s.getLastColumn()).getValues()[0].map(String):[];}
function data_(s){const n=s.getLastRow();return n<=1?[]:s.getRange(2,1,n-1,s.getLastColumn()).getValues();}
function requireHeaders_(s,req){const h=headers_(s);req.forEach(x=>{if(h.indexOf(x)<0)throw err_(500,RC.STORAGE_ERROR,'Required API history header is missing.');});}
function lockMs_(){const n=Number(PropertiesService.getScriptProperties().getProperty('LUNARIS_LOCK_TIMEOUT_MS')||5000);return isFinite(n)&&n>=0?n:5000;}
function out_(http,ok,code,status,message,r){return ContentService.createTextOutput(JSON.stringify({ok:ok,http_status:http,result_code:code,processing_status:status,message:message,request_id:r.request_id||undefined,record_id:r.record_id||undefined})).setMimeType(ContentService.MimeType.JSON);}
function err_(http,code,message){const e=new Error(message);e.httpStatus=http;e.code=code;return e;}
function msg_(e){return e.code===RC.AUTH_FAILED?'Authentication failed.':e.message||'Processing failed.';}
function safeLog_(e){return String(e&&(e.message||e)||'').substring(0,500);}
