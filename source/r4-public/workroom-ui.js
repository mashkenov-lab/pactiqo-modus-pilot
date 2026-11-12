'use strict';
let openRoomId = null;
let roomTimer = null;
const adviceLabels={queued:'В очереди',submitting:'ИИ готовит ответ',pending:'ИИ готовит ответ',ready:'Ответ готов',stale:'Нужен повторный анализ после изменений',error:'Ошибка'};
function stopRoom() { clearInterval(roomTimer); roomTimer = null; openRoomId = null; }
async function openWorkroom(id) {
  stopRoom();
  const [room, card] = await Promise.all([api('/cases/' + id + '/workroom'), api('/cases/' + id)]);
  openRoomId = id;
  modal(modalHead(room.title, `<span class="badge">${esc(room.number)} · ${esc(room.phase==='new'?'Зарегистрировано':state.statuses[room.phase] || 'Состояние уточняется')}</span>`) + `
    <p>Сообщения видят автор и ответственный; руководитель — по своим правам.</p>
    <p>Участники: ${room.participants.map(p => esc(p.name || p.id)+' · '+esc(roles[p.role]||p.role||'роль неизвестна')).join(', ')}</p><p><strong>Ответственный:</strong> ${esc(card.owner||'не назначен')} · <strong>Результат:</strong> ${esc(card.resolution?.body||'пока не представлен')}</p>
    <div id="room-content" aria-live="polite"></div>
    <form id="room-message" class="stack"><label>Общее сообщение<textarea name="body" required maxlength="4000"></textarea></label><button class="primary">Сохранить сообщение</button></form>
    <button type="button" id="room-advice">Помочь с планом</button>
    <form id="room-plan" class="stack"><label>План исполнителя<textarea name="body" required maxlength="4000"></textarea></label><label>Срок плана, отдельно от срока обращения<input name="dueAt" type="datetime-local" required></label><button>Сохранить план</button></form>
    <button type="button" id="room-case">Действия и результат обращения</button>`);
  let latest = room;
  function paint(data) {
    latest = data;
    const target = document.querySelector('#room-content');
    if (!target || openRoomId !== id || !state || !$('#modal').open) return;
    target.innerHTML = `<section><h3>Общее обсуждение</h3>${data.messages.map(m => `<p><strong>${esc(m.authorName || 'ИИ')}</strong>: ${esc(m.body)}</p>`).join('') || '<p>Сообщений пока нет.</p>'}</section>
      <p><strong>План человека:</strong> ${esc(data.plan?.body || 'не сохранён')} ${data.plan ? ' · ' + esc(dt(data.plan.dueAt)) : ''}</p>
      <p><strong>Состояние ИИ:</strong> ${esc(data.ai ? (adviceLabels[data.ai.status] || 'Состояние уточняется') : 'не запрошен')} ${esc(data.ai?.error || '')}</p>
      ${data.ai?.result ? `<p>Предложение ИИ (не утверждено): ${esc(data.ai.result.proposedPlan)}</p><p>${(data.ai.result.questions || []).map(esc).join('<br>')}</p>` : ''}`;
  }
  paint(room);
  async function reload() { if (!state || openRoomId !== id || !$('#room-content') || !$('#modal').open) return stopRoom(); try { paint(await api('/cases/' + id + '/workroom')); } catch (e) { if (openRoomId === id) toast(e.message); } }
  $('#room-message').addEventListener('submit', async e => { e.preventDefault(); const form=e.currentTarget, button=form.querySelector('button');button.disabled=true;try { await api('/cases/'+id+'/workroom/message',{body:form.elements.body.value,key:crypto.randomUUID(),expectedRevision:latest.revision});form.reset();await reload();toast('Сообщение сохранено'); } catch(err) {toast(err.message);} finally {button.disabled=false;} });
  $('#room-plan').addEventListener('submit', async e => { e.preventDefault();const form=e.currentTarget,button=form.querySelector('button');button.disabled=true;try {await api('/cases/'+id+'/workroom/plan',{body:form.elements.body.value,dueAt:new Date(form.elements.dueAt.value).toISOString(),expectedRevision:latest.revision});form.reset();await reload();toast('План сохранён');}catch(err){toast(err.message);}finally{button.disabled=false;} });
  $('#room-advice').addEventListener('click',async e=>{e.currentTarget.disabled=true;try{await api('/cases/'+id+'/workroom/advice',{key:crypto.randomUUID(),expectedRevision:latest.revision});await reload();toast('Запрос сохранён. ИИ обрабатывает обсуждение.');}catch(err){toast(err.message);}finally{if(e.currentTarget)e.currentTarget.disabled=false;}});
  $('#room-case').addEventListener('click',()=>{stopRoom();showCase(id).catch(e=>toast(e.message));});
  roomTimer=setInterval(reload,3000);
}
document.addEventListener('click', e => {const button=e.target.closest('[data-workroom]');if(button){openWorkroom(button.dataset.workroom).catch(err=>toast(err.message));}});
document.querySelector('#modal').addEventListener('close',stopRoom);

