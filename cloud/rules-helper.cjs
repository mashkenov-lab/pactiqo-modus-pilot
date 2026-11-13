'use strict';
// A transparent deterministic helper. No model inference or remote service is invoked.
const {validate}=require('./core/desk-analyzer.cjs');
module.exports={
 async status(){return {installed:true,authenticated:true,verifiedInference:false,engine:'rules-demo',cloud:false,label:'Учебный помощник по правилам; генеративный ИИ не подключён'};},
 async analyze(c,context){
  const messages=c.messages.filter(m=>m.role==='user'),text=messages.map(m=>m.text).join('\n\n').slice(0,3900),last=messages.at(-1);
  const department=context.departments.find(d=>text.toLocaleLowerCase().includes(d.toLocaleLowerCase().replace(/ки$/,'к').replace(/ия$/,'')))||null;
  const category=context.categories.find(d=>text.toLocaleLowerCase().includes(d.toLocaleLowerCase()))||context.categories.find(d=>/Организация работы|Межотдельное взаимодействие/.test(d))||context.categories[0];
  const result={title:messages[0].text.slice(0,160),summary:text,intent:/предлага|улучш|давайте/i.test(text)?'suggestion':/спасибо|благодар/i.test(text)?'praise':'problem',category,department,suggestedSolution:null,quotes:messages.slice(-4).map(m=>({messageId:m.id,text:m.text})),missing:department?[]:[{field:'department',question:'В каком подразделении возникла ситуация? Укажите его или выберите подразделение в карточке.'}],uncertainty:'Учебный помощник работает по простым правилам, без генеративной модели. Проверьте категорию, подразделение и формулировку перед регистрацией.',reply:department?'Сохранил ваш текст без изменения смысла. Проверьте подготовленную карточку справа; после подтверждения система назначит ответственного по правилам маршрутизации.':'Сохранил ваш текст. Уточните подразделение; затем проверьте карточку и подтвердите направление. Я работаю по правилам, генеративный ИИ в этом облачном пилоте не подключён.'};
  return {...validate(result,c,context),engine:'rules-demo',reviewRequired:true,analyzedAt:new Date().toISOString()};
 }
};
