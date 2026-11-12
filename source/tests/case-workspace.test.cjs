'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SuiteStore } = require('../suite-store.cjs');
const { CaseWorkspace, buildCaseContext } = require('../case-workspace.cjs');
const { casePrompt, validateCaseAdvice } = require('../case-assistant.cjs');

function setup(analysis) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-room-'));
  const store = new SuiteStore(dir);
  const author = store.actor('employee');
  const owner = store.actor('owner');
  const admin = store.actor('admin');
  const row = store.create(author, { key: 'one', title: 'Тема', description: 'Описание', department: 'Склад', category: 'Организация работы' });
  return {dir, store, author, owner, admin, row, room: new CaseWorkspace({store, analysis})};
}
const advice = {reply:'Проверим факты', questions:['Какие ресурсы нужны?'], proposedPlan:'Проверить', sourceRefs:[], uncertainty:'Нет замеров'};
const post = (s, actor, body='Вопрос?', key='key') => s.room.post(actor, {caseId:s.row.taskId, body, key, expectedRevision:s.room.snapshot(actor,s.row.taskId).revision});

test('shared thread is durable, authorized, idempotent and excludes private intake', () => {
  const s=setup();
  const m=post(s,s.author,'Вопрос?');
  assert.equal(m.visibility,'case-participants');
  assert.equal(s.room.post(s.author,{caseId:s.row.taskId,body:'Вопрос?',key:'key',expectedRevision:0}).id,m.id);
  assert.throws(()=>s.room.post(s.author,{caseId:s.row.taskId,body:'Иное',key:'key',expectedRevision:0}),{status:409});
  assert.throws(()=>s.room.post(s.owner,{caseId:s.row.taskId,body:'Иное',key:'other',expectedRevision:0}),{status:409});
  assert.equal(s.room.snapshot(s.owner,s.row.taskId).messages[0].body,'Вопрос?');
  assert.throws(()=>s.room.snapshot(s.store.actor('employee2'),s.row.taskId));
  s.store.state.suite.conversations.secret={messages:[{text:'PRIVATE'}]};
  assert.ok(!JSON.stringify(buildCaseContext(s.store,s.author,s.row.taskId,s.store.state.suite.caseWorkspaces[s.row.taskId])).includes('PRIVATE'));
  const reopened=new SuiteStore(s.dir), room=new CaseWorkspace({store:reopened});
  assert.equal(room.snapshot(reopened.actor('owner'),s.row.taskId).messages[0].body,'Вопрос?');
});

test('plan requires owner or supervisor and never changes case lifecycle',()=>{
  const s=setup(), id=s.row.taskId;
  assert.throws(()=>s.room.savePlan(s.author,{caseId:id,body:'Plan',dueAt:'2030-01-01T00:00:00Z',expectedRevision:0}),{status:403});
  const before=s.store.row(s.store.get(id,s.author));
  s.room.savePlan(s.owner,{caseId:id,body:'Plan',dueAt:'2030-01-01T00:00:00Z',reason:'Согласован срок',expectedRevision:0});
  const after=s.store.row(s.store.get(id,s.author));
  assert.equal(after.phase,before.phase); assert.equal(after.dueAt,'2030-01-01T00:00:00.000Z');
  assert.equal(new CaseWorkspace({store:new SuiteStore(s.dir)}).snapshot(s.author,id).plan.body,'Plan');
  let done=s.store.act(s.owner,id,{action:'resolve',revision:after.revision,body:'Сделано',evidence:'Фото'});
  done=s.store.act(s.author,id,{action:'accept',revision:done.revision,body:'Принято'});
  assert.equal(done.phase,'accepted');
});

test('advice queues immediately, recovers same request after restart and validates output',async()=>{
  let requestId;
  const analysis={analyze:async job=>{requestId=job.requestId; throw Object.assign(Error('pending'),{pending:true});},recover:async job=>{assert.equal(job.requestId,requestId);return advice;}};
  const s=setup(analysis); post(s,s.author);
  const job=s.room.requestAdvice(s.author,{caseId:s.row.taskId,key:'advice',expectedRevision:1});
  assert.equal(job.status,'queued'); await s.room.processPending();
  const store=new SuiteStore(s.dir), room=new CaseWorkspace({store,analysis});
  assert.equal(room.snapshot(s.author,s.row.taskId).ai.status,'pending');
  await room.processPending();
  const view=room.snapshot(s.author,s.row.taskId);
  assert.equal(view.ai.status,'ready'); assert.equal(view.messages.at(-1).body,advice.reply);
  assert.equal(room.requestAdvice(s.author,{caseId:s.row.taskId,key:'advice',expectedRevision:1}).requestId,requestId);
});

test('stale analysis is never published after room, case or membership changes',async()=>{
  for(const change of ['room','case','member']) {
    let finish; const analysis={analyze:()=>new Promise(r=>finish=r)};
    const s=setup(analysis); post(s,s.author);
    s.room.requestAdvice(s.author,{caseId:s.row.taskId,key:'q',expectedRevision:1});
    const pending=s.room.processPending(); await new Promise(r=>setImmediate(r));
    if(change==='room') post(s,s.owner,'Дополнение','next');
    if(change==='case') s.store.act(s.owner,s.row.taskId,{action:'start',revision:s.row.revision});
    if(change==='member') s.store.act(s.admin,s.row.taskId,{action:'assign',revision:s.row.revision,ownerId:'owner2',dueAt:'2030-01-01T00:00:00Z',body:'Переназначение'});
    finish(advice); await pending;
    assert.equal(s.room.snapshot(s.author,s.row.taskId).ai.status,'stale');
    assert.equal(s.room.snapshot(s.author,s.row.taskId).messages.filter(x=>x.role==='assistant').length,0);
    if(change==='member') assert.throws(()=>s.room.snapshot(s.owner,s.row.taskId));
  }
});

test('provider failures and forged references are visible and never retried',async()=>{
  let calls=0; const s=setup({analyze:async()=>{calls++;return {...advice,sourceRefs:['forged']};}});
  post(s,s.author); s.room.requestAdvice(s.author,{caseId:s.row.taskId,key:'q',expectedRevision:1});
  await s.room.processPending(); await s.room.processPending();
  assert.equal(calls,1); assert.equal(s.room.snapshot(s.author,s.row.taskId).ai.status,'error');
  assert.throws(()=>validateCaseAdvice({...advice,recipient:'x'}, {documents:[]}));
  assert.throws(()=>validateCaseAdvice({...advice,sourceRefs:['forged']}, {documents:[]}));
});

test('disabled and reassigned users lose access; prompt bounds and newest message',()=>{
  const s=setup(); post(s,s.author);
  const person=s.store.person('employee'); s.store.updateStaff(s.admin,{id:person.id,revision:person.revision,active:false});
  assert.throws(()=>s.room.snapshot(s.author,s.row.taskId));
  const ctx=buildCaseContext(s.store,s.owner,s.row.taskId,s.store.state.suite.caseWorkspaces[s.row.taskId]);
  const prompt=casePrompt(ctx); assert.ok(JSON.stringify(prompt).includes('Вопрос?'));
  assert.ok(JSON.stringify(prompt).length<=24000);
});

test('trusted channel is recorded without allowing input impersonation',()=>{
  const s=setup();
  const m=s.room.post(s.author,{caseId:s.row.taskId,body:'Hi',key:'one',expectedRevision:0,source:'telegram',authorId:'owner'}, {source:'whatsapp'});
  assert.equal(m.authorId,'employee'); assert.equal(m.source,'whatsapp');
  assert.throws(()=>s.room.post(s.author,{caseId:s.row.taskId,body:'Hi',key:'two',expectedRevision:1},{source:'fake'}));
});

test('revoking a source while analysis runs makes result stale',async()=>{
  let finish;
  const s=setup({analyze:()=>new Promise(r=>finish=r)});
  const doc=s.store.saveResponsibility(s.admin,{title:'Role',body:'Only approved',sourceName:'role.txt',department:'Склад',ownerId:'owner',kind:'process',approved:true});
  post(s,s.author);s.room.requestAdvice(s.author,{caseId:s.row.taskId,key:'q',expectedRevision:1});
  const pending=s.room.processPending();await new Promise(r=>setImmediate(r));
  s.store.saveResponsibility(s.admin,{...doc,approved:false});
  finish({...advice,sourceRefs:[doc.id]});await pending;
  assert.equal(s.room.snapshot(s.author,s.row.taskId).ai.status,'stale');
});

test('two processors on one store cannot submit a queued job twice',async()=>{
  let finish,calls=0,recoveries=0;
  const s=setup({analyze:()=>{calls++;return new Promise(r=>finish=r);},recover:async()=>{recoveries++;return advice;}});
  post(s,s.author);s.room.requestAdvice(s.author,{caseId:s.row.taskId,key:'q',expectedRevision:1});
  const first=s.room.processPending();await new Promise(r=>setImmediate(r));
  const other=new CaseWorkspace({store:s.store,analysis:s.room.analysis});await other.processPending();
  finish(advice);await first;
  assert.equal(calls,1);assert.equal(recoveries,0);assert.equal(s.room.snapshot(s.author,s.row.taskId).messages.filter(m=>m.role==='assistant').length,1);
});

test('prompt rejects oversized essential context and preserves newest message',()=>{
  const s=setup();post(s,s.author,'LAST QUESTION');
  const context=buildCaseContext(s.store,s.author,s.row.taskId,s.store.state.suite.caseWorkspaces[s.row.taskId]);
  context.documents=[{id:'x',body:'a'.repeat(50000)}];
  const p=casePrompt(context);assert.equal(p.context.contextPartial,true);assert.equal(p.context.messages.at(-1).body,'LAST QUESTION');
  context.case.description='a'.repeat(50000);
  assert.throws(()=>casePrompt(context),{code:'needs-shortening'});
});

test('invalid calendar dates cannot be approved as plan deadlines',()=>{
  const s=setup();
  assert.throws(()=>s.room.savePlan(s.owner,{caseId:s.row.taskId,body:'Plan',dueAt:'2030-02-31T00:00:00Z',expectedRevision:0}));
  assert.equal(s.room.snapshot(s.owner,s.row.taskId).plan,null);
});

test('pending jobs do not starve another room and recover by the same ID',async()=>{
  const calls=[];
  const analysis={analyze:async job=>{calls.push(['submit',job.requestId]);if(calls.length===1) throw Object.assign(Error('pending'),{pending:true});return advice;},recover:async job=>{calls.push(['recover',job.requestId]);throw Object.assign(Error('pending'),{pending:true});}};
  const s=setup(analysis), second=s.store.create(s.author,{key:'two',title:'Другая тема',description:'Описание',department:'Склад',category:'Организация работы'});
  post(s,s.author);s.room.post(s.author,{caseId:second.taskId,body:'Вопрос 2',key:'two',expectedRevision:0});
  const a=s.room.requestAdvice(s.author,{caseId:s.row.taskId,key:'a',expectedRevision:1});
  const b=s.room.requestAdvice(s.author,{caseId:second.taskId,key:'b',expectedRevision:1});
  await s.room.processPending();await s.room.processPending();
  assert.deepEqual(calls,[['submit',a.requestId],['submit',b.requestId]]);
  assert.equal(s.room.snapshot(s.author,second.taskId).ai.status,'ready');
  await s.room.processPending();assert.deepEqual(calls.at(-1),['recover',a.requestId]);
});

test('provider result and message settle together after unrelated transaction rollback',async()=>{
  let finish;const s=setup({analyze:()=>new Promise(r=>finish=r)});
  post(s,s.author);const job=s.room.requestAdvice(s.author,{caseId:s.row.taskId,key:'a',expectedRevision:1});
  const running=s.room.processPending();await new Promise(r=>setImmediate(r));
  assert.throws(()=>s.store.atomic(()=>{throw Error('rollback');}),/rollback/);
  finish(advice);await running;
  const view=s.room.snapshot(s.author,s.row.taskId);
  assert.equal(view.ai.requestId,job.requestId);assert.equal(view.ai.status,'ready');assert.deepEqual(view.ai.result,advice);
  assert.equal(view.messages.filter(m=>m.role==='assistant').length,1);
  const restarted=new CaseWorkspace({store:new SuiteStore(s.dir)}).snapshot(s.author,s.row.taskId);
  assert.equal(restarted.ai.status,'ready');assert.equal(restarted.messages.filter(m=>m.role==='assistant').length,1);
});

test('round robin persists across restart and gives pending recovery a turn amid new jobs',async()=>{
  const calls=[];
  const analysis={analyze:async job=>{calls.push(['submit',job.requestId]);throw Object.assign(Error('pending'),{pending:true});},recover:async job=>{calls.push(['recover',job.requestId]);return advice;}};
  const s=setup(analysis);post(s,s.author);
  const first=s.room.requestAdvice(s.author,{caseId:s.row.taskId,key:'first',expectedRevision:1});
  await s.room.tick();
  const second=s.store.create(s.author,{key:'second',title:'Два',description:'Описание',department:'Склад',category:'Организация работы'});
  s.room.post(s.author,{caseId:second.taskId,body:'Вопрос',key:'p',expectedRevision:0});
  const next=s.room.requestAdvice(s.author,{caseId:second.taskId,key:'next',expectedRevision:1});
  const store=new SuiteStore(s.dir),room=new CaseWorkspace({store,analysis});
  await room.tick();await room.tick();
  assert.deepEqual(calls,[['submit',first.requestId],['recover',first.requestId],['submit',next.requestId]]);
  assert.equal(room.snapshot(s.author,s.row.taskId).ai.status,'ready');
  assert.equal(room.snapshot(s.author,second.taskId).ai.status,'pending');
});
