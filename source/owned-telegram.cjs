'use strict';
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const {spawn, spawnSync} = require('node:child_process');
const {randomBytes, randomUUID} = require('node:crypto');
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));

function localRequest(url, options) {
  return new Promise((resolve,reject)=>{
    const request = http.request(url,{method:options.method,headers:options.headers,agent:false},res=>{
      const chunks=[]; let size=0;
      res.on('data',chunk=>{
        size+=chunk.length;
        if(size>65536){request.destroy(Error('Bridge response too large'));return;}
        chunks.push(chunk);
      });
      res.on('end',()=>resolve({ok:res.statusCode>=200&&res.statusCode<300,json:async()=>JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
    });
    request.on('error',reject);
    request.setTimeout(3000,()=>request.destroy(Error('Bridge timeout')));
    request.end(options.body);
  });
}
function ownsPort(port,pid) {
  const result=spawnSync('netstat.exe',['-ano','-p','tcp'],{encoding:'utf8',windowsHide:true,timeout:3000});
  if(result.status!==0)return false;
  return result.stdout.split(/\r?\n/).some(line=>{
    const match=/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    return !!match&&Number(match[1])===port&&Number(match[2])===pid;
  });
}
class OwnedTelegram {
  constructor({python,bridge,profile,port,spawnImpl=spawn,fetchImpl=localRequest,realpath=fs.realpathSync.native,platform=process.platform,pid=process.pid,ownsPortImpl=ownsPort}) {
    if(platform!=='win32'||![python,bridge,profile].every(path.win32.isAbsolute)||!Number.isInteger(port)||port<1024||port>65535||port===4399)throw Error('Explicit isolated Windows bridge configuration required');
    Object.assign(this,{python,bridge,profile,port,spawnImpl,fetch:fetchImpl,realpath,parentPid:pid,ownsPortImpl});
    this.secret=randomBytes(32).toString('base64url');
    this.instanceId=randomUUID(); this.child=null; this.exited=false;
  }
  async request(action,method='GET') {
    if(!this.child?.pid||!this.ownsPortImpl(this.port,this.child.pid))throw Error('Bridge listener not owned');
    const response=await this.fetch('http://127.0.0.1:'+this.port+'/control/'+action,{
      method,headers:{authorization:'Bearer '+this.secret,'x-instance-id':this.instanceId,...(method==='POST'?{'content-type':'application/json'}:{})},
      ...(method==='POST'?{body:'{}'}:{}),redirect:'error',signal:AbortSignal.timeout(3000)
    });
    if(!response.ok)throw Error('Bridge management rejected '+action);
    return response.json();
  }
  async status() {
    const status=await this.request('status');
    const expected=this.realpath(this.profile).toLowerCase(),actual=String(status.profilePath||'').toLowerCase();
    const validCounts=status.active&&['requests','mutations','pollerJobs','providerRequests'].every(k=>Number.isSafeInteger(status.active[k])&&status.active[k]>=0);
    if(status.instanceId!==this.instanceId||status.pid!==this.child?.pid||status.port!==this.port||actual!==expected||!['running','quiescing','stopping'].includes(status.phase)||!validCounts||typeof status.idle!=='boolean')throw Error('Bridge identity or status mismatch');
    if(status.idle!==Object.values(status.active).every(n=>n===0))throw Error('Bridge inconsistent idle status');
    return status;
  }
  async start({timeoutMs=15000}={}) {
    if(this.child)throw Error('Bridge already started');
    this.child=this.spawnImpl(this.python,['-X','utf8','-m','telegram_adapter.server','--data',this.profile,'--port',String(this.port),'--control-stdin'],{cwd:this.bridge,windowsHide:true,stdio:['pipe','ignore','ignore']});
    this.child.on('error',error=>{this.error=error;});
    this.child.on('exit',(code,signal)=>{this.exited=true;this.exitCode=code;this.signal=signal;});
    this.child.stdin.on?.('error',()=>{});
    this.child.stdin.end(JSON.stringify({secret:this.secret,instanceId:this.instanceId,parentPid:this.parentPid})+'\n');
    const until=Date.now()+timeoutMs;
    do {
      if(this.error||this.exited)throw Error('Owned bridge exited before readiness');
      try{const status=await this.status();if(status.phase==='running')return status;}
      catch(error){if(/identity|inconsistent/.test(error.message))throw error;}
      await delay(100);
    } while(Date.now()<until);
    throw Error('Owned bridge readiness timeout');
  }
  async quiesce({timeoutMs=15000,intervalMs=100}={}) {
    await this.status(); await this.request('quiesce','POST');
    try {
      const until=Date.now()+timeoutMs;
      do {
        const status=await this.status();
        if(status.phase!=='quiescing')throw Error('Bridge did not enter quiesce');
        if(status.idle)return status;
        await delay(intervalMs);
      } while(Date.now()<until);
      throw Error('Bridge busy; stop deferred');
    } catch(error) {
      try{await this.request('resume','POST');}catch{}
      throw error;
    }
  }
  async resume() {await this.status();await this.request('resume','POST');}
  async shutdown({timeoutMs=15000}={}) {
    const status=await this.status();
    if(status.phase!=='quiescing'||!status.idle)throw Error('Bridge busy; stop deferred');
    const exited=new Promise(resolve=>{if(this.exited)return resolve();this.child.once('exit',resolve);});
    await this.request('shutdown','POST');
    let timer;
    try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Bridge shutdown timeout')),timeoutMs);})]);}
    finally{clearTimeout(timer);}
    if(this.exitCode!==0||this.signal)throw Error('Bridge did not exit normally');
    return {stopped:true};
  }
  async stop(options={}) {
    await this.quiesce(options);
    try{return await this.shutdown(options);}
    catch(error){if(!this.exited)try{await this.resume();}catch{}throw error;}
  }
}
module.exports={OwnedTelegram,ownsPort};
