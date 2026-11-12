'use strict';

const {randomUUID, createHash} = require('node:crypto');
const {casePrompt, validateCaseAdvice, formatAdvice} = require('./case-assistant.cjs');
const activeStores = new WeakSet();
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const clean = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('Некорректный текст');
  return value.trim();
};
function validDate(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return false;
  const [,year,month,day,hour,minute,second,zone] = m;
  const days = new Date(Date.UTC(Number(year),Number(month),0)).getUTCDate();
  const offset = zone === 'Z' ? [0,0] : zone.slice(1).split(':').map(Number);
  return Number(month)>=1 && Number(month)<=12 && Number(day)>=1 && Number(day)<=days && Number(hour)<=23 && Number(minute)<=59 && Number(second)<=59 && offset[0]<=23 && offset[1]<=59 && Number.isFinite(Date.parse(value));
}
function caseInfo(store, actor, caseId) {
  const person = store.person(actor?.id);
  const item = store.get(caseId, person);
  if (item.phase === 'draft') fail('Обсуждение доступно после регистрации', 404);
  const task = store.state.tasks.find(t => t.id === caseId);
  return {person, item, task};
}
function members(store, item) {
  return [...new Set([item.authorId, item.ownerId].filter(Boolean))].map(id => {
    const p = store.people[id];
    return p ? {id:p.id, name:p.name, role:p.role, active:p.active, revision:p.revision} : {id, active:false};
  });
}
function fingerprint(store, info, room) {
  return hash({caseRevision:info.task.revision, roomRevision:room.revision, members:members(store,info.item), actor:{id:info.person.id,role:info.person.role,revision:info.person.revision}, documents:store.responsibilityContext(info.person,info.item.department), availability:store.platform.availability[info.item.ownerId]});
}
function buildCaseContext(store, actor, caseId, room) {
  const {person, item, task} = caseInfo(store, actor, caseId);
  const docs = store.responsibilityContext(person,item.department);
  const history = room.messages.slice(-20).map(m => ({role:m.role,body:m.body,authorId:m.authorId,createdAt:m.createdAt}));
  return {
    case:{id:caseId,number:item.number,title:task.title,description:item.description,department:item.department,category:item.category,phase:item.phase,ownerId:item.ownerId,authorId:item.authorId,result:clone(item.resolution),dueAt:task.dueAt},
    actor:{id:person.id,role:person.role}, participants:members(store,item),
    route:{routing:clone(item.routing || null),availability:item.ownerId ? store.platform.availability[item.ownerId] !== false : false},
    plan:clone(room.plan), messages:history, historyPartial:room.messages.length>history.length,
    documents:clone(docs.documents), contextPartial:!!docs.truncated, documentNotice:docs.notice
  };
}
class CaseWorkspace {
  constructor({store, analysis, now = () => Date.now()}) {
    this.store = store; this.analysis = analysis; this.now = now; this.processing = false; this.timer = null;
    if (!store.suite.caseWorkspaces || !store.suite.caseAdviceJobs) {
      store.atomic(() => { store.suite.caseWorkspaces ||= {}; store.suite.caseAdviceJobs ||= {}; });
    }
  }
  stamp() { return new Date(this.now()).toISOString(); }
  empty(caseId) { return {caseId,revision:0,messages:[],events:[],plan:null,keys:{},adviceKeys:{},latestJobId:null}; }
  room(caseId) { return this.store.suite.caseWorkspaces[caseId] || this.empty(caseId); }
  ensure(caseId) { return this.store.suite.caseWorkspaces[caseId] ||= this.empty(caseId); }
  check(room, revision) { if (revision !== room.revision) fail('Обсуждение изменилось',409); }
  snapshot(actor, caseId) {
    const info = caseInfo(this.store,actor,caseId), room = this.room(caseId);
    return {caseId,number:info.item.number,title:info.task.title,phase:info.item.phase,caseRevision:info.task.revision,participants:members(this.store,info.item),revision:room.revision,messages:clone(room.messages.slice(-200)),historyPartial:room.messages.length>200,plan:clone(room.plan),ai:clone(this.store.suite.caseAdviceJobs[room.latestJobId] || null)};
  }
  post(actor, input, trusted = {}) {
    const info=caseInfo(this.store,actor,input.caseId), room=this.room(input.caseId);
    const body=clean(input.body,4000), key=clean(input.key,120), k=info.person.id+':'+key;
    const source=trusted.source || 'web';
    if (!['web','whatsapp','telegram','max','mail'].includes(source)) fail('Неизвестный канал');
    const known=room.keys[k];
    if (known) { if (known.body !== body || known.source !== source) fail('Ключ уже использован',409); return clone(room.messages.find(m=>m.id===known.id)); }
    this.check(room,input.expectedRevision);
    if (room.messages.length>=5000) fail('Достигнут предел сообщений',409);
    return this.store.atomic(()=>{
      const target=this.ensure(input.caseId), revision=++target.revision;
      const message={id:randomUUID(),caseId:input.caseId,role:'human',authorId:info.person.id,authorName:info.person.name,source,body,createdAt:this.stamp(),visibility:'case-participants',revision};
      target.messages.push(message); target.keys[k]={id:message.id,body,source};
      target.events.push({id:randomUUID(),type:'shared_message',caseId:input.caseId,creatorId:info.person.id,revision,body});
      return clone(message);
    });
  }
  savePlan(actor,input) {
    const info=caseInfo(this.store,actor,input.caseId), room=this.room(input.caseId);
    if (info.person.id!==info.item.ownerId && info.person.role!=='manager' && !info.person.admin) fail('План утверждает исполнитель или руководитель',403);
    const body=clean(input.body,4000);
    if (!validDate(input.dueAt)) fail('Укажите срок с часовым поясом');
    this.check(room,input.expectedRevision);
    return this.store.atomic(()=>{
      const target=this.ensure(input.caseId), revision=++target.revision;
      target.plan={body,dueAt:new Date(input.dueAt).toISOString(),approvedBy:info.person.id,approvedAt:this.stamp(),revision};
      target.events.push({id:randomUUID(),type:'plan_updated',caseId:input.caseId,creatorId:info.person.id,revision,body});
      return clone(target.plan);
    });
  }
  requestAdvice(actor,input) {
    const info=caseInfo(this.store,actor,input.caseId), room=this.room(input.caseId), key=clean(input.key,120), k=info.person.id+':'+key;
    const known=room.adviceKeys[k]; if (known) return clone(this.store.suite.caseAdviceJobs[known]);
    this.check(room,input.expectedRevision);
    const existing=this.store.suite.caseAdviceJobs[room.latestJobId];
    if (existing && ['queued','submitting','pending'].includes(existing.status)) fail('Совет уже запрошен',409);
    return this.store.atomic(()=>{
      const target=this.ensure(input.caseId), requestId=randomUUID();
      const order=(this.store.suite.caseAdviceSequence || 0)+1;
      this.store.suite.caseAdviceSequence=order;
      const job={requestId,caseId:input.caseId,actorId:info.person.id,key,status:'queued',createdAt:this.stamp(),caseRevision:info.task.revision,roomRevision:target.revision,members:members(this.store,info.item),fingerprint:fingerprint(this.store,info,target),error:null,result:null,queueOrder:order};
      this.store.suite.caseAdviceJobs[requestId]=job; target.adviceKeys[k]=requestId; target.latestJobId=requestId;
      return clone(job);
    });
  }
  async processPending() {
    if (this.processing || activeStores.has(this.store)) return;
    this.processing=true;
    activeStores.add(this.store);
    try {
      const selected=Object.values(this.store.suite.caseAdviceJobs)
        .filter(job=>['queued','submitting','pending'].includes(job.status))
        .sort((a,b)=>(a.queueOrder || 0)-(b.queueOrder || 0))[0];
      if (!selected) return;
      const requestId=selected.requestId;
      const expectedFingerprint=selected.fingerprint;
      const current=()=>this.store.suite.caseAdviceJobs[requestId];
      const stale=job=>{
        try {
          const info=caseInfo(this.store,{id:job.actorId},job.caseId);
          return fingerprint(this.store,info,this.room(job.caseId))!==job.fingerprint;
        } catch { return true; }
      };
      // All mutations resolve the job in current state. Another store transaction can
      // roll back and replace the whole state while the provider promise is pending.
      const transition=(expectedStatus,status,error=null)=>this.store.atomic(()=>{
        const job=current();
        if (!job || job.status!==expectedStatus || job.fingerprint!==expectedFingerprint) return false;
        job.status=status; job.error=error; job.updatedAt=this.stamp();
        return true;
      });
      if (stale(selected)) {transition(selected.status,'stale','Контекст изменился');return;}
      if (!this.analysis) {transition(selected.status,'error','Анализатор недоступен');return;}
      const first=selected.status==='queued';
      const method=first?'analyze':'recover';
      let expectedStatus=selected.status;
      try {
        const context=buildCaseContext(this.store,{id:selected.actorId},selected.caseId,this.room(selected.caseId));
        const bounded=casePrompt(context).context;
        if (typeof this.analysis[method]!=='function') throw new Error('Получение состояния анализатора недоступно');
        const started=this.store.atomic(()=>{
          const job=current();
          if (!job || job.status!==expectedStatus || job.fingerprint!==expectedFingerprint) return null;
          if (stale(job)) {job.status='stale';job.error='Контекст изменился';job.updatedAt=this.stamp();return null;}
          const sequence=(this.store.suite.caseAdviceSequence || 0)+1;
          this.store.suite.caseAdviceSequence=sequence;
          job.queueOrder=sequence;
          if (first) job.status='submitting';
          job.updatedAt=this.stamp();
          return job;
        });
        if (!started) return;
        expectedStatus=started.status;
        const result=await this.analysis[method](started,clone(bounded));
        const validated=validateCaseAdvice(result,bounded);
        this.store.atomic(()=>{
          const job=current();
          if (!job || job.status!==expectedStatus || job.fingerprint!==expectedFingerprint) return;
          if (stale(job)) {job.status='stale';job.error='Контекст изменился';job.updatedAt=this.stamp();return;}
          const room=this.room(job.caseId);
          if (room.messages.length>=5000) throw new Error('Достигнут предел сообщений');
          const revision=++room.revision;
          const message={id:randomUUID(),caseId:job.caseId,role:'assistant',authorId:null,body:validated.reply,createdAt:this.stamp(),visibility:'case-participants',revision,requestId:job.requestId};
          room.messages.push(message);
          room.events.push({id:randomUUID(),type:'assistant_reply',caseId:job.caseId,creatorId:null,revision,requestId:job.requestId,body:formatAdvice(validated)});
          job.status='ready'; job.result=validated; job.updatedAt=this.stamp(); job.error=null;
        });
      } catch (error) {
        this.store.atomic(()=>{
          const job=current();
          if (!job || job.status!==expectedStatus || job.fingerprint!==expectedFingerprint) return;
          if (stale(job)) {job.status='stale';job.error='Контекст изменился';}
          else if (error.pending) {job.status='pending';job.error=String(error.message||'Ожидается ответ').slice(0,500);}
          else {job.status='error';job.error=String(error.message||error).slice(0,500);}
          job.updatedAt=this.stamp();
        });
      }
    } finally {
      this.processing=false;
      activeStores.delete(this.store);
    }
  }
  tick() { return this.processPending(); }
  start() { if (!this.timer) {this.timer=setInterval(()=>this.tick().catch(()=>{}),2500);this.timer.unref();} }
  stop() { if (this.timer) clearInterval(this.timer); this.timer=null; }
}
module.exports = {CaseWorkspace,buildCaseContext};
