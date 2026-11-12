'use strict';
let openRoomId = null;
let roomTimer = null;
const adviceLabels = {queued:'В очереди',submitting:'ИИ готовит ответ',pending:'ИИ готовит ответ',ready:'Ответ готов',stale:'Нужен повторный анализ после изменений',error:'Ошибка'};
function stopRoom() { clearInterval(roomTimer); roomTimer = null; openRoomId = null; }
async function openWorkroom(id) {
  const opening = newView();
  if (!opening.actorId) return;
  stopRoom();
  const [room, card] = await Promise.all([api('/cases/' + id + '/workroom'), api('/cases/' + id)]);
  if (!currentView(opening)) return;
  openRoomId = id;
  modal(modalHead(room.title, '<span class="badge" id="room-phase"></span>') + `
    <p>Сообщения видят автор и ответственный; руководитель — по своим правам.</p>
    <div id="room-header"></div><div id="room-content" aria-live="polite"></div>
    <form id="room-message" class="stack"><label>Общее сообщение<textarea name="body" required maxlength="4000"></textarea></label><button class="primary">Сохранить сообщение</button></form>
    <button type="button" id="room-advice">Помочь с планом</button>
    <form id="room-plan" class="stack"><label>План исполнителя<textarea name="body" required maxlength="4000"></textarea></label><label>Срок плана, отдельно от срока обращения<input name="dueAt" type="datetime-local" required></label><button>Сохранить план</button></form>
    <button type="button" id="room-case">Действия и результат обращения</button>`);
  const view = {epoch:uiEpoch,actorId:opening.actorId};
  let latest = room, latestCard = card, requestSequence = 0, planBusy = false;
  const active = () => currentView(view) && openRoomId === id && $('#modal').open && !!$('#room-content');
  function paint(data, currentCard) {
    if (!active()) return;
    latest = data; latestCard = currentCard;
    $('#room-phase').textContent = data.number + ' · ' + (data.phase === 'new' ? 'Зарегистрировано' : state.statuses[data.phase] || 'Состояние уточняется');
    $('#room-header').innerHTML = `<p>Участники: ${data.participants.map(p => esc(p.name || p.id)+' · '+esc(roles[p.role]||p.role||'роль неизвестна')).join(', ')}</p><p><strong>Ответственный:</strong> ${esc(currentCard.owner||'не назначен')} · <strong>Результат:</strong> ${esc(currentCard.resolution?.body||'пока не представлен')}</p>`;
    $('#room-content').innerHTML = `<section><h3>Общее обсуждение</h3>${data.messages.map(m => `<p><strong>${esc(m.authorName || 'ИИ')}</strong>: ${esc(m.body)}</p>`).join('') || '<p>Сообщений пока нет.</p>'}</section>
      <p><strong>План человека:</strong> ${esc(data.plan?.body || 'не сохранён')} ${data.plan ? ' · ' + esc(dt(data.plan.dueAt)) : ''}</p>
      <p><strong>Состояние ИИ:</strong> ${esc(data.ai ? (adviceLabels[data.ai.status] || 'Состояние уточняется') : 'не запрошен')} ${esc(data.ai?.error || '')}</p>
      ${data.ai?.result ? `<p>Предложение ИИ (не утверждено): ${esc(data.ai.result.proposedPlan)}</p><p>${(data.ai.result.questions || []).map(esc).join('<br>')}</p>` : ''}`;
    const allowed = state.actor.id === currentCard.ownerId || state.actor.role === 'manager' || state.actor.admin;
    $('#room-plan').querySelectorAll('textarea,input').forEach(element => { element.disabled = !allowed; });
    $('#room-plan button').disabled = !allowed || planBusy;
  }
  paint(room, card);
  async function reload() {
    if (!active()) return;
    const sequence = ++requestSequence;
    try {
      const [nextRoom, nextCard] = await Promise.all([api('/cases/'+id+'/workroom'),api('/cases/'+id)]);
      if (!active() || sequence !== requestSequence) return;
      if (nextRoom.caseRevision !== nextCard.revision) return;
      paint(nextRoom,nextCard);
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
    e.preventDefault();const form=e.currentTarget,button=form.querySelector('button');planBusy=true;button.disabled=true;
    try { await api('/cases/'+id+'/workroom/plan',{body:form.elements.body.value,dueAt:new Date(form.elements.dueAt.value).toISOString(),expectedRevision:latest.revision});if(!active())return;form.reset();await reload();if(active())toast('План сохранён'); }
    catch(error) { if(active())toast(error.message); } finally { planBusy=false;if(button.isConnected&&active())button.disabled=!(state.actor.id===latestCard.ownerId||state.actor.role==='manager'||state.actor.admin); }
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
