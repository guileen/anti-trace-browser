import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const owned=resolve(here,'../../.local/lightpanda-cost'),source=resolve(owned,'source'),downloads=resolve(owned,'dependency-archives');
await mkdir(downloads,{recursive:true});
const deps=[
 {name:'curl',url:'https://github.com/curl/curl/releases/download/curl-8_23_0/curl-8.23.0.tar.gz',hash:'N-V-__8AAMjlVwH79yAHsK65VUcPuhOO6BWgpLDvvnlWPLly'},
 {name:'zenai',url:'https://codeload.github.com/lightpanda-io/zenai/tar.gz/8bfbb3e5788d278a63708db8ee5f58aa589f9fff',hash:'zenai-0.0.0-iOY_VHNwCAAZJVdc_8q-Vs7j5hexgpBh_8s6c6F1dlay'},
 {name:'pcre2',url:'https://codeload.github.com/PCRE2Project/pcre2/tar.gz/9ad4a2e956876747a5022bf04614c7e39e71d4ec',hash:'pcre2-10.50.0-DEV-IZ6r6yDTrgCmI3jcBntPIdZLWLhNORGZZSi8hxQkc11x'},
 {name:'boringssl',url:'https://codeload.github.com/google/boringssl/tar.gz/7c1efd8d6ffb36a57feba44e8c73cf674801f3cb',hash:'N-V-__8AAEhRag6gHL85MNqOxGFtJs5Lu9fK22BDYLMwOJs6'},
];
const origins = process.argv.includes('--official-origins');
if (origins) deps.splice(0, deps.length,
 {name:'curl-origin',url:'https://curl.se/download/curl-8.23.0.tar.gz',hash:'N-V-__8AAMjlVwH79yAHsK65VUcPuhOO6BWgpLDvvnlWPLly'},
 {name:'boringssl-origin',url:'https://boringssl.googlesource.com/boringssl/+archive/7c1efd8d6ffb36a57feba44e8c73cf674801f3cb.tar.gz',hash:'N-V-__8AAEhRag6gHL85MNqOxGFtJs5Lu9fK22BDYLMwOJs6'}
);
const api = process.argv.includes('--boringssl-api');
if (api) deps.splice(0, deps.length, {
 name:'boringssl-api',
 url:'https://api.github.com/repos/google/boringssl/tarball/7c1efd8d6ffb36a57feba44e8c73cf674801f3cb',
 hash:'N-V-__8AAEhRag6gHL85MNqOxGFtJs5Lu9fK22BDYLMwOJs6'
});
async function run(command,args,timeout){const started=performance.now();let stdout='',stderr='';const child=spawn(command,args,{cwd:source,env:{...process.env,ZIG_GLOBAL_CACHE_DIR:resolve(owned,'zig-global-cache'),CARGO_HOME:resolve(owned,'cargo-home')}});child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);const status=await new Promise(r=>{child.once('error',e=>r({error:String(e)}));child.once('exit',(status,signal)=>r({status,signal}))});clearTimeout(timer);return{command,args,elapsed_ms:performance.now()-started,...status,stdout,stderr}}
const report=[];
for(const dep of deps){
 const archive=resolve(downloads,`${dep.name}.tar.gz`);
 const download=await run('curl',['--fail','--location','--retry',api?'0':'1','--connect-timeout','15','--max-time',api?'120':'180','--output',archive,dep.url],api?140000:380000);
 const result={...dep,download};
 if(download.status===0){const bytes=await readFile(archive);result.archive={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};result.fetch=await run('zig',['fetch','--pkg-dir',resolve(source,'zig-pkg'),archive],180000);result.hash_matches=result.fetch.status===0&&result.fetch.stdout.trim().split('\n').at(-1)===dep.hash;}
 report.push(result);await writeFile(resolve(downloads,`${dep.name}.json`),JSON.stringify(result,null,2));console.log(dep.name,{download:download.status,fetch:result.fetch?.status,hash_matches:result.hash_matches});
}
await writeFile(resolve(downloads,api?'summary-api.json':origins?'summary-origins.json':'summary.json'),JSON.stringify(report,null,2));
if(report.some(r=>!r.hash_matches))process.exitCode=1;
