const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
let desktopCache={until:0,paths:[]};
function desktopCodex(){
 if(process.platform!=='win32')return [];
 if(Date.now()<desktopCache.until)return desktopCache.paths;
 const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const result=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Process -Name codex -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique; Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | ForEach-Object { Join-Path $_.InstallLocation 'app/resources/codex.exe' }"],{encoding:'utf8',windowsHide:true,timeout:8000});
 const paths=(result.stdout||'').split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&path.isAbsolute(s));
 desktopCache={until:Date.now()+60000,paths};return paths;
}
function findCodex(preferred){
 const candidates=[preferred,process.env.PACTIQO_CODEX];
 for(const dir of (process.env.PATH||'').split(path.delimiter))if(dir)candidates.push(path.join(dir,'codex.exe'));
 if(process.env.APPDATA)candidates.push(path.join(process.env.APPDATA,'npm','node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe'));
 const valid=p=>{try{return p&&path.isAbsolute(p)&&path.basename(p).toLowerCase()==='codex.exe'&&fs.statSync(p).isFile();}catch{return false;}};
 return candidates.find(valid)||desktopCodex().find(valid)||null;
}
function diagnostic({codex,voice,recording,version}){
 return {schemaVersion:1,createdAt:new Date().toISOString(),app:{name:'PACTIQO Desk',version},os:{platform:process.platform,arch:process.arch,release:os.release(),memoryGiB:Math.round(os.totalmem()/1073741824)},codex:{available:!!codex?.available,verifiedInference:!!codex?.verifiedInference},voice:{available:!!voice?.available,modelReady:!!voice?.modelReady,offline:true},recording:!!recording,chatgptDirect:{enabled:false,reason:'Commercial access and integration not configured'},externalChannels:{whatsapp:false,email:false,computerActions:false},privacy:{audioUploaded:false,reportContainsContacts:false,reportContainsTokens:false,reportContainsTranscript:false}};
}
module.exports={findCodex,diagnostic};
