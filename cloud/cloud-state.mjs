import {get, put, BlobPreconditionFailedError} from '@vercel/blob';
import {createCipheriv, createDecipheriv, randomBytes, createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const LIMIT = 16*1024*1024;
const strong = value => typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value) && !value.startsWith('W/');
export function seal(value,key){
 if(!/^[a-f0-9]{64}$/i.test(key||''))throw Error('CLOUD_KEY_NOT_CONFIGURED');
 const plain=Buffer.from(JSON.stringify(value));if(plain.length>LIMIT)throw Error('PILOT_CAPACITY_REACHED');
 const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv), data=Buffer.concat([cipher.update(gzipSync(plain)),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),data]);
}
export function unseal(data,key){
 const cipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));
 return JSON.parse(gunzipSync(Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]),{maxOutputLength:LIMIT}));
}
export function cloudState({token=process.env.BLOB_READ_WRITE_TOKEN,key=process.env.MODUS_PILOT_DATA_KEY,path=process.env.MODUS_PILOT_NAMESPACE||'modus-pilot/v1/state.enc',io={get,put}}={}){
 if(!token||!key)throw Error('CLOUD_STORE_NOT_CONFIGURED');
 if(!/^modus-pilot\/(v1|test-[a-z0-9-]+)\/state\.enc$/.test(path))throw Error('INVALID_NAMESPACE');
 const opts=()=>({token,abortSignal:AbortSignal.timeout(15000)});
 return {
  async load(){
   const blob=await io.get(path,{...opts(),access:'private',useCache:false,headers:{'accept-encoding':'identity'}});
   if(blob===null)return {value:null,etag:null};
   if(blob.statusCode!==200||!strong(blob.blob?.etag)||blob.blob.pathname!==path||!Number.isSafeInteger(blob.blob.size)||blob.blob.size<29||blob.blob.size>LIMIT)throw Error('STATE_READ_INVALID');
   const reader=blob.stream.getReader(),parts=[];let size=0;
   try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>LIMIT||size>blob.blob.size)throw Error('STATE_READ_TOO_LARGE');parts.push(Buffer.from(r.value));}}finally{reader.releaseLock();}
   if(size!==blob.blob.size)throw Error('STATE_READ_INCOMPLETE');
   return {value:unseal(Buffer.concat(parts),key),etag:blob.blob.etag};
  },
  async save(value,etag){
   let result;try{result=await io.put(path,seal(value,key),{...opts(),access:'private',addRandomSuffix:false,allowOverwrite:!!etag,...(etag?{ifMatch:etag}:{}),contentType:'application/octet-stream',cacheControlMaxAge:60});}catch(error){if(error instanceof BlobPreconditionFailedError||error?.name==='BlobAlreadyExistsError')throw Object.assign(Error('Concurrent state update'),{name:'CAS_CONFLICT'});throw error;}
   if(result?.pathname!==path||!strong(result.etag))throw Error('STATE_WRITE_UNCONFIRMED');
   return result.etag;
  }
 };
}
