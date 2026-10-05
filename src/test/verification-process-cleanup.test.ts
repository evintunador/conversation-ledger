import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const pause=(ms:number)=>new Promise(done=>setTimeout(done,ms));
function alive(pid:number): boolean {
  try {process.kill(pid,0);} catch {return false;}
  // A killed orphan may briefly await its adopter's reap on Linux.
  const status=spawnSync("ps",["-o","stat=","-p",String(pid)],{encoding:"utf8"}).stdout.trim();
  return !!status && !status.startsWith("Z");
}
for(const type of ["process","pty"] as const) test(`parent cancellation reaps owned ${type} child and grandchild and preserves its signal`, async () => {
  const root=await mkdtemp(join(tmpdir(),"cledger-cancel-test-"));
  const pidsPath=join(root,"pids.json"), wrapper=join(root,"parent.mjs");
  const childCode=`const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const grand=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidsPath)},JSON.stringify([process.pid,grand.pid]));setInterval(()=>{},1000);`;
  const moduleUrl=new URL(`../verification/${type==="process"?"process":"pty"}.js`,import.meta.url).href;
  await writeFile(wrapper,`import {${type==="process"?"runProcess":"runPty"}} from ${JSON.stringify(moduleUrl)};await ${type==="process"?"runProcess":"runPty"}(process.execPath,['-e',${JSON.stringify(childCode)}],{cwd:${JSON.stringify(root)},env:{PATH:${JSON.stringify(process.env.PATH)}},timeoutMs:60000,actions:[]});`);
  const parent=spawn(process.execPath,[wrapper],{cwd:root,env:{PATH:process.env.PATH},detached:true,stdio:["ignore","ignore","pipe"]});
  let stderr=""; parent.stderr.on("data",chunk=>{stderr+=chunk;});
  const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(done=>parent.once("close",(code,signal)=>done({code,signal})));
  let pids:number[]=[];
  try {
    const deadline=Date.now()+5000;
    while(Date.now()<deadline) {
      try {pids=JSON.parse(await readFile(pidsPath,"utf8"));break;} catch {await pause(20);}
    }
    assert.equal(pids.length,2,stderr);
    assert.ok(pids.every(alive),"Fixture child and grandchild must actually be running");
    const signal=type==="process"?"SIGTERM":"SIGINT";
    parent.kill(signal); // Signal the Node parent alone, not its process group.
    const result=await Promise.race([closed,pause(5000).then(()=>{throw Error("Parent did not exit after cancellation")})]);
    assert.equal(result.signal,signal,stderr);
    const cleanupDeadline=Date.now()+5000;
    while(pids.some(alive) && Date.now()<cleanupDeadline) await pause(20);
    assert.ok(pids.every(pid=>!alive(pid)),`Owned descendants survived parent cancellation: ${pids}`);
  } finally {
    if(parent.pid) {try {process.kill(-parent.pid,"SIGKILL");} catch {}}
    for(const pid of pids) {try {process.kill(-pid,"SIGKILL");} catch {} try {process.kill(pid,"SIGKILL");} catch {}}
    await rm(root,{recursive:true,force:true});
  }
});
