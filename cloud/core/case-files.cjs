'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const MAX_BYTES=2*1024*1024;
const fail=message=>{throw Object.assign(Error(message),{status:400});};
function prepareFiles(input){
 if(input===undefined)return [];
 if(!Array.isArray(input)||input.length>3)fail('До трёх файлов на сообщение');
 let total=0;
 return input.map(value=>{
  if(!value||typeof value.name!=='string'||!value.name.trim()||value.name.length>150||/[\\/\x00-\x1f\x7f]/.test(value.name))fail('Недопустимое имя файла');
  const name=value.name.trim(),ext=path.extname(name).toLowerCase();
  const mime={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.txt':'text/plain; charset=utf-8','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}[ext];
  if(!mime)fail('Допустимы PDF, PNG, JPG, TXT и DOCX');
  if(typeof value.base64!=='string'||value.base64.length>2800000||value.base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64))fail('Некорректный файл');
  const bytes=Buffer.from(value.base64,'base64');total+=bytes.length;
  if(bytes.toString('base64')!==value.base64)fail('Некорректный файл');
  if(!bytes.length||total>MAX_BYTES)fail('Общий размер файлов сообщения — до 2 МБ');
  if(ext==='.pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-'))||ext==='.png'&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||['.jpg','.jpeg'].includes(ext)&&!(bytes[0]===255&&bytes[1]===216)||ext==='.docx'&&!(bytes[0]===80&&bytes[1]===75))fail('Содержимое не соответствует расширению');
  return {name,mime,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),bytes};
 });
}
function writeFiles(store,caseId,messageId,files,at,created){
 const folder=path.join(store.dir,'attachments');
 if(files.length)fs.mkdirSync(folder,{recursive:true});
 return files.map(file=>{
  const id=randomUUID(),destination=path.join(folder,id);
  const fd=fs.openSync(destination,'wx',0o600);created.push(destination);
  try{fs.writeFileSync(fd,file.bytes);}finally{fs.closeSync(fd);}
  const meta={id,caseId,messageId,name:file.name,mime:file.mime,size:file.size,sha256:file.sha256,createdAt:at};
  store.platform.attachments[id]=meta;return {...meta};
 });
}
function cleanupFiles(created){for(const file of created)try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}}
module.exports={prepareFiles,writeFiles,cleanupFiles,MAX_BYTES};
