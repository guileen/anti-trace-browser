import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../../.local/lightpanda-cost');
const source=resolve(root,'source');
await mkdir(resolve(root,'build'),{recursive:true});
async function run(name,command,args,cwd=source,timeout=900000){
  const started=performance.now();let stdout='',stderr='';
  const child=spawn(command,args,{cwd,env:{...process.env,ZIG_GLOBAL_CACHE_DIR:resolve(root,'zig-global-cache'),CARGO_HOME:resolve(root,'cargo-home')}});
  child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);
  const result=await new Promise(r=>{child.once('error',error=>r({error:String(error)}));child.once('exit',(status,signal)=>r({status,signal}))});clearTimeout(timer);
  const record={name,command,args,cwd,elapsed_ms:performance.now()-started,...result,stdout,stderr};
  await writeFile(resolve(root,'build',`${name}.json`),JSON.stringify(record,null,2));console.log(name,result,record.elapsed_ms);return record;
}
async function bytes(path){let n=0;for(const e of await readdir(path,{withFileTypes:true}).catch(()=>[])){const p=resolve(path,e.name);if(e.isDirectory())n+=await bytes(p);else if(e.isFile())n+=(await stat(p)).size}return n}
const report={started:new Date().toISOString(),source:'https://github.com/lightpanda-io/browser.git',tag:'1.0.2',source_commit:'c5f7bb29b127040c899d4e181b5709f76fc71a6f',cache_ownership:root};
for(const [name,args]of [['zig',['version']],['cargo',['--version']],['rustc',['--version']],['cmake',['--version']],['clang',['--version']]])await run(name,name,args,source,30000);
report.prebuilt=await run('prebuilt-v8','make',['download-v8']);
report.clean=await run('clean-build','zig',['build','-Doptimize=fast','-j4']);
report.incremental=await run('incremental-build','zig',['build','-Doptimize=fast','-j4']);
report.patch=await run('patch','git',['diff','--binary']);
await writeFile(resolve(here,'runtime.patch'),report.patch.stdout);
const binary=resolve(source,'zig-out/bin/lightpanda');
try {const b=await readFile(binary);report.artifact={path:binary,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')}}catch{}
report.disk_bytes=await bytes(root);report.finished=new Date().toISOString();
await writeFile(resolve(root,'build','summary.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({clean:report.clean.status,incremental:report.incremental.status,artifact:report.artifact,disk_bytes:report.disk_bytes}));
