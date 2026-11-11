'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SuiteStore,people}=require('../suite-store.cjs');
const {MessengerWorkflow}=require('../messenger-workflow.cjs');
function harness(t,channel='telegram'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'modus-messenger-'));
 t.after(()=>{const target=path.resolve(dir);assert(target.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(target,{recursive:true,force:true});});
 const store=new SuiteStore(dir),calls=[],events=[],receipts=new Map();let seq=0;
 const transport={status:async()=>({ready:true,providers:[{channelId:'service',channel,state:'ready'}],bindings:[{channelId:'service',employeeId:'employee',conversationId:'private-test',enabled:true},{channelId:'service',employeeId:'employee2',conversationId:'another-private',enabled:true}]}),poll:async()=>({events:events.splice(0)}),ack:async p=>calls.push({ack:p.eventId}),reply:async p=>{calls.push({reply:p});const r={operationId:p.operationId,state:'sent',providerMessageId:'provider-'+p.operationId};receipts.set(p.operationId,r);return r;},receipt:async p=>receipts.get(p.operationId)||{operationId:p.operationId,state:'unknown'}};
 const analysis={analyze:async c=>{calls.push({analysis:c.id});return result(c);},collect:async c=>result(c)};
 function result(c){const user=c.messages.filter(m=>m.role==='user'),ready=user.length>1;return {title:'Улучшить работу склада',summary:'Нужно устранить помехи в проходе склада.',intent:'suggestion',category:ready?'Безопасность':null,department:ready?'Склад':null,suggestedSolution:'Выделить место для коробок',quotes:[{messageId:user[0].id,text:user[0].text}],missing:ready?[]:[{field:'details',question:'Где и когда возникает проблема?'}],uncertainty:'',reply:c.entity?'Продолжим по зарегистрированной карточке.':ready?'Подготовил предложение.':'Где именно стоят коробки и что мешает?',engine:'synthetic-test'};}
 let worker=new MessengerWorkflow({store,analysis,transport});worker.configure(people.admin,{enabled:true});
 const input=(text,extra={})=>({eventId:'event-'+(++seq),messageId:'message-'+seq,channelId:'service',channel,employeeId:'employee',conversationId:'private-test',receivedAt:new Date().toISOString(),text,...extra});
 const send=async(text,extra)=>{const event=input(text,extra);events.push(event);await worker.tick();return event;};
 return {dir,store,transport,analysis,calls,events,receipts,input,send,get worker(){return worker;},restart(){const next=new SuiteStore(dir);worker=new MessengerWorkflow({store:next,analysis,transport});return next;},proposal(){return Object.values(worker.state.sessions)[0]?.proposal;}};
}
for(const channel of ['telegram','whatsapp'])test(channel+': same-chat clarification → reviewed confirmation → assigned case exactly once',async t=>{
 const h=harness(t,channel);await h.send('/modus На складе неудобно проходить');assert.equal(Object.keys(h.store.state.modus.cases).length,0);assert.match(h.calls.find(x=>x.reply).reply.text,/Где именно/);
 await h.send('Коробки стоят в проходе у двери. Нужна отдельная зона.');const p=h.proposal();assert(p?.code);assert.match(h.calls.filter(x=>x.reply).at(-1).reply.text,/Подтверждаю/);await h.send('да');assert.equal(Object.keys(h.store.state.modus.cases).length,0);
 const confirmation=await h.send('Подтверждаю '+p.code);const row=Object.values(h.store.state.modus.cases)[0];assert(row.ownerId);assert.equal(row.authorId,'employee');assert.equal(row.source,channel+' · Адаптер · Диалог Desk');assert(h.store.platform.notifications.some(n=>n.recipient===row.ownerId&&n.caseId===row.taskId));
 h.events.push(confirmation);await h.worker.tick();assert.equal(Object.keys(h.store.state.modus.cases).length,1);await h.send('Что теперь дальше?');assert.equal(Object.keys(h.store.state.modus.cases).length,1);assert(h.calls.every(x=>!x.reply||Object.keys(x.reply).sort().join(',')==='eventId,operationId,text'));
});
test('message replay, cross-identity collision and foreign employees cannot impersonate a sender',async t=>{
 const h=harness(t);const e=await h.send('Проблема');const count=h.calls.filter(x=>x.analysis).length;h.events.push(e);await h.worker.tick();assert.equal(h.calls.filter(x=>x.analysis).length,count);
 assert.throws(()=>h.worker.ingest({...e,text:'Подменено'}),/изменён|повтор|конфликт/i);assert.throws(()=>h.worker.ingest(h.input('Чужой',{employeeId:'owner'})),/сотрудник/i);assert.throws(()=>h.worker.ingest({...e,employeeId:'employee2'}),/изменён|повтор|конфликт/i);
});
test('new facts, expiry and changed route invalidate previously reviewed confirmation',async t=>{
 const h=harness(t);await h.send('Проблема');await h.send('Детали');const old=h.proposal().code;await h.send('Другое описание');await h.send('Подтверждаю '+old);assert.equal(Object.keys(h.store.state.modus.cases).length,0);
 const p=h.proposal();h.store.atomic(()=>{p.expiresAt=new Date(Date.now()-1000).toISOString();});await h.send('Подтверждаю '+p.code);assert.equal(Object.keys(h.store.state.modus.cases).length,0);
 await h.send('Уточнение');const next=h.proposal().code;h.store.atomic(()=>{h.store.platform.availability.owner=false;h.store.platform.settingsRevision++;});await h.send('Подтверждаю '+next);assert.equal(Object.keys(h.store.state.modus.cases).length,0);assert.notEqual(h.proposal().code,next);await h.send('Подтверждаю '+h.proposal().code);assert.equal(Object.values(h.store.state.modus.cases)[0].ownerId,'owner2');
});
test('unknown delivery is reconciled after restart without replaying external send',async t=>{
 const h=harness(t);h.transport.reply=async p=>{h.calls.push({reply:p});throw Error('Connection lost after acceptance');};await h.send('Проблема');const operation=Object.values(h.worker.state.outbox)[0];assert.equal(operation.state,'unknown');const originalSends=h.calls.filter(x=>x.reply).length;
 h.restart();h.receipts.set(operation.operationId,{operationId:operation.operationId,state:'sent',providerMessageId:'provider-recovered'});await h.worker.tick();assert.equal(h.calls.filter(x=>x.reply).length,originalSends);assert.equal(h.worker.state.outbox[operation.operationId].state,'sent');
});
test('pending AI is collected with original request after restart, never resubmitted',async t=>{
 const h=harness(t);h.analysis.analyze=async c=>{h.calls.push({analysis:c.id});throw Object.assign(Error('Still running'),{pending:true});};await h.send('Проблема');assert.equal(h.calls.filter(x=>x.analysis).length,1);h.restart();await h.worker.tick();assert.equal(h.calls.filter(x=>x.analysis).length,1);assert(h.calls.some(x=>x.reply));
});
test('cancel and new conversation do not modify registered case or leak another employee context',async t=>{
 const h=harness(t);await h.send('Проблема');await h.send('Детали');await h.send('Подтверждаю '+h.proposal().code);const registered=Object.values(h.store.state.modus.cases)[0];await h.send('/отмена');assert.equal(registered.phase,'new');await h.send('/новое');await h.send('Другой вопрос');assert.equal(Object.keys(h.store.suite.conversations).length,2);
 await h.send('Вопрос другого сотрудника',{employeeId:'employee2',conversationId:'another-private'});assert.equal(Object.keys(h.worker.state.sessions).length,2);assert.equal(h.worker.snapshot(people.employee2).sessions.length,1);assert.equal(h.worker.snapshot(people.owner).sessions.length,0);assert.throws(()=>h.worker.configure(people.employee,{enabled:false}),/администратор/i);
});
test('disabled worker does not poll or send; durable input is persisted before Adapter ack',async t=>{
 const h=harness(t);h.worker.configure(people.admin,{enabled:false});h.events.push(h.input('Не трогать'));await h.worker.tick();assert.equal(h.events.length,1);assert.equal(h.calls.length,0);h.worker.configure(people.admin,{enabled:true});h.transport.ack=async({eventId})=>{const disk=JSON.parse(fs.readFileSync(path.join(h.dir,'workspace.json')));assert(disk.suite.messaging.events[eventId]);};await h.worker.tick();assert(h.calls.some(x=>x.reply));
});
test('revoked binding cannot confirm a cached card; overly long previews have no confirmation code',async t=>{
 const h=harness(t);await h.send('Проблема');await h.send('Детали');const code=h.proposal().code;h.transport.status=async()=>({ready:false,providers:[],bindings:[]});await h.send('Подтверждаю '+code);assert.equal(Object.keys(h.store.state.modus.cases).length,0);assert.match(h.worker.lastError,/Привязка/);
});
test('long card and Unicode content cannot exceed one owner reply or hide material confirmed fields',async t=>{
 const h=harness(t);h.analysis.analyze=async c=>({title:'Длинное предложение',summary:'Текст '.repeat(650),intent:'suggestion',category:'Безопасность',department:'Склад',suggestedSolution:'💧'.repeat(700),quotes:[{messageId:c.messages[0].id,text:c.messages[0].text}],missing:[],uncertainty:'',reply:'Подготовил'});await h.send('Много деталей');assert.equal(h.proposal(),null);assert.equal(h.calls.filter(c=>c.reply).length,1);assert(h.calls.filter(c=>c.reply).every(c=>c.reply.text.length<=4000));assert(!h.calls.find(c=>c.reply).reply.text.includes('Подтверждаю'));assert.equal(Object.keys(h.store.state.modus.cases).length,0);
});
test('temporary status failure preserves pending analysis and later input resumes',async t=>{
 const h=harness(t);h.analysis.analyze=async()=>{throw Object.assign(Error('Pending'),{pending:true});};await h.send('Проблема');const normal=h.transport.status;let calls=0;h.transport.status=async()=>{if(++calls===2)throw Error('Temporary bridge outage');return normal();};await h.worker.tick();assert.equal(Object.values(h.worker.state.events)[0].state,'analyzing');h.transport.status=normal;h.events.push(h.input('Дополнительные сведения'));await h.worker.tick();assert.equal(Object.values(h.worker.state.events)[0].state,'completed');assert(h.calls.some(c=>c.reply));
});
test('same provider message number in different private chats is not a duplicate',async t=>{
 const h=harness(t);const one=h.input('Первое');h.worker.ingest(one);const two={...one,eventId:'other-event',employeeId:'employee2',conversationId:'another-private',text:'Второе'};assert.doesNotThrow(()=>h.worker.ingest(two));assert.equal(Object.keys(h.worker.state.events).length,2);
});
test('cancel invalidates older queued messages and pending model so they cannot resurrect a draft',async t=>{
 const h=harness(t);h.analysis.analyze=async()=>{throw Object.assign(Error('Pending'),{pending:true});};h.analysis.collect=async()=>{throw Object.assign(Error('Pending'),{pending:true});};await h.send('Проблема');h.events.push(h.input('Старые детали'),h.input('/отмена'));await h.worker.tick();await h.worker.tick();assert.equal(Object.values(h.worker.state.sessions)[0].localConversationId,null);assert.equal(Object.keys(h.store.suite.conversations).length,1);assert.equal(Object.values(h.worker.state.events).filter(e=>['received','analyzing'].includes(e.state)).length,0);assert.equal(Object.values(h.store.suite.conversations)[0].analysisStatus,'idle');assert(!h.calls.filter(c=>c.reply).some(c=>c.reply.text.includes('Подтверждаю')));
});
test('oversize or unmapped inputs cannot poison the poll head; acknowledged only after durable handling',async t=>{
 const h=harness(t);await h.send('Я'.repeat(5000));assert.equal(h.calls.filter(c=>c.analysis).length,0);assert(h.calls.some(c=>c.reply&&/короче|сократ|4000/.test(c.reply.text)));assert(h.calls.some(c=>c.ack));const unknown=h.input('Неизвестный сотрудник',{employeeId:'not-bound'});h.events.push(unknown);await h.worker.tick();assert(h.calls.some(c=>c.ack===unknown.eventId));assert(Object.values(h.worker.state.rejected).some(e=>e.eventId===unknown.eventId));assert.equal(h.calls.filter(c=>c.reply).length,1);
});
