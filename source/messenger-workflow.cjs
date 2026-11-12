'use strict';
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const stamp=()=>new Date().toISOString();
const terminal=new Set(['sent','delivered','read','failed-before-send','failed','cancelled']);
const text=(v,label,max)=>{if(typeof v!=='string'||!v.trim()||Array.from(v).length>max)fail('Некорректное поле '+label);return v.trim();};

// Only an authenticated Adapter messaging transport may supply events here.
// There is intentionally no public/browser endpoint for injecting an inbound event.
class MessengerWorkflow{
 constructor({store,analysis,transport,workroom,now=()=>Date.now()}){
  Object.assign(this,{store,analysis,transport,workroom,now,busy:false,timer:null,lastError:null,providerStatus:null});
  if(!store.suite.messaging)store.atomic(()=>{store.suite.messaging={schema:1,enabled:false,events:{},sessions:{},outbox:{}};});
  if(!this.state.rejected)store.atomic(()=>{this.state.rejected={};});
  // Migration only touches the local pilot ledger; provider events keep their IDs.
  store.atomic(()=>{let sequence=0;for(const e of Object.values(this.state.events)){e.msgKey=digest([e.channelId,e.channel,e.conversationId,e.messageId]);e.sequence||=++sequence;sequence=Math.max(sequence,e.sequence);}this.state.sequence=Math.max(sequence,this.state.sequence||0);});
  if(Object.values(this.state.outbox).some(x=>x.state==='sending'))store.atomic(()=>{for(const o of Object.values(this.state.outbox))if(o.state==='sending')o.state='unknown';});
 }
 get state(){return this.store.suite.messaging;}
 configure(a,{enabled}){if(!a.admin)fail('Настройки изменяет администратор',403);if(typeof enabled!=='boolean')fail('Укажите состояние обработки');return this.store.atomic(()=>{this.state.enabled=enabled;return {enabled};});}
 snapshot(a){
  const sessions=Object.values(this.state.sessions).filter(s=>a.admin||s.employeeId===a.id).map(s=>({id:s.id,employeeId:s.employeeId,channel:s.channel,channelId:s.channelId,conversationId:s.localConversationId,entity:s.localConversationId?this.store.suite.conversations[s.localConversationId]?.entity:null,proposalPending:!!s.proposal,updatedAt:s.updatedAt}));
  const allowed=new Set(sessions.map(s=>s.id));
  return {enabled:this.state.enabled,busy:this.busy,lastError:a.admin?this.lastError:null,providers:a.admin?this.providerStatus:null,sessions,outbox:Object.values(this.state.outbox).filter(o=>a.admin||allowed.has(o.sessionId)).slice(-60).reverse().map(o=>({operationId:o.operationId,eventId:o.eventId,state:o.state,at:o.at,providerMessageId:o.providerMessageId||null})),errors:a.admin?[...Object.values(this.state.events).filter(e=>e.state==='error'),...Object.values(this.state.rejected)].map(e=>({eventId:e.eventId,error:e.error})).slice(-20):[]};
 }
 async status(a){if(a.admin&&this.transport)try{this.providerStatus=await this.transport.status();}catch{this.providerStatus={ready:false,error:'Канал Адаптера недоступен'};}return this.snapshot(a);}
 ingest(input){
  const event={};for(const key of ['eventId','messageId','channelId','conversationId','employeeId'])event[key]=text(input[key],key,160);
  if(['__proto__','constructor','prototype'].includes(event.eventId))fail('Некорректный ID события');
  if(input.transportVersion==='v2'){event.transportVersion='v2';event.bindingId=text(input.bindingId,'bindingId',160);if(event.conversationId!==event.bindingId)fail('Некорректная привязка события',403);}
  if(!['telegram','whatsapp'].includes(input.channel))fail('Неизвестный канал');event.channel=input.channel;event.text=text(input.text,'text',24000);
  const hash=digest(event),old=this.state.events[event.eventId];if(old){if(old.hash!==hash)fail('Повтор события изменён: конфликт идентичности или текста',409);return {...old,duplicate:true};}
  try{this.store.person(event.employeeId);}catch{fail('Отправитель не найден среди сотрудников',403);}
  if(this.providerStatus && !this.providerStatus.bindings?.some(b=>b.enabled&&b.channelId===event.channelId&&b.employeeId===event.employeeId&&b.conversationId===event.conversationId))fail('Привязка сотрудника отключена или изменена',403);
  const msgKey=digest([event.channelId,event.channel,event.conversationId,event.messageId]),known=Object.values(this.state.events).find(e=>e.msgKey===msgKey);
  if(known){if(known.messageDigest!==digest({...event,eventId:null}))fail('Конфликт повторного сообщения',409);return {...known,duplicate:true,ackEventId:event.eventId};}
  const sessionId=digest([event.channelId,event.channel,event.conversationId,event.employeeId]);
  return this.store.atomic(()=>{this.state.sessions[sessionId]||={id:sessionId,channel:event.channel,channelId:event.channelId,employeeId:event.employeeId,localConversationId:null,proposal:null,updatedAt:stamp()};const e={...event,receivedAt:stamp(),hash,msgKey,messageDigest:digest({...event,eventId:null}),sessionId,sequence:++this.state.sequence,state:'received',acked:false};this.state.events[event.eventId]=e;return e;});
 }
 quarantine(input,error){const eventId=text(input.eventId,'eventId',160);return this.store.atomic(()=>{const key=digest([eventId,input.channelId,input.messageId]);this.state.rejected[key]={eventId,channelId:typeof input.channelId==='string'?input.channelId.slice(0,160):null,error:String(error.message).slice(0,300),at:stamp()};return {eventId};});}
 resetSession(e,c){
  const session=this.state.sessions[e.sessionId];session.proposal=null;
  for(const old of Object.values(this.state.events))if(old.sessionId===e.sessionId&&old.sequence<e.sequence&&['received','analyzing'].includes(old.state))old.state='superseded';
  for(const o of Object.values(this.state.outbox))if(o.sessionId===e.sessionId&&o.state==='queued'&&this.state.events[o.eventId]?.sequence<e.sequence)o.state='cancelled';
  if(c?.analysisStatus==='waiting_adapter')this.store.abandonAnalysis(this.store.person(e.employeeId),c.id,{revision:c.revision});
 }
 prefix(e){return this.providerStatus?.providers?.find(p=>p.channelId===e.channelId)?.commandPrefix||'';}
 command(e,value){const prefix=this.prefix(e);return (prefix?prefix+' ':'')+value;}
 queue(e,body){
  if(body.length>4000)fail('Ответ превышает лимит канала');
  const operationId=randomUUID();this.state.outbox[operationId]={operationId,eventId:e.eventId,sessionId:e.sessionId,caseId:e.caseId||this.store.suite.caseAdviceJobs?.[e.caseJobId]?.caseId||null,text:body,state:'queued',at:stamp()};return [operationId];
 }
 complete(e,body){return this.store.atomic(()=>{const current=this.state.events[e.eventId];this.queue(current,body);current.state='completed';current.error=null;return current;});}
 routeStamp(c){return digest({settings:this.store.platform.settingsRevision,route:this.store.routeFor(c.analysis.category),category:c.analysis.category,department:c.analysis.department});}
 offer(e,c,lead=''){
  const r=c.analysis,s=this.state.sessions[e.sessionId],route=this.store.routeFor(r.category);
  const card={title:r.title,description:r.summary,department:r.department,category:r.category,type:{suggestion:'Предложение',praise:'Положительный отзыв'}[r.intent]||'Проблема',priority:'Средний',suggestedSolution:r.suggestedSolution||''};
  const proposal={code:randomBytes(4).toString('hex').toUpperCase(),revision:c.revision,routeStamp:this.routeStamp(c),card,expiresAt:new Date(this.now()+3600000).toISOString()};s.proposal=proposal;
  const parts=['Карточка на проверку:',card.title,card.description,'Тип: '+card.type,'Подразделение: '+card.department,'Категория: '+card.category,'Ответственный: '+(this.store.people[route.ownerId]?.name||'Руководитель назначит исполнителя'),card.suggestedSolution?'Предложение: '+card.suggestedSolution:'','Приоритет: '+card.priority,'Если всё верно, отправьте: '+this.command(e,'Подтверждаю '+proposal.code),'Код действует 1 час. Чтобы исправить, напишите уточнение. Отмена: '+this.command(e,'/отмена')].filter(Boolean);
  let body=[lead,...parts].filter(Boolean).join('\n\n');if(body.length>3500)body=parts.join('\n\n');
  if(body.length>3500){s.proposal=null;this.queue(e,'Описание получилось слишком длинным для полной проверки в одном сообщении. Уточните кратко главное: что произошло, где и какого результата ждёте. Исходные сведения сохранены; карточка ещё не зарегистрирована.');return null;}
  proposal.operations=this.queue(e,body);return proposal;
 }
 async process(e){
  e=this.state.events[e.eventId];if(!e||!['received','analyzing','case_analyzing'].includes(e.state))return;
  this.providerStatus=await this.transport.status();
  if(e.transportVersion==='v2'&&this.providerStatus.v2Available===false)return;
  if(!this.providerStatus.bindings?.some(b=>b.enabled&&b.channelId===e.channelId&&b.employeeId===e.employeeId&&b.conversationId===e.conversationId))fail('Привязка сотрудника выключена или изменена',403);
  e=this.state.events[e.eventId];if(!e||!['received','analyzing','case_analyzing'].includes(e.state))return;
  const a=this.store.person(e.employeeId),s=this.state.sessions[e.sessionId];let c=s.localConversationId?this.store.conversation(a,s.localConversationId):null;
  if(e.state==='case_analyzing'){
   await this.workroom.processPending();
   e=this.state.events[e.eventId];const job=this.store.suite.caseAdviceJobs[e.caseJobId];
   if(!job||['stale','error'].includes(job.status))return this.complete(e,'Общее сообщение сохранено; совет сейчас недоступен или контекст изменился.');
   if(job.status==='ready'){const view=this.workroom.snapshot(this.store.person(e.employeeId),job.caseId);return this.complete(e,'Общее обсуждение '+view.number+':\n'+job.result.reply);}
   return;
  }
  if(e.state==='received'){
   const body=e.text.replace(/^\/modus(?:@\w+)?(?:\s+|$)/iu,'').trim(),confirmation=body.match(/^(?:подтверждаю|\/confirm)\s+([a-f0-9]{8})$/iu);
   if(this.workroom){
    const visible=this.store.snapshot(a).cases.filter(x=>x.phase!=='draft');
    const find=number=>visible.filter(x=>x.number?.toLowerCase()===number.toLowerCase());
    if(/^мои задачи$/iu.test(body)){const list=visible.filter(x=>x.authorId===a.id||x.ownerId===a.id);return this.complete(e,list.length?list.slice(0,30).map(x=>x.number+' · '+x.title+' · '+x.phase).join('\n'):'У вас нет доступных карточек.');}
    const card=body.match(/^карточка\s+(MT-\d+)$/iu);
    if(card){const matches=find(card[1]);if(matches.length!==1)return this.complete(e,matches.length?'Найдено несколько карточек; уточните выбор в системе.':'Карточка не найдена или недоступна.');const row=matches[0];this.store.atomic(()=>{this.state.sessions[e.sessionId].selectedCaseId=row.taskId;this.state.events[e.eventId].caseId=row.taskId;});return this.complete(this.state.events[e.eventId],row.number+' · '+row.title+' · '+row.phase+'\nОбсуждение видно автору и исполнителю. Напишите «обсудить '+row.number+' текст».');}
    if(/^\/(выход|exit)$/iu.test(body)){this.store.atomic(()=>{this.state.sessions[e.sessionId].selectedCaseId=null;});return this.complete(e,'Вы вышли из общего обсуждения.');}
    const discussion=body.match(/^обсудить\s+(MT-\d+)\s+([\s\S]+)$/iu);
    const selected=s.selectedCaseId && !discussion && !body.startsWith('/') && !confirmation ? visible.find(x=>x.taskId===s.selectedCaseId) : null;
    if(discussion||selected){const matches=discussion?find(discussion[1]):[selected];if(matches.length!==1)return this.complete(e,'Карточка не найдена, недоступна или выбор неоднозначен.');const row=matches[0],message=discussion?discussion[2]:body,room=this.workroom.snapshot(a,row.taskId);this.workroom.post(a,{caseId:row.taskId,body:message,key:'messenger-'+e.eventId,expectedRevision:room.revision},{source:e.channel});const updated=this.workroom.snapshot(a,row.taskId);let job;try{job=this.workroom.requestAdvice(a,{caseId:row.taskId,key:'messenger-'+e.eventId,expectedRevision:updated.revision});}catch(error){if(error.status===409)return this.complete(e,'Сообщение сохранено в общем обсуждении. Уже выполняется другой запрос совета.');throw error;}this.store.atomic(()=>{const current=this.state.events[e.eventId];current.state='case_analyzing';current.caseJobId=job.requestId;current.caseId=row.taskId;this.state.sessions[e.sessionId].selectedCaseId=row.taskId;});return;}
   }
   if(body.length>4000)return this.complete(e,'Сообщение сохранено, но для разбора одного шага нужно не более 4000 символов. Напишите короче основную проблему, место и желаемый результат; затем я уточню детали. Карточка пока не создана.');
   if(confirmation){
    const p=s.proposal;
    if(c?.entity){const context=this.store.analysisContext(a,c.id).registeredEntity;return this.complete(e,'Обращение '+c.entity.number+' уже зарегистрировано. Ответственный: '+context.owner+'. Повторная карточка не создана.');}
    if(!p||!c||p.code!==confirmation[1].toUpperCase()||Date.parse(p.expiresAt)<=this.now()||p.revision!==c.revision)return this.complete(e,'Подтверждение устарело или не относится к этой карточке. Напишите уточнение, чтобы получить актуальную карточку и новый код.');
    if(p.routeStamp!==this.routeStamp(c))return this.store.atomic(()=>{this.offer(e,c,'Маршрут изменился. Проверьте актуальную карточку перед направлением.');e.state='completed';});
    return this.store.atomic(()=>{const confirmed=this.store.confirmConversation(a,c.id,{...p.card,revision:c.revision}),context=this.store.analysisContext(a,c.id).registeredEntity;s.proposal=null;this.queue(e,'Обращение '+confirmed.entity.number+' зарегистрировано.\nОтветственный: '+context.owner+'.\nСтатус: '+context.status+'.\nСрок: '+new Date(context.dueAt).toLocaleString('ru-RU',{timeZone:'Asia/Qyzylorda'})+' (время Казахстана).\nМожно продолжить разговор. Новое обращение: '+this.command(e,'/новое'));e.state='completed';});
   }
   if(/^\/(отмена|cancel)$/iu.test(body))return this.store.atomic(()=>{this.resetSession(e,c);if(!c?.entity)s.localConversationId=null;this.queue(e,c?.entity?'Карточка '+c.entity.number+' уже зарегистрирована. Её статус не изменён. Дальнейшие действия доступны в системе.':'Подготовка обращения отменена. Напишите новое сообщение, когда захотите вернуться.');e.state='completed';});
   if(/^\/(новое|new)$/iu.test(body))return this.store.atomic(()=>{this.resetSession(e,c);s.localConversationId=null;s.selectedCaseId=null;this.queue(e,'Расскажите своими словами, что произошло или что хотите улучшить. '+(this.prefix(e)?'Начинайте каждое сообщение с '+this.prefix(e)+'.':''));e.state='completed';});
   if(!body||/^\/(start|help)$/iu.test(body))return this.complete(e,'Расскажите о проблеме или предложении. Я уточню детали и покажу карточку перед регистрацией. '+(this.prefix(e)?'Для этого разговора начинайте сообщения с '+this.prefix(e)+'.':''));
   if(s.proposal&&/^(да|ок|хорошо|согласен|подтверждаю)[.!\s]*$/iu.test(body))return this.complete(e,'Для направления именно этой карточки отправьте: '+this.command(e,'Подтверждаю '+s.proposal.code)+'. Либо напишите, что нужно исправить.');
   if(c&&['pending','waiting_adapter'].includes(c.analysisStatus))return;
   this.store.atomic(()=>{
    s.proposal=null;s.updatedAt=stamp();
    if(!c){c=this.store.openConversation(a,{kind:'employee',key:'messenger-'+e.eventId,body});s.localConversationId=c.id;const original=this.store.conversation(a,c.id);Object.assign(original,{source:e.channel+' · Адаптер',providerVerified:true,externalSource:{channel:e.channel,channelId:e.channelId,conversationId:e.conversationId,from:a.name},messengerSessionId:s.id});}
    else if(!/^\/(повторить|retry)$/iu.test(body))c=this.store.addMessage(a,c.id,{body,key:'messenger-'+e.eventId,revision:c.revision});
    c=this.store.beginAnalysis(a,c.id,{revision:c.revision,engine:'adapter'});e.localConversationId=c.id;e.analysisRequestId=c.analysisRequestId;e.state='analyzing';
   });
   await this.analyze(e,false);return;
  }
  await this.analyze(e,true);
 }
 async analyze(e,collect){
  const a=this.store.person(e.employeeId),c=this.store.conversation(a,e.localConversationId),context={...this.store.analysisContext(a,c.id),messenger:true};
  if(c.analysisRequestId!==e.analysisRequestId)return this.complete(e,'Разговор изменён в системе. Для продолжения напишите новое уточнение.');
  try{
   const result=await (collect?(this.analysis.recover?this.analysis.recover(c,context):this.analysis.collect(c,context)):this.analysis.analyze(c,context));
   this.store.atomic(()=>{const updated=this.store.finishAnalysis(a,c.id,e.analysisRequestId,result),s=this.state.sessions[e.sessionId];e=this.state.events[e.eventId];if(s.localConversationId!==updated.id){e.state='completed';return;}const r=updated.analysis;if(!updated.entity&&r.category&&r.department&&!r.missing?.length)this.offer(e,updated,r.reply||'Подготовил карточку.');else this.queue(e,(r.reply||r.missing?.map(x=>x.question).join('\n')||r.summary)+(this.prefix(e)?'\n\nОтветьте: '+this.prefix(e)+' ваш ответ':''));e.state='completed';e.error=null;});
  }catch(error){
   this.store.atomic(()=>{const latest=this.store.conversation(a,c.id);if(latest.analysisRequestId===e.analysisRequestId&&['pending','waiting_adapter'].includes(latest.analysisStatus))this.store.finishAnalysis(a,c.id,e.analysisRequestId,null,error);e=this.state.events[e.eventId];e.error=String(error.message).slice(0,300);if(error.pending){e.state='analyzing';}else{e.state='error';this.queue(e,'Сообщение сохранено, но сейчас не удалось получить ответ ИИ. Администратор видит ошибку. Повторить разбор: '+this.command(e,'/повторить'));}});
  }
 }
 async flush(){
  const blockedEvents=new Set();
  for(const copy of Object.values(this.state.outbox)){
   if(!this.state.enabled||!this.transport)return;
   if(terminal.has(copy.state)||blockedEvents.has(copy.eventId))continue;
   const operationId=copy.operationId;let receipt;
   try{
    if(copy.state==='queued'){
     const event=this.state.events[copy.eventId];this.store.person(event.employeeId);const status=await this.transport.status();if(event.transportVersion==='v2'&&status.v2Available===false)continue;if(!status.bindings?.some(b=>b.enabled&&b.channelId===event.channelId&&b.employeeId===event.employeeId&&b.conversationId===event.conversationId))throw Error('Привязка отключена');
     const freshEvent=this.state.events[copy.eventId],fresh=this.state.outbox[operationId];if(!freshEvent||!fresh||fresh.state!=='queued')continue;const person=this.store.person(freshEvent.employeeId);const caseId=fresh.caseId||freshEvent.caseId||this.store.suite.caseAdviceJobs?.[freshEvent.caseJobId]?.caseId;if(caseId)this.store.get(caseId,person);
     this.store.atomic(()=>{this.state.outbox[operationId].state='sending';});
     receipt=await this.transport.reply({eventId:copy.eventId,operationId,text:copy.text});
    }else receipt=await this.transport.receipt({operationId});
    if(receipt.operationId!==operationId||!['accepted','sent','delivered','read','unknown','failed-before-send','failed'].includes(receipt.state))throw Error('Квитанция не соответствует операции');
    this.store.atomic(()=>{Object.assign(this.state.outbox[operationId],{state:receipt.state,providerMessageId:receipt.providerMessageId||null,checkedAt:stamp()});});
    if(!['sent','delivered','read'].includes(receipt.state))blockedEvents.add(copy.eventId);
   }catch{this.store.atomic(()=>{const current=this.state.outbox[operationId];current.state=current.state==='queued'?'cancelled':'unknown';});blockedEvents.add(copy.eventId);}
  }
 }
 async tick(){
  if(this.busy||!this.state.enabled||!this.transport||!this.analysis)return;
  this.busy=true;
  try{
   this.providerStatus=await this.transport.status();
   const polled=await this.transport.poll({limit:20});
   for(const input of (Array.isArray(polled)?polled:polled.events||[])){
    let event;try{event=this.ingest(input);}catch(error){this.lastError=String(error.message).slice(0,300);if([400,403,409].includes(error.status)){try{const rejected=this.quarantine(input,error);await this.transport.ack({eventId:rejected.eventId});}catch{}}continue;}
    try{await this.transport.ack({eventId:input.eventId});if(this.state.events[event.eventId])this.store.atomic(()=>{this.state.events[event.eventId].acked=true;});}catch(error){this.lastError=String(error.message).slice(0,300);}
   }
   for(const event of Object.values(this.state.events))if(this.state.enabled&&['received','analyzing','case_analyzing'].includes(event.state)){
    try{await this.process(event);}catch(e){this.lastError=String(e.message).slice(0,300);this.store.atomic(()=>{const current=this.state.events[event.eventId];if([400,403,404,409].includes(e.status)){current.state='error';const c=current.localConversationId?this.store.conversation(this.store.person(current.employeeId),current.localConversationId):null;if(c?.analysisStatus==='waiting_adapter')this.store.abandonAnalysis(this.store.person(current.employeeId),c.id,{revision:c.revision});}current.error=this.lastError;});}
    await this.flush();
   }
   await this.flush();
  }catch(e){this.lastError=String(e.message).slice(0,300);}finally{this.busy=false;}
 }
 start(){if(this.timer)return;this.timer=setInterval(()=>{void this.tick();},2500);this.timer.unref?.();}
 stop(){clearInterval(this.timer);this.timer=null;}
}
module.exports={MessengerWorkflow};
