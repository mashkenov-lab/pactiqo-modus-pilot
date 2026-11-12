'use strict';
const fs=require('node:fs'),path=require('node:path');
const {PlatformClient}=require('./vendor/adapter-platform/client.cjs');
const {MessagingClient}=require('./vendor/adapter-platform/messaging.cjs');
const {MessagingV2Client}=require('./vendor/adapter-platform/messaging-v2.cjs');
const {casePrompt,validateCaseAdvice}=require('./case-assistant.cjs');
const {validate,schema,prompt}=require('./desk-analyzer.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
class AdapterLink{
 constructor({profile,dir,executable,codexExecutable,version='0.2.138',attached=false,fetchImpl=fetch}){if(!path.isAbsolute(profile)||!path.isAbsolute(dir))throw Error('Нужен отдельный абсолютный профиль');Object.assign(this,{profile,dir,executable,codexExecutable,version,attached,fetch:fetchImpl});this.cap=null;this.client=new PlatformClient({rpc:(m,p)=>this.scoped(m,p),directory:path.join(dir,'adapter-jobs'),clientId:'modus-platform'});this.messagingCap=null;this.messaging=new MessagingClient({rpc:(m,p)=>this.messagingScoped(m,p)});this.messagingV2=new MessagingV2Client({rpc:(m,p)=>this.messagingScoped(m,p)});this.caseAnalysis={analyze:(job,context)=>this.analyzeCase(job,context),recover:(job,context)=>this.recoverCase(job,context)};}
 async messagingScoped(method,params){if(!['adapter_messaging_status','adapter_messaging_poll','adapter_messaging_ack','adapter_messaging_reply','adapter_messaging_receipt','adapter_messaging_v2_status','adapter_messaging_v2_poll','adapter_messaging_v2_receipt','adapter_messaging_v2_binding_prepare','adapter_messaging_v2_binding_proof','adapter_messaging_v2_binding_confirm','adapter_messaging_v2_binding_revoke','adapter_messaging_v2_case_state','adapter_messaging_v2_case_link','adapter_messaging_v2_notify','adapter_messaging_v2_mail_import'].includes(method))throw Error('Метод за пределами канала');const master=this.bridge();if(this.messagingMaster!==master.token){this.messagingCap=null;this.messagingMaster=master.token;}if(!this.messagingCap||Number(this.messagingCap.expiresAt)-Date.now()<20000)this.messagingCap=await this.rpc(master,'adapter_messaging_capability',{space:'modus-platform'});return this.rpc(this.messagingCap,method,params);}
 bridge(){const c=JSON.parse(fs.readFileSync(path.join(this.profile,'bridge.json'),'utf8'));if(!Number.isInteger(c.port)||c.port<1||c.port>65535||typeof c.token!=='string'||c.token.length<20)throw Error('Неверное подключение клиентского Адаптера');return {port:c.port,token:c.token};}
 async rpc(c,method,params){let r;try{r=await this.fetch('http://127.0.0.1:'+c.port+'/rpc',{method:'POST',headers:{authorization:'Bearer '+c.token,'content-type':'application/json'},body:JSON.stringify({method,params}),signal:AbortSignal.timeout(15000),redirect:'error'});}catch{throw Error('Клиентский Адаптер недоступен');}const v=await r.json();if(!r.ok)throw Error(String(v.error||'Адаптер отклонил запрос').slice(0,180));return v.result;}
 async scoped(method,params){if(!['adapter_status','adapter_request_submit','adapter_request_result'].includes(method))throw Error('Метод за пределами доступа платформы');const master=this.bridge();if(this.masterToken!==master.token){this.cap=null;this.masterToken=master.token;}if(!this.cap||Number(this.cap.expiresAt)-Date.now()<20000)this.cap=await this.rpc(master,'adapter_platform_capability',{space:'modus-platform',mode:'analysis-only'});return this.rpc(this.cap,method,params);}
 async configureAuthority(params){return this.rpc(this.bridge(),'adapter_platform_authority_configure',params);}
 async mailConnections(){const status=await this.rpc(this.bridge(),'adapter_status',{});if(!Array.isArray(status?.connections))throw Error('Список подключений недоступен');return status.connections.filter(c=>c?.service==='gmail'&&typeof c.id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(c.id)).map(c=>({id:c.id,label:typeof c.name==='string'?c.name.replace(/[\x00-\x1f\x7f]/g,'').slice(0,120):'Gmail',provider:'gmail'}));}
 async mailControl(method,params){if(!['adapter_mail_snapshot_stage','adapter_mail_snapshot_approve','adapter_gmail_candidates','adapter_gmail_select'].includes(method))throw Error('Метод почты недоступен');return this.rpc(this.bridge(),method,params);}
 async readiness(){try{const r=await this.client.readiness();return {...r,attached:this.attached,installed:fs.existsSync(this.executable),label:r.ready?(this.attached?'ИИ подключён через Адаптер этого компьютера':'Адаптер готов'):'Адаптер запущен; требуется вход клиента или включение обработки'};}catch(e){return {ready:false,installed:fs.existsSync(this.executable),label:e.message};}}
 async onboarding(action='status'){if(this.attached){if(action!=='status')throw Error('Настройки существующего Адаптера изменяются в нём самом');const r=await this.readiness();return {state:r.ready?'ready':'waiting_adapter',executorEnabled:r.ready,attached:true,label:r.label};}if(!['configure','status','enable','disable'].includes(action))throw Error('Неизвестное действие подключения');const r=await this.rpc(this.bridge(),'adapter_client_onboarding',{action,...(action==='configure'?{executable:this.codexExecutable,codexHome:path.join(this.profile,'codex')}: {})});return {state:r.state,executorEnabled:!!r.executorEnabled,label:r.state==='ready'?'Вход и обработка готовы':r.state==='waiting_login'?'Выполните вход клиента в Codex':'Настройка: '+r.state};}
 async stop(){if(this.attached)return {status:'scheduled',externalAdapterPreserved:true};return this.rpc(this.bridge(),'adapter_profile_stop',{expectedVersion:this.version});}
 async recover(c,context){return Object.hasOwn(this.client.jobs,c.analysisRequestId)?this.collect(c,context):this.analyze(c,context);}
 async analyze(c,context){const input=prompt(c,context)+'\nJSON schema: '+JSON.stringify(schema);if(input.length>24000||Buffer.byteLength(JSON.stringify({method:'adapter_request_submit',params:{clientRequestId:c.analysisRequestId,text:input}}),'utf8')>65000)throw Error('Диалог превышает лимит входа Адаптера. Выберите прямой разбор Codex либо сократите исходный текст.');try{await this.client.submit({requestId:c.analysisRequestId,text:input});return await this.collect(c,context,1000);}catch(e){if(e.message==='ADAPTER_NOT_READY')e.message='ИИ пока не подключён. Администратору нужно выполнить вход в Codex или подключить действующий Адаптер. Сообщение сохранено.';const job=this.client.jobs[c.analysisRequestId];if(job&&['submitting','accepted','unknown','running','pending'].includes(job.state))e.pending=true;throw e;}}
 async analyzeCase(job,context){
  const bounded=casePrompt(context);
  const schema={type:'object',additionalProperties:false,required:['reply','questions','proposedPlan','sourceRefs','uncertainty'],properties:{reply:{type:'string'},questions:{type:'array',items:{type:'string'}},proposedPlan:{type:'string'},sourceRefs:{type:'array',items:{type:'string'}},uncertainty:{type:'string'}}};
  let text;
  for(;;){
   text=JSON.stringify({...bounded,schema});
   const envelope=JSON.stringify({method:'adapter_request_submit',params:{clientRequestId:job.requestId,text}});
   if(text.length<=24000&&Buffer.byteLength(envelope,'utf8')<=65000)break;
   if(bounded.context.documents?.length){bounded.context.documents.pop();bounded.context.contextPartial=true;continue;}
   if(bounded.context.messages?.length>1){bounded.context.messages.shift();bounded.context.historyPartial=true;bounded.context.contextPartial=true;continue;}
   throw Object.assign(Error('Сократите обязательный контекст или последнее сообщение'),{code:'needs-shortening'});
  }
  try{await this.client.submit({requestId:job.requestId,text});return await this.recoverCase(job,bounded.context);}
  catch(e){const row=this.client.jobs[job.requestId];if(row&&['submitting','accepted','unknown','running','pending'].includes(row.state))e.pending=true;throw e;}
 }
 async recoverCase(job,context){
  let result;
  try{result=await this.client.result(job.requestId);}catch(e){e.pending=true;throw e;}
  if(result.state==='answered'){
   let value=String(result.reply||'').trim();
   if(value.startsWith('```'))value=value.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
   return validateCaseAdvice(JSON.parse(value),context);
  }
  if(['error','failed','cancelled','waiting_user'].includes(result.state))throw Error('Адаптер: '+result.state);
  throw Object.assign(Error('Адаптер ещё обрабатывает запрос'),{pending:true});
 }
 async collect(c,context,timeout=15000){const deadline=Date.now()+timeout;while(Date.now()<deadline){let r;try{r=await this.client.result(c.analysisRequestId);}catch(e){e.pending=true;throw e;}if(r.state==='answered'){let source=String(r.reply||'').trim();if(source.startsWith('```'))source=source.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');const result=validate(JSON.parse(source),c,context);return {...result,engine:'adapter-codex',reviewRequired:true,analyzedAt:new Date().toISOString(),adapterRequestId:r.adapterId};}if(['error','failed','cancelled','waiting_user'].includes(r.state))throw Error('Адаптер: '+r.state+'. Проверьте вход и состояние задачи.');await pause(1000);}throw Object.assign(Error('Адаптер ещё обрабатывает запрос. Нажмите «Проверить ответ»; повторная отправка не выполняется.'),{pending:true});}
}
module.exports={AdapterLink};
