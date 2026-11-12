'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function safeRelative(s) {
  if(typeof s!=='string'||!s||s.includes('\\')||s.startsWith('/')||s.split('/').some(x=>!x||x==='.'||x==='..'||x.includes(':')||/[. ]$/.test(x)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x)))throw Error('Unsafe backup path');
  return s;
}
function noLinks(p) {
  const absolute=path.resolve(p),parts=absolute.slice(path.parse(absolute).root.length).split(path.sep);
  let at=path.parse(absolute).root;
  for(const part of parts){
    at=path.join(at,part);
    try{if(fs.lstatSync(at).isSymbolicLink())throw Error('Link in backup path');}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
}
function list(dir,prefix='') {
  noLinks(dir);
  return fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>{
    const rel=safeRelative(prefix+e.name),p=path.join(dir,e.name);
    if(e.isSymbolicLink())throw Error('Link in backup');
    if(e.isDirectory())return list(p,rel+'/');
    if(!e.isFile())throw Error('Unsupported file in backup');
    return /(^|\/)([^/]*\.lock|suite-control\.json|supervisor\.lock)$/i.test(rel)?[]:[rel];
  });
}
function inside(root,rel) {
  safeRelative(rel);
  const p=path.resolve(root,...rel.split('/'));
  if(!p.toLowerCase().startsWith((path.resolve(root)+path.sep).toLowerCase()))throw Error('Unsafe backup path');
  return p;
}
function backup({data,backupRoot,revision}) {
  data=path.resolve(data);backupRoot=path.resolve(backupRoot);
  noLinks(data);noLinks(backupRoot);
  if(backupRoot.toLowerCase().startsWith((data+path.sep).toLowerCase()))throw Error('Backup cannot be inside source');
  const names=list(data);
  if(!names.includes('workspace.json')||!names.includes('accounts.json'))throw Error('Incomplete platform data');
  fs.mkdirSync(backupRoot,{recursive:true});
  const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(6).toString('hex');
  const stage=path.join(backupRoot,'.'+id+'.staging'),directory=path.join(backupRoot,id);
  fs.mkdirSync(path.join(stage,'files'),{recursive:true});
  const files=[];
  for(const name of names){
    const bytes=fs.readFileSync(inside(data,name)),dest=inside(path.join(stage,'files'),name);
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.writeFileSync(dest,bytes,{mode:0o600});
    files.push({path:name,size:bytes.length,sha256:hash(bytes)});
  }
  if(JSON.stringify(names)!==JSON.stringify(list(data)))throw Error('Platform changed during backup');
  for(const f of files){
    const bytes=fs.readFileSync(inside(data,f.path));
    if(bytes.length!==f.size||hash(bytes)!==f.sha256)throw Error('Platform changed during backup');
  }
  const manifest={schema:1,revision:String(revision||''),createdAt:new Date().toISOString(),files,limitations:'Local protected backup; account credentials may be machine-bound and are not portable.'};
  fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  fs.renameSync(stage,directory);
  return {directory,manifest};
}
function restore({backupDir,target}) {
  backupDir=path.resolve(backupDir);target=path.resolve(target);
  noLinks(backupDir);noLinks(path.join(backupDir,'manifest.json'));noLinks(target);
  for(let parent=target;;parent=path.dirname(parent)){
    if(fs.existsSync(path.join(parent,'current.json')))throw Error('Restore target must be outside any installation');
    if(parent===path.dirname(parent))break;
  }
  if(target.toLowerCase()===backupDir.toLowerCase()||target.toLowerCase().startsWith((backupDir+path.sep).toLowerCase())||backupDir.toLowerCase().startsWith((target+path.sep).toLowerCase()))throw Error('Restore target overlaps backup');
  if(fs.existsSync(target)&&(!fs.statSync(target).isDirectory()||fs.readdirSync(target).length))throw Error('Restore target must be empty');
  const m=JSON.parse(fs.readFileSync(path.join(backupDir,'manifest.json'),'utf8'));
  if(m.schema!==1||!Array.isArray(m.files)||!m.files.length)throw Error('Invalid backup manifest');
  const seen=new Set();
  for(const f of m.files){
    const name=safeRelative(f.path),key=name.toLowerCase();
    if(seen.has(key)||!Number.isSafeInteger(f.size)||f.size<0||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('Invalid backup entry');
    seen.add(key);
    const source=inside(path.join(backupDir,'files'),name);noLinks(source);
    const bytes=fs.readFileSync(source);
    if(bytes.length!==f.size||hash(bytes)!==f.sha256)throw Error('Backup integrity mismatch');
  }
  if(!seen.has('workspace.json')||!seen.has('accounts.json')||JSON.stringify([...seen].sort())!==JSON.stringify(list(path.join(backupDir,'files')).map(x=>x.toLowerCase()).sort()))throw Error('Incomplete backup');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const stage=target+'.restore-'+crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(stage);
  try{
    for(const f of m.files){
      const dest=inside(stage,f.path);fs.mkdirSync(path.dirname(dest),{recursive:true});
      fs.copyFileSync(inside(path.join(backupDir,'files'),f.path),dest);
      const bytes=fs.readFileSync(dest);
      if(bytes.length!==f.size||hash(bytes)!==f.sha256)throw Error('Restore integrity mismatch');
    }
    if(fs.existsSync(target))fs.rmdirSync(target);
    fs.renameSync(stage,target);
  }catch(e){fs.rmSync(stage,{recursive:true,force:true});throw e;}
  return {target,revision:m.revision,files:m.files.length};
}
function matchesBackup({backupDir,data}) {
  try{
    noLinks(path.join(backupDir,'manifest.json'));
    const m=JSON.parse(fs.readFileSync(path.join(backupDir,'manifest.json'),'utf8'));
    if(m.schema!==1||!Array.isArray(m.files)||!m.files.length)return false;
    const seen=new Set();
    for(const f of m.files){
      const name=safeRelative(f.path),key=name.toLowerCase();
      if(seen.has(key)||!Number.isSafeInteger(f.size)||!/^[a-f0-9]{64}$/.test(f.sha256))return false;
      seen.add(key);
      for(const base of [path.join(backupDir,'files'),data]){
        const p=inside(base,name);noLinks(p);const bytes=fs.readFileSync(p);
        if(bytes.length!==f.size||hash(bytes)!==f.sha256)return false;
      }
    }
    return seen.has('workspace.json')&&seen.has('accounts.json')&&JSON.stringify([...seen].sort())===JSON.stringify(list(path.join(backupDir,'files')).map(x=>x.toLowerCase()).sort())&&JSON.stringify([...seen].sort())===JSON.stringify(list(data).map(x=>x.toLowerCase()).sort());
  }catch{return false;}
}
module.exports={backup,restore,matchesBackup};
if(require.main===module){
  try{
    const [action,...args]=process.argv.slice(2);let result;
    if(action==='backup'&&args.length===1&&path.isAbsolute(args[0])){
      const root=path.resolve(args[0]);
      if(fs.existsSync(path.join(root,'data','supervisor.lock')))throw Error('Stop the suite before command-line backup');
      const current=JSON.parse(fs.readFileSync(path.join(root,'current.json'),'utf8'));
      result=backup({data:path.join(root,'data','platform'),backupRoot:path.join(root,'data','backups'),revision:current.version});
      result={directory:result.directory,files:result.manifest.files.length};
    }else if(action==='restore'&&args.length===2&&args.every(path.isAbsolute))result=restore({backupDir:args[0],target:args[1]});
    else throw Error('Usage: backup <absolute installation root> | restore <absolute backup directory> <separate empty target>');
    console.log(JSON.stringify(result));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
