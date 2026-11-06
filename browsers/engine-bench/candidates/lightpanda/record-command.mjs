import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),owned=resolve(here,'../../.local/lightpanda-cost');
const [name,command,...args]=process.argv.slice(2);
if(!name||!command||!/^[a-z0-9-]+$/.test(name))throw new Error('usage: node record-command.mjs <record-name> <command> [args...]');
await mkdir(resolve(owned,'build'),{recursive:true});
const started=performance.now();let stdout='',stderr='';
const globalCacheDir=process.env.BUILD_GLOBAL_CACHE_DIR||resolve(owned,'zig-global-cache');
const child=spawn(command,args,{cwd:resolve(owned,'source'),detached:true,env:{...process.env,ZIG_GLOBAL_CACHE_DIR:globalCacheDir,CARGO_HOME:resolve(owned,'cargo-home')}});
child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
const deadlineMs=Number(process.env.BUILD_TIMEOUT_MS||900000);
const timer=setTimeout(()=>{
  try{process.kill(-child.pid,'SIGTERM')}catch{}
  setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},2000);
},deadlineMs);
const result=await new Promise(r=>{child.once('error',e=>r({error:String(e)}));child.once('exit',(status,signal)=>r({status,signal}))});clearTimeout(timer);
const record={name,command,args,deadline_ms:deadlineMs,global_cache_dir:globalCacheDir,cargo_home:resolve(owned,'cargo-home'),cargo_net_offline:process.env.CARGO_NET_OFFLINE||null,...result,elapsed_ms:performance.now()-started,stdout,stderr};
await writeFile(resolve(owned,'build',`${name}.json`),JSON.stringify(record,null,2));
console.log(JSON.stringify(record,null,2));
process.exitCode=result.status??1;
