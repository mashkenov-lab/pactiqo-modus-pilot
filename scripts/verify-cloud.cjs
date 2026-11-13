'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),manifest=require('../evidence/CLOUD_IMPORT.json');
for(const f of manifest.files){
  assert(f.path.startsWith('cloud/')&&!f.path.split('/').includes('..'));
  const b=fs.readFileSync(path.join(root,f.path));
  assert.equal(b.length,f.bytes,f.path);assert.equal(createHash('sha256').update(b).digest('hex'),f.sha256,f.path);
}
console.log(JSON.stringify({ok:true,sourceManifestFiles:manifest.sourceManifestFiles,verifiedFiles:manifest.files.length,manifestSha256:manifest.manifestSha256}));
