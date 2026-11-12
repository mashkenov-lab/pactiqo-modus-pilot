'use strict';
let openRoomId = null;
let roomTimer = null;
const adviceLabels = {queued:'В очереди',submitting:'ИИ готовит ответ',pending:'ИИ готовит ответ',ready:'Ответ готов',stale:'Нужен повторный анализ после изменений',error:'Ошибка'};
function stopRoom() { clearInterval(roomTimer); roomTimer = null; openRoomId = null; }
async function openWorkroom(id) {
  const opening = newView();
  if (!opening.actorId) return;
  stopRoom();
  const [room, card, attention] = await Promise.all([api('/cases/' + id + '/workroom'), api('/cases/' + id), api('/cases/' + id + '/attention')]);
  if (!currentView(opening)) return;
  openRoomId = id;
  modal(modalHead(room.title, '<span class="badge" id="room-phase"></span>') + `
    <p>Сообщения видят автор и ответственный; руководитель — по своим правам.</p>
    <div id="room-header"></div><div id="room-content" aria-live="polite"></div>
    <form id="room-message" class="stack"><label>Общее сообщение<textarea name="body" required maxlength="4000"></textarea></label><button class="primary">Сохранить сообщение</button></form>
    <button type="button" id="room-advice">Помочь с планом</button>
    <form id="room-plan" class="stack"><label>План исполнителя<textarea name="body" required maxlength="4000"></textarea></label><label>Срок обращения<input name="dueAt" type="datetime-local" required></label><label>Причина изменения срока<textarea name="reason" maxlength="2000"></textarea></label><p id="room-plan-status" aria-live="polite"></p><button>Сохранить план</button></form>
    <section><h3>Сопровождение</h3><div id="attention-current"></div><form id="attention-progress" class="stack"><label>Что сделано<textarea name="body" maxlength="2000"></textarea></label><label>Следующий шаг<textarea name="nextStep" maxlength="2000"></textarea></label><label>Сообщённое препятствие<textarea name="blocked" maxlength="2000"></textarea></label><label>Следующая проверка<input name="checkAt" type="datetime-local"></label><button>Сохранить прогресс</button><p id="attention-progress-status" aria-live="polite"></p></form><h4>История напоминаний и доставки</h4><div id="attention-history"></div></section>
    <button type="button" id="room-case">Действия и результат обращения</button>`);
  const view = {epoch:uiEpoch,actorId:opening.actorId};
  let latest = room, latestCard = card, latestAttention=attention, requestSequence = 0, planBusy = false;
  const planForm=$('#room-plan');planForm.dataset.roomRevision=room.revision;planForm.dataset.caseRevision=room.caseRevision;
  let progressRevision=attention.progress[id]?.revision||0;
  const active = () => currentView(view) && openRoomId === id && $('#modal').open && !!$('#room-content');
  function canEditPlan(currentCard){return currentCard.phase!=='accepted'&&(state.actor.id===currentCard.ownerId||state.actor.role==='manager'||state.actor.admin);}
  function paint(data, currentCard) {
    if (!active()) return;
    latest = data; latestCard = currentCard;
    $('#room-phase').textContent = data.number + ' · ' + (data.phase === 'new' ? 'Зарегистрировано' : state.statuses[data.phase] || 'Состояние уточняется');
    $('#room-header').innerHTML = currentCaseSummary(currentCard)+`<p>Участники: ${data.participants.map(p => esc(p.name || p.id)+' · '+esc(roles[p.role]||p.role||'роль неизвестна')).join(', ')}</p><p><strong>Ответственный:</strong> ${esc(currentCard.owner||'не назначен')} · <strong>Срок:</strong> ${esc(currentCard.dueAt?dt(currentCard.dueAt):'не указан')} · <strong>Результат:</strong> ${esc(currentCard.resolution?.body||'пока не представлен')}</p>`;
    const expanded=new Set([...$('#room-content').querySelectorAll('details[open][data-detail]')].map(e=>e.dataset.detail));const focusedDetail=document.activeElement?.closest('#room-content details')?.dataset.detail;
    $('#room-content').innerHTML = `<section><h3>Общее обсуждение</h3>${data.messages.map(m => `<article class="bubble shared-message"><small>${esc(m.authorName || 'ИИ · помощник')} · ${dt(m.at||m.createdAt)}</small>${m.body.length>550?`<details data-detail="message-${esc(m.id)}"><summary>${esc(m.body.slice(0,180))}… Читать полностью</summary><p class="body-text">${esc(m.body)}</p></details>`:`<p class="body-text">${esc(m.body)}</p>`}</article>`).join('') || '<p>Сообщений пока нет.</p>'}</section>
      <p><strong>План человека:</strong> ${esc(data.plan?.body || 'не сохранён')} ${data.plan ? ' · ' + esc(dt(data.plan.dueAt)) : ''}</p>
      <p><strong>Состояние ИИ:</strong> ${esc(data.ai ? (adviceLabels[data.ai.status] || 'Состояние уточняется') : 'не запрошен')} ${esc(data.ai?.error || '')}</p>
      ${data.ai?.result ? `<details class="advice-detail" data-detail="advice-${esc(data.ai.requestId||'current')}"><summary>Предложение ИИ — раскрыть план (не утверждено)</summary><p class="body-text">${esc(data.ai.result.proposedPlan)}</p></details><p>${(data.ai.result.questions || []).map(esc).join('<br>')}</p>` : ''}`;
    $('#room-content').querySelectorAll('details[data-detail]').forEach(detail=>{if(expanded.has(detail.dataset.detail))detail.open=true;if(focusedDetail===detail.dataset.detail)detail.querySelector('summary').focus({preventScroll:true});});
    const allowed = canEditPlan(currentCard);if(currentCard.phase==='accepted')$('#room-plan-status').textContent='Результат принят. План и срок доступны только для чтения.';
    $('#room-plan').querySelectorAll('textarea,input').forEach(element => { element.disabled = !allowed; });
    $('#room-plan button').disabled = !allowed || planBusy;
  }
  function paintAttention(data) {
    if(!active())return;latestAttention=data;const progress=data.progress[id];const closed=latest.phase==='accepted';$('#attention-progress').querySelectorAll('textarea,input,button').forEach(element=>{element.disabled=closed;});if(closed)$('#attention-progress-status').textContent='Результат принят. Прогресс доступен для чтения.';
    $('#attention-current').innerHTML=`<p><strong>Что сделано:</strong> ${esc(progress?.body||'не сообщено')} · <strong>Следующий шаг:</strong> ${esc(progress?.nextStep||'не указан')} · <strong>Препятствие со слов сотрудника:</strong> ${esc(progress?.blocked||'не сообщено')} · <strong>Следующая проверка:</strong> ${esc(progress?.checkAt?dt(progress.checkAt):'не указана')}</p>${progress?`<p>Обновлено: ${esc(state.people.find(p=>p.id===progress.actorId)?.name||'участником')} · ${esc(dt(progress.at))}</p>`:''}<p>${latest.phase==='accepted'?'Результат принят, действий по обращению не ожидается.':['question','review'].includes(latest.phase)?'Ожидается ответ или приёмка автора.':'Следующее действие — у исполнителя.'}</p>`;
    const labels={queued:'Ожидает отправки; доставка не подтверждена',unsupported:'Канал не подключён; доставка не подтверждена',unknown:'Результат отправки неизвестен',accepted:'Канал принял операцию; доставка не подтверждена',sent:'Отправлено; прочтение не подтверждено',delivered:'Доставлено; прочтение не подтверждено',read:'Прочтение подтверждено',cancelled:'Отменено',failed:'Ошибка доставки',sending:'Отправка выполняется', 'failed-before-send':'Не отправлено'};
    $('#attention-history').innerHTML=data.events.map(e=>`<p>${esc(dt(e.at))} · ${esc(e.body)}<br>${e.deliveries.length?e.deliveries.map(d=>esc(labels[d.state]||'Состояние неизвестно')).join('; '):'Канал не настроен или доставка ещё не поставлена в очередь'}</p>`).join('')||'<p>Напоминаний пока нет.</p>';
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
  $('#room-message').addEventListener('submit', async e => {
    e.preventDefault(); const form=e.currentTarget, button=form.querySelector('button'); button.disabled=true;
    try { await api('/cases/'+id+'/workroom/message',{body:form.elements.body.value,key:crypto.randomUUID(),expectedRevision:latest.revision}); if(!active())return; form.reset();await reload();if(active())toast('Сообщение сохранено'); }
    catch(error) { if(active())toast(error.message); } finally { if(button.isConnected)button.disabled=false; }
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
