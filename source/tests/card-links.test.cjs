'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SuiteStore}=require('../suite-store.cjs');
const {CardLinks}=require('../card-links.cjs');
test('opaque durable links require exact active current recipient and expire',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cards-')),s=new SuiteStore(dir),author=s.actor('employee');
 const row=s.create(author,{key:'card',title:'Private',description:'Private',department:'Склад',category:s.categories()[0]});
 let now=1000;const links=new CardLinks({store:s,now:()=>now});const token=links.issue(row.taskId,'employee');
 assert.match(token,/^[A-Za-z0-9_-]+$/);assert.ok(!token.includes('Private'));assert.equal(links.resolve(token,author),row.taskId);
 assert.throws(()=>links.resolve(token,s.actor('manager')));assert.equal(new CardLinks({store:new SuiteStore(dir),now:()=>now}).resolve(token,author),row.taskId);
 now+=7*86400000+1;assert.throws(()=>links.resolve(token,author));
});
test('old assignee and disabled recipient lose links even before expiry',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cards-reassign-')),s=new SuiteStore(dir),a=s.person('employee'),admin=s.person('admin');const row=s.create(a,{key:'q',title:'T',description:'D',department:'Склад',category:s.categories()[0]}),links=new CardLinks({store:s});const owner=s.person(row.ownerId),token=links.issue(row.taskId,owner.id);assert.equal(links.resolve(token,owner),row.taskId);s.atomic(()=>{s.state.modus.cases[row.taskId].ownerId='owner2';});assert.throws(()=>links.resolve(token,owner));const author=links.issue(row.taskId,a.id);s.updateStaff(admin,{id:a.id,revision:a.revision,active:false});assert.throws(()=>links.resolve(author,a));assert.throws(()=>links.issue(row.taskId,'employee2'));
});
test('supervisor resolves only their own separately issued pointer',()=>{
 const s=new SuiteStore(fs.mkdtempSync(path.join(os.tmpdir(),'cards-supervisor-'))),a=s.person('employee'),manager=s.person('manager'),row=s.create(a,{key:'manager',title:'T',description:'D',department:'Склад',category:s.categories()[0]}),links=new CardLinks({store:s});const token=links.issue(row.taskId,manager.id);assert.equal(links.resolve(token,manager),row.taskId);assert.throws(()=>links.resolve(token,a));const admin=s.person('admin');s.updateStaff(admin,{id:manager.id,revision:manager.revision,role:'employee'});assert.throws(()=>links.resolve(token,{id:manager.id}));
});
