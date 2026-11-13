import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {createRequire} from 'node:module';
import {cloudState,digest} from '../cloud-state.mjs';
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {createPlatformServer}=require('../core/platform-server.cjs');
const {people}=require('../core/platform-store.cjs');
const {populateDiscussionDemo}=require('../core/discussion-demo.cjs');
const analyzer=require('../rules-helper.cjs');
const PASSWORD='MODUS-demo-2026';
const staticFiles={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/suite.js':['suite.js','text/javascript'],'/chat-ui.js':['chat-ui.js','text/javascript'],'/workroom-ui.js':['workroom-ui.js','text/javascript'],'/files-ui.js':['files-ui.js','text/javascript'],'/company-ui.js':['company-ui.js','text/javascript'],'/messenger-ui.js':['messenger-ui.js','text/javascript'],'/pilot-ui.js':['pilot-ui.js','text/javascript'],'/styles.css':['styles.css','text/css'],'/pdfjs/pdf.mjs':['pdfjs/pdf.mjs','text/javascript'],'/pdfjs/pdf.worker.mjs':['pdfjs/pdf.worker.mjs','text/javascript']};
function respond(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function restore(dir,bundle){
 if(!bundle)return;
 if(bundle.schema!==1||!bundle.files||typeof bundle.files!=='object')throw Error('STATE_SCHEMA_INVALID');
 for(const [name,data] of Object.entries(bundle.files)){
  if(!/^(workspace\.json|accounts\.json|attachments\/[a-f0-9-]{36})$/.test(name)||typeof data!=='string')throw Error('STATE_FILE_INVALID');
  const file=path.join(dir,...name.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.from(data,'base64'),{mode:0o600});
 }
}
function snapshot(dir,app){
 const files={};for(const name of ['workspace.json','accounts.json'])files[name]=fs.readFileSync(path.join(dir,name)).toString('base64');
 const attachments=path.join(dir,'attachments');if(fs.existsSync(attachments))for(const name of fs.readdirSync(attachments)){if(!/^[a-f0-9-]{36}$/.test(name))throw Error('STATE_FILE_INVALID');files['attachments/'+name]=fs.readFileSync(path.join(attachments,name)).toString('base64');}
 if(Object.keys(files).length>202||Object.keys(app.store.state.modus.cases).length>100||Object.keys(app.store.suite.conversations).length>150)throw Error('PILOT_CAPACITY_REACHED');
 const sessions=[...app.auth.sessions].filter(([,v])=>v.expires>Date.now());if(sessions.length>500)throw Error('PILOT_SESSION_LIMIT');
 return {schema:1,files,sessions,attempts:[...app.auth.attempts],synthetic:true};
}
class BufferedResponse{
 constructor(){this.statusCode=200;this.headers={};this.parts=[];this.headersSent=false;}
 setHeader(k,v){this.headers[k.toLowerCase()]=v;}
 writeHead(status,headers={}){this.statusCode=status;for(const [k,v] of Object.entries(headers))this.setHeader(k,v);this.headersSent=true;return this;}
 end(value){if(value!==undefined)this.parts.push(Buffer.isBuffer(value)?value:Buffer.from(value));this.finished=true;}
}
export function createHandler({persistence,origin:fixedOrigin}={}){
 return async function handler(req,res){
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  const requested=new URL(req.url,'https://pilot.invalid'),basePath=/^\/modus\/app(?:\/|$)/.test(requested.pathname)?'/modus/app':'',pathname=(basePath?requested.pathname.slice(basePath.length):requested.pathname)||'/',innerUrl=pathname+requested.search;
  if(req.method==='GET'&&pathname==='/health')return respond(res,200,{ok:true,app:'pactiqo-modus-pilot',release:'R6-cloud-pilot-1',synthetic:true,storage:'private-encrypted-blob-cas',ai:'rules-demo',externalChannels:false});
  const asset=staticFiles[pathname]||(/^\/card\/[A-Za-z0-9_-]+$/.test(pathname)?staticFiles['/']:null);
  if(req.method==='GET'&&asset){res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8','Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' blob:; worker-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});let data=fs.readFileSync(path.join(root,'core','r4-public',asset[0]));if(basePath){let content=data.toString('utf8');if(asset[1]==='text/html')content=content.replace(/(["'])\/(?!\/)/g,'$1'+basePath+'/');else if(asset[1]==='text/javascript'&&!pathname.startsWith('/pdfjs/'))for(const resource of ['api','pdfjs','demo-desk.json','company-demo.csv'])for(const quote of ["'",'"','`'])content=content.replaceAll(quote+'/'+resource,quote+basePath+'/'+resource);data=Buffer.from(content);}return res.end(data);}
  if(req.method==='GET'&&['/demo-desk.json','/company-demo.csv'].includes(pathname)){const isCsv=pathname.endsWith('.csv');res.writeHead(200,{'Content-Type':isCsv?'text/csv; charset=utf-8':'application/json; charset=utf-8','Cache-Control':'no-store'});return res.end(fs.readFileSync(path.join(root,'core',isCsv?'fixtures':'public',isCsv?'company-demo.csv':'demo-desk.json')));}
  if(req.method==='GET'&&pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
  if(!pathname.startsWith('/api/'))return respond(res,404,{error:'Страница не найдена'});
  if(!['GET','POST'].includes(req.method))return respond(res,405,{error:'Метод недоступен'});
  if(req.method==='POST'&&/^\/api\/cases\/[a-f0-9-]+\/workroom\/advice$/.test(pathname))return respond(res,503,{error:'Генеративный ИИ в облачном пилоте не подключён. Обсуждение, материалы и план работы доступны участникам.'});
  // Never execute remote integrations, local command execution, or credential changes in the public synthetic pilot.
  if(/^\/api\/(integrations\/bitrix\/|adapter\/|messaging\/(config|check)|company\/(backup|credential|staff|import\/apply|channel\/|authority\/|binding\/|mail\/)|company\/external-origin$)/.test(pathname)&&req.method==='POST')return respond(res,403,{error:'Это публичный учебный пилот. Внешние отправки, изменение учётных записей и подключение реальных каналов здесь отключены.'});
  const host=String(req.headers['x-forwarded-host']||req.headers.host||'');
  if(!fixedOrigin&&!/^(?:[a-z0-9-]+\.vercel\.app|(?:modus\.)?pactiqo\.com)$/.test(host))return respond(res,403,{error:'Недопустимый адрес приложения'});
  const origin=fixedOrigin||'https://'+host;
  if(req.method==='POST'&&(req.headers['x-modus-client']!=='1'||req.headers.origin&&req.headers.origin!==origin))return respond(res,403,{error:'Запрос должен прийти из приложения'});
  try{
   const parts=[];let size=0;if(req.body!==undefined){const data=Buffer.isBuffer(req.body)?req.body:Buffer.from(typeof req.body==='string'?req.body:JSON.stringify(req.body));size=data.length;parts.push(data);}else{for await(const part of req){size+=part.length;if(size>2900000)return respond(res,413,{error:'Размер запроса — до 2,9 МБ'});parts.push(Buffer.from(part));}}if(size>2900000)return respond(res,413,{error:'Размер запроса — до 2,9 МБ'});const input=Buffer.concat(parts);
   const backend=persistence||cloudState();
   for(let attempt=0;attempt<5;attempt++){
    const stored=await backend.load(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'modus-cloud-'));let app;
    try{
     restore(dir,stored.value);
     app=createPlatformServer({dir,seed:!stored.value,passwords:Object.fromEntries(Object.keys(people).map(id=>[id,PASSWORD])),analyzer});
     if(!stored.value)populateDiscussionDemo(app.store);
     app.auth.sessions=new Map(stored.value?.sessions||[]);app.auth.attempts=new Map(stored.value?.attempts||[]);
     const before=stored.value?digest(snapshot(dir,app)):null;
     app.store.suite.externalOrigin=origin;
     const incoming=Readable.from(input.length?[input]:[]);incoming.url=innerUrl;incoming.method=req.method;incoming.headers={...req.headers,host:new URL(origin).host,cookie:String(req.headers.cookie||'').replace(/(^|;\s*)modus_cloud=/g,'$1modus_r5=')};incoming.socket={remoteAddress:'127.0.0.1'};
     const output=new BufferedResponse();await app.server.listeners('request')[0](incoming,output);
     if(!output.finished)throw Error('RESPONSE_INCOMPLETE');
     const updated=snapshot(dir,app);
     if(!stored.value||digest(updated)!==before){
      try{await backend.save(updated,stored.etag);}catch(e){if(['BlobPreconditionFailedError','BlobAlreadyExistsError','CAS_CONFLICT'].includes(e?.name)){continue;}throw e;}
     }
     if(output.headers['set-cookie'])output.headers['set-cookie']=output.headers['set-cookie'].replace('modus_r5=','modus_cloud=').replace('Path=/','Path='+(basePath||'/'));
     let responseBody=Buffer.concat(output.parts);if(basePath&&String(output.headers['content-type']).startsWith('application/json'))responseBody=Buffer.from(responseBody.toString('utf8').replaceAll(origin+'/card/',origin+basePath+'/card/'));
     res.writeHead(output.statusCode,output.headers);return res.end(responseBody);
    }finally{
     app?.server.emit('close');
     const verified=path.resolve(dir);if(verified.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(verified).startsWith('modus-cloud-'))fs.rmSync(verified,{recursive:true,force:true});
    }
   }
   return respond(res,409,{error:'Параллельное изменение данных. Обновите карточку и повторите действие.'});
  }catch(e){console.error('MODUS_PILOT_ERROR',e?.name,e?.message);return respond(res,503,{error:e.message==='PILOT_CAPACITY_REACHED'?'Достигнут лимит учебного стенда. Обратитесь к организатору демонстрации.':'Облачное хранилище временно недоступно. Успешное сохранение не подтверждено. Повторите после обновления страницы.'});}
 };
}
export default createHandler();
