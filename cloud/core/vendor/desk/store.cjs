const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { validate,validateChanges } = require('./codex.cjs');
const {Persistence}=require('./persistence.cjs');
const notifications=require('./task-notifications.cjs');

const empty = () => ({ version: 1, tasks: [], notes: [], contacts: [], outbox: [], events: [], settings: { reminderMinutes: [120, 60], audioRetentionMinutes: 15 } });
function str(v, name, max = 500) { if (typeof v !== 'string' || !v.trim() || v.length > max) throw Error(`Проверьте поле «${name}»`); return v.trim(); }
function date(v) { if (!v) return null; if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) throw Error('Некорректный срок'); return new Date(v).toISOString(); }
class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true }); this.file = path.join(dir, 'workspace.json');
    this.persistence=new Persistence(this.file,empty);this.state=this.persistence.load();
    this.committed=structuredClone(this.state);
    if (this.state.version !== 1) throw Error('Неподдерживаемая версия хранилища');
  }
  read() { const state=structuredClone(this.state);for(const r of state.taskReplies||[])delete r.ciphertext;return {...state,storageWarning:this.persistence.warning}; }
  reload(){this.state=this.persistence.load();this.committed=structuredClone(this.state);return this.read();}
  settings(patch){this.state.settings={...this.state.settings,...patch};this.save();}
  voiceSettings(patch){const old=this.state.settings.voice||{enabled:false,paused:false,analyze:true,language:'ru',launchAtLogin:false};const next={...old};for(const k of ['enabled','paused','analyze','launchAtLogin'])if(patch[k]!==undefined){if(typeof patch[k]!=='boolean')throw Error('Неверная настройка диктофона');next[k]=patch[k];}if(patch.language!==undefined){if(!['ru','en','kk'].includes(patch.language))throw Error('Неизвестный язык');next.language=patch.language;}if(next.enabled&&!old.enabled)next.enabledAt=new Date().toISOString();if(JSON.stringify(next)!==JSON.stringify(this.state.settings.voice))this.settings({voice:next});return next;}
  commitAnalysis(input){
    const text=str(input.text,'Расшифровка',20000),sourceId=str(input.sourceId,'Источник',100),analysis=validateChanges(validate(input.analysis,text),text);
    const key=createHash('sha256').update(sourceId+'\n'+text).digest('hex');
    const previous=(this.state.ingestions||[]).find(x=>x.key===key);if(previous)return {...previous,duplicate:true};
    const old=this.state;this.state=structuredClone(old);
    try{
      const note={id:randomUUID(),title:'Итоги разговора',voiceSourceId:sourceId,text:(analysis.summary||'').trim().slice(0,20000),source:'Голос · локальное распознавание → Codex',createdAt:new Date().toISOString()};
      const tasks=[],reused=[],changed=[];
      const seen=new Set();for(const c of analysis.changes||[]){const t=this.state.tasks.find(t=>t.id===c.taskId);if(!t||t.projectId||t.voiceSourceId!==sourceId||!['draft','open'].includes(t.status)||c.revision!==(t.revision||1)||seen.has(t.id))throw Error('Контекст поручения устарел или не относится к этому разговору. Повторите разбор.');seen.add(t.id);}
      for(const c of analysis.changes||[]){const t=this.state.tasks.find(t=>t.id===c.taskId),matches=this.state.contacts.filter(x=>x.name===c.assignee);const patch={title:c.title,contactId:matches.length===1?matches[0].id:null,assigneeText:c.assignee,dueAt:date(c.dueAt),source:c.quote,uncertainty:c.uncertainty,status:c.operation==='cancel'?'cancelled':t.status};
       if(t.status==='draft'){Object.assign(t,patch,{revision:(t.revision||1)+1});changed.push({id:t.id,applied:true,operation:c.operation});}
       else{this.state.taskChanges||=[];const proposal={id:randomUUID(),taskId:t.id,revision:t.revision||1,patch,quote:c.quote,status:'pending',createdAt:note.createdAt};this.state.taskChanges.push(proposal);t.reviewPending=true;changed.push({id:t.id,proposalId:proposal.id,applied:false,operation:c.operation});}
       for(const j of this.state.outbox)if(j.taskId===t.id&&['pending','dispatching','blocked'].includes(j.status))j.status='cancelled';this.event('task.voice-change',t.id,{operation:c.operation,quote:c.quote});
      }
      for(const t of analysis.tasks){const matches=this.state.contacts.filter(c=>c.name===t.assignee),contactId=matches.length===1?matches[0].id:null,dueAt=date(t.dueAt);const existing=[...this.state.tasks,...tasks].find(x=>x.voiceSourceId===sourceId&&!['done','cancelled'].includes(x.status)&&x.title.toLocaleLowerCase()===t.title.trim().toLocaleLowerCase()&&x.dueAt===dueAt&&x.contactId===contactId&&x.assigneeText===(t.assignee||null));if(existing){reused.push(existing.id);continue;}tasks.push({id:randomUUID(),title:str(t.title,'Поручение'),contactId,dueAt,priority:'normal',status:'draft',source:t.quote,voiceSourceId:sourceId,assigneeText:t.assignee||null,assigneeKind:t.assigneeKind||(t.assignee?'contact':'unknown'),noteId:note.id,uncertainty:t.uncertainty,reminderMinutes:[120,60],createdAt:note.createdAt,completedAt:null});}
      const keepNote=!!note.text||tasks.length>0||changed.length>0;if(keepNote){if(!note.text)note.text='Выделены поручения или изменения для проверки.';this.state.notes.unshift(note);}this.state.tasks.unshift(...tasks);const receipt={key,noteId:keepNote?note.id:null,taskIds:tasks.map(t=>t.id),reusedTaskIds:reused,changes:changed};this.state.ingestions=[...(this.state.ingestions||[]),receipt].slice(-10000);this.event('voice.committed',note.id);this.save();return receipt;
    }catch(e){if(e.code!=='STORE_CONFLICT')this.state=old;throw e;}
  }
  save() { try{this.persistence.save(this.state);this.committed=structuredClone(this.state);}catch(e){if(e.code==='STORE_CONFLICT')this.reload();else this.state=structuredClone(this.committed);throw e;} }
  event(action, id,details={}) { this.state.events.unshift({ id: randomUUID(), action, entityId: id, at: new Date().toISOString(),details }); this.state.events = this.state.events.slice(0, 2000); }
  voiceEvent(reason,active){if(!['start','manual','device-ended','overload','capture-error','recognition-error','renderer-crash','shutdown','suspend','resume','mode-change'].includes(reason))reason='mode-change';this.event('voice.'+reason,'microphone',{active:!!active});this.save();}
  task(input, metadata = {}) {
    const title = str(input.title, 'Поручение');
    const contact = input.contactId ? this.state.contacts.find(x => x.id === input.contactId) : null;
    if (input.contactId && !contact) throw Error('Ответственный не найден');
    const dueAt = date(input.dueAt);
    const reminders = input.reminderMinutes ?? [120, 60];
    if (!Array.isArray(reminders) || reminders.some(x => ![15,60,120].includes(x))) throw Error('Некорректные напоминания');
    if(input.personalWhatsAppSelf!==undefined&&typeof input.personalWhatsAppSelf!=='boolean')throw Error('Проверьте правило личного WhatsApp');
    if(input.remindOwner!==undefined&&typeof input.remindOwner!=='boolean')throw Error('Некорректный канал');
    if(input.notifyBoth!==undefined&&typeof input.notifyBoth!=='boolean')throw Error('Некорректное правило уведомлений');
    if(input.issuerContactId&&!this.state.contacts.some(c=>c.id===input.issuerContactId))throw Error('Автор поручения не найден');
    const t = { id: randomUUID(), revision:1, title, contactId: contact?.id || null, dueAt, priority: input.priority === 'high' ? 'high' : 'normal', status: input.status === 'draft' ? 'draft' : 'open', source: String(input.source || 'Вручную').slice(0, 2000), noteId: input.noteId || null, reminderMinutes: [...new Set(reminders)], createdAt: new Date().toISOString(), completedAt: null };
    t.remindOwner=input.remindOwner===true;
    t.notifyBoth=input.notifyBoth===true;t.issuerContactId=input.issuerContactId||null;
    if(metadata.assistantProposalId)t.assistantProposalId=metadata.assistantProposalId;if(metadata.personalWhatsAppSelf===true||input.personalWhatsAppSelf===true)t.personalWhatsAppSelf=true;
    if(metadata.assigneeText)t.assigneeText=str(metadata.assigneeText,'Ответственный',120);
    this.state.tasks.unshift(t); this.event('task.created', t.id); this.save(); return t;
  }
  update(id, patch, metadata={}) {
    const index = this.state.tasks.findIndex(x => x.id === id); if (index < 0) throw Error('Поручение не найдено');
    const t = { ...this.state.tasks[index] };
    if(patch.expectedRevision!==undefined&&patch.expectedRevision!==(t.revision||1))throw Error('Поручение уже изменилось. Откройте карточку заново.');
    if(t.projectId){if(patch.status!==undefined&&patch.status!==t.status)throw Error('Статус проекта обновляется через новую ревизию manifest с подтверждениями');t.projectEditedAt=new Date().toISOString();}
    if (patch.title !== undefined) t.title = str(patch.title, 'Поручение');
    if (patch.contactId !== undefined) { if (patch.contactId && !this.state.contacts.some(x => x.id === patch.contactId)) throw Error('Ответственный не найден'); t.contactId = patch.contactId || null; }
    if (patch.dueAt !== undefined) t.dueAt = date(patch.dueAt);
    if (patch.priority !== undefined) { if (!['high', 'normal'].includes(patch.priority)) throw Error('Некорректный приоритет'); t.priority = patch.priority; }
    if (patch.status !== undefined) { if (!['open', 'done', 'draft','cancelled'].includes(patch.status)) throw Error('Неизвестный статус'); t.status = patch.status; t.completedAt = patch.status === 'done' ? new Date().toISOString() : null; }
    if(patch.reminderMinutes!==undefined){if(!Array.isArray(patch.reminderMinutes)||patch.reminderMinutes.some(x=>![15,60,120].includes(x)))throw Error('Некорректные напоминания');t.reminderMinutes=[...new Set(patch.reminderMinutes)];}
    if(patch.personalWhatsAppSelf!==undefined){if(typeof patch.personalWhatsAppSelf!=='boolean')throw Error('Проверьте правило личного WhatsApp');t.personalWhatsAppSelf=patch.personalWhatsAppSelf;}
    if(patch.assigneeKind!==undefined){if(!['self','contact','unknown'].includes(patch.assigneeKind))throw Error('Проверьте исполнителя');t.assigneeKind=patch.assigneeKind;if(patch.assigneeKind==='self')t.assigneeText=null;}
    if(patch.assigneeText!==undefined)t.assigneeText=patch.assigneeText===null?null:str(patch.assigneeText,'Ответственный',120);
    if(patch.remindOwner!==undefined){if(typeof patch.remindOwner!=='boolean')throw Error('Некорректный канал');t.remindOwner=patch.remindOwner;}
    if(patch.notifyBoth!==undefined){if(typeof patch.notifyBoth!=='boolean')throw Error('Некорректное правило уведомлений');t.notifyBoth=patch.notifyBoth;}
    if(patch.issuerContactId!==undefined){if(patch.issuerContactId&&!this.state.contacts.some(c=>c.id===patch.issuerContactId))throw Error('Автор поручения не найден');t.issuerContactId=patch.issuerContactId||null;}
    if(metadata.clarificationId)t.clarificationId=metadata.clarificationId;
    t.revision=(t.revision||1)+1;
    // An explicit edit supersedes proposals based on the previous revision.
    for(const c of this.state.taskChanges||[])if(c.taskId===id&&c.status==='pending'){c.status='superseded';c.reason='Поручение изменено вручную';}
    t.reviewPending=false;
    this.state.tasks[index] = t;
    // Unsent reminders become invalid on change, including changes to the recipient.
    for (const j of this.state.outbox) if (j.taskId === id && ['pending','dispatching','blocked'].includes(j.status)) j.status = 'cancelled';
    this.event('task.updated', id); this.save(); return t;
  }
  note(input) { const n = { id: randomUUID(), title: str(input.title || 'Заметка', 'Название', 200), text: str(input.text, 'Текст', 20000), createdAt: new Date().toISOString(), source: String(input.source || 'Текст').slice(0, 100) }; this.state.notes.unshift(n); this.event('note.created', n.id); this.save(); return n; }
  deleteNote(id) { this.state.notes = this.state.notes.filter(x => x.id !== id); this.event('note.deleted', id); this.save(); }
  contact(input) { const c = { id: randomUUID(), name: str(input.name, 'Имя', 120), role: String(input.role || 'Команда').slice(0, 120) }; this.state.contacts.push(c); this.event('contact.created', c.id); this.save(); return c; }
  tick(now = Date.now(),available=['local']) {
    let changed=false;
    const closest=t=>(t.reminderMinutes||[]).filter(m=>t.dueAt&&now>=Date.parse(t.dueAt)-m*60000).sort((a,b)=>a-b)[0];
    for(const j of this.state.outbox){
      if(!['pending','dispatching','blocked'].includes(j.status))continue;
      const t=this.state.tasks.find(t=>t.id===j.taskId);
      const eventNotice=['reply','decision','overdue'].includes(j.kind);
      if(j.channel==='whatsapp-goldcard'&&(!t||!notifications.targets(t,this.state.contacts).some(r=>r.channel===j.channel&&r.botRuleId===j.botRuleId&&r.recipientId===j.recipientId))){j.status='cancelled';j.reason='Правило WhatsApp выключено или получатель изменился';changed=true;continue;}
      const invalid=eventNotice?(!t||(j.expiresAt&&Date.parse(j.expiresAt)<=now)||(j.taskRevision&&j.taskRevision!==(t.revision||1))||(j.kind!=='decision'&&t.status!=='open')):(!t||t.status!=='open'||t.reviewPending||(j.taskRevision&&j.taskRevision!==(t.revision||1))||(t.dueAt&&Date.parse(t.dueAt)<=now)||(j.kind!=='assignment'&&(!t.dueAt||closest(t)!==j.minutes)));
      if(invalid){j.status='expired';j.reason='Поручение или срок напоминания изменились';changed=true;}
      else if(j.status==='dispatching'&&j.leaseUntil<=now){j.status='unknown';j.reason='Нет подтверждения результата. Нужна сверка; автоматический повтор остановлен.';changed=true;}
    }
    const add=(t,target,kind,minutes,key,coveredMinutes)=>{
      if(this.state.outbox.some(x=>x.key===key&&!['cancelled','expired'].includes(x.status)))return;
      this.state.outbox.unshift({id:randomUUID(),key,taskId:t.id,taskRevision:t.revision||1,...target,kind,title:t.title,body:notifications.message(t,this.state.contacts,{kind,minutes,audience:target.audience}),minutes,coveredMinutes,status:'pending',createdAt:new Date(now).toISOString(),expiresAt:t.dueAt});changed=true;
    };
    for(const t of this.state.tasks){
      if(t.status!=='open'||t.reviewPending)continue;
      if(t.dueAt&&Date.parse(t.dueAt)<=now){
        if(t.progress?.recordedAt&&Date.parse(t.progress.recordedAt)>=Date.parse(t.dueAt))continue;
        // One neutral check-in per agreed deadline. Never infer a cause or resend old predeadline reminders.
        if(t.notifyBoth)for(const target of notifications.targets(t,this.state.contacts)){
          const key=`${t.id}:overdue:${t.dueAt}:${target.recipientId||target.recipientName}:${target.channel}`;
          if(this.state.outbox.some(j=>j.key===key))continue;
          this.state.outbox.unshift({id:randomUUID(),key,taskId:t.id,taskRevision:t.revision||1,...target,kind:'overdue',title:t.title,body:notifications.message(t,this.state.contacts,{kind:'overdue',audience:target.audience}),status:'pending',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+86400000).toISOString()});changed=true;
        }
        continue;
      }
      const minutes=closest(t);
      for(const target of notifications.targets(t,this.state.contacts)){
        const who=target.recipientId||target.recipientName;
        const noticeKey=`${t.id}:assignment:${notifications.fingerprint(t)}:${who}:${target.channel}`;
        if(t.notifyBoth){
          const decision=this.state.outbox.find(j=>j.taskId===t.id&&j.kind==='decision'&&j.coversAssignment===notifications.fingerprint(t)&&(j.recipientId||j.recipientName)===who&&j.channel===target.channel&&!['cancelled','expired'].includes(j.status));
          if(!decision)add(t,target,'assignment',null,noticeKey,minutes);
          if(decision&&decision.coveredMinutes===minutes)continue;
          // The assignment already carries the deadline; don't send a duplicate reminder in the same window.
          if(this.state.outbox.some(j=>j.key===noticeKey&&j.coveredMinutes===minutes&&!['cancelled','expired'].includes(j.status)))continue;
        }
        if(minutes===undefined)continue;
        const key=t.notifyBoth?`${t.id}:${t.dueAt}:${who}:${minutes}:${target.channel}`:`${t.id}:${t.dueAt}:${t.contactId||'self'}:${minutes}:${target.channel}`;
        add(t,target,'reminder',minutes,key);
      }
    }
    const claimed=[];
    for(const j of this.state.outbox){if(!['pending','blocked'].includes(j.status))continue;if(j.channel==='whatsapp-goldcard'&&this.state.outbox.some(x=>x.id!==j.id&&x.taskId===j.taskId&&x.recipientId===j.recipientId&&x.channel===j.channel&&x.status==='unknown')){const reason='Предыдущая отправка не подтверждена. Сначала нужна сверка.';if(j.status!=='blocked'||j.reason!==reason){j.status='blocked';j.reason=reason;changed=true;}continue;}if(!available.includes(j.channel)){if(j.status!=='blocked'){j.status='blocked';j.reason='Канал получателя не настроен или не проверен. Отправки нет.';changed=true;}continue;}j.status='dispatching';j.claimId=randomUUID();j.leaseUntil=now+90000;claimed.push(structuredClone(j));changed=true;}
    if(changed)this.save();return claimed;
  }
  delivered(id,claimId) { const j = this.state.outbox.find(x => x.id === id); if (j&&['dispatching','unknown'].includes(j.status)&&(!claimId||j.claimId===claimId)) { j.status = 'shown'; j.shownAt = new Date().toISOString(); this.save(); } }
  deliveryFailed(id,claimId,message){const j=this.state.outbox.find(x=>x.id===id&&x.claimId===claimId&&x.status==='dispatching');if(j){j.status='failed';j.reason=String(message).slice(0,300);this.save();}}
  resolveLocal(id,retry){const j=this.state.outbox.find(x=>x.id===id&&x.channel==='local'&&['unknown','failed'].includes(x.status));if(!j)throw Error('Это уведомление нельзя повторить вручную');j.status=retry?'pending':'shown';j.reason=retry?'Повтор после проверки владельцем':'Владелец подтвердил показ';this.event('notification.reviewed',id,{retry:!!retry});this.save();}
  conversationContext(sourceId){
    if(typeof sourceId!=='string'||!sourceId)return [];
    const legacyIds=new Set(this.state.tasks.filter(t=>t.voiceSourceId===sourceId).map(t=>t.noteId));
    return this.state.notes.filter(n=>n.voiceSourceId===sourceId||legacyIds.has(n.id)).slice(0,4).reverse().map(n=>({summary:n.text.slice(0,2000),at:n.createdAt}));
  }
  context(sourceId){if(typeof sourceId!=='string'||!sourceId)return [];return this.state.tasks.filter(t=>t.voiceSourceId===sourceId&&!t.projectId&&['draft','open'].includes(t.status)).slice(0,50).map(t=>({id:t.id,revision:t.revision||1,title:t.title,status:t.status,dueAt:t.dueAt,assignee:this.state.contacts.find(c=>c.id===t.contactId)?.name||t.assigneeText||null}));}
  reviewChange(id,accept){const c=(this.state.taskChanges||[]).find(c=>c.id===id&&c.status==='pending');if(!c)throw Error('Изменение уже обработано');const t=this.state.tasks.find(t=>t.id===c.taskId);if(!t||(t.revision||1)!==c.revision)throw Error('Поручение изменено после предложения. Сначала повторите разбор.');if(accept)Object.assign(t,c.patch,{revision:(t.revision||1)+1});for(const x of this.state.taskChanges)if(x.taskId===t.id&&x.status==='pending')x.status=x.id===id?(accept?'accepted':'rejected'):'superseded';t.reviewPending=false;this.event('task.change-reviewed',t.id,{accepted:!!accept,changeId:id});this.save();return t;}
}
module.exports = { Store, empty };
