'use strict';
let openRoomId = null;
let roomTimer = null;
const adviceLabels = {queued:'В очереди',submitting:'ИИ готовит ответ',pending:'ИИ готовит ответ',ready:'Ответ готов',stale:'Нужен повторный анализ после изменений',error:'Ошибка'};
function stopRoom() { clearInterval(roomTimer); roomTimer = null; openRoomId = null; clearRoomFileViews(); }
async function openWorkroom(id) {
  const opening = newView();
  if (!opening.actorId) return;
  stopRoom();
  const [room, card, attention] = await Promise.all([api('/cases/' + id + '/workroom'), api('/cases/' + id), api('/cases/' + id + '/attention')]);
  if (!currentView(opening)) return;
  openRoomId = id;
  modal(modalHead(room.title, '<span class="badge" id="room-phase"></span>') + `
    <p>Сообщения видят автор и ответственный; руководитель — по своим правам.</p>
    <div id="room-header"></div><div id="room-participants"></div><div id="room-result" aria-live="polite"></div><div id="room-content" aria-live="polite"></div>
    <p id="room-closed-note" class="notice" hidden>Дело закрыто. Сообщение останется в истории и не откроет дело заново.</p><form id="room-message" class="stack"><div id="room-review-target" aria-live="polite"></div><label>Общее сообщение<textarea name="body" maxlength="4000" placeholder="Напишите коллегам или приложите материал для обсуждения…"></textarea></label><label class="room-file-picker">Прикрепить материалы<input type="file" name="files" multiple accept=".png,.jpg,.jpeg,.pdf,.txt,.docx"></label><small>До 3 файлов, суммарно до 2 МБ · PNG, JPG, PDF, TXT, DOCX</small><div id="room-selected-files" aria-live="polite"></div><p id="room-message-status" role="status"></p><button class="primary" data-room-send>Сохранить сообщение</button></form>
    <button type="button" id="room-advice">Помочь с планом</button>
    <form id="room-plan" class="stack"><label>План исполнителя<textarea name="body" required maxlength="4000"></textarea></label><label>Срок обращения<input name="dueAt" type="datetime-local" required></label><label>Причина изменения срока<textarea name="reason" maxlength="2000"></textarea></label><button>Сохранить план</button></form><p id="room-plan-status" aria-live="polite"></p>
    <section class="attention-section"><h3>Сопровождение</h3><div id="attention-current"></div><form id="attention-progress" class="stack"><label>Что сделано<textarea name="body" maxlength="2000"></textarea></label><label>Следующий шаг<textarea name="nextStep" maxlength="2000"></textarea></label><label>Сообщённое препятствие<textarea name="blocked" maxlength="2000"></textarea></label><label>Следующая проверка<input name="checkAt" type="datetime-local"></label><button>Сохранить прогресс</button><p id="attention-progress-status" aria-live="polite"></p></form><h4>История напоминаний и доставки</h4><div id="attention-history"></div></section>
    <button type="button" id="room-case">Действия и результат обращения</button>`);
  const view = {epoch:uiEpoch,actorId:opening.actorId};
  let latest = room, latestCard = card, latestAttention=attention, requestSequence = 0, planBusy = false;
  let pendingFiles=[],reviewTarget=null,sendKey=null,sendSignature=null,sendBusy=false;const roomFiles=new Map();
  const planForm=$('#room-plan');planForm.dataset.roomRevision=room.revision;planForm.dataset.caseRevision=room.caseRevision;
  let progressRevision=attention.progress[id]?.revision||0;
  const active = () => currentView(view) && openRoomId === id && $('#modal').open && !!$('#room-content');
  function canEditPlan(currentCard){return currentCard.phase!=='accepted'&&(state.actor.id===currentCard.ownerId||state.actor.role==='manager'||state.actor.admin);}
  function paint(data, currentCard) {
    if (!active()) return;
    latest = data; latestCard = currentCard;
    $('#room-phase').textContent = data.number + ' · ' + (data.phase === 'new' ? 'Зарегистрировано' : state.statuses[data.phase] || 'Состояние уточняется');
    const headerHtml=currentCaseSummary(currentCard);if($('#room-header').dataset.markup!==headerHtml){$('#room-header').innerHTML=headerHtml;$('#room-header').dataset.markup=headerHtml;}$('#room-participants').innerHTML=`<p class="tight">Участники: ${data.participants.map(p=>esc(p.name||p.id)).join(', ')}</p>`;const closed=currentCard.phase==='accepted';$('#room-closed-note').hidden=!closed;$('#room-message [data-room-send]').classList.toggle('primary',!closed);$('#room-advice').hidden=closed;$('#room-plan').hidden=closed;
    const expanded=new Set([...$('#room-content').querySelectorAll('details[open][data-detail]')].map(e=>e.dataset.detail));const focusedDetail=document.activeElement?.closest('#room-content details')?.dataset.detail;
    for(const message of data.messages)for(const file of message.attachments||[])roomFiles.set(file.id,file);
    const contentKey=JSON.stringify([data.revision,currentCard.phase,data.ai?.status,data.ai?.result,data.plan]);
    if($('#room-content').dataset.contentKey!==contentKey){$('#room-content').dataset.contentKey=contentKey;
    $('#room-content').innerHTML = `<section><h3>Общее обсуждение</h3>${data.messages.some(m=>m.demo)?'<p class="demo-thread-note">Учебная переписка для демонстрации: примеры материалов и согласования. Она не подтверждает реальное внедрение.</p>':''}${data.messages.map(m => `<article class="bubble shared-message ${m.role==='assistant'?'assistant':'human'}" data-message-id="${esc(m.id)}"><small>${esc(m.role==='assistant'?'Помощник PACTIQO (ИИ)':m.authorName||'Участник')} · ${dt(m.at||m.createdAt)}${m.demo?' · Учебный пример':''}${closed?' · История':''}</small>${m.reviewOf?`<div class="file-review-reference ${m.fileDecision==='approved'?'approved':'changes'}">${m.fileDecision==='approved'?'Материал согласован':'Запрошены правки'} · <button type="button" class="link" data-open-file="${esc(m.reviewOf)}">${esc(roomFiles.get(m.reviewOf)?.name||'Материал')}</button></div>`:''}${m.body?messageBody(m.body,'message-'+m.id):''}${m.attachments?.length?`<div class="room-file-grid">${roomFileMarkup(m,data.messages)}</div>`:''}</article>`).join('') || '<p>Сообщений пока нет.</p>'}</section>
      <p><strong>План человека:</strong> ${esc(data.plan?.body || 'не сохранён')} ${data.plan ? ' · ' + esc(dt(data.plan.dueAt)) : ''}</p>
      <p ${closed?'hidden':''}><strong>Состояние ИИ:</strong> ${esc(data.ai ? (adviceLabels[data.ai.status] || 'Состояние уточняется') : 'не запрошен')} ${esc(data.ai?.error || '')}</p>
      ${data.ai?.result ? `<details class="advice-detail" data-detail="advice-${esc(data.ai.requestId||'current')}"><summary>${closed?'Историческое предложение ИИ · до принятия результата':'Предложение ИИ — раскрыть план (не утверждено)'}</summary><p class="body-text">${esc(data.ai.result.proposedPlan)}</p></details><p>${(data.ai.result.questions || []).map(esc).join('<br>')}</p>` : ''}`;
    $('#room-content').querySelectorAll('details[data-detail]').forEach(detail=>{if(expanded.has(detail.dataset.detail))detail.open=true;if(focusedDetail===detail.dataset.detail)detail.querySelector('summary').focus({preventScroll:true});});
    void paintFilePreviews($('#room-content'),roomFiles,active);}
    $('#room-result').innerHTML=currentCard.resolution?`<section class="notice ${closed?'accepted-result':'pending-result'}"><strong>${closed?'Принятый результат':'Результат на проверке'}</strong><p class="body-text">${esc(currentCard.resolution.body)}</p><p class="tight">${esc(currentCard.resolution.evidence||'')}</p></section>`:'';
    const allowed = canEditPlan(currentCard);
    $('#room-plan').querySelectorAll('textarea,input').forEach(element => { element.disabled = !allowed; });
    $('#room-plan button').disabled = !allowed || planBusy;
  }
  function paintAttention(data) {
    if(!active())return;latestAttention=data;const progress=data.progress[id];const closed=latest.phase==='accepted';$('#attention-progress').querySelectorAll('textarea,input,button').forEach(element=>{element.disabled=closed;});$('#attention-progress').hidden=closed;if(closed)$('#attention-progress-status').textContent='Результат принят. Прогресс доступен для чтения.';
    $('#attention-current').innerHTML=`<div class="progress-record"><p class="history-note">${closed?'Последний отчёт до закрытия. Прежний следующий шаг больше не требуется.':'Последний отчёт участника'}</p><p><strong>Что сделано:</strong> ${esc(progress?.body||'не сообщено')} · <strong>Следующий шаг:</strong> ${esc(progress?.nextStep||'не указан')} · <strong>Препятствие со слов сотрудника:</strong> ${esc(progress?.blocked||'не сообщено')} · <strong>Следующая проверка:</strong> ${esc(progress?.checkAt?dt(progress.checkAt):'не указана')}</p>${progress?`<p>Обновлено: ${esc(state.people.find(p=>p.id===progress.actorId)?.name||'участником')} · ${esc(dt(progress.at))}</p>`:''}<p>${latest.phase==='accepted'?'Результат принят, действий по обращению не ожидается.':['question','review'].includes(latest.phase)?'Ожидается ответ или приёмка автора.':'Следующее действие — у исполнителя.'}</p></div>`;
    const labels={queued:'Ожидает отправки; доставка не подтверждена',unsupported:'Канал не подключён; доставка не подтверждена',unknown:'Результат отправки неизвестен',accepted:'Канал принял операцию; доставка не подтверждена',sent:'Отправлено; прочтение не подтверждено',delivered:'Доставлено; прочтение не подтверждено',read:'Прочтение подтверждено',cancelled:'Отменено',failed:'Ошибка доставки',sending:'Отправка выполняется', 'failed-before-send':'Не отправлено'};
    $('#attention-history').innerHTML=data.events.map(e=>`<p>${esc(dt(e.at))} · ${esc(e.body)}<br>${e.deliveries.length?e.deliveries.map(d=>esc(labels[d.state]||'Состояние неизвестно')).join('; '):'Канал не настроен или доставка ещё не поставлена в очередь'}</p>`).join('')||(closed?'<p>Дело закрыто — напоминания не отправляются.</p>':'<p>Напоминаний пока нет.</p>');
  }
  paint(room, card);paintAttention(attention);
  const pf=$('#attention-progress'),initialProgress=attention.progress[id];if(initialProgress){for(const k of ['body','nextStep','blocked'])pf.elements[k].value=initialProgress[k]||'';if(initialProgress.checkAt){const d=new Date(initialProgress.checkAt);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());pf.elements.checkAt.value=d.toISOString().slice(0,16);}}
  pf.onsubmit=async e=>{e.preventDefault();if(latest.phase==='accepted')return;const button=pf.querySelector('button');button.disabled=true;try{await api('/cases/'+id+'/attention/progress',{body:pf.elements.body.value,nextStep:pf.elements.nextStep.value,blocked:pf.elements.blocked.value,checkAt:pf.elements.checkAt.value?new Date(pf.elements.checkAt.value).toISOString():null,expectedRevision:progressRevision});if(!active())return;progressRevision++;$('#attention-progress-status').textContent='Прогресс сохранён.';await reload();}catch(error){if(active())$('#attention-progress-status').textContent=error.message+(error.status===409?' Откройте обсуждение заново и проверьте изменения.':'');}finally{if(active())button.disabled=latest.phase==='accepted';}};
  async function reload() {
    if (!active()) return;
    const sequence = ++requestSequence;
    try {
      const [nextRoom, nextCard, nextAttention] = await Promise.all([api('/cases/'+id+'/workroom'),api('/cases/'+id),api('/cases/'+id+'/attention')]);
      if (!active() || sequence !== requestSequence) return;
      if (nextRoom.caseRevision !== nextCard.revision) return;
      paint(nextRoom,nextCard);paintAttention(nextAttention);
    } catch (error) {
      if (!active() || sequence !== requestSequence) return;
      if (error.status === 403 || error.status === 404) {
        stopRoom(); uiEpoch++; $('#modal').close(); $('#modal').replaceChildren();
        toast('Доступ к обсуждению изменился.');
      } else toast(error.message);
    }
  }
  function drawSelection(){if(!active())return;$('#room-selected-files').innerHTML=pendingFiles.map((f,i)=>`<div class="selected-file"><span>${esc(f.name)} · ${fileSize(f.size)}</span><button type="button" data-remove-file="${i}" aria-label="Убрать ${esc(f.name)}">×</button></div>`).join('');$('#room-review-target').innerHTML=reviewTarget?`<div class="notice">${reviewTarget.decision==='approved'?'Согласование материала':'Замечания к материалу'}: <strong>${esc(reviewTarget.file.name)}</strong><p>Это решение по файлу. Статус обращения не изменится.</p><button type="button" data-cancel-review>Отменить выбор материала</button></div>`:'';}
  $('#room-message [name=files]').onchange=e=>{if(sendBusy)return;const additions=[...e.target.files],combined=[...pendingFiles,...additions];e.target.value='';if(combined.length>3||combined.reduce((n,f)=>n+f.size,0)>2*1024*1024){$('#room-message-status').textContent='До трёх файлов, суммарно до 2 МБ. Ранее выбранные материалы сохранены.';return;}if(combined.some(f=>!f.size||!(/\.(png|jpe?g|pdf|txt|docx)$/i.test(f.name)))){$('#room-message-status').textContent='Выберите непустой PNG, JPG, PDF, TXT или DOCX.';return;}pendingFiles=combined;$('#room-message-status').textContent='';drawSelection();};
  $('#room-message').addEventListener('click',e=>{if(sendBusy)return;const remove=e.target.closest('[data-remove-file]');if(remove){pendingFiles.splice(Number(remove.dataset.removeFile),1);drawSelection();}if(e.target.closest('[data-cancel-review]')){reviewTarget=null;drawSelection();}});
  $('#room-content').addEventListener('click',e=>{const open=e.target.closest('[data-open-file]'),review=e.target.closest('[data-review-file]');if(open){const file=roomFiles.get(open.dataset.openFile);if(file)void openRoomFile(file);return;}if(review){if(sendBusy)return;const file=roomFiles.get(review.dataset.reviewFile);if(!file)return;reviewTarget={file,decision:review.dataset.fileDecision};drawSelection();const input=$('#room-message [name=body]');if(!input.value.trim())input.value=reviewTarget.decision==='approved'?'Материал проверен, замечаний нет.':'Прошу доработать: ';input.focus();}});
  $('#room-message').addEventListener('submit', async e => {
    e.preventDefault();if(sendBusy)return;sendBusy=true; const form=e.currentTarget, button=form.querySelector('[data-room-send]');button.disabled=true;form.querySelectorAll('[data-remove-file],[data-cancel-review]').forEach(b=>b.disabled=true);form.elements.files.disabled=true;form.elements.body.disabled=true;
    try {if(!form.elements.body.value.trim()&&!pendingFiles.length)throw Error('Напишите сообщение или приложите файл.');const attachments=await encodeRoomFiles(pendingFiles),payload={body:form.elements.body.value,attachments,reviewOf:reviewTarget?.file.id||null,fileDecision:reviewTarget?.decision||null};const signature=JSON.stringify(payload);if(sendSignature!==signature){sendSignature=signature;sendKey=crypto.randomUUID();}await api('/cases/'+id+'/workroom/message',{...payload,key:sendKey,expectedRevision:latest.revision}); if(!active())return; form.reset();pendingFiles=[];reviewTarget=null;sendKey=null;sendSignature=null;drawSelection();$('#room-message-status').textContent='Сообщение и материалы сохранены.';await reload();if(active())toast('Сообщение сохранено'); }
    catch(error) { if(active()){$('#room-message-status').textContent=error.message+' Текст и выбранные материалы сохранены.';if(error.status===409)await reload();} } finally {sendBusy=false; if(button.isConnected){button.disabled=false;form.elements.files.disabled=false;form.elements.body.disabled=false;form.querySelectorAll('[data-remove-file],[data-cancel-review]').forEach(b=>b.disabled=false);} }
  });
  $('#room-plan').addEventListener('submit', async e => {
    e.preventDefault();if(!canEditPlan(latestCard))return;const form=e.currentTarget,button=form.querySelector('button');planBusy=true;button.disabled=true;
    try { await api('/cases/'+id+'/workroom/plan',{body:form.elements.body.value,dueAt:new Date(form.elements.dueAt.value).toISOString(),reason:form.elements.reason.value,expectedRevision:Number(form.dataset.roomRevision),expectedCaseRevision:Number(form.dataset.caseRevision)});if(!active())return;form.reset();await reload();if(active()){form.dataset.roomRevision=latest.revision;form.dataset.caseRevision=latest.caseRevision;toast('План сохранён');} }
    catch(error) { if(active())$('#room-plan-status').textContent=error.message+(error.status===409?' Откройте обсуждение заново и проверьте изменения.':''); } finally { planBusy=false;if(button.isConnected&&active())button.disabled=!canEditPlan(latestCard); }
  });
  $('#room-advice').addEventListener('click', async e => {
    const button=e.currentTarget; button.disabled=true;
    try { await api('/cases/'+id+'/workroom/advice',{key:crypto.randomUUID(),expectedRevision:latest.revision});if(!active())return;await reload();if(active())toast('Запрос сохранён. ИИ обрабатывает обсуждение.'); }
    catch(error) { if(active())toast(error.message); } finally { if(button.isConnected&&active())button.disabled=false; }
  });
  $('#room-case').addEventListener('click',()=>{stopRoom();showCase(id).catch(e=>toast(e.message));});
  roomTimer=setInterval(reload,3000);
}
document.addEventListener('click', e => {const button=e.target.closest('[data-workroom]');if(button){openWorkroom(button.dataset.workroom).catch(err=>toast(err.message));}});
document.querySelector('#modal').addEventListener('close',()=>{if(!$('#modal').open){stopRoom();uiEpoch++;}});
