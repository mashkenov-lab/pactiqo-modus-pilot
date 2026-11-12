'use strict';
const fs=require('node:fs'),path=require('node:path');
function cleanupOwn(root){const base=process.env.MODUS_TEST_TEMP_ROOT;if(!base)return;const parent=path.resolve(base),target=path.resolve(root);if(path.dirname(target).toLowerCase()!==parent.toLowerCase()||!/^modus-(?:r6-offline|r6-firststart|install-test|unbounded|backup-browser|real-bridge|parent-death|real-suite)-[A-Za-z0-9]+$/.test(path.basename(target)))throw Error('Unsafe test cleanup target');if(fs.lstatSync(target).isSymbolicLink())throw Error('Test cleanup cannot follow link');fs.rmSync(target,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
module.exports={cleanupOwn};
