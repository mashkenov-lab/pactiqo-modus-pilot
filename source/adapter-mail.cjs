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
  async select(actor,input){
    const p=this.admin(actor);
    const {connection,rowId,subject,sender,revision}=input;
    const result=await this.transport.mailControl('adapter_gmail_select',{connection,rowId,subject,sender,revision});
    this.admin({id:p.id});
    if(!result?.snapshotId||!result.hash||!result.revision)throw Error('Снимок письма не получен');
    return this.store.atomic(()=>{this.state.selected={...result,actorId:p.id};return structuredClone(this.state.selected);});
  }
  async stage(actor,{connection}){
    const p=this.admin(actor),result=await this.transport.mailControl('adapter_mail_snapshot_stage',{connection});
    this.admin({id:p.id});
    if(!result?.snapshotId||!result.hash||!result.revision)throw Error('Снимок письма не получен');
    return this.store.atomic(()=>{this.state.selected={...result,actorId:p.id};return structuredClone(this.state.selected);});
  }
  snapshot(actor){this.admin(actor);return structuredClone(this.state);}
  async importSelected(actor){
    const p=this.admin(actor),selected=structuredClone(this.state.selected);
    if(!selected || selected.actorId!==p.id)throw Error('Сначала выберите письмо');
    const existing=Object.values(this.state.imports).find(x=>x.snapshotId===selected.snapshotId&&x.snapshotRevision===selected.revision);
    if(existing)return structuredClone(existing);
    let operation=Object.values(this.state.operations).find(x=>x.snapshotId===selected.snapshotId&&x.revision===selected.revision);
    if(operation){
      if(operation.state==='unknown'||operation.state==='sending'){
        const receipt=await this.transport.messagingV2.receipt({operationId:operation.operationId});
        this.admin({id:p.id});
        return this.settle(p,selected,operation.operationId,receipt);
      }
      throw Error('Операция импорта не может быть повторена автоматически');
    }
    const approval=await this.transport.mailControl('adapter_mail_snapshot_approve',{space:'modus-platform',snapshotId:selected.snapshotId,revision:selected.revision,hash:selected.hash});
    this.admin({id:p.id});
    if(JSON.stringify(this.state.selected)!==JSON.stringify(selected))throw Error('Выбранное письмо изменилось');
    const operationId=randomUUID(),payload={snapshotId:selected.snapshotId,revision:selected.revision,operationId};
    this.authority.issue(p,{action:'mail_import',payload,grantId:approval.grantId,expiresAt:approval.expiresAt,purpose:'approved-mail'});
    this.store.atomic(()=>{this.state.operations[operationId]={...payload,state:'sending'};});
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
