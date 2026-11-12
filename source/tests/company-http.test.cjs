'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPlatformServer}=require('../platform-server.cjs');
test('company import and workroom endpoints use current session and saved ACK',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'modus-http-'));const app=createPlatformServer({dir,seed:false,passwords:{admin:'test',employee:'test'}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.server.close());const base=`http://127.0.0.1:${app.server.address().port}`;
 const post=(p,body,cookie='')=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json','x-modus-client':'1',cookie},body:JSON.stringify(body)});
 let r=await post('/api/login',{actor:'admin',password:'test'});const admin=r.headers.get('set-cookie').split(';')[0];
 const text=JSON.stringify([{id:'alice',name:'Alice'}]);r=await post('/api/company/import/preview',{format:'json',text},admin);assert.equal(r.status,200);const preview=await r.json();assert.deepEqual(preview.errors,[]);
 r=await post('/api/company/import/apply',{format:'json',text,digest:preview.digest},admin);assert.equal(r.status,200);assert.equal((await r.json()).added,1);
 r=await post('/api/company/credential',{id:'alice',action:'issue'},admin);const cred=await r.json();assert.ok(cred.password);r=await post('/api/company/credential',{id:'alice',action:'issue'},admin);assert.equal((await r.json()).password,null);
 r=await post('/api/login',{actor:'employee',password:'test'});const employee=r.headers.get('set-cookie').split(';')[0];
 r=await post('/api/cases',{key:'a',title:'Idea',description:'Text',department:'Склад',category:app.store.categories()[0]},employee);const c=await r.json();
 r=await fetch(base+'/api/cases/'+c.taskId+'/workroom',{headers:{cookie:employee}});assert.equal(r.status,200);const room=await r.json();
 r=await post('/api/cases/'+c.taskId+'/workroom/message',{body:'Saved',key:'m1',expectedRevision:room.revision},employee);assert.equal(r.status,200);assert.equal((await r.json()).body,'Saved');
});
test('authority callback is bearer-only and does not use browser session',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'modus-authority-'));
 const adapter={messaging:{},messagingV2:{},caseAnalysis:{},configureAuthority:async()=>({})};
 const app=createPlatformServer({dir,seed:false,adapter});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.server.close());
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const payload={employeeId:'employee',channelId:'telegram',operationId:'op'};const grant=app.authority.issue(app.store.person('admin'),{action:'binding_prepare',payload});const query={space:'modus-platform',grantId:grant.grantId,action:'binding_prepare',payloadHash:require('../vendor/adapter-platform/grant-hash.cjs').payloadHash(payload)};
 let r=await fetch(base+'/internal/adapter/verify',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+app.authority.secret},body:JSON.stringify(query)});assert.equal(r.status,200);r=await fetch(base+'/internal/adapter/verify',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer invalid'},body:JSON.stringify(query)});assert.equal(r.status,403);
});
test('employee webhook forwards raw bytes and signature without echoing rejected inputs',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'modus-webhook-')),calls=[];const adapter={channelControl:async(method,input)=>{calls.push({method,input});if(method==='adapter_employee_webhook_challenge')return {challenge:input.challenge};if(input.signature!=='valid')throw Error('SECRET SHOULD NOT ECHO');return {ok:true};}};
 const app=createPlatformServer({dir,seed:false,adapter});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.server.close());const base=`http://127.0.0.1:${app.server.address().port}`;const raw=Buffer.from([0,255,123,10]);
 let r=await fetch(base+'/webhooks/employee/employee-wa-demo',{method:'POST',headers:{'x-hub-signature-256':'valid'},body:raw});assert.equal(r.status,200);assert.equal(calls[0].input.rawBase64,raw.toString('base64'));assert.equal(calls[0].input.signature,'valid');
 r=await fetch(base+'/webhooks/employee/employee-wa-demo',{method:'POST',headers:{'x-hub-signature-256':'invalid'},body:raw});assert.equal(r.status,403);assert.ok(!(await r.text()).includes('SECRET'));
 r=await fetch(base+'/webhooks/employee/employee-wa-demo?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=xyz');assert.equal(await r.text(),'xyz');
 r=await fetch(base+'/webhooks/employee/employee-max-demo',{method:'POST',body:Buffer.alloc(1048577)});assert.equal(r.status,413);
});
test('configured HTTPS host and origin are scoped while foreign origins and hosts fail',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'modus-origin-')),app=createPlatformServer({dir,seed:false,passwords:{admin:'test'}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.server.close());const base=`http://127.0.0.1:${app.server.address().port}`;const post=(p,body,headers={})=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json','x-modus-client':'1',...headers},body:JSON.stringify(body)});
 let r=await post('/api/login',{actor:'admin',password:'test'});const cookie=r.headers.get('set-cookie').split(';')[0];r=await post('/api/company/external-origin',{origin:'https://company.example'}, {cookie});assert.equal(r.status,200);
 const direct=(host,origin,method='POST',route='/api/login')=>new Promise((resolve,reject)=>{const req=require('node:http').request({host:'127.0.0.1',port:app.server.address().port,path:route,method,headers:{host,origin,'content-type':'application/json','x-modus-client':'1'}},res=>{res.resume();res.on('end',()=>resolve(res));});req.on('error',reject);req.end(method==='POST'?JSON.stringify({actor:'admin',password:'test'}):undefined);});
 r=await direct('company.example','https://company.example');assert.equal(r.statusCode,200);assert.match(r.headers['set-cookie'][0],/Secure/);
 r=await direct('company.example','https://evil.example');assert.equal(r.statusCode,403);
 r=await direct('evil.example','https://evil.example','GET','/health');assert.equal(r.statusCode,403);
 r=await post('/api/company/external-origin',{origin:'https://user:pass@company.example/path?x=1'},{cookie});assert.equal(r.status,400);
});
test('channel control requires admin and passes only exact allowed configuration fields',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'modus-control-')),calls=[],adapter={channelControl:async(method,input)=>(calls.push({method,input}),{ok:true})},app=createPlatformServer({dir,seed:false,passwords:{admin:'test',employee:'test'},adapter});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.server.close());const base=`http://127.0.0.1:${app.server.address().port}`;const post=(p,body,cookie='')=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json','x-modus-client':'1',cookie},body:JSON.stringify(body)});let r=await post('/api/login',{actor:'employee',password:'test'});const employee=r.headers.get('set-cookie').split(';')[0];r=await post('/api/company/channel/configure',{channel:'telegram'},employee);assert.equal(r.status,403);r=await post('/api/login',{actor:'admin',password:'test'});const admin=r.headers.get('set-cookie').split(';')[0];r=await post('/api/company/channel/configure',{channel:'telegram',channelId:'employee-tg-test',organizationId:'org',account:'a'.repeat(32),botId:'123',evil:'drop'},admin);assert.equal(r.status,200);assert.equal(calls[0].method,'adapter_employee_telegram_configure');assert.equal(calls[0].input.evil,undefined);
});
test('build label is taken only from a matching R6 suite manifest',()=>{
 const {releaseBuild}=require('../platform-server.cjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'modus-manifest-'));assert.equal(releaseBuild(dir),null);fs.writeFileSync(path.join(dir,'suite-manifest.json'),JSON.stringify({schema:1,version:'r5-3.0.0-b1'}));assert.equal(releaseBuild(dir),null);fs.writeFileSync(path.join(dir,'suite-manifest.json'),JSON.stringify({schema:1,version:'r6-4.0.0-b1'}));assert.equal(releaseBuild(dir),'r6-4.0.0-b1');
});
test('protected card HTTP requires exact current recipient and login page does not reveal title',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'modus-card-http-')),app=createPlatformServer({dir,seed:false,passwords:{employee:'test',employee2:'test'}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.server.close());const base=`http://127.0.0.1:${app.server.address().port}`,author=app.store.person('employee'),card=app.store.create(author,{key:'card',title:'Secret title unique',description:'D',department:'Склад',category:app.store.categories()[0]}),token=app.cards.issue(card.taskId,author.id);let r=await fetch(base+'/card/'+token);assert.equal(r.status,200);assert.doesNotMatch(await r.text(),/Secret title unique/);r=await fetch(base+'/api/card/'+token);assert.equal(r.status,401);const login=async id=>{const x=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json','x-modus-client':'1'},body:JSON.stringify({actor:id,password:'test'})});return x.headers.get('set-cookie').split(';')[0];};const other=await login('employee2'),own=await login('employee');assert.equal((await fetch(base+'/api/card/'+token,{headers:{cookie:other}})).status,404);r=await fetch(base+'/api/card/'+token,{headers:{cookie:own}});assert.equal(r.status,200);assert.equal((await r.json()).caseId,card.taskId);
});
