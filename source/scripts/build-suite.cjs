'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),version=process.argv[2]||'r6-4.0.0-b1',stage=path.resolve(process.env.MODUS_STAGE_DIR||path.join(root,'release-r6','staging-'+version)),adapter=path.resolve(process.env.MODUS_ADAPTER_BUILD||''),adapterVersion=process.env.MODUS_ADAPTER_VERSION||'',telegram=process.env.MODUS_TELEGRAM_BRIDGE;
if(!process.env.MODUS_ADAPTER_BUILD||!path.isAbsolute(process.env.MODUS_ADAPTER_BUILD)||!/^r6-4\.0\.0-b[1-9][0-9]*$/.test(version)||!/^0\.2\.\d+$/.test(adapterVersion)||path.basename(path.dirname(adapter))!==adapterVersion)throw Error('Invalid version or Adapter build path');
if(fs.existsSync(stage))throw Error('Stage already exists; choose a fresh immutable version');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
for(const [relative,key] of [['Adapter.exe','MODUS_ADAPTER_EXE_SHA256'],['resources/app.asar','MODUS_ADAPTER_ASAR_SHA256'],['resources/mcp.cjs','MODUS_ADAPTER_MCP_SHA256']]){const expected=process.env[key];if(!/^[a-f0-9]{64}$/.test(expected||'')||sha(path.join(adapter,relative))!==expected)throw Error('Explicit verified Adapter hash required: '+relative);}
const {validateBridge,copyBridge}=require('./bridge-artifact.cjs');
const telegramManifest=validateBridge(telegram,{manifestHash:process.env.MODUS_TELEGRAM_MANIFEST_SHA256,launchHash:process.env.MODUS_TELEGRAM_LAUNCHER_SHA256});
const pythonArchive=path.join(root,'components','python-runtime','3.14.10','python-3.14.10-embed-amd64.zip');if(sha(pythonArchive)!=='90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159')throw Error('Python archive hash mismatch');
const pyVerify=`import sys,zipfile,pathlib,hashlib
z=zipfile.ZipFile(sys.argv[1]); root=pathlib.Path(sys.argv[2]); expected={x.filename for x in z.infolist() if not x.is_dir()}
actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
if actual!=expected: raise ValueError('Python runtime file list mismatch')
for name in expected:
 p=root.joinpath(*name.split('/'))
 if p.is_symlink() or hashlib.sha256(p.read_bytes()).digest()!=hashlib.sha256(z.read(name)).digest(): raise ValueError('Python runtime mismatch: '+name)
`;const check=spawnSync(process.env.MODUS_PYTHON||'python',['-c',pyVerify,pythonArchive,path.join(root,'components','python-runtime','3.14.10','runtime')],{encoding:'utf8',windowsHide:true});if(check.status!==0)throw Error('Python runtime integrity check failed: '+check.stderr);
function copy(a,b){fs.mkdirSync(path.dirname(b),{recursive:true});fs.copyFileSync(a,b,fs.constants.COPYFILE_EXCL);}
function tree(a,b){for(const f of fs.readdirSync(a,{withFileTypes:true})){if(f.isSymbolicLink())throw Error('Link in payload: '+f.name);if(/^(?:__pycache__|startup-status\.json)$/i.test(f.name)||/\.pyc$/i.test(f.name))continue;if(/^(?:\.git|node_modules|data|profiles?|bridge|cache|auth|auth\.json|bridge\.json|accounts\.json|access\.txt|cookies(?:\..*)?|.*authority.*private.*|.*\.(?:key|pfx|p12)|state\.bin|client-runtime\.json|\.env(?:\..*)?)$/i.test(f.name))throw Error('Forbidden payload entry: '+f.name);const x=path.join(a,f.name),y=path.join(b,f.name);if(f.isDirectory())tree(x,y);else if(f.isFile())copy(x,y);else throw Error('Invalid payload entry');}}
function files(d,p=''){return fs.readdirSync(d,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(f=>f.isDirectory()?files(path.join(d,f.name),p+f.name+'/'):[p+f.name]);}
fs.mkdirSync(stage,{recursive:true});
for(const name of ['adapter-authority.cjs','adapter-link.cjs','adapter-mail.cjs','bitrix-connector.cjs','card-links.cjs','case-assistant.cjs','case-attention.cjs','case-delivery.cjs','case-workspace.cjs','communications.cjs','company-directory.cjs','desk-analyzer.cjs','domain.cjs','install-suite.cjs','messenger-workflow.cjs','owned-adapter.cjs','owned-telegram.cjs','platform-auth.cjs','platform-server.cjs','platform-store.cjs','suite-backup.cjs','suite-control.cjs','suite-store.cjs'])copy(path.join(root,name),path.join(stage,name));
for(const dir of ['r4-public','fixtures','vendor'])tree(path.join(root,dir),path.join(stage,dir));
for(const f of ['public/demo-desk.json','README_R6.md','defense/R6_ARCHITECTURE.md','defense/R6_REQUIREMENTS_AND_PLATFORM.md','defense/R6_DEMO.md'])copy(path.join(root,f),path.join(stage,f));
for(const f of ['node.exe','NODE-LICENSE.txt'])copy(path.join(root,'..','runtime',f),path.join(stage,'runtime',f));
tree(adapter,path.join(stage,'components','adapter'));
tree(path.join(root,'components','codex-package','package','vendor','x86_64-pc-windows-msvc'),path.join(stage,'components','codex'));
for(const f of ['LICENSE','provenance.json'])copy(path.join(root,'components','codex-package',f),path.join(stage,'components','codex',f));
tree(path.join(root,'components','python-runtime','3.14.10','runtime'),path.join(stage,'components','python','runtime'));
fs.writeFileSync(path.join(stage,'components','python','provenance.json'),JSON.stringify({version:'3.14.10',source:'https://www.python.org/ftp/python/3.14.10/python-3.14.10-embed-amd64.zip',sha256:'90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159'},null,2));
copyBridge(telegram,path.join(stage,'components','telegram-bridge'),telegramManifest,process.env.MODUS_TELEGRAM_MANIFEST_SHA256);
const pth=path.join(stage,'components','python','runtime','python314._pth');fs.appendFileSync(pth,'\n../../telegram-bridge\n');
const compile=spawnSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/target:winexe','/optimize+','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll','/out:'+path.join(stage,'PACTIQO.exe'),path.join(root,'installer','Launcher.cs')],{encoding:'utf8',windowsHide:true});if(compile.status!==0)throw Error(compile.stdout+compile.stderr);
const list=files(stage);const node=spawnSync(path.join(stage,'runtime','node.exe'),['--version'],{encoding:'utf8',windowsHide:true});if(node.status!==0)throw Error('Bundled Node failed');const manifest={schema:1,version,adapterVersion,codexVersion:'0.167.1',nodeVersion:node.stdout.trim(),at:new Date().toISOString(),files:list.map(f=>({path:f,size:fs.statSync(path.join(stage,f)).size,sha256:sha(path.join(stage,f))}))};fs.writeFileSync(path.join(stage,'suite-manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});console.log(JSON.stringify({version,adapterVersion,files:list.length,bytes:manifest.files.reduce((n,f)=>n+f.size,0),stage}));
