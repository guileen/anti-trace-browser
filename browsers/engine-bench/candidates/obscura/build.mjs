import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync, existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = resolve(import.meta.dirname, '../..');
const work = resolve(root, '.local/obscura-cost');
const source = resolve(work, 'source');
const target = resolve(work, 'target');
mkdirSync(work, {recursive:true});
const fact = (command, args=[], cwd=source) => { const p=spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:64*1024*1024});return {status:p.status,error:p.error?.message,stdout:p.stdout,stderr:p.stderr}; };
const bytes = path => fact('du',['-sk',path],root);
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const profile=process.argv.includes('--release')?'release':'debug';
const result={schema:1,profile,started_at:new Date().toISOString(),source_commit:fact('git',['rev-parse','HEAD']).stdout.trim(),toolchain:fact('rustc',['--version','--verbose']),cargo:fact('cargo',['--version']),host:fact('uname',['-a']),sdk:fact('xcrun',['--show-sdk-path']),command:['cargo','build','--locked',...(profile==='release'?['--release']:[]),'-p','obscura-cli','--features','render','--bin','obscura'],feature_scope:'render enabled; stealth deliberately off because fixed wreq Windows profile is not environment configurable',cache_ownership:{cargo_home:process.env.CARGO_HOME||'~/.cargo (shared download cache)',target_dir:target,initial_target_exists:existsSync(resolve(target,profile))},before:{source:bytes(source),cargo:bytes(process.env.CARGO_HOME||`${process.env.HOME}/.cargo`)},builds:[]};
if(result.source_commit!=='7c751c5cd8833ac951d48320218c4fe91aa97ac8' || !result.toolchain.stdout.startsWith('rustc 1.99.1 (58cf8f9c3 2026-10-13)')) throw new Error('Pinned source/toolchain mismatch; install rustc 1.99.1 and prepare the pinned source');
result.input_patch={path:'browsers/engine-bench/candidates/obscura/runtime-environment.patch',sha256:sha(resolve(import.meta.dirname,'runtime-environment.patch'))};
const reportPrefix=`build-schema3-${profile}-${Date.now()}`;
const previousBinary=resolve(target,profile,'obscura');
let previousArtifact;
if(existsSync(previousBinary)){
 const previousSha=sha(previousBinary);
 const revision=resolve(work,'revisions',previousSha);
 mkdirSync(revision,{recursive:true});
 const archivedBinary=resolve(revision,'obscura');
 if(!existsSync(archivedBinary))copyFileSync(previousBinary,archivedBinary);
 previousArtifact={path:archivedBinary,bytes:statSync(archivedBinary).size,sha256:previousSha};
 const patch=resolve(import.meta.dirname,'runtime-environment.patch');
 const archivedPatch=resolve(revision,`runtime-environment-${sha(patch)}.patch`);
 if(!existsSync(archivedPatch))copyFileSync(patch,archivedPatch);
}
for (const kind of [existsSync(resolve(target,profile))?'warm-target':'clean-profile','incremental-no-change']) {
 if(kind==='incremental-no-change' && result.builds[0].status!==0) break;
 const start=performance.now();
 const p=spawnSync('cargo',result.command.slice(1),{cwd:source,env:{...process.env,CARGO_TARGET_DIR:target,CARGO_INCREMENTAL:'0',CARGO_BUILD_JOBS:process.env.CARGO_BUILD_JOBS||'2'},encoding:'utf8',maxBuffer:64*1024*1024,timeout:900000});
 writeFileSync(resolve(work,`${reportPrefix}-${kind}.log`),(p.stdout||'')+(p.stderr||''));
 result.builds.push({kind,status:p.status,signal:p.signal,error:p.error?.message,wall_ms:performance.now()-start,log:`${reportPrefix}-${kind}.log`});
 writeFileSync(resolve(work,`${reportPrefix}.json`),JSON.stringify(result,null,2));
}
result.after={target:bytes(target),cargo:bytes(process.env.CARGO_HOME||`${process.env.HOME}/.cargo`)};
const binary=resolve(target,profile,'obscura');
const buildsSucceeded=result.builds.length>0&&result.builds.every(build=>build.status===0);
if(buildsSucceeded&&existsSync(binary))result.artifact={path:binary,bytes:statSync(binary).size,sha256:sha(binary)};
else if(previousArtifact)result.previous_artifact=previousArtifact;
if(buildsSucceeded && result.input_patch.sha256!==sha(resolve(import.meta.dirname,'runtime-environment.patch')))throw new Error('Source patch changed during compilation; repeat with fixed build inputs');
result.status=buildsSucceeded&&existsSync(binary)?'built':'failed';
result.lock_sha256=sha(resolve(source,'Cargo.lock'));
result.metadata=fact('cargo',['metadata','--locked','--format-version','1','--filter-platform','aarch64-apple-darwin']);
if(result.metadata.status===0){const path=`${reportPrefix}-dependency-metadata.json`;writeFileSync(resolve(work,path),result.metadata.stdout);result.metadata={status:0,path};}
if(result.status==='failed'){
 const failure=result.builds.find(build=>build.status!==0);
 process.exitCode=Number.isInteger(failure?.status)&&failure.status>0?failure.status:1;
}
writeFileSync(resolve(work,`${reportPrefix}.json`),JSON.stringify(result,null,2));
if(result.status==='built')writeFileSync(resolve(import.meta.dirname,'current-build.json'),JSON.stringify({schema:1,runtime:'obscura',source_commit:result.source_commit,artifact:result.artifact,patch:result.input_patch,build_receipt:`browsers/engine-bench/.local/obscura-cost/${reportPrefix}.json`,qualification:'Successful compilation with unchanged source inputs; functionality and release acceptance are separate.'},null,2)+'\n');
console.log(JSON.stringify(result,null,2));
