'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {SuiteStore:PlatformStore,people}=require('./suite-store.cjs');
const {DeskAnalyzer}=require('./desk-analyzer.cjs');
const {BitrixConnector}=require('./bitrix-connector.cjs');
const {LocalAuth}=require('./platform-auth.cjs');
const {MessengerWorkflow}=require('./messenger-workflow.cjs');
const {CaseWorkspace}=require('./case-workspace.cjs');
const {CardLinks}=require('./card-links.cjs');
const {AdapterAuthority,BindingAdmin,CaseLinks,CombinedMessengerTransport}=require('./adapter-authority.cjs');
const {CaseDelivery}=require('./case-delivery.cjs');
const {CaseAttention}=require('./case-attention.cjs');
const {AdapterMail}=require('./adapter-mail.cjs');
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
function csv(rows){const cell=v=>'"'+(/^[=+@\-\t\r]/.test(String(v??''))?'\'':'')+String(v??'').replaceAll('"','""')+'"';return '\ufeff'+rows.map(row=>row.map(cell).join(';')).join('\r\n');}
function releaseBuild(dir){try{const m=JSON.parse(fs.readFileSync(path.join(dir,'suite-manifest.json'),'utf8'));return m.schema===1&&typeof m.version==='string'&&/^r6-4\.0\.0-[A-Za-z0-9._-]+$/.test(m.version)?m.version:null;}catch{return null;}}
function createPlatformServer({dir=process.env.MODUS_DATA_DIR||process.env.MODUS_R4_DATA_DIR||path.join(__dirname,'data-r5'),seed=process.env.MODUS_DEMO!=='0',passwords,analyzer,bitrixOptions,adapter,messaging,enableAdapter=false,now=Date.now}={}){
 const store=new PlatformStore(dir);if(seed)store.seedDataset();const auth=new LocalAuth(dir,{passwords,resolveActor:id=>store.person(id),listActors:()=>Object.values(store.people)});
 analyzer||=new DeskAnalyzer({dir});if(!adapter&&process.env.MODUS_ADAPTER_PROFILE)adapter=new (require('./adapter-link.cjs').AdapterLink)({profile:process.env.MODUS_ADAPTER_PROFILE,dir,executable:process.env.MODUS_ADAPTER_EXE,codexExecutable:process.env.MODUS_CODEX_EXE});const bitrix=new BitrixConnector(store,bitrixOptions);
 const workroom=new CaseWorkspace({store,analysis:adapter?.caseAnalysis});
 const attention=new CaseAttention({store,now});
 const cards=new CardLinks({store});
 const cardLinkFor=(caseId,recipientId)=>{const origin=store.suite.externalOrigin||('http://127.0.0.1:'+server.address().port);return origin+'/card/'+cards.issue(caseId,recipientId);};
 const authority=adapter?new AdapterAuthority({store,dir}):null;
 const binding=adapter?.messagingV2?new BindingAdmin({store,transport:adapter.messagingV2,authority}):null;
 const externalLinks=binding?new CaseLinks({store,transport:adapter.messagingV2,authority}):null;
 const delivery=binding?new CaseDelivery({store,workroom,transport:adapter.messagingV2,authority,links:externalLinks,cardLinkFor,now}):null;
 const mail=adapter?new AdapterMail({store,transport:adapter,authority}):null;
 const transport=adapter?new CombinedMessengerTransport({store,legacy:adapter.messaging,v2:adapter.messagingV2,authority}):messaging;
 const messenger=new MessengerWorkflow({store,analysis:adapter,transport:messaging||transport,workroom,cardLinkFor});
 let adapterIntegration={configured:false,error:null},adapterRetry=null,adapterConnecting=false,registeredBridge=null,draining=false,activeMutations=0,drainTimers=null;
 function ensureAdapterRetry(){if(adapterRetry||draining)return;adapterRetry=setInterval(()=>{const identity=bridgeIdentity();if(!adapterIntegration.configured||(identity&&identity!==registeredBridge))void reconnectAuthority();},5000);adapterRetry.unref();}
 const bridgeIdentity=()=>{try{const b=adapter?.bridge?.();return b?b.port+':'+b.token:null;}catch{return null;}};
 async function reconnectAuthority(){if(draining||adapterConnecting||!authority||!store.suite.adapterIntegrationEnabled)return;adapterConnecting=true;try{await authority.configure(adapter,server.address().port);registeredBridge=bridgeIdentity();adapterIntegration={configured:true,error:null};if(!draining)delivery?.start();}catch{adapterIntegration={configured:false,error:'Адаптер не подтвердил регистрацию; повторяем подключение'};}finally{adapterConnecting=false;}}
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 const server=http.createServer(async(req,res)=>{const mutation=req.url!=='/health'&&req.url!=='/internal/adapter/verify';if(mutation&&draining)return json(res,503,{error:'Приложение ожидает безопасной остановки'});if(mutation)activeMutations++;res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');try{
  const host=req.headers.host||'', localHost=/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  const external=store.suite.externalOrigin||null;
  const externalHost=!!external && host===new URL(external).host;
  if(!localHost&&!externalHost)fail('Доступ запрещён',403);
  const url=new URL(req.url,'http://'+host),p=url.pathname,post=req.method==='POST';
  const webhook=p.match(/^\/webhooks\/employee\/(employee-(?:wa|max)-[a-z0-9-]{1,48})$/);
  if(webhook){
   if(!adapter?.channelControl)fail('Канал недоступен',503);
   const channelId=webhook[1];
   if(req.method==='GET'&&channelId.startsWith('employee-wa-')){
    if(url.searchParams.get('hub.mode')!=='subscribe')fail('Проверка отклонена',403);
    try{const challenge=url.searchParams.get('hub.challenge'),result=await adapter.channelControl('adapter_employee_webhook_challenge',{channelId,verifyToken:url.searchParams.get('hub.verify_token'),challenge});if(typeof challenge!=='string'||result?.challenge!==challenge)throw Error('denied');res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});return res.end(challenge);}catch{fail('Проверка отклонена',403);}
   }
   if(!post)fail('Метод недоступен',405);
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1048576)fail('Слишком большой запрос',413);chunks.push(chunk);}
   const signature=req.headers[channelId.startsWith('employee-wa-')?'x-hub-signature-256':'x-max-bot-api-secret'];
   try{await adapter.channelControl('adapter_employee_webhook',{channelId,rawBase64:Buffer.concat(chunks).toString('base64'),signature});return json(res,200,{ok:true});}catch{fail('Проверка отклонена',403);}
  }
  if(p==='/internal/adapter/verify'){
   if(!post||!localHost||!authority||req.headers.origin||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!String(req.headers['content-type']||'').startsWith('application/json'))fail('Доступ запрещён',403);
   try{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8192)throw Error('size');chunks.push(chunk);}const query=JSON.parse(Buffer.concat(chunks).toString('utf8'));return json(res,200,authority.verify(req.headers.authorization,query));}catch{fail('Доступ запрещён',403);}
  }
  if(req.method==='GET'&&p==='/health')return json(res,200,{ok:true,app:'pactiqo-modus',release:'R6',version:'4.0.0',build:releaseBuild(__dirname),channel:'configured_separately'});
  if(post&&(req.headers['x-modus-client']!=='1'||req.headers.origin&&req.headers.origin!==(externalHost?external:'http://'+host)))fail('Запрос должен прийти из приложения',403);
  let body={};if(post){if(!String(req.headers['content-type']).startsWith('application/json'))fail('Нужен JSON',415);let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>2900000)fail('Запрос превышает допустимый размер',413);chunks.push(c);}try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('Некорректный JSON');}if(!body||Array.isArray(body)||typeof body!=='object')fail('Нужен объект JSON');}
  const token=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('modus_r5='))?.slice(9);const a=auth.actor(token);
  if(req.method==='GET'&&p==='/api/accounts')return json(res,200,{accounts:Object.values(store.people).filter(person=>person.active!==false&&Object.hasOwn(auth.accounts,person.id)).map(({id,name,role,admin})=>({id,name,role,admin:!!admin})),authenticated:!!a});
  if(post&&p==='/api/login'){const r=auth.login(body.actor,body.password,token);res.setHeader('Set-Cookie','modus_r5='+r.token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800'+(externalHost?'; Secure':''));return json(res,200,{actor:r.actor});}
  if(p.startsWith('/api/')){if(!a)fail('Войдите в учётную запись',401);
   if(req.method==='GET'&&p==='/api/company/external-origin'){store.companyAdmin(a);return json(res,200,{origin:external,networkVerified:false});}
   if(post&&p==='/api/company/external-origin'){store.companyAdmin(a);let origin=null;if(body.origin){try{const u=new URL(body.origin);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||u.origin!==body.origin)throw Error();origin=u.origin;}catch{fail('Укажите только HTTPS origin без пути и учётных данных');}}store.atomic(()=>{store.suite.externalOrigin=origin;});return json(res,200,{origin,networkVerified:false});}
   if(req.method==='GET'&&p==='/api/company/telegram-accounts'){store.companyAdmin(a);if(!adapter?.channelControl)fail('Адаптер не подключён');const result=await adapter.channelControl('adapter_employee_telegram_accounts',{});return json(res,200,{accounts:(result.accounts||[]).map(({account,label,botId,botUsername,enabled,ready,reason})=>({account,label,botId,botUsername,enabled,ready,reason}))});}
   if(req.method==='GET'&&p==='/api/company/telegram-local'){store.companyAdmin(a);if(!adapter?.channelControl)fail('Адаптер не подключён');const result=await adapter.channelControl('adapter_telegram_local_status',{});return json(res,200,{configured:!!result.configured,managementUrl:Number.isInteger(result.port)&&result.port>0&&result.port<65536?'http://127.0.0.1:'+result.port+'/':null});}
   if(post&&p==='/api/company/channel/configure'){store.companyAdmin(a);if(!adapter?.channelControl)fail('Адаптер не подключён');const fields={telegram:['channelId','organizationId','account','botId'],whatsapp:['channelId','organizationId','channel','phoneId','wabaId','graphVersion','accessToken','appSecret','verifyToken'],max:['channelId','organizationId','channel','botId','accessToken','webhookSecret']}[body.channel];if(!fields)fail('Неизвестный канал');const params=Object.fromEntries(fields.filter(k=>Object.hasOwn(body,k)).map(k=>[k,body[k]]));try{await adapter.channelControl(body.channel==='telegram'?'adapter_employee_telegram_configure':'adapter_employee_channel_configure',params);}catch{fail('Адаптер не подтвердил настройку канала',400);}return json(res,200,{ok:true});}
   if(post&&p==='/api/company/authority/configure'){store.companyAdmin(a);if(!authority)fail('Адаптер не подключён');try{await authority.configure(adapter,server.address().port);store.atomic(()=>{store.suite.adapterIntegrationEnabled=true;});registeredBridge=bridgeIdentity();adapterIntegration={configured:true,error:null};ensureAdapterRetry();if(!draining)delivery?.start();return json(res,200,adapterIntegration);}catch(e){adapterIntegration={configured:false,error:'Адаптер не подтвердил регистрацию'};return json(res,503,adapterIntegration);}}
   if(post&&p==='/api/company/backup'){store.companyAdmin(a);const result=require('./suite-backup.cjs').backup({data:dir,backupRoot:path.join(path.dirname(dir),'backups'),revision:releaseBuild(__dirname)||'source'});return json(res,200,{created:true,name:path.basename(result.directory),files:result.manifest.files.length,createdAt:result.manifest.createdAt});}
   if(req.method==='GET'&&p==='/api/company/connections'){store.companyAdmin(a);return json(res,200,{integration:adapterIntegration,bindings:binding?await binding.status(a):null});}
   if(req.method==='GET'&&p==='/api/company/delivery'){if(!delivery)fail('Адаптер не подключён');return json(res,200,delivery.snapshot(a));}
   if(post&&p.startsWith('/api/company/binding/')){if(!binding)fail('Адаптер не подключён');const action=p.slice('/api/company/binding/'.length);if(!['prepare','proof','confirm','revoke'].includes(action))fail('Действие не найдено',404);return json(res,200,await binding[action](a,body));}
   if(req.method==='GET'&&p==='/api/company/mail/connections'){if(!mail)fail('Адаптер не подключён');return json(res,200,await mail.connections(a));}
   if(req.method==='GET'&&p==='/api/company/mail'){if(!mail)fail('Адаптер не подключён');return json(res,200,mail.snapshot(a));}
   if(post&&p.startsWith('/api/company/mail/')){if(!mail)fail('Адаптер не подключён');const action=p.slice('/api/company/mail/'.length),methods={candidates:'candidates',select:'select',preview:'preview',stage:'stage',import:'importSelected'};if(!methods[action])fail('Действие не найдено',404);return json(res,200,await mail[methods[action]](a,body));}
   if(req.method==='GET'&&p==='/api/company/attention')return json(res,200,attention.policy(a));
   if(post&&p==='/api/company/attention/preview'){const result=attention.preview(a,body);return json(res,200,{...result,cases:result.cases.map(c=>({...c,title:store.row(store.get(c.id,a),a).title}))});}
   if(post&&p==='/api/company/attention/apply')return json(res,200,attention.configure(a,body));
   const att=p.match(/^\/api\/cases\/([a-f0-9-]+)\/attention(?:\/(progress))?$/);
   if(att){if(req.method==='GET'&&!att[2])return json(res,200,attention.snapshot(a,{caseId:att[1]}));if(post&&att[2])return json(res,200,attention.setProgress(a,{...body,caseId:att[1]}));}
   if(req.method==='GET'&&p==='/api/company')return json(res,200,store.companySnapshot(a));
   if(post&&p==='/api/company/import/preview')return json(res,200,store.previewStaffImport(a,body));
   if(post&&p==='/api/company/import/apply')return json(res,200,store.applyStaffImport(a,body));
   if(post&&p==='/api/company/staff')return json(res,200,store.updateStaff(a,body));
   if(post&&p==='/api/company/responsibility')return json(res,200,store.saveResponsibility(a,body));
   if(post&&p==='/api/company/credential'){store.companyAdmin(a);if(!['issue','reset'].includes(body.action))fail('Неизвестное действие');const password=body.action==='issue'?auth.ensureAccount(body.id):auth.resetPassword(body.id);return json(res,200,{password});}
   const room=p.match(/^\/api\/cases\/([a-f0-9-]+)\/workroom(?:\/(message|plan|advice))?$/);
   if(room){const [,id,action]=room;if(req.method==='GET'&&!action)return json(res,200,workroom.snapshot(a,id));if(post&&action==='message')return json(res,200,workroom.post(a,{...body,caseId:id},{source:'web'}));if(post&&action==='plan')return json(res,200,workroom.savePlan(a,{...body,caseId:id}));if(post&&action==='advice')return json(res,200,workroom.requestAdvice(a,{...body,caseId:id}));}
   const card=p.match(/^\/api\/card\/([A-Za-z0-9_-]+)$/);if(req.method==='GET'&&card)return json(res,200,workroom.snapshot(a,cards.resolve(card[1],a)));
   if(post&&p==='/api/logout'){mail?.invalidateSelection(a);auth.logout(token);res.setHeader('Set-Cookie','modus_r5=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(res,200,{ok:true});}
   if(req.method==='GET'&&p==='/api/state')return json(res,200,{...store.snapshot(a),messenger:messenger.snapshot(a)});
   if(req.method==='GET'&&p==='/api/messaging')return json(res,200,await messenger.status(a));
   if(post&&p==='/api/messaging/config')return json(res,200,messenger.configure(a,body));
   if(post&&p==='/api/messaging/check'){if(!a.admin)fail('Очередью управляет администратор',403);void messenger.tick();return json(res,200,{checking:true});}
   if(req.method==='GET'&&p==='/api/readiness')return json(res,200,{desk:await analyzer.status(),adapter:adapter?await adapter.readiness():{ready:false,label:'Адаптер не связан с этим профилем'}});
   if(req.method==='GET'&&p==='/api/integrations/bitrix')return json(res,200,bitrix.status(a));
   const conv=p.match(/^\/api\/conversations\/([a-f0-9-]+)(?:\/(message|analyze|confirm|analysis-result|abandon-analysis))?$/);
   if(conv){const [,id,action]=conv;if(req.method==='GET'&&!action)return json(res,200,store.conversationView(a,id));if(post&&action==='message')return json(res,200,store.addMessage(a,id,body));if(post&&action==='confirm')return json(res,200,store.confirmConversation(a,id,body));if(post&&action==='abandon-analysis')return json(res,200,store.abandonAnalysis(a,id,body));if(post&&action==='analysis-result'){if(!adapter)fail('Адаптер не подключён');const c=store.beginCollection(a,id);try{const result=await adapter.collect(c,store.analysisContext(a,id));return json(res,200,store.finishAnalysis(a,id,c.analysisRequestId,result));}catch(e){const current=store.conversation(a,id);if(current.analysisRequestId===c.analysisRequestId&&['pending','waiting_adapter'].includes(current.analysisStatus))store.finishAnalysis(a,id,c.analysisRequestId,null,e);throw e;}}if(post&&action==='analyze'){if(body.engine==='adapter'&&!adapter)fail('Адаптер не подключён');const c=store.beginAnalysis(a,id,body);try{const result=await (c.engine==='adapter'?adapter:analyzer).analyze(c,store.analysisContext(a,id));return json(res,200,store.finishAnalysis(a,id,c.analysisRequestId,result));}catch(e){const current=store.conversation(a,id);if(current.analysisRequestId===c.analysisRequestId&&['pending','waiting_adapter'].includes(current.analysisStatus))store.finishAnalysis(a,id,c.analysisRequestId,null,e);throw e;}}}
   if(post&&p==='/api/adapter/onboarding'){if(!a.admin)fail('Доступно администратору',403);if(!adapter)fail('Адаптер не подключён');return json(res,200,await adapter.onboarding(body.action));}
   if(post&&p==='/api/conversations')return json(res,201,store.openConversation(a,body));
   if(post&&p==='/api/categories')return json(res,200,store.category(a,body));
   if(post&&p==='/api/process-routes')return json(res,200,store.processSettings(a,body));
   if(post&&p==='/api/transfers')return json(res,201,store.createTransfer(a,body));
   const transfer=p.match(/^\/api\/transfers\/([a-f0-9-]+)\/action$/);if(post&&transfer)return json(res,200,store.transferAction(a,transfer[1],body));
   if(post&&p==='/api/integrations/bitrix/configure')return json(res,200,bitrix.configure(a,body));
   if(post&&p==='/api/integrations/bitrix/sync')return json(res,200,await bitrix.sync(a));
   if(post&&p==='/api/integrations/bitrix/export')return json(res,200,await bitrix.exportItem(a,body));
   if(post&&p==='/api/integrations/bitrix/reconcile')return json(res,200,await bitrix.reconcile(a,body));
   if(post&&p==='/api/integrations/bitrix/reply-preview')return json(res,200,bitrix.mailReplyPreview(a,body));
   if(post&&p==='/api/integrations/bitrix/send-reply')return json(res,200,await bitrix.sendMailReply(a,body));
   if(post&&p==='/api/integrations/bitrix/import-mail')return json(res,200,await bitrix.importMail(a,body));
   if(req.method==='GET'&&p==='/api/export.csv'){const rows=store.snapshot(a).cases;res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="modus-cases.csv"','Cache-Control':'no-store'});return res.end(csv([['Номер','Тема','Тип','Категория','Подразделение','Статус','Автор','Ответственный','Срок','Решение'],...rows.map(c=>[c.number,c.title,c.type,c.category,c.department,c.phase,c.author,c.owner,c.dueAt,c.resolution?.body])]));}
   const get=p.match(/^\/api\/(attachments|cases)\/([a-f0-9-]+)(\/similar)?$/);
   if(req.method==='GET'&&get){if(get[1]==='cases'&&get[3])return json(res,200,store.similar(a,get[2]));if(get[1]==='cases')return json(res,200,store.row(store.get(get[2],a),a));if(get[3])fail('Не найдено',404);const f=store.attachment(a,get[2]);res.writeHead(200,{'Content-Type':f.mime,'Content-Length':f.size,'Content-Disposition':"attachment; filename=\"attachment\"; filename*=UTF-8''"+encodeURIComponent(f.name),'Cache-Control':'no-store','Content-Security-Policy':"sandbox; default-src 'none'"});return res.end(fs.readFileSync(f.path));}
   if(post){const handlers={'/api/cases':()=>store.create(a,body),'/api/configuration':()=>store.settings(a,body),'/api/note':()=>store.note(a,body),'/api/desk-import':()=>store.importDesk(a,body),'/api/inbox':()=>store.ingestDemo(a,body),'/api/replies':()=>store.prepareReply(a,body)};if(Object.hasOwn(handlers,p))return json(res,p==='/api/configuration'?200:201,handlers[p]());
    const m=p.match(/^\/api\/(cases|inbox|leads|notifications)\/([a-f0-9-]+)\/(action|comment|attachments|handoff|route|read)$/);if(m){const [,kind,id,action]=m;if(kind==='cases'){const methods={action:'act',comment:'comment',attachments:'attach',handoff:'handoff'};if(methods[action])return json(res,200,store[methods[action]](a,id,body));}if(kind==='inbox'&&action==='route')return json(res,200,store.route(a,id,body));if(kind==='leads'&&action==='action')return json(res,200,store.leadAction(a,id,body));if(kind==='notifications'&&action==='read')return json(res,200,store.readNotification(a,id));}
   }fail('Действие не найдено',404);
  }
  if(req.method==='GET'&&p==='/favicon.ico'){res.writeHead(204);return res.end();}
  const assets={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/suite.js':['suite.js','text/javascript'],'/chat-ui.js':['chat-ui.js','text/javascript'],'/workroom-ui.js':['workroom-ui.js','text/javascript'],'/company-ui.js':['company-ui.js','text/javascript'],'/messenger-ui.js':['messenger-ui.js','text/javascript'],'/styles.css':['styles.css','text/css'],'/demo-desk.json':['demo-desk.json','application/json']};const asset=assets[p]||(/^\/card\/[A-Za-z0-9_-]+$/.test(p)?assets['/']:null);if(req.method==='GET'&&p==='/company-demo.csv'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Cache-Control':'no-store'});return res.end(fs.readFileSync(path.join(__dirname,'fixtures','company-demo.csv')));}
  if(req.method==='GET'&&asset){res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8','Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});return res.end(fs.readFileSync(path.join(__dirname,p==='/demo-desk.json'?'public':'r4-public',asset[0])));}fail('Страница не найдена',404);
 }catch(e){const status=e.status||(e.code==='STORE_CONFLICT'?409:400);if(!res.headersSent)json(res,status,{error:e.message});else res.end();}finally{if(mutation)activeMutations--;}});
 server.once('listening',()=>{messenger.start();workroom.start();attention.start();if(enableAdapter&&authority&&!store.suite.adapterIntegrationEnabled)store.atomic(()=>{store.suite.adapterIntegrationEnabled=true;});if(store.suite.adapterIntegrationEnabled){void reconnectAuthority();ensureAdapterRetry();}});server.once('close',()=>{clearInterval(adapterRetry);messenger.stop();workroom.stop();attention.stop();delivery?.stop();});
 return {server,store,auth,analyzer,bitrix,messenger,workroom,attention,cards,authority,binding,delivery,mail,beginDrain:()=>{draining=true;drainTimers={messenger:!!messenger.timer,workroom:!!workroom.timer,attention:!!attention.timer,delivery:!!delivery?.timer};messenger.stop();workroom.stop();attention.stop();delivery?.stop();},endDrain:()=>{draining=false;if(drainTimers?.messenger)messenger.start();if(drainTimers?.workroom)workroom.start();if(drainTimers?.attention)attention.start();if(drainTimers?.delivery||adapterIntegration.configured)delivery?.start();if(store.suite.adapterIntegrationEnabled)ensureAdapterRetry();drainTimers=null;},get activeMutations(){return activeMutations;},get integrationBusy(){return adapterConnecting;},get integrationRetryActive(){return !!adapterRetry;}};
}
if(require.main===module){const {server}=createPlatformServer(),port=Number(process.env.MODUS_PORT||process.env.MODUS_R4_PORT||4389);server.listen(port,'127.0.0.1',()=>console.log('PACTIQO MODUS R6: http://127.0.0.1:'+port));server.on('error',e=>{console.error(e.message);process.exitCode=1;});}
module.exports={createPlatformServer,csv,releaseBuild};

