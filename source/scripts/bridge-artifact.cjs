'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function artifactFiles(directory, prefix = '') {
  const entries = [];
  for (const item of fs.readdirSync(directory, {withFileTypes:true})) {
    const relative = prefix + item.name;
    if (item.isSymbolicLink()) throw Error('Linked bridge artifact entry');
    if (item.isDirectory() && item.name === '__pycache__') continue;
    if (item.isDirectory()) entries.push(...artifactFiles(path.join(directory,item.name), relative + '/'));
    else if (item.isFile()) entries.push(relative);
    else throw Error('Invalid bridge artifact entry');
  }
  return entries.sort();
}
function validateBridge(directory, {manifestHash, launchHash}) {
  if (!path.isAbsolute(directory) || !/^[a-f0-9]{64}$/.test(manifestHash || '') || !/^[a-f0-9]{64}$/.test(launchHash || '')) throw Error('Verified bridge hashes and path required');
  if (sha(path.join(directory,'manifest.json')) !== manifestHash || sha(path.join(directory,'launch.cjs')) !== launchHash) throw Error('Bridge metadata hash mismatch');
  if (fs.lstatSync(directory).isSymbolicLink()) throw Error('Linked bridge artifact root');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  if (manifest.managementVersion !== 1 || manifest.personalDataIncluded !== false || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid bridge manifest');
  const seen = new Set();
  for (const item of manifest.files) {
    if (typeof item.path !== 'string' || !/^(?:telegram_adapter\/[A-Za-z0-9_./-]+|launch\.cjs|MANAGEMENT\.md)$/.test(item.path) || item.path.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(item.sha256 || '')) throw Error('Invalid bridge manifest path');
    const key = item.path.toLowerCase();
    if (seen.has(key)) throw Error('Duplicate bridge manifest path');
    seen.add(key);
    if (sha(path.join(directory,...item.path.split('/'))) !== item.sha256) throw Error('Bridge artifact integrity mismatch');
  }
  const expected = [...seen,'manifest.json'].sort();
  const actual = artifactFiles(directory).map(name=>name.toLowerCase()).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Unexpected bridge artifact file');
  return manifest;
}
function copyBridge(directory, destination, manifest, manifestHash) {
  for (const relative of ['manifest.json',...manifest.files.map(item=>item.path)]) {
    const target = path.join(destination,...relative.split('/'));
    fs.mkdirSync(path.dirname(target),{recursive:true});
    const source=path.join(directory,...relative.split('/'));
    fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
    const expected=relative==='manifest.json'?manifestHash:manifest.files.find(item=>item.path===relative).sha256;
    if(sha(target)!==expected)throw Error('Bridge artifact changed during copy');
  }
}
module.exports = {validateBridge, copyBridge};
