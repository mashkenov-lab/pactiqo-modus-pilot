const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const digest=b=>createHash('sha256').update(b).digest('hex');
function parse(bytes){const s=JSON.parse(bytes);if(s.version!==1){const e=Error('Неподдерживаемая версия хранилища. Обновите приложение.');e.code='STORE_VERSION';throw e;}if(!['tasks','notes','contacts','outbox','events'].every(k=>Array.isArray(s[k]))||!s.settings||typeof s.settings!=='object')throw Error('Неверная структура хранилища');return s;}
function atomic(file,bytes){const temp=file+'.'+randomUUID()+'.tmp';let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(temp,file);}finally{if(fd!=null)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}}
class Persistence{
 constructor(file,empty){this.file=file;this.backup=file+'.bak';this.empty=empty;this.warning=null;}
 load(){
  if(!fs.existsSync(this.file)&&!fs.existsSync(this.backup)){this.hash=null;return this.empty();}
  try{const bytes=fs.readFileSync(this.file,'utf8');const state=parse(bytes);this.hash=digest(bytes);return state;}
  catch(original){if(original.code==='STORE_VERSION')throw original;try{const bytes=fs.readFileSync(this.backup,'utf8'),state=parse(bytes);if(fs.existsSync(this.file))fs.copyFileSync(this.file,this.file+'.corrupt-'+Date.now());atomic(this.file,bytes);this.hash=digest(bytes);this.warning='База восстановлена из проверенной резервной копии. Проверьте последние изменения.';return state;}catch{throw Error('Не удалось прочитать базу и резервную копию. Исходные файлы сохранены; требуется восстановление. '+original.message);}}
 }
 save(state){
  const lock=this.file+'.lock';let fd;
  try{try{fd=fs.openSync(lock,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;let pid;try{pid=Number(fs.readFileSync(lock,'utf8'));}catch{}let alive=true;if(Number.isSafeInteger(pid)&&pid>0)try{process.kill(pid,0);}catch(x){if(x.code==='ESRCH')alive=false;}if(alive)throw Error('Хранилище занято другой операцией. Повторите после обновления.');fs.unlinkSync(lock);fd=fs.openSync(lock,'wx',0o600);}fs.writeFileSync(fd,String(process.pid));
   const current=fs.existsSync(this.file)?digest(fs.readFileSync(this.file)):null;
   if(current!==this.hash){const error=Error('Данные изменились в другом процессе. Обновите состояние и повторите действие.');error.code='STORE_CONFLICT';throw error;}
   parse(JSON.stringify(state));state.storageRevision=(state.storageRevision||0)+1;
   const bytes=JSON.stringify(state,null,2);atomic(this.file,bytes);this.hash=digest(bytes);
   try{atomic(this.backup,bytes);if(this.warning?.startsWith('Изменения сохранены'))this.warning=null;}catch{this.warning='Изменения сохранены, но резервная копия не обновлена. Проверьте свободное место и права.';}
  }finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}}
 }
}
module.exports={Persistence,atomic};
