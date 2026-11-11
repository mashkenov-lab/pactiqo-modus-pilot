'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {seed}=require('./domain.cjs');
const {CommunicationsStore}=require('./communications.cjs');
function createServer({dir=process.env.MODUS_DATA_DIR||path.join(__dirname,'data'),demoSeed=true}={}){
 const store=new CommunicationsStore(dir);if(demoSeed)seed(store);const sessions=new Map();
 const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
 const server=http.createServer(async(req,res)=>{try{
  if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host||'')){json(res,403,{error:'Сервер работает только на этом ноутбуке'});return;}
  const url=new URL(req.url,'http://'+req.headers.host);
  if(req.method==='GET'&&url.pathname==='/health'){json(res,200,{ok:true,app:'pactiqo-modus',version:'1.1.0',release:'R3'});return;}
  if(req.method==='POST'&&(req.headers['x-modus-client']!=='1'||(req.headers.origin&&req.headers.origin!=='http://'+req.headers.host))){json(res,403,{error:'Запрос должен прийти из приложения'});return;}
  let body={};if(req.method==='POST'){if(!String(req.headers['content-type']).startsWith('application/json'))throw Object.assign(Error('Нужен JSON'),{status:415});let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>520000)throw Object.assign(Error('Файл слишком большой'),{status:413});chunks.push(c);}try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(Error('Некорректный JSON'),{status:400});}if(!body||Array.isArray(body)||typeof body!=='object')throw Object.assign(Error('Нужен объект JSON'),{status:400});}
  const sid=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('modus_session='))?.split('=')[1];let actor=sessions.get(sid);
  if(url.pathname==='/api/login'&&req.method==='POST'){const a=store.actor(body.actor);if(a.id==='employee2')throw Object.assign(Error('Роль недоступна в демонстрации'),{status:403});const id=randomUUID();sessions.delete(sid);sessions.set(id,a);res.setHeader('Set-Cookie','modus_session='+id+'; HttpOnly; SameSite=Strict; Path=/');json(res,200,{actor:a});return;}
  if(url.pathname.startsWith('/api/')){
   if(!actor){json(res,401,{error:'Выберите учебную роль'});return;}
   if(req.method==='GET'&&url.pathname==='/api/state'){json(res,200,store.snapshot(actor));return;}
   if(req.method==='POST'&&url.pathname==='/api/cases'){json(res,201,store.create(actor,body));return;}
   if(req.method==='POST'&&url.pathname==='/api/note'){json(res,201,store.note(actor,body));return;}
   if(req.method==='POST'&&url.pathname==='/api/desk-import'){json(res,201,store.importDesk(actor,body));return;}
   if(req.method==='POST'&&url.pathname==='/api/inbox'){json(res,201,store.ingestDemo(actor,body));return;}
   if(req.method==='POST'&&url.pathname==='/api/replies'){json(res,201,store.prepareReply(actor,body));return;}
   const comm=url.pathname.match(/^\/api\/(inbox|leads|cases)\/([a-f0-9-]+)\/(route|action|comment)$/);
   if(req.method==='POST'&&comm){const [,kind,id,action]=comm;
    if(kind==='inbox'&&action==='route'){json(res,200,store.route(actor,id,body));return;}
    if(kind==='leads'&&action==='action'){json(res,200,store.leadAction(actor,id,body));return;}
    if(kind==='cases'&&action==='comment'){json(res,200,store.comment(actor,id,body));return;}
   }
   const m=url.pathname.match(/^\/api\/cases\/([a-f0-9-]+)\/(action|handoff)$/);
   if(req.method==='POST'&&m){json(res,200,m[2]==='action'?store.act(actor,m[1],body):store.handoff(actor,m[1]));return;}
   json(res,404,{error:'Действие не найдено'});return;
  }
  const assets={'/communications.js':['communications.js','text/javascript; charset=utf-8'],'/communications.css':['communications.css','text/css; charset=utf-8'],'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8'],'/demo-desk.json':['demo-desk.json','application/json; charset=utf-8']};const asset=assets[url.pathname];
  if(req.method==='GET'&&asset){res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(fs.readFileSync(path.join(__dirname,'public',asset[0])));return;}json(res,404,{error:'Страница не найдена'});
 }catch(e){json(res,e.status||(e.code==='STORE_CONFLICT'?409:400),{error:e.message});}});
 return {server,store};
}
if(require.main===module){const {server}=createServer();const port=Number(process.env.MODUS_PORT||4387);server.listen(port,'127.0.0.1',()=>console.log('PACTIQO × Модус Трейд: http://127.0.0.1:'+port));server.on('error',e=>{console.error(e.message);process.exitCode=1;});}
module.exports={createServer};
