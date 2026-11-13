'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..','source');
// This portable group has no browser, Windows installer or live-provider dependency.
const excluded=/^(?:browser-|design-final|discussion-files-browser|installer|r6-)/;
const tests=fs.readdirSync(path.join(root,'tests')).filter(n=>n.endsWith('.test.cjs')&&!excluded.test(n)).sort();
console.log('Portable core: '+tests.length+' test files. Live providers and Windows packaging are separate checks.');
const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('MODUS_'))delete env[k];
const r=spawnSync(process.execPath,['--test',...tests.map(n=>path.join('tests',n))],{cwd:root,env,stdio:'inherit',windowsHide:true});
if(r.error)throw r.error;process.exitCode=r.status??1;
