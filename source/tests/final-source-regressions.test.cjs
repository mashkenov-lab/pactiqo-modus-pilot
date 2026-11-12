'use strict';
// All bindings, inbound events and receipts in this file are educational doubles.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SuiteStore}=require('../suite-store.cjs');
const {CaseDelivery}=require('../case-delivery.cjs');
const {CardLinks}=require('../card-links.cjs');
const {createPlatformServer}=require('../platform-server.cjs');
const fresh=()=>new SuiteStore(fs.mkdtempSync(path.join(os.tmpdir(),'modus-final-source-')));
const card=s=>s.create(s.person('employee'),{key:'case',title:'Approved title',description:'Approved description',department:'Склад',category:s.categories()[0]});
test('private intake stays author-only across persisted legacy cards, conversations, handoff and provider inbox',()=>{
 let s=fresh();const a=s.person('employee');let c=s.openConversation(a,{kind:'employee',key:'private',body:'PRIVATE_INTAKE_SENTINEL'});
 for(const id of ['owner','manager','admin']){
  assert.throws(()=>s.conversationView(s.person(id),c.id));
  assert.ok(!JSON.stringify(s.snapshot(s.person(id))).includes('PRIVATE_INTAKE_SENTINEL'));
 }
 s.atomic(()=>Object.assign(s.suite.conversations[c.id],{providerVerified:true,source:'Educational provider',externalSource:{from:'Synthetic sender'}}));
 c=s.confirmConversation(a,c.id,{revision:c.revision,title:'Approved title',description:'Only approved shared summary',department:'Склад',category:s.categories()[0]});
 // Persisted old sourceText is retained for recovery; serialization must handle it safely.
 s.atomic(()=>{s.state.modus.cases[c.entity.id].sourceText='PRIVATE_INTAKE_SENTINEL';});s=new SuiteStore(s.dir);
 assert.match(JSON.stringify(s.conversationView(s.person('employee'),c.id)),/PRIVATE_INTAKE_SENTINEL/);
 assert.equal(s.state.modus.cases[c.entity.id].sourceText,'PRIVATE_INTAKE_SENTINEL');
 assert.equal(s.row(s.get(c.entity.id,s.person('employee')),s.person('employee')).sourceText,'PRIVATE_INTAKE_SENTINEL');
 for(const id of ['owner','manager','admin']){
  const actor=s.person(id),row=s.row(s.get(c.entity.id,actor));
  assert.equal(row.description,'Only approved shared summary');assert.ok(!JSON.stringify(row).includes('PRIVATE_INTAKE_SENTINEL'));
  assert.ok(!JSON.stringify(s.snapshot(actor)).includes('PRIVATE_INTAKE_SENTINEL'));
  assert.ok(!JSON.stringify(s.handoff(actor,c.entity.id)).includes('PRIVATE_INTAKE_SENTINEL'));
  assert.throws(()=>s.conversation(actor,c.id));assert.equal(s.message(s.suite.conversations[c.id].messageId,actor).body,'Only approved shared summary');assert.ok(!JSON.stringify(s.message(s.suite.conversations[c.id].messageId,actor)).includes('PRIVATE_INTAKE_SENTINEL'));
 }
 assert.match(s.message(s.suite.conversations[c.id].messageId,s.person('employee')).body,/PRIVATE_INTAKE_SENTINEL/);
});
function deliveryFixture(){
 const s=fresh(),sent=[],bindings=[{bindingId:'educational-author',channelId:'test-telegram',employeeId:'employee',enabled:true,revision:1},{bindingId:'educational-owner',channelId:'test-max',employeeId:'owner',enabled:true,revision:1}],status={bindings,channels:[{channelId:'test-telegram',channel:'telegram',ready:true},{channelId:'test-max',channel:'max',ready:true}],capabilities:{caseNotify:{enabled:true}}},cards=new CardLinks({store:s});
 const authority=new (require('../adapter-authority.cjs').AdapterAuthority)({store:s,dir:s.dir});
 const transport={status:async()=>status,notify:async p=>{authority.verify('Bearer '+authority.secret,{space:'modus-platform',grantId:p.grantId,action:'notify',payloadHash:require('../vendor/adapter-platform/grant-hash.cjs').payloadHash({caseId:p.caseId,bindingId:p.bindingId,operationId:p.operationId,kind:p.kind,text:p.text})});sent.push(p);return {operationId:p.operationId,state:'sent'};},receipt:async p=>({...p,state:'sent'})};
 const args={store:s,transport,authority,links:{ensure:async()=>{}},cardLinkFor:(id,recipient)=>'https://educational.invalid/card/'+cards.issue(id,recipient)};
 const d=new CaseDelivery(args);const c=card(s);const act=(who,action,body,evidence)=>s.act(s.person(who),c.taskId,{revision:s.row(s.state.modus.cases[c.taskId]).revision,action,body,evidence});return {s,d,c,sent,status,args,cards,act};
}
test('human result return revised result acceptance are durable, pinned and cross-channel',async()=>{
 const f=deliveryFixture(),{s,c,act,sent,cards}=f;await f.d.tick();act('owner','resolve','First result','First evidence');act('employee','return','Please revise');act('owner','resolve','Revised result','Revised evidence');act('employee','accept','Accepted after inspection');
 await f.d.tick();const rows=Object.values(f.d.state.outbox).filter(x=>x.eventAction==='resolve'||x.eventAction==='return'||x.eventAction==='accept');assert.equal(rows.length,4);
 assert.deepEqual(rows.map(x=>x.recipientId),['employee','owner','employee','owner']);assert.match(rows[0].payload.text,/First result/);assert.match(rows[0].payload.text,/First evidence/);assert.ok(!rows[0].payload.text.includes('Revised result'));
 assert.match(rows[1].payload.text,/Please revise/);assert.match(rows[2].payload.text,/Revised evidence/);assert.match(rows[3].payload.text,/Accepted after inspection/);
 for(const r of rows){assert.equal(r.state,'sent');const token=r.payload.text.match(/\/card\/([\w-]{43})/)[1];assert.equal(cards.resolve(token,s.person(r.recipientId)),c.taskId);assert.throws(()=>cards.resolve(token,s.person(r.recipientId==='owner'?'employee':'owner')));}
 const count=sent.length;await new CaseDelivery(f.args).tick();assert.equal(sent.length,count);
});
test('messenger card lookup receives server-issued scoped pointer and replay keeps it stable',async t=>{
 const dir=fresh().dir,bindings=['employee','owner','employee2'].map(id=>({bindingId:'education-'+id,channelId:'education-'+id,conversationId:'education-'+id,employeeId:id,enabled:true}));
 const messaging={status:async()=>({bindings})};const app=createPlatformServer({dir,seed:false,messaging});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.server.close());const c=card(app.store),cards=new CardLinks({store:app.store});
 for(const id of ['employee','owner','employee2']){
  const event={eventId:'lookup-'+id,messageId:'lookup-'+id,channelId:'education-'+id,conversationId:'education-'+id,employeeId:id,channel:'telegram',text:'карточка '+c.number};app.messenger.ingest(event);await app.messenger.process(app.messenger.state.events[event.eventId]);
  const out=Object.values(app.messenger.state.outbox).filter(x=>x.eventId===event.eventId);assert.equal(out.length,1);
  if(id==='employee2'){assert.ok(!out[0].text.includes('/card/'));continue;}
  const url=out[0].text.match(/http:\/\/127\.0\.0\.1:\d+\/card\/[\w-]{43}/)?.[0];assert.ok(url,'authorized lookup must include actual local server pointer');assert.equal(cards.resolve(url.split('/').pop(),app.store.person(id)),c.taskId);assert.throws(()=>cards.resolve(url.split('/').pop(),app.store.person(id==='owner'?'employee':'owner')));
  const original=out[0].text;app.messenger.ingest(event);await app.messenger.process(app.messenger.state.events[event.eventId]);assert.equal(Object.values(app.messenger.state.outbox).filter(x=>x.eventId===event.eventId).length,1);assert.equal(out[0].text,original);
 }
 app.store.atomic(()=>{app.store.suite.externalOrigin='https://company.educational.invalid';});
 const e={eventId:'https-card',messageId:'https-card',channelId:'education-employee',conversationId:'education-employee',employeeId:'employee',channel:'telegram',text:'карточка '+c.number};app.messenger.ingest(e);await app.messenger.process(app.messenger.state.events[e.eventId]);const response=Object.values(app.messenger.state.outbox).find(x=>x.eventId===e.eventId);assert.match(response.text,/https:\/\/company\.educational\.invalid\/card\/[\w-]{43}/);
});
test('private intake HTTP responses retain author source and exclude manager/executor recovery paths',async t=>{
 const app=createPlatformServer({dir:fresh().dir,seed:false,passwords:{employee:'educational',owner:'educational',manager:'educational'}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.server.close());const base='http://127.0.0.1:'+app.server.address().port;
 const post=(route,body,cookie='')=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json','x-modus-client':'1',cookie},body:JSON.stringify(body)});
 const cookies={};for(const actor of ['employee','owner','manager']){const r=await post('/api/login',{actor,password:'educational'});cookies[actor]=r.headers.get('set-cookie').split(';')[0];}
 let r=await post('/api/conversations',{kind:'employee',key:'private',body:'HTTP_PRIVATE_SENTINEL'},cookies.employee);const conv=await r.json();
 r=await post('/api/conversations/'+conv.id+'/confirm',{revision:conv.revision,title:'Approved',description:'Approved summary',department:'Склад',category:app.store.categories()[0]},cookies.employee);const saved=await r.json();assert.equal(r.status,200);
 for(const actor of ['owner','manager']){
  for(const route of ['/api/state','/api/cases/'+saved.entity.id]){r=await fetch(base+route,{headers:{cookie:cookies[actor]}});assert.equal(r.status,200);assert.ok(!(await r.text()).includes('HTTP_PRIVATE_SENTINEL'));}
  r=await fetch(base+'/api/conversations/'+conv.id,{headers:{cookie:cookies[actor]}});assert.equal(r.status,404);
  r=await post('/api/cases/'+saved.entity.id+'/handoff',{},cookies[actor]);assert.equal(r.status,200);assert.ok(!(await r.text()).includes('HTTP_PRIVATE_SENTINEL'));
 }
 r=await fetch(base+'/api/cases/'+saved.entity.id,{headers:{cookie:cookies.employee}});assert.equal((await r.json()).sourceText,'HTTP_PRIVATE_SENTINEL');
});
test('legacy provider inbox without conversation pointer and customer intake stay private',()=>{
 const s=fresh(),a=s.person('employee'),c=card(s);s.atomic(()=>{s.state.modus.cases[c.taskId].sourceText='LEGACY_PRIVATE';s.comm.inbox.legacy={id:'legacy',body:'LEGACY_PRIVATE',senderId:a.id,entityType:'case',entityId:c.taskId,providerVerified:true};});
 assert.equal(s.message('legacy',a).body,'LEGACY_PRIVATE');for(const id of ['owner','manager'])assert.equal(s.message('legacy',s.person(id)).body,'Approved description');
 const admin=s.person('admin');let conv=s.openConversation(admin,{kind:'customer',key:'customer-private',body:'CUSTOMER_PRIVATE',contact:'Educational customer'});conv=s.confirmConversation(admin,conv.id,{revision:conv.revision,title:'Shared lead',description:'Approved customer summary',department:'Продажи',nextStep:'Contact customer',dueAt:'2027-01-01T00:00:00Z'});
 const lead=s.comm.leads[conv.entity.id];assert.equal(lead.description,'Approved customer summary');assert.match(s.message(lead.messageId,admin).body,/CUSTOMER_PRIVATE/);assert.equal(s.message(lead.messageId,s.person('owner')).body,'Approved customer summary');assert.ok(!JSON.stringify(s.snapshot(s.person('manager'))).includes('CUSTOMER_PRIVATE'));
 // Legacy lead rows can carry the relationship only on the lead itself.
 s.atomic(()=>{delete s.comm.inbox[lead.messageId].conversationId;});assert.equal(s.message(lead.messageId,s.person('owner')).body,'Approved customer summary');
});
test('question reply and decline pin human messages without converting refusal into acceptance',async()=>{
 const f=deliveryFixture();await f.d.tick();f.act('owner','question','Which location?');f.act('employee','reply','North entrance');f.act('owner','decline','Outside agreed scope');await f.d.tick();const rows=Object.values(f.d.state.outbox).filter(r=>['question','reply','decline'].includes(r.eventAction));assert.equal(rows.length,3);assert.deepEqual(rows.map(r=>r.recipientId),['employee','owner','employee']);assert.match(rows[0].payload.text,/Which location/);assert.match(rows[1].payload.text,/North entrance/);assert.match(rows[2].payload.text,/Outside agreed scope/);assert.equal(f.s.get(f.c.taskId,f.s.person('employee')).phase,'review');assert.ok(rows.every(r=>r.state==='sent'));
});
test('pending lifecycle notifications survive restart and missing binding, then unknown only reconciles',async()=>{
 const f=deliveryFixture();await f.d.tick();f.act('owner','resolve','Durable result','Evidence');const authorBinding=f.status.bindings.shift();await f.d.tick();const note=f.s.platform.notifications.find(n=>n.action==='resolve');assert.equal(f.d.state.notificationSeen[note.id],undefined);
 f.status.bindings.push(authorBinding);const s=new SuiteStore(f.s.dir),authority=new (require('../adapter-authority.cjs').AdapterAuthority)({store:s,dir:s.dir});let attempts=0,receipts=0;
 const transport={status:async()=>f.status,notify:async p=>{attempts++;throw Error('Educational transport outcome unknown');},receipt:async p=>{receipts++;return {...p,state:'sent'};}};
 const args={...f.args,store:s,authority,transport,cardLinkFor:(id,recipient)=>'https://educational.invalid/card/'+new CardLinks({store:s}).issue(id,recipient)};await new CaseDelivery(args).tick();assert.equal(attempts,1);assert.equal(Object.values(s.suite.caseDelivery.outbox).find(r=>r.eventAction==='resolve').state,'unknown');
 const reopened=new SuiteStore(s.dir),worker=new CaseDelivery({...args,store:reopened,authority:new (require('../adapter-authority.cjs').AdapterAuthority)({store:reopened,dir:reopened.dir})});await worker.tick();assert.equal(attempts,1);assert.equal(receipts,1);assert.equal(Object.values(worker.state.outbox).find(r=>r.eventAction==='resolve').state,'sent');
});
test('lifecycle delivery cancels reassignment, disabled recipient, revoked binding and changed event before send',async()=>{
 for(const change of ['assignment','inactive','binding','event']){
  const f=deliveryFixture();await f.d.tick();f.act('owner','resolve','Result','Evidence');f.d.collectAssignments(f.status);const row=Object.values(f.d.state.outbox).find(x=>x.eventAction==='resolve'),count=f.sent.length;
  if(change==='assignment')f.s.atomic(()=>{f.s.state.modus.cases[f.c.taskId].ownerId='owner2';});
  if(change==='inactive'){const p=f.s.person('employee');f.s.updateStaff(f.s.person('admin'),{id:p.id,revision:p.revision,active:false});}
  if(change==='binding')f.status.bindings.find(b=>b.employeeId==='employee').enabled=false;
  if(change==='event')f.s.atomic(()=>{f.s.platform.notifications.find(n=>n.id===row.eventId).humanEvent.body='Changed event';});
  await f.d.tick();assert.equal(f.sent.length,count,change);assert.equal(f.d.state.outbox[row.operationId].state,'cancelled',change);
 }
});
test('grant callback denies lifecycle event tampering during send and keeps unknown receipt-only',async()=>{
 const f=deliveryFixture();await f.d.tick();f.act('owner','resolve','Original result','Evidence');let attempts=0;f.args.transport.notify=async p=>{attempts++;const row=f.d.state.outbox[p.operationId];f.s.atomic(()=>{f.s.platform.notifications.find(n=>n.id===row.eventId).humanEvent.body='Changed after grant';});f.args.authority.verify('Bearer '+f.args.authority.secret,{space:'modus-platform',grantId:p.grantId,action:'notify',payloadHash:require('../vendor/adapter-platform/grant-hash.cjs').payloadHash(row.payload)});throw Error('Must reject before this');};
 await f.d.tick();const row=Object.values(f.d.state.outbox).find(r=>r.eventAction==='resolve');assert.equal(row.state,'unknown');assert.equal(attempts,1);await f.d.tick();assert.equal(attempts,1);assert.equal(f.d.state.outbox[row.operationId].state,'sent');
});
test('single-final owner capability never becomes unsolicited lifecycle notification permission',async()=>{
 const f=deliveryFixture();await f.d.tick();f.status.bindings=[{bindingId:'educational-owner-path',channelId:'owner-modus',employeeId:'employee',enabled:true}];f.act('owner','resolve','Result','Evidence');const count=f.sent.length;await f.d.tick();const row=Object.values(f.d.state.outbox).find(r=>r.eventAction==='resolve');assert.equal(row.state,'unsupported');assert.equal(row.reason,'owner_one_final_reply_per_event');assert.equal(f.sent.length,count);
});
