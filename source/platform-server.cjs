'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {SuiteStore:PlatformStore,people}=require('./suite-store.cjs');
const {DeskAnalyzer}=require('./desk-analyzer.cjs');
const {BitrixConnector}=require('./bitrix-connector.cjs');
const {LocalAuth}=require('./platform-auth.cjs');
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
function csv(rows){const cell=v=>'"'+(/^[=+@\-\t\r]/.test(String(v??''))?'\'':'')+String(v??'').replaceAll('"','""')+'"';return '\ufeff'+rows.map(row=>row.map(cell).join(';')).join('\r\n');}
function createPlatformServer({dir=process.env.MODUS_DATA_DIR||process.env.MODUS_R4_DATA_DIR||path.join(__dirname,'data-r5'),seed=process.env.MODUS_DEMO!=='0',passwords,analyzer,bitrixOptions,adapter}={}){
 const store=new PlatformStore(dir);if(seed)store.seedDataset();const auth=new LocalAuth(dir,{passwords});
 analyzer||=new DeskAnalyzer({dir});if(!adapter&&process.env.MODUS_ADAPTER_PROFILE)adapter=new (require('./adapter-link.cjs').AdapterLink)({profile:process.env.MODUS_ADAPTER_PROFILE,dir,executable:process.env.MODUS_ADAPTER_EXE,codexExecutable:process.env.MODUS_CODEX_EXE});const bitrix=new BitrixConnector(store,bitrixOptions);
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 const server=http.createServer(async(req,res)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');try{
  if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host||''))fail('Доступ разрешён только на этом компьютере',403);
  const url=new URL(req.url,'http://'+req.headers.host),p=url.pathname,post=req.method==='POST';
  if(req.method==='GET'&&p==='/health')return json(res,200,{ok:true,app:'pactiqo-modus',release:'R5',version:'3.0.0',channel:'configured_separately'});
  if(post&&(req.headers['x-modus-client']!=='1'||req.headers.origin&&req.headers.origin!=='http://'+req.headers.host))fail('Запрос должен прийти из приложения',403);
  let body={};if(post){if(!String(req.headers['content-type']).startsWith('application/json'))fail('Нужен JSON',415);let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>2900000)fail('Запрос превышает допустимый размер',413);chunks.push(c);}try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('Некорректный JSON');}if(!body||Array.isArray(body)||typeof body!=='object')fail('Нужен объект JSON');}
  const token=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('modus_r5='))?.slice(9);const a=auth.actor(token);
  if(req.method==='GET'&&p==='/api/accounts')return json(res,200,{accounts:Object.values(people).map(({id,name,role,admin})=>({id,name,role,admin:!!admin}))});
  if(post&&p==='/api/login'){const r=auth.login(body.actor,body.password,token);res.setHeader('Set-Cookie','modus_r5='+r.token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800');return json(res,200,{actor:r.actor});}
  if(p.startsWith('/api/')){if(!a)fail('Войдите в учётную запись',401);
   if(post&&p==='/api/logout'){auth.logout(token);res.setHeader('Set-Cookie','modus_r5=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(res,200,{ok:true});}
   if(req.method==='GET'&&p==='/api/state')return json(res,200,store.snapshot(a));
   if(req.method==='GET'&&p==='/api/readiness')return json(res,200,{desk:await analyzer.status(),adapter:adapter?await adapter.readiness():{ready:false,label:'Адаптер не связан с этим профилем'}});
   if(req.method==='GET'&&p==='/api/integrations/bitrix')return json(res,200,bitrix.status(a));
   const conv=p.match(/^\/api\/conversations\/([a-f0-9-]+)(?:\/(message|analyze|confirm|analysis-result))?$/);
   if(conv){const [,id,action]=conv;if(req.method==='GET'&&!action)return json(res,200,store.conversation(a,id));if(post&&action==='message')return json(res,200,store.addMessage(a,id,body));if(post&&action==='confirm')return json(res,200,store.confirmConversation(a,id,body));if(post&&action==='analysis-result'){if(!adapter)fail('Адаптер не подключён');const c=store.conversation(a,id);if(c.analysisStatus!=='waiting_adapter')fail('Нет ожидающего запроса');try{const result=await adapter.collect(c,{categories:store.categories(),departments:store.snapshot(a).departments});return json(res,200,store.finishAnalysis(a,id,c.analysisRequestId,result));}catch(e){store.finishAnalysis(a,id,c.analysisRequestId,null,e);throw e;}}if(post&&action==='analyze'){if(body.engine==='adapter'&&!adapter)fail('Адаптер не подключён');const c=store.beginAnalysis(a,id,body);try{const result=await (c.engine==='adapter'?adapter:analyzer).analyze(c,{categories:store.categories(),departments:store.snapshot(a).departments});return json(res,200,store.finishAnalysis(a,id,c.analysisRequestId,result));}catch(e){store.finishAnalysis(a,id,c.analysisRequestId,null,e);throw e;}}}
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
   if(req.method==='GET'&&get){if(get[1]==='cases'&&get[3])return json(res,200,store.similar(a,get[2]));if(get[1]==='cases')return json(res,200,store.row(store.get(get[2],a)));if(get[3])fail('Не найдено',404);const f=store.attachment(a,get[2]);res.writeHead(200,{'Content-Type':f.mime,'Content-Length':f.size,'Content-Disposition':"attachment; filename=\"attachment\"; filename*=UTF-8''"+encodeURIComponent(f.name),'Cache-Control':'no-store','Content-Security-Policy':"sandbox; default-src 'none'"});return res.end(fs.readFileSync(f.path));}
   if(post){const handlers={'/api/cases':()=>store.create(a,body),'/api/configuration':()=>store.settings(a,body),'/api/note':()=>store.note(a,body),'/api/desk-import':()=>store.importDesk(a,body),'/api/inbox':()=>store.ingestDemo(a,body),'/api/replies':()=>store.prepareReply(a,body)};if(Object.hasOwn(handlers,p))return json(res,p==='/api/configuration'?200:201,handlers[p]());
    const m=p.match(/^\/api\/(cases|inbox|leads|notifications)\/([a-f0-9-]+)\/(action|comment|attachments|handoff|route|read)$/);if(m){const [,kind,id,action]=m;if(kind==='cases'){const methods={action:'act',comment:'comment',attachments:'attach',handoff:'handoff'};if(methods[action])return json(res,200,store[methods[action]](a,id,body));}if(kind==='inbox'&&action==='route')return json(res,200,store.route(a,id,body));if(kind==='leads'&&action==='action')return json(res,200,store.leadAction(a,id,body));if(kind==='notifications'&&action==='read')return json(res,200,store.readNotification(a,id));}
   }fail('Действие не найдено',404);
  }
  const assets={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/suite.js':['suite.js','text/javascript'],'/styles.css':['styles.css','text/css'],'/demo-desk.json':['demo-desk.json','application/json']};const asset=assets[p];if(req.method==='GET'&&asset){res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8','Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});return res.end(fs.readFileSync(path.join(__dirname,p==='/demo-desk.json'?'public':'r4-public',asset[0])));}fail('Страница не найдена',404);
 }catch(e){const status=e.status||(e.code==='STORE_CONFLICT'?409:400);if(!res.headersSent)json(res,status,{error:e.message});else res.end();}});
 return {server,store,auth,analyzer,bitrix};
}
if(require.main===module){const {server}=createPlatformServer(),port=Number(process.env.MODUS_PORT||process.env.MODUS_R4_PORT||4389);server.listen(port,'127.0.0.1',()=>console.log('PACTIQO MODUS R5: http://127.0.0.1:'+port));server.on('error',e=>{console.error(e.message);process.exitCode=1;});}
module.exports={createPlatformServer,csv};
