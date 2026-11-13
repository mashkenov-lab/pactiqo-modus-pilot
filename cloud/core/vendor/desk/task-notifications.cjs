const {createHash}=require('node:crypto');
function identities(t){return JSON.stringify([t.contactId||null,t.assigneeText||null,t.issuerContactId||null]);}
function activeRule(t){return t.whatsappRule?.enabled===true&&t.whatsappRule.identities===identities(t)?t.whatsappRule:null;}
function targets(task,contacts){
 const recipient=(id,role,text)=>{const c=contacts.find(c=>c.id===id);return {recipientId:id||null,audience:role,recipientName:c?.name||text||'Вы',channel:id||text?(c?.delivery?.channel||'recipient-unconfigured'):'local'};};
 let list;
 if(!task.notifyBoth){const c=recipient(task.contactId,'assignee',task.assigneeText);list=task.remindOwner?[recipient(null,'issuer')]:[c];}
 else{list=[recipient(task.issuerContactId,'issuer')];if(task.contactId||task.assigneeText)list.push(recipient(task.contactId,'assignee',task.assigneeText));}
 const rule=activeRule(task);
 if(rule){
  // Keep the owner's Windows notice; replace unconfigured contact routes only after explicit binding.
  list=list.filter(t=>t.channel==='local'||!rule.routes.some(r=>r.audience===t.audience));
  for(const r of [...rule.routes].sort((a,b)=>(a.audience==='assignee'?-1:1)))if(!list.some(t=>t.channel==='whatsapp-goldcard'&&t.recipientId===r.recipientId))list.push({...r,channel:'whatsapp-goldcard',botRuleId:rule.id});
 }
 if(task.personalWhatsAppSelf===true)list.push({audience:'owner',recipientId:'self',recipientName:'Вы',channel:'whatsapp-personal'});
 return list.filter((t,i)=>!list.slice(0,i).some(x=>x.recipientId===t.recipientId&&x.channel===t.channel&&x.recipientName===t.recipientName));
}
function fingerprint(t){return createHash('sha256').update(JSON.stringify([t.title,t.dueAt,t.contactId,t.assigneeText,t.issuerContactId])).digest('hex').slice(0,24);}
function message(t,contacts,{kind='reminder',minutes,audience}={}){
 const name=id=>contacts.find(c=>c.id===id)?.name;
 const issuer=name(t.issuerContactId)||'Владелец пространства';
 const assignee=name(t.contactId)||t.assigneeText||'Владелец пространства';
 const due=t.dueAt?new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}).format(new Date(t.dueAt)):'нужно уточнить';
 const header=kind==='assignment'?'Поручение от PACTIQO Desk':kind==='overdue'?'PACTIQO Desk · срок наступил':`PACTIQO Desk · напоминание за ${minutes} мин.`;
 const followup=kind==='overdue'?(t.progress?.status==='reported_done'?'\nИсполнитель сообщил о выполнении. Требуется проверка результата.':t.progress?'\nОтвет исполнителя учтён в Desk. Проверьте согласованный срок и следующее действие.':'\nВыполнение пока не подтверждено. Уточните, что уже сделано, что мешает и какой срок реалистичен.'):'';
 return `${header}\n${t.title}\nПоручил: ${issuer}\nОтветственный: ${assignee}\nСрок: ${due}${audience==='issuer'?'\nКонтроль выполнения.':''}${followup}`;
}
module.exports={targets,fingerprint,message,identities,activeRule};
