'use strict';
const {randomUUID} = require('node:crypto');
class AdapterMail {
  constructor({store, transport, authority}) {
    Object.assign(this,{store,transport,authority});
    if (!store.suite.adapterMail) store.atomic(()=>{store.suite.adapterMail={selected:null,imports:{},operations:{}};});
    store.atomic(()=>{for(const o of Object.values(this.state.operations))if(o.state==='sending')o.state='unknown';});
  }
  get state(){return this.store.suite.adapterMail;}
  admin(actor){const p=this.store.person(actor?.id);if(!p.admin)throw Object.assign(Error('Доступно администратору'),{status:403});return p;}
  async connections(actor){const p=this.admin(actor);const rows=await this.transport.mailConnections();this.admin({id:p.id});return rows;}
  async candidates(actor,{connection}){
    const p=this.admin(actor), result=await this.transport.mailControl('adapter_gmail_candidates',{connection});
    this.admin({id:p.id});return result;
  }
  beginSelection(actorId) {
    return this.store.atomic(()=>{
      this.state.selectionGeneration=(this.state.selectionGeneration||0)+1;
      this.state.preview=null;
      this.state.selected=null;
      this.state.selectionActorId=actorId;
      return this.state.selectionGeneration;
    });
  }
  invalidateSelection(actor) {
    if(actor?.id&&(this.state.selectionActorId===actor.id||this.state.selected?.actorId===actor.id||this.state.preview?.actorId===actor.id))this.beginSelection(null);
  }
  checkGeneration(generation) {
    if(this.state.selectionGeneration!==generation)throw Object.assign(Error('Выбор письма изменился'),{status:409});
  }
  async select(actor,input){
    const p=this.admin(actor),generation=this.beginSelection(p.id);
    const {connection,rowId,subject,sender,revision}=input;
    const result=await this.transport.mailControl('adapter_gmail_select',{connection,rowId,subject,sender,revision});
    this.admin({id:p.id});this.checkGeneration(generation);
    if(!result||['snapshotId','hash','revision'].some(k=>typeof result[k]!=='string'||!result[k]||result[k].length>512))throw Error('Снимок письма не получен');
    return this.store.atomic(()=>{this.checkGeneration(generation);this.state.selected={snapshotId:result.snapshotId,hash:result.hash,revision:result.revision,actorId:p.id};return structuredClone(this.state.selected);});
  }
  async preview(actor,{connection,subject,sender}) {
    const p=this.admin(actor);
    if(typeof connection!=='string'||!connection||connection.length>100||typeof subject!=='string'||!subject.trim()||subject.length>500||typeof sender!=='string'||!sender.includes('@')||sender.length>320)throw Object.assign(Error('Укажите подключение, тему и отправителя'),{status:400});
    const generation=this.beginSelection(p.id);
    const result=await this.transport.mailControl('adapter_mail_snapshot_preview',{connection,subject,sender});
    this.admin({id:p.id});this.checkGeneration(generation);
    const fields=['messageId','sender','subject','accountUrl','revision'];
    if(!result||fields.some(k=>typeof result[k]!=='string'||!result[k])||result.messageId.length>200||result.subject!==subject||result.sender!==sender||!/^[a-f0-9]{64}$/.test(result.revision)||result.partial!==true||result.untrusted!==true||Object.hasOwn(result,'body')||result.accountUrl.length>2048)throw Error('Метаданные письма не подтверждены');
    let url;try{url=new URL(result.accountUrl);}catch{throw Error('Адрес почты не подтверждён');}
    if(url.origin!=='https://mail.google.com'||!/^\/mail\/u\/\d+\/$/.test(url.pathname)||url.username||url.password)throw Error('Адрес почты не подтверждён');
    const identity=Object.fromEntries(fields.map(k=>[k,result[k]]));
    return this.store.atomic(()=>{this.checkGeneration(generation);this.state.preview={connection,identity,actorId:p.id,generation,inFlight:false};return {connection,identity:structuredClone(identity),partial:true,untrusted:true};});
  }
  async stage(actor,{connection,expectedIdentity}={}) {
    const p=this.admin(actor),fields=['messageId','sender','subject','accountUrl','revision'],preview=this.state.preview;
    if(!preview||preview.actorId!==p.id||preview.connection!==connection||preview.inFlight||!expectedIdentity||typeof expectedIdentity!=='object'||Array.isArray(expectedIdentity)||Object.keys(expectedIdentity).sort().join(',')!==[...fields].sort().join(',')||fields.some(k=>typeof expectedIdentity[k]!=='string'||expectedIdentity[k]!==preview.identity[k]))throw Object.assign(Error('Предпросмотр изменился; проверьте письмо заново'),{status:409});
    const generation=preview.generation,identity=structuredClone(preview.identity);
    this.store.atomic(()=>{this.checkGeneration(generation);this.state.preview.inFlight=true;});
    try{
      const result=await this.transport.mailControl('adapter_mail_snapshot_stage',{connection,expectedIdentity:identity});
      this.admin({id:p.id});this.checkGeneration(generation);
      if(!this.state.preview||this.state.preview.actorId!==p.id||this.state.preview.connection!==connection||JSON.stringify(this.state.preview.identity)!==JSON.stringify(identity))throw Object.assign(Error('Предпросмотр изменился'),{status:409});
      if(!result||['snapshotId','hash','revision'].some(k=>typeof result[k]!=='string'||!result[k]||result[k].length>512))throw Error('Снимок письма не получен');
      return this.store.atomic(()=>{this.checkGeneration(generation);this.state.preview=null;this.state.selected={snapshotId:result.snapshotId,hash:result.hash,revision:result.revision,actorId:p.id};return structuredClone(this.state.selected);});
    }catch(error){this.store.atomic(()=>{if(this.state.selectionGeneration===generation&&this.state.preview)this.state.preview.inFlight=false;});throw error;}
  }
  snapshot(actor){this.admin(actor);return structuredClone(this.state);}
  async importSelected(actor,expected){
    const p=this.admin(actor),selected=structuredClone(this.state.selected);
    if(!selected || selected.actorId!==p.id)throw Error('Сначала выберите письмо');
    if(!expected || typeof expected!=='object' || expected.snapshotId!==selected.snapshotId || expected.hash!==selected.hash || expected.revision!==selected.revision)throw Object.assign(Error('Выбранное письмо изменилось; проверьте выбор заново'),{status:409});
    const existing=Object.values(this.state.imports).find(x=>x.snapshotId===selected.snapshotId&&x.snapshotRevision===selected.revision);
    if(existing)return structuredClone(existing);
    let operation=Object.values(this.state.operations).find(x=>x.snapshotId===selected.snapshotId&&x.revision===selected.revision);
    if(operation){
      if(operation.state==='unknown'||operation.state==='sending'){
        const receipt=await this.transport.messagingV2.receipt({operationId:operation.operationId});
        this.admin({id:p.id});
        if(receipt?.operationId!==operation.operationId || receipt.state!=='imported')throw Error('Импорт ещё не подтверждён');
        if(operation.snapshotHash!==selected.hash || JSON.stringify(this.state.selected)!==JSON.stringify(selected))throw Error('Снимок письма изменился');
        const approval=await this.transport.mailControl('adapter_mail_snapshot_approve',{space:'modus-platform',snapshotId:selected.snapshotId,revision:selected.revision,hash:selected.hash});
        this.admin({id:p.id});
        if(JSON.stringify(this.state.selected)!==JSON.stringify(selected))throw Error('Выбранное письмо изменилось');
        const payload={snapshotId:selected.snapshotId,revision:selected.revision,operationId:operation.operationId};
        this.authority.issue(p,{action:'mail_import',payload,grantId:approval.grantId,expiresAt:approval.expiresAt,purpose:'approved-mail'});
        const retrieved=await this.transport.messagingV2.importMail({...payload,grantId:approval.grantId});
        return this.settle(p,selected,operation.operationId,retrieved);
      }
      throw Error('Операция импорта не может быть повторена автоматически');
    }
    const approval=await this.transport.mailControl('adapter_mail_snapshot_approve',{space:'modus-platform',snapshotId:selected.snapshotId,revision:selected.revision,hash:selected.hash});
    this.admin({id:p.id});
    if(JSON.stringify(this.state.selected)!==JSON.stringify(selected))throw Error('Выбранное письмо изменилось');
    const operationId=randomUUID(),payload={snapshotId:selected.snapshotId,revision:selected.revision,operationId};
    this.authority.issue(p,{action:'mail_import',payload,grantId:approval.grantId,expiresAt:approval.expiresAt,purpose:'approved-mail'});
    this.store.atomic(()=>{this.state.operations[operationId]={...payload,snapshotHash:selected.hash,state:'sending'};});
    try{
      const receipt=await this.transport.messagingV2.importMail({...payload,grantId:approval.grantId});
      this.admin({id:p.id});
      return this.settle(p,selected,operationId,receipt);
    }catch(error){this.store.atomic(()=>{const o=this.state.operations[operationId];if(o&&o.state==='sending')o.state='unknown';});throw error;}
  }
  settle(actor,selected,operationId,receipt){
    this.admin(actor);
    if(JSON.stringify(this.state.selected)!==JSON.stringify(selected))throw Error('Выбранное письмо изменилось');
    if(receipt?.operationId!==operationId || receipt.state!=='imported')throw Error('Импорт ещё не подтверждён');
    const value=receipt.result;
    if(!value || value.snapshotId!==selected.snapshotId || value.sha256!==selected.hash || value.revision!==selected.revision || typeof value.messageId!=='string' || typeof value.body!=='string' || !value.body.trim())throw Error('Содержимое письма не подтверждено');
    return this.store.atomic(()=>{
      const key=value.provider+':'+value.messageId+':'+value.revision;
      let row=this.state.imports[key];
      if(!row){row={id:randomUUID(),snapshotId:selected.snapshotId,snapshotRevision:selected.revision,source:'Adapter mail · '+value.provider,provider:value.provider,sourceId:value.messageId,subject:String(value.subject||''),body:value.body,untrusted:true,partial:value.partial!==false,attachments:[],importedAt:new Date().toISOString()};this.state.imports[key]=row;}
      this.state.operations[operationId].state='imported';
      return structuredClone(row);
    });
  }
}
module.exports={AdapterMail};
