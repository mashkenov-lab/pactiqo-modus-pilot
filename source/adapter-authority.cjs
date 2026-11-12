'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomBytes, randomUUID, timingSafeEqual} = require('node:crypto');
const {payloadHash} = require('./vendor/adapter-platform/grant-hash.cjs');
const SPACE = 'modus-platform';
const ADMIN_ACTIONS = new Set(['binding_prepare', 'binding_proof', 'binding_confirm', 'binding_revoke', 'mail_import']);
const CASE_ACTIONS = new Set(['case_link', 'case_state', 'notify']);
const INTAKE_ACTIONS = new Set(['ack','reply']);
const reject = () => { throw Object.assign(new Error('Доступ к операции запрещён'), {status:403}); };
class AdapterAuthority {
  constructor({store, dir, now = Date.now}) {
    if (!path.isAbsolute(dir)) throw new Error('Нужна абсолютная папка');
    Object.assign(this, {store, dir, now});
    fs.mkdirSync(dir, {recursive:true});
    const file = path.join(dir, 'adapter-authority-private.json');
    if (!fs.existsSync(file)) {
      try { fs.writeFileSync(file, JSON.stringify({secret:randomBytes(32).toString('hex'),instanceId:randomUUID()}), {flag:'wx',mode:0o600}); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    const privateData = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(privateData.secret) || !/^[a-zA-Z0-9_-]{1,100}$/.test(privateData.instanceId)) throw new Error('Повреждён закрытый файл authority');
    this.secret = privateData.secret;
    this.instanceId = privateData.instanceId;
    if (!store.suite.adapterAuthority) store.atomic(() => { store.suite.adapterAuthority = {grants:{},bindings:{}}; });
  }
  get state() { return this.store.suite.adapterAuthority; }
  async configure(adapter, port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Некорректный порт');
    return adapter.configureAuthority({space:SPACE,verifierUrl:`http://127.0.0.1:${port}/internal/adapter/verify`,verifierToken:this.secret,instanceId:this.instanceId});
  }
  // Only a server-side status response from Adapter may update this cache.
  updateBindings(status) {
    if (!Array.isArray(status?.bindings)) throw new Error('Некорректное состояние привязок');
    const bindings = {};
    for (const b of status.bindings) {
      if (typeof b.bindingId !== 'string' || typeof b.employeeId !== 'string' || typeof b.channelId !== 'string' || typeof b.enabled !== 'boolean') throw new Error('Некорректная привязка');
      bindings[b.bindingId] = {bindingId:b.bindingId,employeeId:b.employeeId,channelId:b.channelId,enabled:b.enabled,revision:Number.isSafeInteger(b.revision)?b.revision:0};
    }
    this.store.atomic(() => { this.state.bindings = bindings; });
    return structuredClone(bindings);
  }
  current(grant) {
    const actor = this.store.person(grant.actorId);
    if (actor.revision !== grant.actorRevision || actor.role !== grant.actorRole || !!actor.admin !== grant.actorAdmin) reject();
    if (ADMIN_ACTIONS.has(grant.action)) { if (!actor.admin) reject(); }
    if (grant.targetId) {const target=this.store.person(grant.targetId);if(target.revision!==grant.targetRevision)reject();}
    if (grant.challengeId) {const challenge=this.store.suite.bindingChallenges?.[grant.challengeId];if(!challenge || challenge.actorId!==actor.id || challenge.employeeId!==grant.targetId || challenge.employeeRevision!==grant.targetRevision || challenge.expiresAt<=this.now() || (grant.proofId && challenge.proof?.proofId!==grant.proofId))reject();}
    if (grant.mailSelectionHash && payloadHash(this.store.suite.adapterMail?.selected || null)!==grant.mailSelectionHash) reject();
    if(INTAKE_ACTIONS.has(grant.action)){const event=this.store.suite.messaging?.events?.[grant.eventId],binding=this.state.bindings[grant.bindingId];if(!event || event.transportVersion!=='v2' || event.employeeId!==actor.id || event.bindingId!==grant.bindingId || !binding?.enabled || binding.employeeId!==actor.id || binding.channelId!==event.channelId || event.conversationId!==event.bindingId || payloadHash(binding)!==grant.bindingHash)reject();if(event.caseId)this.store.get(event.caseId,actor);if(grant.action==='reply'){const out=this.store.suite.messaging?.outbox?.[grant.operationId];if(!out || out.eventId!==event.eventId || out.state!=='sending' || payloadHash({eventId:event.eventId,operationId:out.operationId,text:out.text})!==grant.payloadHash)reject();if(out.caseId)this.store.get(out.caseId,actor);}}
    if (grant.adminBindingId && payloadHash(this.state.bindings[grant.adminBindingId] || null)!==grant.adminBindingHash) reject();
    if (CASE_ACTIONS.has(grant.action)) {
      const item = this.store.get(grant.caseId, actor);
      const task = this.store.state.tasks.find(t => t.id === grant.caseId);
      if (!task || task.revision !== grant.caseRevision || item.authorId !== grant.authorId || item.ownerId !== grant.ownerId) reject();
      if (grant.action === 'case_state') return actor;
      const binding = this.state.bindings[grant.bindingId];
      if (!binding?.enabled || payloadHash(binding) !== grant.bindingHash) reject();
      this.store.person(binding.employeeId);
      if (![item.authorId,item.ownerId].includes(binding.employeeId) && this.store.person(binding.employeeId).role !== 'manager') reject();
      if (grant.action === 'notify') {
        const row = this.store.suite.caseDelivery?.outbox?.[grant.operationId];
        if (!row || !['queued','sending'].includes(row.state) || row.payloadHash !== grant.payloadHash) reject();
        const event = row.eventSource==='assignment' ? this.store.platform.notifications.find(n=>n.id===row.eventId && ['created','assign'].includes(n.action) && n.recipient===binding.employeeId) : this.store.suite.caseWorkspaces?.[grant.caseId]?.events?.find(e => e.id === row.eventId);
        if (!event || (row.eventSource==='assignment'?event.title:event.body) !== row.eventBody || (row.eventSource==='assignment' && item.ownerId!==binding.employeeId)) reject();
        if (row.creatorId) this.store.get(grant.caseId,this.store.person(row.creatorId));
      }
    }
    return actor;
  }
  issue(actor, {action,payload,caseId,bindingId,purpose,grantId,expiresAt} = {}) {
    if (!ADMIN_ACTIONS.has(action) && !CASE_ACTIONS.has(action) && !INTAKE_ACTIONS.has(action)) reject();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) reject();
    const keys={binding_prepare:['employeeId','channelId','operationId'],binding_proof:['challengeId'],binding_confirm:['challengeId','proofId'],binding_revoke:['bindingId','operationId','expectedRevision'],case_state:['caseId'],case_link:['caseId','bindingId','role','expectedRevision'],notify:['caseId','bindingId','operationId','kind','text'],mail_import:['snapshotId','revision','operationId'],ack:['eventId'],reply:['eventId','operationId','text']}[action];
    if (Object.keys(payload).sort().join(',') !== [...keys].sort().join(',')) reject();
    const person = this.store.person(actor?.id);
    const id = grantId || randomUUID();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || this.state.grants[id]) reject();
    const limit = Math.min(expiresAt || this.now()+240000, this.now()+240000);
    if (!Number.isFinite(limit) || limit <= this.now()) reject();
    const row = {space:SPACE,grantId:id,action,payloadHash:payloadHash(payload),expiresAt:limit,instanceId:this.instanceId,actorId:person.id,actorRevision:person.revision,actorRole:person.role,actorAdmin:!!person.admin,purpose:purpose || null};
    if (CASE_ACTIONS.has(action)) {
      if (caseId !== payload.caseId || (action !== 'case_state' && bindingId !== payload.bindingId)) reject();
      const item = this.store.get(caseId, person), task = this.store.state.tasks.find(t=>t.id===caseId), binding = this.state.bindings[bindingId];
      if (!task || (action !== 'case_state' && !binding?.enabled)) reject();
      if (action === 'case_link' && ((payload.role === 'author' && binding.employeeId !== item.authorId) || (payload.role === 'executor' && binding.employeeId !== item.ownerId) || (payload.role === 'curator' && this.store.person(binding.employeeId).role !== 'manager'))) reject();
      Object.assign(row,{caseId,bindingId,bindingHash:binding?payloadHash(binding):null,caseRevision:task.revision,authorId:item.authorId,ownerId:item.ownerId,operationId:payload.operationId || null});
    }
    if(INTAKE_ACTIONS.has(action)){const event=this.store.suite.messaging?.events?.[payload.eventId],binding=event&&this.state.bindings[event.bindingId];if(!event || event.employeeId!==person.id || event.transportVersion!=='v2' || !binding?.enabled || binding.employeeId!==person.id)reject();Object.assign(row,{eventId:event.eventId,bindingId:event.bindingId,bindingHash:payloadHash(binding),operationId:payload.operationId||null});}
    if(action==='binding_prepare'){const target=this.store.person(payload.employeeId);row.targetId=target.id;row.targetRevision=target.revision;}
    if(action==='binding_proof'||action==='binding_confirm'){const challenge=this.store.suite.bindingChallenges?.[payload.challengeId];if(!challenge)reject();const target=this.store.person(challenge.employeeId);if(target.revision!==challenge.employeeRevision)reject();row.targetId=target.id;row.targetRevision=target.revision;row.challengeId=payload.challengeId;row.proofId=payload.proofId||null;}
    if(action==='mail_import'){const selected=this.store.suite.adapterMail?.selected;if(!selected || selected.actorId!==person.id || selected.snapshotId!==payload.snapshotId || selected.revision!==payload.revision)reject();row.mailSelectionHash=payloadHash(selected);}
    if (action==='binding_revoke') {const binding=this.state.bindings[payload.bindingId];const prior=this.store.suite.bindingRevokes?.[payload.operationId];const retry=prior && prior.hash===payloadHash(payload) && binding && !binding.enabled && binding.revision===payload.expectedRevision+1;if(!binding || binding.channelId==='owner-modus' || (!retry && (!binding.enabled || binding.revision!==payload.expectedRevision)))reject();row.adminBindingId=payload.bindingId;row.adminBindingHash=payloadHash(binding);}
    this.current(row);
    this.store.atomic(() => { this.state.grants[id] = row; });
    return {grantId:id,expiresAt:limit};
  }
  verify(bearer, query) {
    const token = typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
    const left = Buffer.from(token), right = Buffer.from(this.secret);
    if (left.length !== right.length || !timingSafeEqual(left,right)) reject();
    if (!query || Object.keys(query).sort().join(',') !== 'action,grantId,payloadHash,space') reject();
    const grant = this.state.grants[query.grantId];
    if (!grant || grant.space !== query.space || grant.action !== query.action || grant.payloadHash !== query.payloadHash || grant.instanceId !== this.instanceId || grant.expiresAt <= this.now() || grant.expiresAt > this.now()+240000) reject();
    this.current(grant);
    const {space,grantId,action,payloadHash:hash,expiresAt,instanceId} = grant;
    return {space,grantId,action,payloadHash:hash,expiresAt,instanceId};
  }
}
class BindingAdmin {
  constructor({store,transport,authority}) {
    Object.assign(this,{store,transport,authority});
    if(!store.suite.bindingChallenges)store.atomic(()=>{store.suite.bindingChallenges={};});
  }
  admin(actor){const p=this.store.person(actor?.id);if(!p.admin)reject();return p;}
  checkChallenge(id,actor,expected){const row=this.store.suite.bindingChallenges[id];if(!row || row.actorId!==actor.id || row.employeeId!==expected.employeeId || row.employeeRevision!==expected.employeeRevision || row.expiresAt<=this.authority.now() || this.store.person(row.employeeId).revision!==row.employeeRevision)reject();return row;}
  async status(actor){this.admin(actor);const status=await this.transport.status();this.admin(actor);this.authority.updateBindings(status);return status;}
  async prepare(actor,{employeeId,channelId}){
    const p=this.admin(actor), target=this.store.person(employeeId);
    const payload={employeeId,channelId,operationId:randomUUID()};
    const grant=this.authority.issue(p,{action:'binding_prepare',payload});
    const result=await this.transport.prepareBinding({...payload,grantId:grant.grantId});
    this.admin(p);if(this.store.person(employeeId).revision!==target.revision)reject();
    if(!result.challengeId || !result.expiresAt)throw Error('Challenge не получен');
    this.store.atomic(()=>{this.store.suite.bindingChallenges[result.challengeId]={...payload,...result,actorId:p.id,employeeRevision:target.revision,proof:null};});
    return result;
  }
  async proof(actor,{challengeId}){
    const p=this.admin(actor),challenge=this.store.suite.bindingChallenges[challengeId];
    if(!challenge || challenge.actorId!==p.id || challenge.expiresAt<=Date.now())reject();
    const payload={challengeId},grant=this.authority.issue(p,{action:'binding_proof',payload});
    const result=await this.transport.bindingProof({...payload,grantId:grant.grantId});
    this.admin(p);this.checkChallenge(challengeId,p,challenge);
    if(result.channelId!==challenge.channelId || result.verifiedEmployee!==false || !result.proofId)throw Error('Provider proof не подтверждён');
    this.store.atomic(()=>{const row=this.store.suite.bindingChallenges[challengeId];if(!row||row.actorId!==p.id)reject();row.proof=structuredClone(result);});
    return result;
  }
  async confirm(actor,{challengeId,proofId}){
    const p=this.admin(actor),challenge=this.store.suite.bindingChallenges[challengeId];
    if(!challenge || challenge.actorId!==p.id || challenge.proof?.proofId!==proofId || challenge.proof.expiresAt<=Date.now())reject();
    this.checkChallenge(challengeId,p,challenge);
    const payload={challengeId,proofId},grant=this.authority.issue(p,{action:'binding_confirm',payload});
    const result=await this.transport.confirmBinding({...payload,grantId:grant.grantId});
    this.admin(p);this.checkChallenge(challengeId,p,challenge);await this.status(p);this.checkChallenge(challengeId,p,challenge);return result;
  }
  async revoke(actor,{bindingId,operationId,expectedRevision}){
    const p=this.admin(actor);await this.status(p);
    const payload={bindingId,operationId,expectedRevision};
    const previous=this.store.suite.bindingRevokes?.[operationId];if(previous && previous.hash!==payloadHash(payload))reject();
    const binding=this.authority.state.bindings[bindingId];if(!previous && (!binding?.enabled || binding.revision!==expectedRevision || binding.channelId==='owner-modus'))reject();
    this.store.atomic(()=>{this.store.suite.bindingRevokes||={};this.store.suite.bindingRevokes[operationId]||={hash:payloadHash(payload)};});
    const grant=this.authority.issue(p,{action:'binding_revoke',payload});
    const result=await this.transport.revokeBinding({...payload,grantId:grant.grantId});
    this.admin(p);await this.status(p);return result;
  }
}
class CaseLinks {
  constructor({store,transport,authority}){Object.assign(this,{store,transport,authority});}
  async ensure(caseId,binding,recipientId){
    let actor=this.store.person(recipientId),item=this.store.get(caseId,actor);
    let payload={caseId},grant=this.authority.issue(actor,{action:'case_state',payload,caseId});
    const state=await this.transport.caseState({...payload,grantId:grant.grantId});
    actor=this.store.person(recipientId);item=this.store.get(caseId,actor);
    const role=recipientId===item.authorId?'author':recipientId===item.ownerId?'executor':actor.role==='manager'?'curator':null;
    if(!role)reject();
    if(state.members.some(x=>x.bindingId===binding.bindingId&&x.role===role))return state;
    payload={caseId,bindingId:binding.bindingId,role,expectedRevision:state.revision};
    grant=this.authority.issue(actor,{action:'case_link',payload,caseId,bindingId:binding.bindingId});
    return this.transport.linkCase({...payload,grantId:grant.grantId});
  }
}
class CombinedMessengerTransport {
  constructor({store,legacy,v2,authority}){Object.assign(this,{store,legacy,v2,authority});this.v2Ready=false;}
  async status(){
    const old=await this.legacy.status();
    try{
      const status=await this.v2.status();this.authority.updateBindings(status);this.v2Ready=true;
      const corporate=status.bindings.filter(b=>b.channelId!=='owner-modus').map(b=>({...b,conversationId:b.bindingId}));
      return {...old,bindings:[...(old.bindings||[]).filter(b=>b.channelId==='owner-modus'),...corporate],v2Capabilities:status.capabilities,v2Available:true};
    }catch{this.v2Ready=false;return {...old,bindings:(old.bindings||[]).filter(b=>b.channelId==='owner-modus'),v2Available:false};}
  }
  async poll(params){
    if(this.v2Ready){
      try{const result=await this.v2.poll(params);return {events:(result.events||[]).map(e=>e.channelId==='owner-modus'?Object.fromEntries(Object.entries(e).filter(([k])=>!['bindingId','untrusted'].includes(k))):{...e,transportVersion:'v2'})};}catch{this.v2Ready=false;}
    }
    const result=await this.legacy.poll(params);return {events:(result.events||[]).filter(e=>e.channelId==='owner-modus')};
  }
  async ack({eventId}){
    const event=this.store.suite.messaging?.events?.[eventId];if(!event)throw Error('Событие не сохранено');
    if(event.transportVersion!=='v2')return this.legacy.ack({eventId});
    const payload={eventId},actor=this.store.person(event.employeeId),grant=this.authority.issue(actor,{action:'ack',payload});
    return this.v2.ack({...payload,grantId:grant.grantId});
  }
  async reply({eventId,operationId,text}){
    const event=this.store.suite.messaging?.events?.[eventId];if(!event)throw Error('Событие не сохранено');
    if(event.transportVersion!=='v2')return this.legacy.reply({eventId,operationId,text});
    const payload={eventId,operationId,text},actor=this.store.person(event.employeeId),grant=this.authority.issue(actor,{action:'reply',payload});
    return this.v2.reply({...payload,grantId:grant.grantId});
  }
  async receipt({operationId}){
    const row=this.store.suite.messaging?.outbox?.[operationId],event=row&&this.store.suite.messaging?.events?.[row.eventId];
    if(!event)throw Error('Операция не найдена');
    if(event.transportVersion!=='v2')return this.legacy.receipt({operationId});
    const receipt=await this.v2.receipt({operationId});if(receipt.eventId!==event.eventId)throw Error('Квитанция не соответствует событию');return receipt;
  }
}
module.exports = {AdapterAuthority,BindingAdmin,CaseLinks,CombinedMessengerTransport};
