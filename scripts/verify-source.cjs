'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),manifest=require('../evidence/source-provenance.json');
const supplement=require('../evidence/supplemental-source-provenance.json');
for(const f of [...manifest.files,...supplement.files]){const b=fs.readFileSync(path.join(root,'source',f.path));assert.equal(b.length,f.bytes,f.path);assert.equal(createHash('sha256').update(b).digest('hex'),f.sha256,f.path);}
console.log(JSON.stringify({ok:true,sourceHead:manifest.sourceHead,archiveSha256:manifest.archiveSha256,archiveFiles:manifest.files.length,supplementalFiles:supplement.files.length,verifiedFiles:manifest.files.length+supplement.files.length}));
