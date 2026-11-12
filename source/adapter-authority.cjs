'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomBytes, randomUUID, timingSafeEqual} = require('node:crypto');
const {payloadHash} = require('./vendor/adapter-platform/grant-hash.cjs');
const SPACE = 'modus-platform';
const ADMIN_ACTIONS = new Set(['binding_prepare', 'binding_proof', 'binding_confirm', 'binding_revoke', 'mail_import']);
const CASE_ACTIONS = new Set(['case_link', 'case_state', 'notify']);
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
    if (grant.challengeId) {const challenge=this.store.suite.bindingChallenges?.[grant.challengeId];if(!challenge || challenge.actorId!==actor.id || challenge.expiresAt<=this.now() || (grant.proofId && challenge.proof?.proofId!==grant.proofId))reject();}
    if (grant.mailSelectionHash && payloadHash(this.store.suite.adapterMail?.selected || null)!==grant.mailSelectionHash) reject();
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
        const event = row.eventSource==='assignment' ? this.store.platform.notifications.find(n=>n.id===row.eventId && n.action==='assigned' && n.recipient===binding.employeeId) : this.store.suite.caseWorkspaces?.[grant.caseId]?.events?.find(e => e.id === row.eventId);
        if (!event || (row.eventSource==='assignment'?event.title:event.body) !== row.eventBody || (row.eventSource==='assignment' && item.ownerId!==binding.employeeId)) reject();
        if (row.creatorId) this.store.get(grant.caseId,this.store.person(row.creatorId));
      }
    }
    return actor;
  }
  issue(actor, {action,payload,caseId,bindingId,purpose,grantId,expiresAt} = {}) {
    if (!ADMIN_ACTIONS.has(action) && !CASE_ACTIONS.has(action)) reject();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) reject();
    const keys={binding_prepare:['employeeId','channelId','operationId'],binding_proof:['challengeId'],binding_confirm:['challengeId','proofId'],binding_revoke:['bindingId','operationId','expectedRevision'],case_state:['caseId'],case_link:['caseId','bindingId','role','expectedRevision'],notify:['caseId','bindingId','operationId','kind','text'],mail_import:['snapshotId','revision','operationId']}[action];
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
    if(action==='binding_prepare'){const target=this.store.person(payload.employeeId);row.targetId=target.id;row.targetRevision=target.revision;}
    if(action==='binding_proof'||action==='binding_confirm'){row.challengeId=payload.challengeId;row.proofId=payload.proofId||null;}
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
  async status(actor){this.admin(actor);const status=await this.transport.status();this.admin(actor);this.authority.updateBindings(status);return status;}
  async prepare(actor,{employeeId,channelId}){
    const p=this.admin(actor);this.store.person(employeeId);
    const payload={employeeId,channelId,operationId:randomUUID()};
    const grant=this.authority.issue(p,{action:'binding_prepare',payload});
    const result=await this.transport.prepareBinding({...payload,grantId:grant.grantId});
    this.admin(p);this.store.person(employeeId);
    if(!result.challengeId || !result.expiresAt)throw Error('Challenge не получен');
    this.store.atomic(()=>{this.store.suite.bindingChallenges[result.challengeId]={...payload,...result,actorId:p.id,proof:null};});
    return result;
  }
  async proof(actor,{challengeId}){
    const p=this.admin(actor),challenge=this.store.suite.bindingChallenges[challengeId];
    if(!challenge || challenge.actorId!==p.id || challenge.expiresAt<=Date.now())reject();
    const payload={challengeId},grant=this.authority.issue(p,{action:'binding_proof',payload});
    const result=await this.transport.bindingProof({...payload,grantId:grant.grantId});
    this.admin(p);
    if(result.channelId!==challenge.channelId || result.verifiedEmployee!==false || !result.proofId)throw Error('Provider proof не подтверждён');
    this.store.atomic(()=>{const row=this.store.suite.bindingChallenges[challengeId];if(!row||row.actorId!==p.id)reject();row.proof=structuredClone(result);});
    return result;
  }
  async confirm(actor,{challengeId,proofId}){
    const p=this.admin(actor),challenge=this.store.suite.bindingChallenges[challengeId];
    if(!challenge || challenge.actorId!==p.id || challenge.proof?.proofId!==proofId || challenge.proof.expiresAt<=Date.now())reject();
    this.store.person(challenge.employeeId);
    const payload={challengeId,proofId},grant=this.authority.issue(p,{action:'binding_confirm',payload});
    const result=await this.transport.confirmBinding({...payload,grantId:grant.grantId});
    this.admin(p);await this.status(p);return result;
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
module.exports = {AdapterAuthority,BindingAdmin,CaseLinks};
