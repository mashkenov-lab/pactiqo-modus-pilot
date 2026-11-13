'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {createDemo}=require('./demo-app.cjs');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'modus-pilot-selfcheck-'));
 const passwords=Object.fromEntries(['employee','employee2','owner','owner2','manager','admin'].map(id=>[id,'synthetic-selfcheck-only']));
 let app;
 try{
  app=createDemo({dir,passwords});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+app.server.address().port;
  const req=async(p,body,cookie='')=>fetch(base+p,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-modus-client':'1',cookie},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await req('/health')).status,200);assert.equal((await req('/')).status,200);assert.equal((await req('/api/state')).status,401);
  const cookies={};for(const actor of ['employee','employee2','owner','admin']){const r=await req('/api/login',{actor,password:passwords[actor]});assert.equal(r.status,200);cookies[actor]=r.headers.get('set-cookie').split(';')[0];}
  const state=await(await req('/api/state',undefined,cookies.admin)).json();assert.equal(state.cases.length,20);
  const cases=Object.values(app.store.state.modus.cases);let messages=0,files=0;
  for(const c of cases){const room=app.workroom.snapshot(app.store.person('admin'),c.taskId);assert.equal(room.messages.length,6);messages+=room.messages.length;
   for(const msg of room.messages)for(const f of msg.attachments||[]){const r=await req('/api/attachments/'+f.id,undefined,cookies.admin);assert.equal(r.status,200);const b=Buffer.from(await r.arrayBuffer());assert.equal(createHash('sha256').update(b).digest('hex'),f.sha256);files++;}
  }
  assert.equal(messages,120);assert.equal(files,60);
  const first=cases.find(c=>c.dataset.reference==='A-001');assert.equal((await req('/api/cases/'+first.taskId+'/workroom',undefined,cookies.employee2)).status,404);
  const readiness=await(await req('/api/readiness',undefined,cookies.admin)).json();assert.equal(readiness.desk.authenticated,false);assert.equal(readiness.adapter.ready,false);
  const card=app.store.create(app.store.person('employee'),{key:'selfcheck-full-path',title:'Учебная полка для упаковки',description:'Нужна отдельная полка; синтетическая проверка.',department:'Склад',category:'Организация работы',type:'Предложение',priority:'Средний'});
  let c=card;const act=(actor,action,extra={})=>{c=app.store.act(app.store.person(actor),c.taskId,{revision:c.revision,action,body:'Учебная проверка',...extra});};
  act('owner','start');act('owner','question');act('employee','reply');act('owner','resolve',{evidence:'Учебный результат первой редакции'});act('employee','return');act('owner','resolve',{evidence:'Учебный результат после исправления'});act('employee','accept');assert.equal(c.phase,'accepted');
  await new Promise(r=>app.server.close(r));app=null;
  app=createDemo({dir,passwords});assert.equal(Object.keys(app.store.state.modus.cases).length,21);assert.equal(app.store.get(c.taskId,app.store.person('employee')).phase,'accepted');assert.equal(app.workroom.snapshot(app.store.person('admin'),first.taskId).messages.length,6);
  console.log(JSON.stringify({ok:true,checkedAt:new Date().toISOString(),node:process.version,scope:'isolated local source package',datasetCases:20,discussionMessages:messages,downloadedAndHashedFiles:files,registrationToAcceptance:true,rework:true,permissions:true,restartPersistence:true,externalMessagesSent:0,liveProviderAcceptance:false},null,2));
 }finally{
  if(app?.server.listening)await new Promise(r=>app.server.close(r));
  const resolved=path.resolve(dir),parent=path.resolve(os.tmpdir());if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('modus-pilot-selfcheck-'))throw Error('Unexpected cleanup path');fs.rmSync(resolved,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
