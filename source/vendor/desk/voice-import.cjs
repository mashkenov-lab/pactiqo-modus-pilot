const fs=require('node:fs'),{createHash,randomUUID}=require('node:crypto');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const id=v=>{if(typeof v!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(v))throw Error('Некорректный ID голосового пакета');return v;};
const text=(v,max,optional=false)=>{if(optional&&(v===null||v===undefined))return null;if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('Некорректный текст голосового пакета');return v.trim();};
const iso=(v,optional=false)=>{if(optional&&v===null)return null;if(typeof v!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(v)||!Number.isFinite(Date.parse(v)))throw Error('Дата должна содержать часовой пояс');return new Date(v).toISOString();};
function fields(obj,allowed){if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.keys(obj).some(k=>!allowed.includes(k)))throw Error('Неизвестные поля пакета: аудио и полная расшифровка не принимаются');}
function validate(raw){
 fields(raw,['schema','providerId','eventId','sourceId','capturedAt','tasks','metadata']);
 if(raw.schema!=='pactiqo.voice-tasks.v1')throw Error('Нужен формат pactiqo.voice-tasks.v1');
 if(!Array.isArray(raw.tasks)||raw.tasks.length>100)throw Error('В пакете допускается до 100 поручений');
 const metadata=raw.metadata;fields(metadata,['ownerProfileId','ownerConfirmed','speakerConfidence','vadPassed','reviewRequired','ownerName']);
 for(const k of ['ownerConfirmed','vadPassed','reviewRequired'])if(typeof metadata[k]!=='boolean')throw Error('Неверные признаки голосового источника');
 if(metadata.speakerConfidence!==null&&(typeof metadata.speakerConfidence!=='number'||!Number.isFinite(metadata.speakerConfidence)||metadata.speakerConfidence<0||metadata.speakerConfidence>1))throw Error('Неверная уверенность распознавания');
 const seen=new Set(),tasks=raw.tasks.map(t=>{fields(t,['id','revision','title','assignee','dueAt','quote','uncertainty','operation','deadline_text','project_hint']);const key=id(t.id);if(seen.has(key))throw Error('Повтор ID задачи внутри пакета');seen.add(key);if(!Number.isSafeInteger(t.revision)||t.revision<1)throw Error('revision должна быть положительным целым');if(!['upsert','cancel'].includes(t.operation))throw Error('Неизвестная операция');return {id:key,revision:t.revision,title:text(t.title,500),assignee:text(t.assignee,200,true),dueAt:iso(t.dueAt,true),quote:text(t.quote,2000),uncertainty:t.uncertainty===''?'':text(t.uncertainty,2000),operation:t.operation,deadline_text:text(t.deadline_text,300,true),project_hint:text(t.project_hint,300,true)};});
 const packet={schema:raw.schema,providerId:id(raw.providerId),eventId:id(raw.eventId),sourceId:id(raw.sourceId),capturedAt:iso(raw.capturedAt),tasks,metadata:{ownerProfileId:metadata.ownerProfileId===null?null:id(metadata.ownerProfileId),ownerConfirmed:metadata.ownerConfirmed,speakerConfidence:metadata.speakerConfidence,vadPassed:metadata.vadPassed,reviewRequired:metadata.reviewRequired,ownerName:text(metadata.ownerName,200,true)}};
 if(Buffer.byteLength(JSON.stringify(packet),'utf8')>500000)throw Error('Голосовой пакет превышает 500 КБ');return packet;
}
function read(file){const fd=fs.openSync(file,'r');try{if(!fs.fstatSync(fd).isFile()||fs.fstatSync(fd).size>500000)throw Error('Выберите JSON до 500 КБ');const bytes=Buffer.alloc(500001),count=fs.readSync(fd,bytes,0,bytes.length,0);if(count>500000)throw Error('Выберите JSON до 500 КБ');return validate(JSON.parse(bytes.subarray(0,count).toString('utf8').replace(/^\uFEFF/,'')));}finally{fs.closeSync(fd);}}
function preview(store,raw){const p=validate(raw),fingerprint=hash(p),old=(store.state.voiceImports||[]).find(x=>x.providerId===p.providerId&&x.eventId===p.eventId);if(old&&old.fingerprint!==fingerprint)throw Error('Повтор eventId с другим содержимым отклонён');return {packet:p,duplicate:!!old,fingerprint,counts:{tasks:p.tasks.length,cancellations:p.tasks.filter(t=>t.operation==='cancel').length}};}
function commit(store,raw){
 const plan=preview(store,raw);if(plan.duplicate)return {duplicate:true,created:0,updated:0,review:0,stale:0};
 const p=plan.packet,old=store.state;store.state=structuredClone(old);
 try{const s=store.state;s.voiceImportItems||=[];s.voiceImports||=[];s.taskChanges||=[];const receipt={providerId:p.providerId,eventId:p.eventId,fingerprint:plan.fingerprint,created:0,updated:0,review:0,stale:0,duplicate:false};
 for(const row of p.tasks){let mapping=s.voiceImportItems.find(x=>x.providerId===p.providerId&&x.externalId===row.id);const rowHash=hash(row);
  if(mapping&&row.revision<=mapping.revision){if(row.revision===mapping.revision&&rowHash!==mapping.fingerprint)throw Error('Содержимое задачи изменено без новой revision');receipt.stale++;continue;}
  let task=mapping?.taskId?s.tasks.find(t=>t.id===mapping.taskId):null;if(mapping?.taskId&&!task)throw Error('Исходная импортированная задача отсутствует; требуется сверка');
  const uncertainty=[row.uncertainty,row.assignee?'Ответственный из источника: '+row.assignee:'',row.deadline_text&&!row.dueAt?'Срок требует уточнения: '+row.deadline_text:'','Голос и личность владельца не подтверждены Desk.'].filter(Boolean).join(' ');
  const provenance={providerId:p.providerId,eventId:p.eventId,externalId:row.id,sourceId:p.sourceId,capturedAt:p.capturedAt,metadata:p.metadata};
  const patch={title:row.title,dueAt:row.dueAt,source:row.quote,assigneeText:row.assignee,uncertainty,voiceImport:provenance};
  if(task&&row.assignee!==task.assigneeText)patch.contactId=null;
  let appliedRevision=null;
  if(!task&&row.operation==='upsert'){
   task={id:randomUUID(),revision:1,...patch,contactId:null,status:'draft',priority:'normal',createdAt:new Date().toISOString(),completedAt:null,reminderMinutes:[120,60],remindOwner:false,voiceSourceId:'opora:'+hash([p.providerId,p.sourceId]).slice(0,48)};
   s.tasks.unshift(task);receipt.created++;appliedRevision=1;
  }else if(task){
   patch.status=row.operation==='cancel'?'cancelled':task.status;
   if(task.status==='draft'&&!task.reviewPending&&(task.revision||1)===mapping.appliedRevision){Object.assign(task,patch,{revision:(task.revision||1)+1});appliedRevision=task.revision;receipt.updated++;}
   else {for(const previous of s.taskChanges)if(previous.taskId===task.id&&previous.status==='pending'&&previous.voiceImportProvider===p.providerId)previous.status='superseded';s.taskChanges.push({id:randomUUID(),taskId:task.id,revision:task.revision||1,patch,quote:row.quote,status:'pending',createdAt:new Date().toISOString(),voiceImportProvider:p.providerId});task.reviewPending=true;receipt.review++;}
   for(const job of s.outbox)if(job.taskId===task.id&&['pending','dispatching','blocked'].includes(job.status))job.status='cancelled';
  }
  if(!mapping){mapping={providerId:p.providerId,externalId:row.id};s.voiceImportItems.push(mapping);}
  Object.assign(mapping,{revision:row.revision,fingerprint:rowHash,taskId:task?.id||null,appliedRevision});
 }
 if(s.voiceImportItems.length>10000||s.voiceImports.length>=10000)throw Error('Лимит истории импорта; требуется обслуживание базы');
 s.voiceImports.push(receipt);store.event('voice.imported',p.eventId,{providerId:p.providerId,created:receipt.created,updated:receipt.updated,review:receipt.review});store.save();return receipt;
 }catch(e){if(e.code!=='STORE_CONFLICT')store.state=old;throw e;}
}
module.exports={validate,read,preview,commit};
