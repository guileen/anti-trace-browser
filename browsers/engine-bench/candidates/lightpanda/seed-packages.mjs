import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url)),owned=resolve(here,'../../.local/lightpanda-cost');
const packages=[
 {name:'pcre2',archive:'pcre2.tar.gz',hash:'pcre2-10.50.0-DEV-IZ6r6yDTrgCmI3jcBntPIdZLWLhNORGZZSi8hxQkc11x',strip:1},
 {name:'boringssl',archive:'boringssl-origin.tar.gz',hash:'N-V-__8AAEhRag6gHL85MNqOxGFtJs5Lu9fK22BDYLMwOJs6',strip:0},
];
const records=[];
for(const p of packages){
 const archive=resolve(owned,'dependency-archives',p.archive),bytes=await readFile(archive);
 let stdout='',stderr='';const verify=spawn('zig',['fetch','--pkg-dir',resolve(owned,'source/zig-pkg'),archive],{cwd:resolve(owned,'source'),env:{...process.env,ZIG_GLOBAL_CACHE_DIR:resolve(owned,'zig-global-cache')}});
 verify.stdout.on('data',d=>stdout+=d);verify.stderr.on('data',d=>stderr+=d);
 const status=await new Promise(r=>verify.once('exit',r));
 if(status!==0||stdout.trim()!==p.hash)throw new Error(`Exact content hash verification failed: ${p.name}: ${stdout} ${stderr}`);
 const directory=resolve(owned,'source/zig-pkg',p.hash);
 try{await stat(directory);throw new Error(`Refusing existing package directory: ${directory}`)}catch(e){if(e.code!=='ENOENT')throw e}
 await mkdir(directory,{recursive:true});
 const args=['-xzf',archive,'-C',directory,...(p.strip?['--strip-components=1']:[])];
 const unpack=spawn('tar',args);let unpackError='';unpack.stderr.on('data',d=>unpackError+=d);const unpackStatus=await new Promise(r=>unpack.once('exit',r));
 if(unpackStatus!==0)throw new Error(unpackError);
 records.push({...p,archive_sha256:createHash('sha256').update(bytes).digest('hex'),archive_bytes:bytes.length,verify:{status,stdout,stderr},extract:{command:'tar',args,status:unpackStatus},reason:'Avoid Zig0.17 cached Git URL archive wrapper mismatch and separate global-cache roots; seed the package tree only after exact pinned Zig hash verification.'});
 console.log(p.name,p.hash,'verified and extracted');
}
await writeFile(resolve(owned,'dependency-archives/seeded-packages.json'),JSON.stringify(records,null,2));
