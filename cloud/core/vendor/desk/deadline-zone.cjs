// Guard model-derived local deadlines against stale timezone offsets.
function zoneOffset(timeZone, at) {
 const parts=new Intl.DateTimeFormat('en-US',{timeZone,timeZoneName:'longOffset'}).formatToParts(new Date(at));
 const name=parts.find(p=>p.type==='timeZoneName').value;
 return name==='GMT'?'+00:00':name.replace('GMT','');
}
function checkDeadline(value, quote, timeZone) {
 if(!value)return;
 const expected=zoneOffset(timeZone,value),suffix=value.match(/(Z|[+-]\d\d:\d\d)$/)?.[1];
 if(suffix!=='Z'&&suffix!==expected)throw Error('Часовой пояс предложенного срока не совпадает с '+timeZone+' ('+expected+'). Срок не изменён. Уточните дату и время.');
 const clock=quote?.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
 if(clock&&!/\b(?:UTC|GMT|МСК)\b|Москв|Лондон|Нью-Йорк/i.test(quote)){
  const local=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));
  if(local!==clock[1].padStart(2,'0')+':'+clock[2])throw Error('Время предложенного срока не совпадает с цитатой в часовом поясе '+timeZone+'. Срок не изменён. Уточните время.');
 }
}
module.exports={zoneOffset,checkDeadline};
