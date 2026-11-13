'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const scenarios=require('./fixtures/discussion-scenarios.json'),dataset=require('./fixtures/modus-dataset.json');
const {CaseWorkspace}=require('./case-workspace.cjs');
function populateDiscussionDemo(store){
 const manifest=require('./fixtures/discussion-materials/manifest.json');assert.equal(manifest.synthetic,true);const room=new CaseWorkspace({store}),report=[];
 for(const scenario of scenarios){
  const matches=Object.values(store.state.modus.cases).filter(c=>c.dataset?.reference===scenario.reference);assert.equal(matches.length,1,'Expected one explicit dataset case '+scenario.reference);const c=matches[0],original=dataset.records.find(x=>x.reference===scenario.reference);assert.equal(c.description,original.description,'Modified case cannot be populated as an original dataset example');
  const before=JSON.stringify(c),a=store.person(c.authorId),o=store.person(c.ownerId),files=manifest.records.find(x=>x.reference===scenario.reference).files.map(f=>{const bytes=fs.readFileSync(path.join(__dirname,'fixtures/discussion-materials',f.file));assert.equal(createHash('sha256').update(bytes).digest('hex'),f.sha256);return {name:f.file,base64:bytes.toString('base64')};});
  const post=(actor,key,body,extra={})=>room.post(actor,{caseId:c.taskId,key:'demo-files-v1-'+scenario.reference+'-'+key,body,expectedRevision:room.room(c.taskId).revision,...extra},{source:'web',demo:true});
  post(a,'example','Учебный пример. Прикладываю материал по ситуации: «'+scenario.title+'». Давайте разберём, что нужно уточнить.',{attachments:[files[0]]});
  const first=post(o,'v1','Подготовил первую редакцию для обсуждения. Откройте документ и проверьте, достаточно ли этих правил для вашей ситуации.',{attachments:[files[1]]});
  post(a,'remark',scenario.remark,{reviewOf:first.attachments[0].id,fileDecision:'changes'});
  const revised=post(o,'v2','Спасибо, замечание учтено. '+scenario.correction+' Прикладываю новую редакцию, первая остаётся в истории.',{attachments:[files[2]]});
  post(a,'approved','Исправление проверено: '+scenario.result+' Согласую именно этот учебный материал.',{reviewOf:revised.attachments[0].id,fileDecision:'approved'});
  post(o,'next',c.phase==='accepted'?'Согласованный материал сохранён в истории уже принятого учебного обращения. Повторно открывать дело не требуется.':'Материал согласован. Дальнейшее исполнение и приёмку результата фиксируем отдельно в карточке; согласование файла само по себе не завершает дело.');
  assert.equal(JSON.stringify(store.state.modus.cases[c.taskId]),before);report.push({reference:scenario.reference,caseId:c.taskId,number:c.number,messages:6,files:3,phase:c.phase});
 }
 return {synthetic:true,externalMessages:false,cases:report.length,messages:report.length*6,files:report.length*3,records:report};
}
module.exports={populateDiscussionDemo};
if(require.main===module){const args=process.argv.slice(2);if(args[0]!=='--offline-data'||!path.isAbsolute(args[1]||''))throw Error('Use --offline-data with an absolute stopped platform data directory');const {SuiteStore}=require('./suite-store.cjs');console.log(JSON.stringify(populateDiscussionDemo(new SuiteStore(args[1]))));}
