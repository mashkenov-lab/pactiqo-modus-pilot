'use strict';
const {spawn} = require('node:child_process');
const path = require('node:path');
// Only a boolean classification leaves the child process; command lines are not logged.
const inspectionScript = `$p=$env:MODUS_OWNED_PROFILE; $versions=$env:MODUS_OWNED_VERSIONS; $unknown=$false; $found=$false; try { $rows=Get-CimInstance Win32_Process -Filter "Name='Adapter.exe'" -ErrorAction Stop; foreach($r in $rows){ $ownedExe=$r.ExecutablePath -and $r.ExecutablePath.StartsWith($versions,[StringComparison]::OrdinalIgnoreCase); if(!$r.CommandLine){$unknown=$true;continue}; if($r.CommandLine.IndexOf($p,[StringComparison]::OrdinalIgnoreCase) -ge 0){$found=$true;continue}; if($ownedExe -and $r.CommandLine -notmatch '--profile-dir(?:=|\\s)'){$unknown=$true} }; if($found){'running'} elseif($unknown){'unknown'} else{'clear'} } catch {'unknown'}`;
async function inspectProfileProcesses(profile) {
  return new Promise(resolve=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',inspectionScript],{
      windowsHide:true,stdio:['ignore','pipe','ignore'],env:{...process.env,MODUS_OWNED_PROFILE:profile,MODUS_OWNED_VERSIONS:path.join(path.dirname(path.dirname(profile)),'versions')+path.sep}
    });
    let output='',settled=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1000)output=output.slice(-1000);});
    child.on('error',()=>finish('unknown'));
    child.on('exit',code=>{const state=code===0?output.trim():'unknown';finish(['running','unknown','clear'].includes(state)?state:'unknown');});
    const timer=setTimeout(()=>{child.kill();finish('unknown');},10000);
  });
}

async function reconcileOwnedAdapter({link, profile, version, inspect = inspectProfileProcesses, launch}) {
  let observed = null;
  try { observed = await link.probeVersion(); } catch {}
  if (observed) {
    return observed === version ? {state:'running',version:observed} : {state:'wrong-version',version:observed};
  }
  const processState = await inspect(profile);
  if (processState !== 'clear') return {state:'unverified',processState};
  await launch();
  return {state:'starting'};
}
module.exports = {inspectionScript, inspectProfileProcesses, reconcileOwnedAdapter};
