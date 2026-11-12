'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {AdapterLink} = require('../adapter-link.cjs');
const {validateCaseAdvice} = require('../case-assistant.cjs');

test('submitted advice contract matches validator and final bounded document IDs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modus-advice-contract-'));
  const link = new AdapterLink({profile:dir, dir, executable:process.execPath});
  const job = {requestId:'contract-test'};
  const context = {case:{id:'case-1', number:'MT-0022', phase:'new', description:'Не зарегистрировано'}, messages:[{body:'Что делать?'}], documents:[{id:'doc-kept',body:'a'}, {id:'doc-trimmed',body:''}]};
  const {casePrompt} = require('../case-assistant.cjs');
  for (let n=22000;n<24000;n++) {
    context.documents[1].body='x'.repeat(n);
    const candidate=casePrompt(context);
    if (candidate.context.documents.length===2 && JSON.stringify(candidate).length>23900) break;
  }
  assert.equal(casePrompt(context).context.documents.length,2);
  let submitted;
  link.client.submit = async p => { submitted = JSON.parse(p.text); };
  link.client.result = async () => ({state:'pending'});
  await assert.rejects(link.caseAnalysis.analyze(job,context), e => e.pending);
  assert.deepEqual(submitted.context.documents.map(d=>d.id), ['doc-kept']);
  const schema = submitted.schema;
  assert.equal(schema.type,'object');
  assert.deepEqual(schema.required, ['reply','questions','proposedPlan','sourceRefs','uncertainty']);
  assert.equal(schema.additionalProperties,false);
  for (const name of ['reply','proposedPlan','uncertainty']) assert.equal(schema.properties[name].type,'string');
  for (const name of ['questions','sourceRefs']) {assert.equal(schema.properties[name].type,'array');assert.equal(schema.properties[name].items.type,'string');}
  assert.equal(schema.properties.reply.maxLength,3000);
  assert.equal(schema.properties.reply.pattern,'\\S');
  assert.equal(schema.properties.questions.maxItems,3);
  assert.equal(schema.properties.questions.items.maxLength,500);
  assert.equal(schema.properties.questions.items.pattern,'\\S');
  assert.equal(schema.properties.proposedPlan.maxLength,4000);
  assert.equal(schema.properties.uncertainty.maxLength,1000);
  assert.equal(schema.properties.sourceRefs.maxItems,10);
  assert.deepEqual(schema.properties.sourceRefs.items.enum,['doc-kept']);
  assert.match(submitted.instruction,/case\.phase/);
  assert.match(submitted.instruction,/case\.number/);
  assert.match(submitted.instruction,/case\.id/);
  const valid={reply:'Есть карточка',questions:['Вопрос?'],proposedPlan:'План',sourceRefs:['doc-kept'],uncertainty:''};
  link.client.result = async()=>({state:'answered',reply:JSON.stringify(valid)});
  assert.deepEqual(await link.caseAnalysis.recover(job,context),valid);
  for (const ref of ['doc-kept, пояснение','doc-trimmed','unknown']) {
    link.client.result = async()=>({state:'answered',reply:JSON.stringify({...valid,sourceRefs:[ref]})});
    await assert.rejects(link.caseAnalysis.recover(job,context),/Некорректное содержимое/);
  }
  for (const bad of [{reply:' '.repeat(2)}, {reply:'a'.repeat(3001)}, {questions:Array(4).fill('q')}, {questions:['q'.repeat(501)]}, {proposedPlan:'p'.repeat(4001)}, {uncertainty:'u'.repeat(1001)}, {sourceRefs:Array(11).fill('doc-kept')}]) {
    assert.throws(()=>validateCaseAdvice({...valid,...bad},{documents:submitted.context.documents}),/Некорректное содержимое/);
  }
  const atLimit={reply:'a'.repeat(3000),questions:Array(3).fill('q'.repeat(500)),proposedPlan:'p'.repeat(4000),sourceRefs:Array(10).fill('doc-kept'),uncertainty:'u'.repeat(1000)};
  assert.deepEqual(validateCaseAdvice(atLimit,{documents:submitted.context.documents}),atLimit);
});

test('submission without documents permits only an empty source list', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'modus-advice-empty-'));
  const link=new AdapterLink({profile:dir,dir,executable:process.execPath});
  let submitted;
  link.client.submit=async p=>{submitted=JSON.parse(p.text);};
  const value={reply:'Ответ',questions:[],proposedPlan:'',sourceRefs:[],uncertainty:''};
  link.client.result=async()=>({state:'answered',reply:JSON.stringify(value)});
  assert.deepEqual(await link.caseAnalysis.analyze({requestId:'empty-docs'},{messages:[{body:'Вопрос'}],documents:[]}),value);
  assert.deepEqual(submitted.schema.properties.sourceRefs.items.enum,[]);
});
