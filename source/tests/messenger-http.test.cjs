'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPlatformServer}=require('../platform-server.cjs');
test('messenger controls require administrator; there is no public inbound injection',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'modus-messaging-http-'));
 const calls=[],app=createPlatformServer({dir,seed:false,passwords:{admin:'test-password',employee:'test-password'},messaging:{status:async()=>({ready:true,providers:[{channel:'whatsapp',channelId:'owner-modus',state:'ready',commandPrefix:'/modus'}],bindings:[]}),poll:async()=>({events:[]}),ack:async()=>{},reply:async p=>{calls.push(p);return{operationId:p.operationId,state:'sent'};},receipt:async()=>{}}});
 t.after(async()=>{app.messenger?.stop();await new Promise(r=>app.server.close(r));assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 async function request(route,body,cookie){return fetch(base+'/api'+route,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-modus-client':'1',...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});}
 async function login(actor){const r=await request('/login',{actor,password:'test-password'});return r.headers.get('set-cookie').split(';')[0];}
 assert.equal((await request('/messaging')).status,401);const employee=await login('employee');assert.equal((await request('/messaging/config',{enabled:true},employee)).status,403);const admin=await login('admin');let r=await request('/messaging/config',{enabled:true},admin);assert.equal(r.status,200);r=await request('/messaging',null,admin);assert.equal((await r.json()).providers.providers[0].channelId,'owner-modus');
 assert.equal((await request('/messaging/inbound',{text:'Forged confirmation'},admin)).status,404);r=await request('/messaging',null,employee);assert.equal((await r.json()).providers,null);r=await request('/messaging/config',{enabled:false},admin);assert.equal((await r.json()).enabled,false);assert.equal(calls.length,0);
});
