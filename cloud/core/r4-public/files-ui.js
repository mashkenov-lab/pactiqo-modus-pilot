'use strict';
let pdfModulePromise,activeFileViewer=null;
const filePreviewCache=new Map();
const attachmentUrl=id=>'/api/attachments/'+encodeURIComponent(id);
function pdfModule(){return pdfModulePromise ||= import('/pdfjs/pdf.mjs').then(pdf=>{pdf.GlobalWorkerOptions.workerSrc='/pdfjs/pdf.worker.mjs';return pdf;});}
async function fileBytes(file){const response=await fetch(attachmentUrl(file.id),{cache:'no-store'});if(!response.ok)throw Error(response.status===401||response.status===403||response.status===404?'Файл недоступен. Проверьте доступ к обращению.':'Не удалось открыть файл. Попробуйте ещё раз.');return new Uint8Array(await response.arrayBuffer());}
async function loadPdf(file){const [pdf,bytes]=await Promise.all([pdfModule(),fileBytes(file)]);return pdf.getDocument({data:bytes,isEvalSupported:false,useWasm:false,useSystemFonts:true}).promise;}
function fileSize(bytes){return bytes>=1048576?(bytes/1048576).toFixed(1)+' МБ':Math.max(1,Math.ceil(bytes/1024))+' КБ';}
function roomFileMarkup(message,messages){return (message.attachments||[]).map(file=>{
 const decision=[...messages].reverse().find(m=>m.reviewOf===file.id),image=file.mime.startsWith('image/'),pdf=file.mime==='application/pdf';
 return `<div class="room-file"><button type="button" class="file-open" data-open-file="${esc(file.id)}" aria-label="Открыть файл ${esc(file.name)}"><span class="file-preview">${image?`<img src="${attachmentUrl(file.id)}?view=1" alt="Превью ${esc(file.name)}" loading="lazy">`:pdf?`<canvas data-pdf-preview="${esc(file.id)}" aria-label="Первая страница ${esc(file.name)}"></canvas><span class="file-preview-label">PDF · первая страница</span>`:`<span class="file-type">${esc(file.name.split('.').pop().toUpperCase())}</span>`}</span><strong>${esc(file.name)}</strong><small>${fileSize(file.size)} · ${image?'Открыть изображение':pdf?'Открыть документ':'Просмотр и скачивание'}</small></button>${decision?`<p class="file-verdict ${decision.fileDecision==='approved'?'approved':'changes'}">${decision.fileDecision==='approved'?'Материал согласован':'Нужны правки'}<small>${esc(decision.authorName)} · ${dt(decision.createdAt)}</small></p>`:'<p class="file-verdict">Ожидает обсуждения</p>'}<div class="file-actions"><button type="button" data-review-file="${esc(file.id)}" data-file-decision="approved">Согласовать</button><button type="button" data-review-file="${esc(file.id)}" data-file-decision="changes">Нужны правки</button></div></div>`;
}).join('');}
function closeFileViewer(){if(activeFileViewer){activeFileViewer.close();activeFileViewer=null;}}
function clearRoomFileViews(){closeFileViewer();filePreviewCache.clear();}
async function paintFilePreviews(container,files,isCurrent){
 for(const canvas of container.querySelectorAll('[data-pdf-preview]')){
  const file=files.get(canvas.dataset.pdfPreview);if(!file||!isCurrent())continue;
  const key=state.actor.id+':'+file.id;
  try{
   let cached=filePreviewCache.get(key);
   if(!cached){const doc=await loadPdf(file);try{const page=await doc.getPage(1),viewport=page.getViewport({scale:280/page.getViewport({scale:1}).width}),off=document.createElement('canvas');off.width=Math.ceil(viewport.width);off.height=Math.ceil(viewport.height);await page.render({canvasContext:off.getContext('2d'),viewport}).promise;cached=off.toDataURL('image/png');if(filePreviewCache.size>60)filePreviewCache.clear();if(isCurrent())filePreviewCache.set(key,cached);}finally{await doc.destroy();}}
   if(!isCurrent()||!canvas.isConnected)return;
   const image=new Image();image.alt='Первая страница '+file.name;image.src=cached;canvas.replaceWith(image);
  }catch{if(isCurrent()&&canvas.isConnected){const fallback=document.createElement('span');fallback.className='file-type';fallback.textContent='PDF';canvas.replaceWith(fallback);}}
 }
}
async function openRoomFile(file){
 closeFileViewer();
 const view={epoch:uiEpoch,actorId:state?.actor?.id},dialog=document.createElement('dialog');dialog.className='file-viewer';dialog.setAttribute('aria-label','Просмотр файла');
 dialog.innerHTML=`<header><div><strong>${esc(file.name)}</strong><small>${fileSize(file.size)} · Оригинал сохраняется без изменений</small></div><button type="button" data-file-close aria-label="Закрыть просмотр файла">×</button></header><div class="file-viewer-tools"><button type="button" data-file-prev hidden>Предыдущая страница</button><span data-file-page role="status"></span><button type="button" data-file-next hidden>Следующая страница</button><a href="${attachmentUrl(file.id)}" download="${esc(file.name)}">Скачать оригинал</a></div><div class="file-viewer-body"><p role="status">Открываем файл…</p></div>`;
 document.body.append(dialog);let pdf=null,currentPage=1,destroyed=false;
 const close=()=>{if(destroyed)return;destroyed=true;if(pdf)void pdf.destroy();dialog.close();dialog.remove();if(activeFileViewer?.dialog===dialog)activeFileViewer=null;};activeFileViewer={dialog,close};dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.querySelector('[data-file-close]').onclick=close;dialog.showModal();
 const body=dialog.querySelector('.file-viewer-body'),valid=()=>!destroyed&&currentView(view);
 async function renderPage(){if(!valid())return;const prev=dialog.querySelector('[data-file-prev]'),next=dialog.querySelector('[data-file-next]');prev.disabled=true;next.disabled=true;try{const page=await pdf.getPage(currentPage),width=Math.min(1200,Math.max(300,body.clientWidth-24)),viewport=page.getViewport({scale:width/page.getViewport({scale:1}).width}),canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);canvas.setAttribute('aria-label','Страница '+currentPage+' документа '+file.name);await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;if(!valid())return;body.replaceChildren(canvas);body.scrollTop=0;dialog.querySelector('[data-file-page]').textContent='Страница '+currentPage+' из '+pdf.numPages;}finally{if(valid()){prev.disabled=currentPage===1;next.disabled=currentPage===pdf.numPages;}}}
 try{
  if(file.mime==='application/pdf'){pdf=await loadPdf(file);if(!valid()){await pdf.destroy();return;}for(const k of ['prev','next'])dialog.querySelector('[data-file-'+k+']').hidden=false;dialog.querySelector('[data-file-prev]').onclick=()=>{currentPage--;void renderPage().catch(showError);};dialog.querySelector('[data-file-next]').onclick=()=>{currentPage++;void renderPage().catch(showError);};await renderPage();}
  else if(file.mime.startsWith('image/')){const bytes=await fileBytes(file);if(!valid())return;const image=new Image(),url=URL.createObjectURL(new Blob([bytes],{type:file.mime}));image.alt=file.name;image.src=url;image.onload=()=>URL.revokeObjectURL(url);image.onerror=()=>{URL.revokeObjectURL(url);showError(Error('Изображение не удалось прочитать. Оригинал можно скачать.'));};body.replaceChildren(image);}
  else if(file.mime.startsWith('text/plain')){const bytes=await fileBytes(file);if(!valid())return;const pre=document.createElement('pre');pre.textContent=new TextDecoder().decode(bytes);body.replaceChildren(pre);}
  else{await fileBytes(file);if(valid())body.innerHTML='<p>Этот формат открывается в установленной программе. Нажмите «Скачать оригинал».</p>';}
 }catch(error){showError(error);}
 function showError(error){if(valid()){body.replaceChildren();const p=document.createElement('p');p.className='error';p.setAttribute('role','alert');p.textContent=error.message;body.append(p);}}
}
async function encodeRoomFiles(files){return Promise.all(files.map(file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,base64:String(reader.result).split(',')[1]});reader.onerror=()=>reject(Error('Не удалось прочитать '+file.name));reader.readAsDataURL(file);})));}
