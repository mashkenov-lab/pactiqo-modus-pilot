'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.MODUS_PLAYWRIGHT_MODULE);
const {createPlatformServer}=require('../platform-server.cjs');
async function fixture(t,actor='employee'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'modus-design-')),app=createPlatformServer({dir,seed:false,passwords:{employee:'test',owner:'test',admin:'test'}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));t.after(async()=>{assert.deepEqual(errors,[]);await browser.close();await new Promise(r=>app.server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 await page.goto('http://127.0.0.1:'+app.server.address().port);await page.locator('[name=actor]').selectOption(actor);await page.locator('[name=password]').fill('test');await page.locator('#login-form button').click();await page.locator('.topbar').waitFor();return {page,app};
}
function create(s,key){return s.create(s.person('employee'),{key,title:'Проверить комплектность заявки '+key,description:'Историческое описание',department:'Склад',category:s.categories()[0]});}
test('phone overview puts real awaiting actions above analytics and preserves queue filters',async t=>{
 const {page,app}=await fixture(t);const s=app.store;let a=create(s,'review');a=s.act(s.person('owner'),a.taskId,{action:'resolve',revision:a.revision,body:'Результат',evidence:'Учебная проверка'});
 await page.locator('[data-action=refresh]').evaluate(b=>b.click());await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('h1').count(),1);assert.equal(await page.locator('.nav-btn.active').count(),1);
 assert(await page.locator('.topbar').evaluate(e=>e.getBoundingClientRect().bottom<=170));
 assert(await page.locator('.action-card').evaluate(e=>e.getBoundingClientRect().top<700));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const targets=await page.locator('.nav-btn,.profile-menu>summary,.assistant-welcome button,.needs-you button').evaluateAll(els=>els.map(e=>({name:e.textContent,height:e.getBoundingClientRect().height,width:e.getBoundingClientRect().width})));assert(targets.every(x=>x.height>=44&&x.width>=44),JSON.stringify(targets));
 await page.locator('.action-card').click();await page.getByRole('button',{name:'Принять результат',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Вернуть в работу',exact:true}).count(),1);
 await page.locator('#modal').evaluate(e=>e.scrollTop=e.scrollHeight);assert(await page.locator('.current-case').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<innerHeight}));
 await page.locator('[data-action=close]').click();await page.locator('.overview-analytics>summary').click();await page.locator('[data-waiting=author]').click();assert.equal(await page.locator('[data-filter=waiting]').inputValue(),'author');
});
test('accepted room separates old progress and AI from current state without altering records',async t=>{
 const {page,app}=await fixture(t,'owner'),s=app.store;let c=create(s,'closed');
 app.workroom.post(s.person('owner'),{caseId:c.taskId,body:'Работы ещё не выполнены. '+ 'Содержательное пояснение. '.repeat(30),key:'long-message',expectedRevision:0});
 app.attention.setProgress(s.person('owner'),{caseId:c.taskId,body:'Сохранён отчёт',nextStep:'Показать результат',blocked:'Нет',checkAt:null,expectedRevision:0});
 c=s.row(s.get(c.taskId,s.person('owner')));c=s.act(s.person('owner'),c.taskId,{action:'resolve',revision:c.revision,body:'Результат',evidence:'Проверено'});c=s.act(s.person('employee'),c.taskId,{action:'accept',revision:c.revision,body:'Принято'});
 const old=JSON.stringify(s.state.modus.cases[c.taskId]);await page.evaluate(async id=>{await refresh();await showCase(id);},c.taskId);assert.match(await page.locator('#modal').innerText(),/Принятый результат/);assert.equal(await page.locator('.current-case').innerText().then(x=>(x.match(/Ответственный:/g)||[]).length),1);
 await page.locator('[data-workroom]').click();assert.match(await page.locator('.current-case').innerText(),/Не требуется/);assert.match(await page.locator('#room-closed-note').innerText(),/не откроет дело заново/);assert.equal(await page.locator('#room-plan').isVisible(),false);assert.equal(await page.locator('#attention-progress').isVisible(),false);assert.equal(await page.locator('#room-advice').isVisible(),false);assert.match(await page.locator('#attention-current').innerText(),/Прежний следующий шаг больше не требуется/);assert.match(await page.locator('#attention-history').innerText(),/напоминания не отправляются/);
 const detail=page.locator('.shared-message details');await detail.locator('summary').click();await page.waitForTimeout(3200);assert.equal(await detail.evaluate(e=>e.open),true);assert.equal(JSON.stringify(s.state.modus.cases[c.taskId]),old);
});
test('settings preview preserves exact intervals and rejects stale or fractional-hour author policy',async t=>{
 const {page,app}=await fixture(t,'admin');await page.locator('.profile-menu>summary').click();await page.locator('[data-company]').click();await page.locator('#company-attention').click();
 assert.equal(await page.locator('[name=workingDay]').count(),7);assert.equal(await page.locator('[name=timezone]').inputValue(),'Asia/Qyzylorda');assert.equal(await page.locator('#before-intervals input').count(),2);
 await page.locator('[name=beforeInterval0]').fill('61');await page.locator('[name=beforeInterval0Unit]').selectOption('1');await page.locator('[name=beforeInterval1]').fill('1.5');await page.locator('[name=beforeInterval1Unit]').selectOption('60');await page.locator('[name=responseMinutes]').fill('2');await page.locator('[name=responseMinutesUnit]').selectOption('1440');await page.locator('[name=includeExisting]').selectOption('false');await page.locator('#attention-preview').click();await page.locator('#attention-apply:not([disabled])').waitFor();
 await page.locator('[name=workingDay][value="6"]').check();assert.equal(await page.locator('#attention-apply').isDisabled(),true);await page.locator('#attention-preview').click();await page.locator('#attention-apply:not([disabled])').waitFor();await page.locator('#attention-apply').click();await page.getByText('Настройки сохранены.',{exact:false}).waitFor();assert.deepEqual(app.attention.state.policy.beforeMinutes,[61,90]);assert.equal(app.attention.state.policy.responseHours,48);assert.deepEqual(app.attention.state.policy.workingDays,[1,2,3,4,5,6]);
 await page.locator('[name=responseMinutes]').fill('61');await page.locator('[name=responseMinutesUnit]').selectOption('1');await page.locator('#attention-preview').click();assert.match(await page.locator('#attention-policy-result').innerText(),/целым числом часов/);assert.equal(await page.locator('#attention-apply').isDisabled(),true);
 await page.setViewportSize({width:390,height:844});await page.locator('#modal').evaluate(e=>e.scrollTop=0);assert(await page.locator('#attention-preview').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<innerHeight}));assert(await page.locator('#modal').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
});
test('long dialogue retains original text and labels history; new prompt uses formal tone',async t=>{
 const {page,app}=await fixture(t),s=app.store,a=s.person('employee');let c=s.openConversation(a,{kind:'employee',key:'dialog',body:'Расскажите о процессе. '+ 'Учебное предложение '.repeat(40)});c=s.confirmConversation(a,c.id,{revision:c.revision,title:'Учебное предложение',description:'Учебное описание',department:'Склад',category:s.categories()[0],type:'Предложение'});const original=JSON.stringify(s.suite.conversations[c.id].messages);
 await page.evaluate(async id=>{await refresh();await conversationModal(id);},c.id);assert.match(await page.locator('.history-note').innerText(),/История разговора/);assert.equal(await page.locator('.chat-history details').count(),1);assert.match(await page.locator('.chat-history small').innerText(),/До регистрации/);await page.locator('.chat-history summary').click();assert.equal(JSON.stringify(s.suite.conversations[c.id].messages),original);assert.match(fs.readFileSync(path.join(__dirname,'../desk-analyzer.cjs'),'utf8'),/Обращайся к человеку на «вы»/);
});
