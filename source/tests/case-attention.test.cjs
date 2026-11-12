'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SuiteStore}=require('../suite-store.cjs');
const {CaseWorkspace}=require('../case-workspace.cjs');
const {CaseAttention}=require('../case-attention.cjs');
test('approved deadline is canonical, audited and revision controlled',()=>{
 const store=new SuiteStore(fs.mkdtempSync(path.join(os.tmpdir(),'attention-'))), a=store.actor('employee'),o=store.actor('owner');
 const row=store.create(a,{key:'one',title:'Тема',description:'Описание',department:'Склад',category:'Организация работы'}),room=new CaseWorkspace({store});
 assert.throws(()=>room.savePlan(o,{caseId:row.taskId,body:'План',dueAt:'2030-01-01T00:00:00Z',expectedRevision:0}));
 room.savePlan(o,{caseId:row.taskId,body:'План',dueAt:'2030-01-01T00:00:00Z',reason:'Согласован срок',expectedRevision:0});
 assert.equal(store.row(store.get(row.taskId,a)).dueAt,'2030-01-01T00:00:00.000Z');
 assert.match(store.get(row.taskId,a).history.at(-1).body,/Согласован срок/);
 assert.throws(()=>room.savePlan(o,{caseId:row.taskId,body:'План',dueAt:'2031-01-01T00:00:00Z',reason:'Причина',expectedRevision:0}),{status:409});
});

test('activation requires explicit preview, coalesces late work and survives restart',()=>{
 let now=Date.parse('2030-01-07T06:00:00Z');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'attention-cycle-')),store=new SuiteStore(dir),admin=store.actor('admin'),author=store.actor('employee');
 const row=store.create(author,{key:'two',title:'Тема',description:'Описание',department:'Склад',category:'Организация работы'});
 store.atomic(()=>{store.state.tasks.find(x=>x.id===row.taskId).dueAt='2030-01-04T06:00:00.000Z';store.people.owner.managerId='admin';});
 const attention=new CaseAttention({store,now:()=>now}),cfg={...attention.policy(admin).policy,enabled:true,includeExisting:true,revision:0};
 const preview=attention.preview(admin,cfg);assert.throws(()=>attention.configure(admin,{...cfg,previewDigest:'wrong'}),{status:409});attention.configure(admin,{...cfg,previewDigest:preview.digest});
 attention.tick();const events=attention.snapshot(admin,{caseId:row.taskId}).events;assert.equal(events.length,1);assert.equal(events[0].stage,'escalate');assert.equal(events[0].recipientId,'admin');assert.match(events[0].body,/неизвестно/);
 const reopened=new SuiteStore(dir),again=new CaseAttention({store:reopened,now:()=>now});again.tick();assert.equal(again.snapshot(reopened.actor('admin'),{caseId:row.taskId}).events.length,1);
});

test('question and review target the author and closed cases do not emit',()=>{
 let now=Date.parse('2030-01-07T06:00:00Z');const store=new SuiteStore(fs.mkdtempSync(path.join(os.tmpdir(),'attention-phase-'))),admin=store.actor('admin'),author=store.actor('employee'),owner=store.actor('owner');
 let row=store.create(author,{key:'three',title:'Тема',description:'Описание',department:'Склад',category:'Организация работы'});
 row=store.act(owner,row.taskId,{action:'question',revision:row.revision,body:'Уточните'});store.atomic(()=>{store.state.modus.cases[row.taskId].history.at(-1).at='2030-01-06T06:00:00.000Z';});
 const attention=new CaseAttention({store,now:()=>now}),cfg={...attention.policy(admin).policy,enabled:true,includeExisting:true,revision:0};attention.configure(admin,{...cfg,previewDigest:attention.preview(admin,cfg).digest});attention.tick();assert.equal(attention.snapshot(admin,{caseId:row.taskId}).events[0].recipientId,author.id);
 const old=attention.snapshot(admin,{caseId:row.taskId}).events[0];row=store.act(author,row.taskId,{action:'reply',revision:row.revision,body:'Ответ'});row=store.act(owner,row.taskId,{action:'resolve',revision:row.revision,body:'Готово',evidence:'Фото'});row=store.act(author,row.taskId,{action:'accept',revision:row.revision,body:'Принято'});assert.throws(()=>require('../case-attention.cjs').currentAttentionEvent(store,{caseId:row.taskId,eventId:old.id,eventBody:old.body,recipientId:old.recipientId}));
});

test('authority callback rejects attention when deadline or phase changes after grant',()=>{
 const {AdapterAuthority}=require('../adapter-authority.cjs'),{CaseDelivery}=require('../case-delivery.cjs'),{payloadHash}=require('../vendor/adapter-platform/grant-hash.cjs');
 let now=Date.parse('2030-01-07T06:00:00Z');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'attention-grant-')),store=new SuiteStore(dir),admin=store.actor('admin'),author=store.actor('employee'),owner=store.actor('owner');
 const c=store.create(author,{key:'grant',title:'Тема',description:'Описание',department:'Склад',category:'Организация работы'});store.atomic(()=>{store.state.tasks.find(t=>t.id===c.taskId).dueAt='2030-01-07T08:00:00.000Z';});
 const attention=new CaseAttention({store,now:()=>now}),cfg={...attention.policy(admin).policy,enabled:true,includeExisting:true,revision:0};attention.configure(admin,{...cfg,previewDigest:attention.preview(admin,cfg).digest});attention.tick();
 const authority=new AdapterAuthority({store,dir,now:()=>now}),binding={bindingId:'b',employeeId:'owner',channelId:'telegram',enabled:true,revision:1},status={bindings:[binding],channels:[{channelId:'telegram',channel:'telegram',configured:true,ready:true}]};authority.updateBindings(status);
 const delivery=new CaseDelivery({store,authority,now:()=>now});delivery.collectAttention(status);const row=Object.values(delivery.state.outbox)[0];assert.equal(row.state,'queued');const grant=authority.issue(owner,{action:'notify',payload:row.payload,caseId:c.taskId,bindingId:'b'}),q={space:'modus-platform',grantId:grant.grantId,action:'notify',payloadHash:payloadHash(row.payload)};assert.ok(authority.verify('Bearer '+authority.secret,q));
 store.act(owner,c.taskId,{action:'question',revision:c.revision,body:'Уточните'});assert.throws(()=>authority.verify('Bearer '+authority.secret,q));
});

test('activation excludes existing cases unless explicitly enrolled',()=>{
 let now=Date.now()+86400000;const store=new SuiteStore(fs.mkdtempSync(path.join(os.tmpdir(),'attention-no-flood-'))),admin=store.actor('admin'),a=store.actor('employee');const row=store.create(a,{key:'old',title:'T',description:'D',department:'Склад',category:'Организация работы'});store.atomic(()=>{store.state.tasks.find(x=>x.id===row.taskId).dueAt='2020-01-01T00:00:00.000Z';});const service=new CaseAttention({store,now:()=>now}),cfg={...service.policy(admin).policy,enabled:true,includeExisting:false,workingDays:[1,2,3,4,5,6,7],startHour:0,endHour:24,revision:0};service.configure(admin,{...cfg,previewDigest:service.preview(admin,cfg).digest});service.tick();assert.deepEqual(service.snapshot(admin).events,[]);
});

test('weekend work window delays until next configured working time and uses director fallback',()=>{
 let now=Date.parse('2030-01-05T06:00:00Z');const store=new SuiteStore(fs.mkdtempSync(path.join(os.tmpdir(),'attention-weekend-'))),admin=store.actor('admin'),a=store.actor('employee');const row=store.create(a,{key:'weekend',title:'T',description:'D',department:'Склад',category:'Организация работы'});store.atomic(()=>{store.state.tasks.find(x=>x.id===row.taskId).dueAt='2030-01-02T06:00:00.000Z';});const service=new CaseAttention({store,now:()=>now}),cfg={...service.policy(admin).policy,enabled:true,includeExisting:true,directorId:'admin',revision:0};service.configure(admin,{...cfg,previewDigest:service.preview(admin,cfg).digest});service.tick();assert.equal(service.snapshot(admin).events.length,0);now=Date.parse('2030-01-07T06:00:00Z');service.tick();assert.equal(service.snapshot(admin).events[0].recipientId,'admin');
});

test('policy revision replaces unsent dispatch but never resends sent or unknown occurrence',()=>{
 const {CaseDelivery}=require('../case-delivery.cjs');
 for(const oldState of ['queued','sent','unknown']){
  let now=Date.parse('2030-01-07T06:00:00Z');const store=new SuiteStore(fs.mkdtempSync(path.join(os.tmpdir(),'attention-policy-'))),admin=store.actor('admin'),author=store.actor('employee');
  const c=store.create(author,{key:'p',title:'T',description:'D',department:'Склад',category:'Организация работы'});store.atomic(()=>{store.state.tasks.find(t=>t.id===c.taskId).dueAt='2030-01-07T08:00:00.000Z';});
  const attention=new CaseAttention({store,now:()=>now}),cfg={...attention.policy(admin).policy,enabled:true,includeExisting:true,revision:0};attention.configure(admin,{...cfg,previewDigest:attention.preview(admin,cfg).digest});attention.tick();
  const status={bindings:[{bindingId:'b',employeeId:'owner',channelId:'telegram',enabled:true,revision:1}],channels:[{channelId:'telegram',channel:'telegram',configured:true,ready:true}]},delivery=new CaseDelivery({store,now:()=>now});delivery.collectAttention(status);const first=Object.values(delivery.state.outbox)[0];store.atomic(()=>{first.state=oldState;});
  const changed={...attention.policy(admin).policy,includeExisting:true,revision:1};attention.configure(admin,{...changed,previewDigest:attention.preview(admin,changed).digest});attention.tick();delivery.collectAttention(status);
  const events=attention.snapshot(admin,{caseId:c.taskId}).events;assert.equal(events.length,oldState==='queued'?2:1,oldState);assert.equal(Object.keys(delivery.state.outbox).length,oldState==='queued'?2:1,oldState);if(oldState==='queued'){assert.equal(events[0].occurrenceId,events[1].occurrenceId);assert.throws(()=>delivery.current(first));}
 }
});

test('review uses author, inactive recipients are suppressed, and closest active manager wins',()=>{
 let now=Date.parse('2030-01-07T06:00:00Z');const store=new SuiteStore(fs.mkdtempSync(path.join(os.tmpdir(),'attention-review-'))),admin=store.actor('admin'),author=store.actor('employee'),owner=store.actor('owner');let c=store.create(author,{key:'r',title:'T',description:'D',department:'Склад',category:'Организация работы'});c=store.act(owner,c.taskId,{action:'resolve',revision:c.revision,body:'Результат',evidence:'Фото'});store.atomic(()=>{store.state.modus.cases[c.taskId].history.at(-1).at='2030-01-06T06:00:00.000Z';});
 const service=new CaseAttention({store,now:()=>now}),cfg={...service.policy(admin).policy,enabled:true,includeExisting:true,revision:0};service.configure(admin,{...cfg,previewDigest:service.preview(admin,cfg).digest});store.atomic(()=>{store.people.employee.active=false;});service.tick();assert.equal(service.snapshot(admin).events.length,0);store.atomic(()=>{store.people.employee.active=true;});service.tick();assert.equal(service.snapshot(admin).events[0].recipientId,'employee');
 const {curator}=require('../case-attention.cjs');store.atomic(()=>{store.people.owner.managerId='admin';store.people.owner2.managerId='owner';});assert.equal(curator(store,'owner2',{directorId:null}),'admin');store.atomic(()=>{store.people.admin.active=false;});assert.equal(curator(store,'owner2',{directorId:null}),null);
});
