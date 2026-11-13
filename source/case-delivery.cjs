'use strict';
const {createHash,randomUUID} = require('node:crypto');
const {payloadHash} = require('./vendor/adapter-platform/grant-hash.cjs');
const terminal = new Set(['sent','delivered','read','failed','failed-before-send','cancelled','unsupported']);
const humanActions=new Set(['created','assign','publish','start','resolve','decline','question','reply','return','accept','comment','attachment']);
const notificationStamp=n=>payloadHash({id:n.id,caseId:n.caseId,recipient:n.recipient,number:n.number,action:n.action,title:n.title,creatorId:n.creatorId,participants:n.participants,humanEvent:n.humanEvent,resolution:n.resolution});
// Shared with grant issuance/callback verification: a mutable current case must
// never replace the exact human event approved for this durable delivery.
function currentDeliveryEvent(store,row,item,now=Date.now()){
  if(row.eventSource==='attention'){const event=require('./case-attention.cjs').currentAttentionEvent(store,row,now);if(row.payload?.text!==event.body||row.payloadHash!==payloadHash(row.payload))throw Error('Содержимое доставки изменено');return event;}
  const notification=['assignment','notification'].includes(row.eventSource);
  const event=notification?store.platform.notifications.find(n=>n.id===row.eventId&&n.caseId===row.caseId&&n.recipient===row.recipientId):store.suite.caseWorkspaces?.[row.caseId]?.events?.find(e=>e.id===row.eventId);
  if(!event)throw Error('Событие недоступно');
  if(event.demo)throw Error('Учебная переписка не отправляется во внешние каналы');
  if(row.eventSource==='notification'){
    if(notificationStamp(event)!==row.eventStamp||item.authorId!==event.participants?.authorId||item.ownerId!==event.participants?.ownerId)throw Error('Событие или участники изменены');
  }else if((notification?event.title:event.body)!==row.eventBody||(notification&&item.ownerId!==row.recipientId))throw Error('Событие изменено');
  if(row.payloadHash!==payloadHash(row.payload))throw Error('Содержимое доставки изменено');
  return event;
}
class CaseDelivery {
  constructor({store,workroom,transport,authority,links,cardLinkFor,now=Date.now}){
    Object.assign(this,{store,workroom,transport,authority,links,cardLinkFor,now});this.busy=false;this.timer=null;
    if(!store.suite.caseDelivery)store.atomic(()=>{store.suite.caseDelivery={cursors:Object.fromEntries(Object.entries(store.suite.caseWorkspaces||{}).map(([id,r])=>[id,r.events.length])),outbox:{},notificationSeen:Object.fromEntries(store.platform.notifications.map(n=>[n.id,true]))};});
    if(!store.suite.caseDelivery.notificationSeen)store.atomic(()=>{store.suite.caseDelivery.notificationSeen=Object.fromEntries(store.platform.notifications.map(n=>[n.id,true]));});
    store.atomic(()=>{for(const row of Object.values(this.state.outbox))if(row.state==='sending')row.state='unknown';});
  }
  get state(){return this.store.suite.caseDelivery;}
  id(eventId,recipient,bindingId){return createHash('sha256').update(JSON.stringify([eventId,recipient,bindingId])).digest('hex');}
  current(row){
    const person=this.store.person(row.recipientId),item=this.store.get(row.caseId,person);
    if(row.eventSource!=='attention' && ![item.authorId,item.ownerId].includes(person.id))throw Error('Получатель больше не участник');
    if(row.creatorId)this.store.get(row.caseId,this.store.person(row.creatorId));
    const event=currentDeliveryEvent(this.store,row,item,this.now());
    return {person,item,event};
  }
  channel(status, binding) {
    return (status.channels || []).find(c=>c.channelId===binding.channelId) || (status.providers || []).find(c=>c.channelId===binding.channelId) || {channel:binding.channelId};
  }
  choose(status, person, bindings) {
    const available=bindings.filter(b=>{const c=this.channel(status,b);return b.enabled&&b.employeeId===person.id&&b.channelId!=='owner-modus'&&c.configured!==false&&(c.ready!==false||(c.channel==='telegram'&&c.reason==='live_acceptance_required'));});
    return available.find(b=>this.channel(status,b).channel===person.preferredChannel) || available[0] || bindings.find(b=>b.enabled&&b.employeeId===person.id&&b.channelId==='owner-modus');
  }
  collect(status){
    const bindings=status.bindings||[];
    for(const [caseId,room] of Object.entries(this.store.suite.caseWorkspaces||{})){
      const start=this.state.cursors[caseId]||0;
      for(const event of room.events.slice(start)){
        if(event.demo||!['shared_message','assistant_reply','plan_updated'].includes(event.type))continue;
        const item=this.store.state.modus.cases[caseId];if(!item)continue;
        for(const recipientId of new Set([item.authorId,item.ownerId].filter(Boolean))){
          if(recipientId===event.creatorId)continue;
          if(event.type==='assistant_reply' && event.requestId && Object.values(this.store.suite.messaging?.events||{}).some(e=>e.caseJobId===event.requestId&&e.caseId===caseId&&e.employeeId===recipientId))continue;
          let person;try{person=this.store.person(recipientId);this.store.get(caseId,person);}catch{continue;}
          const available=bindings.filter(b=>b.enabled&&b.employeeId===recipientId);
          const chosen=this.choose(status,person,available);
          if(!chosen){const operationId=this.id(event.id,recipientId,'unbound');this.store.atomic(()=>{this.state.outbox[operationId]||={operationId,caseId,eventId:event.id,recipientId,state:'unsupported',reason:'no_verified_binding'};});continue;}
          const operationId=this.id(event.id,recipientId,chosen.bindingId);
          if(this.state.outbox[operationId])continue;
          const label=event.type==='shared_message'?'Новое сообщение':event.type==='plan_updated'?'Обновлён план':'Ответ помощника';
          const url=this.cardLinkFor?.(caseId,recipientId);
          if(url && (typeof url!=='string'||url.length>1000))throw Error('Некорректная ссылка карточки');
          const suffix=url?'\n'+url:'';const text=(label+' · '+item.number+'\n'+event.body).slice(0,4000-suffix.length)+suffix;
          const payload={caseId,bindingId:chosen.bindingId,operationId,kind:'result',text};
          this.store.atomic(()=>{this.state.outbox[operationId]={operationId,caseId,eventId:event.id,eventBody:event.body,creatorId:event.creatorId,recipientId,bindingId:chosen.bindingId,channelId:chosen.channelId,fallback:this.channel(status,chosen).channel!==person.preferredChannel,payload,payloadHash:payloadHash(payload),state:chosen.channelId==='owner-modus'?'unsupported':'queued',reason:chosen.channelId==='owner-modus'?'owner_one_final_reply_per_event':null};});
        }
      }
      this.store.atomic(()=>{this.state.cursors[caseId]=room.events.length;});
    }
  }
  collectAssignments(status){
    const all=this.store.platform.notifications;
    for(const note of all.filter(n=>!this.state.notificationSeen[n.id])){
      if(!humanActions.has(note.action))continue;
      let person,item;try{person=this.store.person(note.recipient);item=this.store.get(note.caseId,person);}catch{continue;}
      if(![item.authorId,item.ownerId].includes(person.id))continue;
      // Older notifications have no immutable human-event payload. Keep the
      // original assignment path; never reconstruct a result from current state.
      const pinned=!!note.humanEvent&&!!note.participants;
      if(!pinned&&(!['created','assign'].includes(note.action)||item.ownerId!==person.id))continue;
      const choices=(status.bindings||[]).filter(b=>b.enabled&&b.employeeId===person.id);
      const binding=this.choose(status,person,choices);if(!binding)continue;
      const operationId=this.id(note.id,person.id,binding.bindingId);
      if(this.state.outbox[operationId])continue;
      const url=this.cardLinkFor?.(note.caseId,person.id);
      const labels={created:'Вам назначено обращение',assign:'Изменён ответственный',publish:'Опубликовано обращение',start:'Принято в работу',resolve:'Результат на проверку автору',decline:'Мотивированный отказ на проверку автору',question:'Уточнение от исполнителя',reply:'Ответ автора',return:'Автор вернул на доработку',accept:'Автор принял результат',comment:'Комментарий',attachment:'Добавлено вложение'};
      const suffix=url?'\n'+url:'';
      const body=pinned?'\n'+note.humanEvent.body+(note.resolution?.url?'\n'+note.resolution.url:''):'';
      const text=(labels[note.action]+' '+note.number+' · '+note.title+body).slice(0,4000-suffix.length)+suffix;
      const payload={caseId:note.caseId,bindingId:binding.bindingId,operationId,kind:['created','assign','publish'].includes(note.action)?'assignment':'result',text};
      this.store.atomic(()=>{this.state.outbox[operationId]={operationId,caseId:note.caseId,eventId:note.id,eventSource:pinned?'notification':'assignment',eventAction:note.action,eventStamp:pinned?notificationStamp(note):null,eventBody:note.title,creatorId:note.creatorId||null,recipientId:person.id,bindingId:binding.bindingId,channelId:binding.channelId,fallback:this.channel(status,binding).channel!==person.preferredChannel,payload,payloadHash:payloadHash(payload),state:binding.channelId==='owner-modus'?'unsupported':'queued',reason:binding.channelId==='owner-modus'?'owner_one_final_reply_per_event':null};this.state.notificationSeen[note.id]=true;});
    }
  }
  collectAttention(status){
    for(const event of Object.values(this.store.suite.attention?.events||{})){
      let person,item;const probe={eventSource:'attention',eventId:event.id,caseId:event.caseId,recipientId:event.recipientId,eventBody:event.body};
      try{person=this.store.person(event.recipientId);item=this.store.get(event.caseId,person);require('./case-attention.cjs').currentAttentionEvent(this.store,probe,this.now());}catch{continue;}
      const binding=this.choose(status,person,(status.bindings||[]).filter(b=>b.employeeId===person.id));
      const operationId=this.id(event.id,person.id,binding?.bindingId||'unbound');
      if(this.state.outbox[operationId]||Object.values(this.state.outbox).some(o=>o.eventId===event.id&&!['unsupported','cancelled','failed-before-send'].includes(o.state)))continue;
      if(!binding){this.store.atomic(()=>{this.state.outbox[operationId]={...probe,operationId,state:'unsupported',reason:'no_verified_binding'};});continue;}
      const payload={caseId:event.caseId,bindingId:binding.bindingId,operationId,kind:'result',text:event.body};
      this.store.atomic(()=>{this.state.outbox[operationId]={...probe,operationId,bindingId:binding.bindingId,channelId:binding.channelId,payload,payloadHash:payloadHash(payload),state:binding.channelId==='owner-modus'?'unsupported':'queued',reason:binding.channelId==='owner-modus'?'owner_one_final_reply_per_event':null};});
    }
  }
  async tick(){
    if(this.busy)return;this.busy=true;
    try{
      const status=await this.transport.status();this.authority.updateBindings(status);this.collect(status);this.collectAssignments(status);this.collectAttention(status);
      for(const copy of Object.values(this.state.outbox)){
        if(terminal.has(copy.state))continue;
        const id=copy.operationId;
        if(copy.state==='unknown'||copy.state==='accepted'){
          try{const r=await this.transport.receipt({operationId:id});if(r.operationId===id)this.store.atomic(()=>{const row=this.state.outbox[id];if(row)row.state=r.state;});}catch{}continue;
        }
        if(copy.eventSource==='attention'&&!require('./case-attention.cjs').working(this.store.suite.attention.policy,this.now()))continue;
        try{
          this.current(copy);
          const binding=status.bindings.find(b=>b.bindingId===copy.bindingId&&b.enabled&&b.employeeId===copy.recipientId);
          if(!binding)throw Error('Привязка отключена');
          if(!status.capabilities?.caseNotify?.enabled)continue;
          await this.links.ensure(copy.caseId,binding,copy.recipientId);
          const row=this.state.outbox[id];if(!row||row.state!=='queued')continue;
          const {person}=this.current(row);
          const grant=this.authority.issue(person,{action:'notify',payload:row.payload,caseId:row.caseId,bindingId:row.bindingId,purpose:'persisted-case-event'});
          this.store.atomic(()=>{const fresh=this.state.outbox[id];if(fresh?.state==='queued')fresh.state='sending';});
          const receipt=await this.transport.notify({...row.payload,grantId:grant.grantId});
          if(receipt.operationId!==id)throw Error('Квитанция не соответствует операции');
          this.store.atomic(()=>{const fresh=this.state.outbox[id];if(fresh?.state==='sending')fresh.state=receipt.state;});
        }catch(error){this.store.atomic(()=>{const row=this.state.outbox[id];if(row) {row.state=row.state==='sending'?'unknown':'cancelled';row.reason=String(error.message).slice(0,200);}});}
      }
    }finally{this.busy=false;}
  }
  snapshot(actor){const p=this.store.person(actor?.id);return Object.values(this.state.outbox).filter(o=>p.admin||o.recipientId===p.id).map(o=>structuredClone(o));}
  start(){if(!this.timer){this.timer=setInterval(()=>this.tick().catch(()=>{}),2500);this.timer.unref?.();}}
  stop(){clearInterval(this.timer);this.timer=null;}
}
module.exports={CaseDelivery,currentDeliveryEvent};
