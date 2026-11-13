'use strict';
const path=require('node:path');
const {createDemo}=require('./demo-app.cjs');
const args=process.argv.slice(2);let dir,port=4389;
for(let i=0;i<args.length;i++){
  if(args[i]==='--data'&&args[i+1])dir=path.resolve(args[++i]);
  else if(args[i]==='--port'&&args[i+1])port=Number(args[++i]);
  else throw Error('Используйте: npm start -- --port 4389 --data <пустая-учебная-папка>');
}
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Порт должен быть целым числом от 1024 до 65535.');
const app=createDemo({dir});
app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'Порт занят. Повторите с --port 4391.':e.message);process.exitCode=1;});
app.server.listen(port,'127.0.0.1',()=>{
  console.log('MODUS — локальный учебный MVP: http://127.0.0.1:'+port);
  console.log('Локальные логины и случайные пароли: '+path.join(app.dir,'ACCESS.txt'));
  console.log('20 примеров ТЗ; 120 сообщений; 60 файлов. Внешние ИИ и отправки отключены.');
  console.log('Остановка: Ctrl+C. Учебные изменения сохраняются в '+app.dir);
});
let stopping=false;function stop(){if(stopping)return;stopping=true;app.beginDrain();app.server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),5000).unref();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
