'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createPlatformServer}=require('../source/platform-server.cjs');
const {populateDiscussionDemo}=require('../source/discussion-demo.cjs');
function createDemo({dir,passwords}={}){
  if(Number(process.versions.node.split('.')[0])!==24)throw Error('Для проверенного запуска нужен Node.js 24.x.');
  dir=path.resolve(dir||path.join(__dirname,'..','demo-data'));
  const marker=path.join(dir,'PILOT-DEMO.json');
  if(fs.existsSync(dir)&&fs.readdirSync(dir).length&&!fs.existsSync(marker))throw Error('Каталог не принадлежит учебному запуску. Выберите новый пустой --data каталог.');
  fs.mkdirSync(dir,{recursive:true});
  if(!fs.existsSync(marker))fs.writeFileSync(marker,JSON.stringify({schema:1,synthetic:true,createdAt:new Date().toISOString()},null,2),{flag:'wx'});
  // This entry point deliberately refuses inherited connection settings.
  for(const key of ['MODUS_ADAPTER_PROFILE','MODUS_ADAPTER_EXE','MODUS_CODEX_EXE','MODUS_CODEX_HOME','MODUS_CODEX_MODEL'])delete process.env[key];
  const analyzer={
    status:async()=>({installed:false,authenticated:false,verifiedInference:false,engine:'disabled',cloud:false,label:'Учебный запуск: внешний ИИ не подключён; карточку можно оформить вручную'}),
    analyze:async()=>{throw Error('В этом автономном запуске внешний ИИ не подключён. Используйте ручное подтверждение карточки.');}
  };
  const app=createPlatformServer({dir,seed:false,passwords,analyzer,adapter:null,enableAdapter:false});
  if(!app.store.platform.datasetLoaded){app.store.seedDataset();populateDiscussionDemo(app.store);}
  return {...app,dir};
}
module.exports={createDemo};
