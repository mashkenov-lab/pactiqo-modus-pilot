'use strict';
async function companyRequest(view,path,body){const result=await api(path,body);if(!currentView(view)||!state.actor.admin)throw Error('Экран уже закрыт');return result;}
async function openCompany() {
  const opening = newView();
  if (!opening.actorId || !state.actor.admin) return;
  const company = await api('/company');
  if (!currentView(opening) || !state.actor.admin) return;
  const people = Object.values(company.people);
  modal(modalHead('Компания и ответственность') + `
    <p>Контакты в справочнике не подтверждают привязку к провайдеру.</p><button type="button" id="company-channels">Каналы и почта</button>
    <h3>Резервная копия</h3><p>Копия сохраняется в защищённой папке приложения и содержит данные компании. Учётные записи и подключения могут зависеть от этого компьютера.</p><button type="button" id="company-backup">Создать копию</button><p id="company-backup-result"></p>
    <h3>Сотрудники</h3><div class="table-wrap"><table><thead><tr><th>Имя</th><th>Роль и подразделение</th><th>Статус</th><th>Действия</th></tr></thead><tbody>
    ${people.map(p=>`<tr><td>${esc(p.name)}<small class="subline">${esc(p.id)}</small></td><td>${esc(p.admin?'Администратор':p.role)} · ${esc(p.department)}</td><td>${p.active?'Активен':'Отключён'} · провайдер не подтверждён справочником</td><td><button type="button" data-edit-person="${esc(p.id)}">Изменить</button> <button type="button" data-issue-person="${esc(p.id)}">Выдать пароль</button></td></tr>`).join('')}
    </tbody></table></div>
    <h3>Импорт сотрудников</h3><label>Формат<select id="company-format"><option value="csv">CSV</option><option value="json">JSON</option></select></label>
    <label>Файл<input type="file" id="company-file" accept=".csv,.json"></label><label>Текст<textarea id="company-text" rows="6"></textarea></label>
    <p><a href="/company-demo.csv" download>Скачать синтетический образец CSV</a></p>
    <button type="button" id="company-preview">Предварительный просмотр</button><div id="company-preview-result"></div><button type="button" id="company-apply" disabled>Применить просмотренный импорт</button>
    <h3>Документ ответственности</h3><p>Текст предоставляется администратором; его происхождение и применимость требуют проверки.</p>
    <form id="company-document" class="stack"><label>Название<input name="title" required></label><label>Источник<input name="sourceName" required></label><label>Текст<textarea name="body" required maxlength="20000"></textarea></label>
    <label>Подразделение<select name="department">${options(company.departments)}</select></label><label>Ответственный<select name="ownerId">${options(people.filter(p=>p.active&&['owner','manager'].includes(p.role)))}</select></label>
    <label>Вид<select name="kind"><option value="process">Процесс</option><option value="job-description">Должностная инструкция</option></select></label><label><input type="checkbox" name="approved"> Утверждён администратором</label><button>Сохранить документ</button></form>
    <div>${company.responsibilities.map(d=>`<p><strong>${esc(d.title)}</strong> · ${esc(d.sourceName)} · ${esc(company.people[d.ownerId]?.name||d.ownerId)} · ${d.approved?'утверждён':'черновик'}</p>`).join('')}</div>`);
  const view={epoch:uiEpoch,actorId:opening.actorId};
  const call=(path,body)=>companyRequest(view,path,body);
  $('#company-channels').onclick=()=>openCompanyChannels(company).catch(err=>toast(err.message));
  $('#company-backup').onclick=async e=>{const button=e.currentTarget;button.disabled=true;try{const result=await call('/company/backup',{});$('#company-backup-result').textContent='Создана копия '+result.name+' · файлов: '+result.files+'. Храните её в защищённом месте.';}catch(err){if(currentView(view))$('#company-backup-result').textContent=err.message;}finally{if(button.isConnected)button.disabled=false;}};
  let preview=null, original=null;
  $('#company-file').onchange=async e=>{const file=e.target.files[0];if(file){const text=await file.text();if(!currentView(view))return;$('#company-text').value=text;$('#company-format').value=file.name.toLowerCase().endsWith('.json')?'json':'csv';preview=null;$('#company-apply').disabled=true;}};
  $('#company-text').oninput=()=>{preview=null;$('#company-apply').disabled=true;};
  $('#company-format').onchange=()=>{preview=null;$('#company-apply').disabled=true;};
  $('#company-preview').onclick=async()=>{try{original={format:$('#company-format').value,text:$('#company-text').value};preview=await call('/company/import/preview',original);$('#company-preview-result').textContent=JSON.stringify(preview,null,2);$('#company-apply').disabled=!!preview.errors.length;}catch(err){if(currentView(view))toast(err.message);}};
  $('#company-apply').onclick=async()=>{try{await call('/company/import/apply',{...original,digest:preview.digest});toast('Импорт сохранён. Пароли выдаются отдельно.');await openCompany();}catch(err){if(currentView(view))toast(err.message);}};
  $('#company-document').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,fd=new FormData(form),button=form.querySelector('button');button.disabled=true;try{await call('/company/responsibility',{...Object.fromEntries(fd),approved:fd.has('approved')});toast('Документ сохранён');await openCompany();}catch(err){if(currentView(view))toast(err.message);}finally{button.disabled=false;}};
  $('#modal').querySelectorAll('[data-issue-person]').forEach(button=>button.onclick=async()=>{try{const r=await call('/company/credential',{id:button.dataset.issuePerson,action:'issue'});toast(r.password?'Пароль показан один раз ниже':'Учётная запись уже имеет пароль');const output=document.createElement('p');output.textContent=r.password||'Для замены используйте сброс в карточке сотрудника';button.after(output);}catch(err){if(currentView(view))toast(err.message);}});
  $('#modal').querySelectorAll('[data-edit-person]').forEach(button=>button.onclick=()=>editPerson(company,button.dataset.editPerson));
}
function editPerson(company,id){
 if(!state?.actor?.admin)return;
 const p=company.people[id];modal(modalHead('Сотрудник: '+p.name)+`<form id="company-person" class="stack"><label>Имя<input name="name" required value="${esc(p.name)}"></label><label>Подразделение<input name="department" value="${esc(p.department)}"></label><label>Должность<input name="position" value="${esc(p.position)}"></label><label>Руководитель<select name="managerId">${options(Object.values(company.people).filter(x=>x.id!==id),p.managerId,'Не указан')}</select></label><label>Роль<select name="role">${options([{id:'employee',name:'Сотрудник'},{id:'owner',name:'Ответственный'},{id:'manager',name:'Руководитель'},{id:'admin',name:'Администратор'}],p.admin?'admin':p.role)}</select></label><label>Телефон<input name="phone" value="${esc(p.phone)}"></label><label>Email<input name="email" value="${esc(p.email)}"></label><label>Предпочитаемый канал<select name="preferredChannel">${options(['web','whatsapp','telegram','max','mail'],p.preferredChannel)}</select></label><label><input type="checkbox" name="active" ${p.active?'checked':''}> Активен</label><button>Сохранить</button></form><button type="button" id="company-reset">Сбросить пароль</button><div id="company-credential"></div><button type="button" id="company-back">Назад</button>`);
 const view={epoch:uiEpoch,actorId:state.actor.id};
 const call=(path,body)=>companyRequest(view,path,body);
 $('#company-back').onclick=()=>openCompany().catch(e=>toast(e.message));
 $('#company-person').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,fd=new FormData(form);if(p.active&&!fd.has('active')&&!confirm('Отключить учётную запись? Доступ сотрудника завершится.'))return;try{await call('/company/staff',{...Object.fromEntries(fd),active:fd.has('active'),id,revision:p.revision});toast('Сотрудник сохранён');await openCompany();}catch(err){if(currentView(view))toast(err.message);}};
 $('#company-reset').onclick=async()=>{try{const r=await call('/company/credential',{id,action:'reset'});$('#company-credential').textContent='Новый пароль (показывается один раз): '+r.password;}catch(err){if(currentView(view))toast(err.message);}};
}
document.addEventListener('click',e=>{if(e.target.closest('[data-company]'))openCompany().catch(err=>toast(err.message));});
async function openCompanyChannels(company) {
  modal(modalHead('Каналы компании')+`<p>Состояние провайдера и подтверждение сотрудника проверяются отдельно. Настройка не создаёт подписку или публичный доступ.</p>
    <button type="button" id="authority-register">Подключить Адаптер к этой локальной платформе</button> <button type="button" id="channels-status">Проверить состояние каналов</button><pre id="channels-view"></pre><div id="binding-actions"></div><button type="button" id="delivery-status">Квитанции уведомлений</button><pre id="delivery-view"></pre>
    <h3>Привязка сотрудника</h3><label>Сотрудник<select id="bind-person">${options(Object.values(company.people).filter(p=>p.active))}</select></label><label>Канал<select id="bind-channel"></select></label><button type="button" id="bind-prepare">Создать запрос</button><button type="button" id="bind-proof" disabled>Проверить входящее подтверждение</button><button type="button" id="bind-confirm" disabled>Подтвердить привязку</button><pre id="bind-result"></pre>
    <h3>Настроить канал</h3><p>Секреты вводятся только в эту локальную форму и очищаются после вызова.</p><label>Тип<select id="channel-kind"><option value="telegram">Telegram</option><option value="whatsapp">WhatsApp</option><option value="max">MAX</option></select></label><div id="channel-fields"></div><button type="button" id="channel-save">Сохранить настройки</button><button type="button" id="telegram-accounts">Загрузить локальные аккаунты Telegram</button><div id="telegram-info"></div>
    <h3>Адрес HTTPS для будущего подключения</h3><p>Требуется отдельно настроенный TLS reverse proxy; доступ с телефона не проверен.</p><label>HTTPS origin<input id="external-origin" placeholder="https://company.example"></label><button type="button" id="external-save">Сохранить адрес</button><p id="webhook-description"></p>
    <h3>Выбранное письмо Gmail</h3><p>Выберите одно наблюдаемое письмо; открытие может изменить статус прочтения. Вложения не импортируются.</p><button type="button" id="mail-load">Загрузить подключения Gmail</button><select id="mail-connection"></select><button type="button" id="mail-candidates">Показать доступные письма</button><div id="mail-list"></div>
    <h4>Проверить уже открытое письмо</h4><p>Предпросмотр показывает только метаданные открытого письма и сам по себе не подтверждает связь со строкой входящих. Проверьте тему, отправителя и аккаунт перед чтением содержимого.</p><label>Точная тема<input id="mail-subject" maxlength="500"></label><label>Точный email отправителя<input id="mail-sender" maxlength="320"></label><button type="button" id="mail-preview">Показать метаданные открытого письма</button><pre id="mail-preview-result"></pre><button type="button" id="mail-stage" disabled>Подтверждаю это открытое письмо — прочитать содержимое</button>
    <button type="button" id="mail-import" disabled>Подтвердить импорт выбранного письма</button><pre id="mail-result"></pre><button type="button" id="channels-back">Назад к компании</button>`);
  const view={epoch:uiEpoch,actorId:state.actor.id};
  const call=(path,body)=>companyRequest(view,path,body);
  let challenge=null,proof=null,list=null,selected=null,openedPreview=null,accounts=[],mailGeneration=0,mailBusy=false;
  function syncMailControls(){for(const id of ['mail-load','mail-candidates','mail-preview'])$('#'+id).disabled=mailBusy;$('#mail-stage').disabled=mailBusy||!openedPreview;$('#mail-import').disabled=mailBusy||!selected;$('#mail-connection').disabled=mailBusy;$('#mail-subject').disabled=mailBusy;$('#mail-sender').disabled=mailBusy;$('#mail-list').querySelectorAll('button').forEach(button=>button.disabled=mailBusy);}
  function clearMailSelection(){mailGeneration++;selected=null;openedPreview=null;$('#mail-result').textContent='';$('#mail-preview-result').textContent='';syncMailControls();}
  $('#channels-back').onclick=()=>openCompany().catch(e=>toast(e.message));
  $('#authority-register').onclick=async()=>{try{await call('/company/authority/configure',{});toast('Регистрация полномочий выполнена. Доставка не проверена.');}catch(e){if(currentView(view))toast(e.message);}};
  $('#channels-status').onclick=async()=>{try{const status=await call('/company/connections');$('#channels-view').textContent=JSON.stringify(status,null,2);$('#bind-channel').innerHTML=options((status.bindings?.channels||[]).map(c=>({id:c.channelId,name:c.channel+' · '+c.channelId+' · '+(c.reason||'состояние получено')})));const host=$('#binding-actions');host.replaceChildren();for(const binding of status.bindings?.bindings||[]){if(!binding.enabled||binding.channelId==='owner-modus')continue;const button=document.createElement('button');button.type='button';button.textContent='Отозвать '+binding.employeeId+' · '+binding.channelId;button.onclick=async()=>{try{await call('/company/binding/revoke',{bindingId:binding.bindingId,operationId:crypto.randomUUID(),expectedRevision:binding.revision});toast('Привязка отозвана');button.disabled=true;}catch(e){if(currentView(view))toast(e.message);}};host.append(button);}}catch(e){if(currentView(view))$('#channels-view').textContent=e.message;}};
  $('#delivery-status').onclick=async()=>{try{$('#delivery-view').textContent=JSON.stringify(await call('/company/delivery'),null,2);}catch(e){if(currentView(view))toast(e.message);}};
  $('#bind-prepare').onclick=async()=>{try{challenge=await call('/company/binding/prepare',{employeeId:$('#bind-person').value,channelId:$('#bind-channel').value});$('#bind-result').textContent=JSON.stringify(challenge,null,2);$('#bind-proof').disabled=false;$('#bind-confirm').disabled=true;}catch(e){if(currentView(view))toast(e.message);}};
  $('#bind-proof').onclick=async()=>{try{proof=await call('/company/binding/proof',{challengeId:challenge.challengeId});$('#bind-result').textContent=JSON.stringify(proof,null,2);$('#bind-confirm').disabled=false;}catch(e){if(currentView(view))toast(e.message);}};
  $('#bind-confirm').onclick=async()=>{try{await call('/company/binding/confirm',{challengeId:challenge.challengeId,proofId:proof.proofId});$('#bind-confirm').disabled=true;toast('Привязка подтверждена провайдером');}catch(e){if(currentView(view))toast(e.message);}};
  function fields(){const kind=$('#channel-kind').value;const common='<label>ID канала<input name="channelId" required></label><label>ID организации<input name="organizationId" required></label>';const specific=kind==='telegram'?`<label>Локальный аккаунт<select name="account">${options(accounts.map(a=>({id:a.account,name:a.label+' · '+(a.reason||'готов')})))}</select></label><label>Bot ID выбранного аккаунта<input name="botId" readonly value="${esc(accounts[0]?.botId||'')}"></label>`:kind==='whatsapp'?['phoneId','wabaId','graphVersion','accessToken','appSecret','verifyToken'].map(x=>`<label>${x}<input name="${x}" ${/Token|Secret/.test(x)?'type="password" autocomplete="off"':''} required></label>`).join(''):['botId','accessToken','webhookSecret'].map(x=>`<label>${x}<input name="${x}" ${/Token|Secret/.test(x)?'type="password" autocomplete="off"':''} required></label>`).join('');$('#channel-fields').innerHTML=common+specific;const account=$('#channel-fields [name=account]');if(account)account.onchange=()=>{$('#channel-fields [name=botId]').value=accounts.find(a=>a.account===account.value)?.botId||'';};}
  $('#channel-kind').onchange=fields;fields();
  $('#telegram-accounts').onclick=async()=>{try{const [r,local]=await Promise.all([call('/company/telegram-accounts'),call('/company/telegram-local')]);accounts=r.accounts;fields();const info=$('#telegram-info');info.replaceChildren();info.append(document.createTextNode(accounts.length?'Выберите существующий локальный аккаунт.':'Локальные аккаунты не найдены.'));if(local.managementUrl){const link=document.createElement('a');link.href=local.managementUrl;link.target='_blank';link.rel='noopener noreferrer';link.textContent=' Управление локальным Telegram';info.append(link);}}catch(e){if(currentView(view))$('#telegram-info').textContent='Список недоступен: '+e.message;}};
  $('#channel-save').onclick=async()=>{const fieldsRoot=$('#channel-fields'),values=Object.fromEntries([...fieldsRoot.querySelectorAll('input,select')].map(x=>[x.name,x.value]));try{await call('/company/channel/configure',{...values,channel:$('#channel-kind').value});toast('Настройка сохранена; фактический обмен требует отдельной проверки.');}catch(e){if(currentView(view))toast(e.message);}finally{fieldsRoot.querySelectorAll('input[type=password]').forEach(x=>x.value='');}};
  try{const setting=await call('/company/external-origin');$('#external-origin').value=setting.origin||'';$('#webhook-description').textContent=setting.origin?'Настроенный origin; сеть не проверена. Webhook: '+setting.origin+'/webhooks/employee/<channelId>':'Публичный адрес не настроен.';}catch(e){if(currentView(view))toast(e.message);}
  if(!currentView(view))return;
  $('#external-save').onclick=async()=>{try{const r=await call('/company/external-origin',{origin:$('#external-origin').value.trim()});$('#webhook-description').textContent=r.origin?'Настроено; сеть не проверена. Webhook: '+r.origin+'/webhooks/employee/<channelId>':'Публичный адрес не настроен.';}catch(e){if(currentView(view))toast(e.message);}};
  $('#mail-connection').onchange=()=>{clearMailSelection();list=null;$('#mail-list').replaceChildren();};
  $('#mail-subject').oninput=clearMailSelection;
  $('#mail-sender').oninput=clearMailSelection;
  $('#mail-load').onclick=async()=>{
    clearMailSelection(); list=null; $('#mail-list').replaceChildren();const generation=mailGeneration;mailBusy=true;syncMailControls();
    try{const rows=await call('/company/mail/connections');if(generation!==mailGeneration)return;$('#mail-connection').innerHTML=options(rows.map(x=>({id:x.id,name:x.label})));}
    catch(error){if(currentView(view))toast(error.message);}
    finally{if(currentView(view)&&generation===mailGeneration){mailBusy=false;syncMailControls();}}
  };
  $('#mail-candidates').onclick=async()=>{
    clearMailSelection();list=null;const generation=mailGeneration, connection=$('#mail-connection').value;
    $('#mail-list').replaceChildren();mailBusy=true;syncMailControls();
    try{
      const result=await call('/company/mail/candidates',{connection});
      if(generation!==mailGeneration)return;
      list=result;const host=$('#mail-list');
      for(const item of list.items||[]){
        const button=document.createElement('button');button.type='button';button.textContent=item.sender+' · '+item.subject;
        button.onclick=async()=>{
          clearMailSelection();const selectionGeneration=mailGeneration;
          $('#mail-subject').value=item.subject||'';$('#mail-sender').value=item.senderEmail||'';
          mailBusy=true;syncMailControls();
          try{
            const snapshot=await call('/company/mail/select',{connection,rowId:item.rowId,subject:item.subject,sender:item.sender,revision:result.revision});
            if(selectionGeneration!==mailGeneration)return;
            selected={snapshotId:snapshot.snapshotId,hash:snapshot.hash,revision:snapshot.revision};
            $('#mail-result').textContent='Выбрано: '+item.sender+' · '+item.subject+'\nСнимок: '+selected.snapshotId+'; проверьте и подтвердите импорт.';
            $('#mail-import').disabled=false;
          }catch(error){if(currentView(view)&&selectionGeneration===mailGeneration){$('#mail-result').textContent='Связь со строкой входящих не подтверждена. Можно отдельно проверить метаданные уже открытого письма.';toast(error.message);}}finally{if(currentView(view)&&selectionGeneration===mailGeneration){mailBusy=false;syncMailControls();}}
        };
        host.append(button);
      }
    }catch(error){if(currentView(view)&&generation===mailGeneration)toast(error.message);}
    finally{if(currentView(view)&&generation===mailGeneration){mailBusy=false;syncMailControls();}}
  };
  $('#mail-preview').onclick=async()=>{
    clearMailSelection();const generation=mailGeneration,connection=$('#mail-connection').value,subject=$('#mail-subject').value,sender=$('#mail-sender').value;
    mailBusy=true;syncMailControls();
    try{const result=await call('/company/mail/preview',{connection,subject,sender});if(generation!==mailGeneration)return;openedPreview={connection,identity:result.identity};const i=openedPreview.identity;$('#mail-preview-result').textContent='Открытое письмо (связь со строкой входящих не подтверждена):\nОтправитель: '+i.sender+'\nТема: '+i.subject+'\nID: '+i.messageId+'\nАккаунт: '+i.accountUrl+'\nВерсия: '+i.revision;}
    catch(error){if(currentView(view)&&generation===mailGeneration)toast(error.message);}
    finally{if(currentView(view)&&generation===mailGeneration){mailBusy=false;syncMailControls();}}
  };
  $('#mail-stage').onclick=async()=>{
    if(!openedPreview)return;const expected=structuredClone(openedPreview),generation=mailGeneration;mailBusy=true;syncMailControls();
    try{const snapshot=await call('/company/mail/stage',{connection:expected.connection,expectedIdentity:expected.identity});if(generation!==mailGeneration)return;openedPreview=null;selected={snapshotId:snapshot.snapshotId,hash:snapshot.hash,revision:snapshot.revision};$('#mail-result').textContent='Содержимое подготовлено. Проверьте выбранное письмо и отдельно подтвердите импорт.';}
    catch(error){if(currentView(view)&&generation===mailGeneration){clearMailSelection();toast(error.message);}}
    finally{if(currentView(view)){mailBusy=false;syncMailControls();}}
  };
  $('#mail-import').onclick=async()=>{
    if(!selected)return;
    const expected={...selected},generation=mailGeneration;mailBusy=true;syncMailControls();
    try{
      const result=await call('/company/mail/import',expected);
      if(generation!==mailGeneration)return;
      $('#mail-result').textContent='Источник: '+result.source+'\nТема: '+result.subject+'\n\n'+result.body;
      selected=null;
    }catch(error){
      if(!currentView(view)||generation!==mailGeneration)return;
      if(error.status===409){clearMailSelection();list=null;$('#mail-list').replaceChildren();}
      toast(error.message);
    }finally{if(currentView(view)){mailBusy=false;syncMailControls();}}
  };
}

document.addEventListener('submit',async e=>{
  if(e.target.id!=='lead-assignment')return;
  e.preventDefault();const form=e.target,button=form.querySelector('button');button.disabled=true;
  try{const lead=state.communications.leads.find(x=>x.id===form.dataset.id),values=Object.fromEntries(new FormData(form));await api('/leads/'+lead.id+'/action',{...values,action:'assign',revision:lead.revision});$('#modal').close();await refresh();toast('Ответственный назначен');}catch(err){toast(err.message);}finally{button.disabled=false;}
});
