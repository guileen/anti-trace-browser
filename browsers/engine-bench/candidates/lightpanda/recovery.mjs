import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url)),owned=resolve(here,'../../.local/lightpanda-cost');
const sha=b=>createHash('sha256').update(b).digest('hex');
const load=async name=>JSON.parse(await readFile(resolve(owned,name),'utf8'));
const logs={};for(const name of process.argv.slice(2))logs[name]=await load(`build/${name}.json`);
const binary=resolve(owned,'source/zig-out/bin/lightpanda');
let artifact;try{const bytes=await readFile(binary);artifact={path:'source/zig-out/bin/lightpanda',bytes:bytes.length,sha256:sha(bytes)}}catch{}
let smoke;try{smoke=await load('patched-controlled/results.json')}catch{}
let patch='';const git=spawn('git',['diff','--binary'],{cwd:resolve(owned,'source')});git.stdout.on('data',d=>patch+=d);let errors='';git.stderr.on('data',d=>errors+=d);const status=await new Promise(r=>git.on('exit',r));if(status!==0)throw new Error(errors);
await writeFile(resolve(here,'runtime.patch'),patch);
const origin_archives=[];for(const name of ['curl-origin','boringssl-origin']){const path=resolve(owned,`dependency-archives/${name}.tar.gz`);try{const bytes=await readFile(path);origin_archives.push({name,bytes:bytes.length,sha256:sha(bytes)})}catch{}}
const report={schema:1,candidate:'lightpanda',source_commit:'c5f7bb29b127040c899d4e181b5709f76fc71a6f',origin_archives,build_attempts:Object.fromEntries(Object.entries(logs).map(([name,r])=>[name,{command:r.command,args:r.args,status:r.status,signal:r.signal,elapsed_ms:r.elapsed_ms,stdout:r.stdout,stderr:r.stderr,raw_log:`browsers/engine-bench/.local/lightpanda-cost/build/${name}.json`}])),artifact,patch:{bytes:Buffer.byteLength(patch),sha256:sha(patch),modules:[...patch.matchAll(/^diff --git a\/(.+) b\//gm)].map(m=>m[1]),added_lines:patch.split('\n').filter(s=>s.startsWith('+')&&!s.startsWith('+++')).length,removed_lines:patch.split('\n').filter(s=>s.startsWith('-')&&!s.startsWith('---')).length},smoke:smoke?{artifact_sha256:smoke.sha256,started:smoke.started,finished:smoke.finished,official:smoke.official,rounds:smoke.raw,viewer:smoke.viewer}:null,remaining:['Experimental config subset is not complete product EnvironmentSpec receipt or seed generator','Genuine CSS/image/Canvas/GL/audio rendering and full same/different environment matrix remain outstanding','Profile locking, abnormal-exit recovery, migration/export/import, sandbox and proxy fail-closed behavior remain unaccepted'],cost_card_ownership:'Parent integrates this recovery without losing its shared-workload performance additions; this script never rewrites cost-card.json'};
report.cache_boundary = {
  recovered:'Previous owned native outputs may be reused; not reported as clean compilation.',
  clean:'recovered-clean-final uses fresh .local/lightpanda-cost/clean-objects and clean-global-cache. Existing pinned source/zig-pkg, prebuilt V8 archive and Cargo source/crate caches are retained; no object cache is borrowed from outside the candidate.',
  incremental:'Same commands, source, flags, local/global object caches and install path as clean; no edits between clean and incremental.',
  no_full_v8_source_build:'V8 static archive is a retained dependency asset; V8 compiler/toolchain rebuild was not measured.'
};
for (const [name,raw] of Object.entries(logs)) {
  const entry=report.build_attempts[name];
  entry.global_cache_dir=raw.global_cache_dir;
  entry.cargo_home=raw.cargo_home;
  entry.cargo_net_offline=raw.cargo_net_offline;
  entry.stage=name==='clean-build'||name==='incremental-build'?'initial_dependency_transport':
    name==='recovered-clean'?'package_transport_and_archive_root_layout':
    name==='recovered-compile'?'native_graph_format_guard_and_Rust_acquisition_wait':
    name.includes('icu-data')?'named_Rust_dependency_transport':
    name==='recovered-rust-offline'?'offline_named_dependency_diagnosis':
    name==='recovered-clean-final'?'clean_native_compilation_with_pinned_dependency_assets':
    name==='recovered-incremental-final'?'no_change_incremental_compilation':'recovered_native_compilation_not_clean';
}
report.seeded_packages=await load('dependency-archives/seeded-packages.json');
report.verified_Rust_prerequisite=await load('dependency-archives/icu-segmenter-verified.json');
function functional(rows) {
  return rows.map(r=>({
    label:r.label,error:r.error,first:r.report?.first,worker_scope:r.report?.worker?.scope,
    audio:r.report?.audio?.map(a=>{
      const samples=a.samples||[],bytes=Buffer.alloc(samples.length*4);
      samples.forEach((x,i)=>bytes.writeFloatLE(x,i*4));
      return {frequency:a.frequency,status:a.status,error:a.error,sampleRate:a.sampleRate,length:a.length,rms:a.rms,float32_le_sha256:samples.length?sha(bytes):null};
    }),
    webgl:r.report?.webgl,canvas_pixel:r.report?.canvasPixel,
    storage_before:r.report?.before,idb_before:r.report?.idbBefore,idb_committed:r.report?.idbCommitted
  }));
}
report.release_functional={artifact_sha256:(await load('release-functional/results.json')).sha256,observations:functional((await load('release-functional/results.json')).raw),raw:'browsers/engine-bench/.local/lightpanda-cost/release-functional/results.json'};
if(smoke)report.patched_functional=functional(smoke.raw);
report.remaining[1]='Genuine CSS/image/Canvas/GL rendering remains absent; connected 440/880 Audio input response is observed, but required audio environment differentiation and the complete functional/identity matrix remain outstanding';
report.source_package_version='1.1.0-dev.1+c5f7bb2 (observed build log and HTTP client hints); source is still pinned at tag1.0.2 commit c5f7bb29b127040c899d4e181b5709f76fc71a6f, not the unchanged release binary';
report.final_disk=await load('disk-final.json');
report.build_CPU_and_peak_memory='not_measured; elapsed build times do not establish runtime throughput or memory performance';
report.smoke_matches_final_artifact=!!smoke&&smoke.sha256===artifact?.sha256;
report.final_pixel_observation=await load('patched-controlled/image-metrics.json');
if(smoke) {
  const byLabel=Object.fromEntries(smoke.raw.map(r=>[r.label,r]));
  const identityKeys=['ua','language','languages','platform','hardwareConcurrency','deviceMemory','timezone','locale'];
  const pick=o=>JSON.stringify(identityKeys.map(k=>o?.[k]));
  report.measured_assertions={
    A_restart_identity_stable:pick(byLabel.A1?.report?.first)===pick(byLabel.A2?.report?.first),
    B_restart_identity_stable:pick(byLabel.B1?.report?.first)===pick(byLabel.B2?.report?.first),
    A_B_configured_fields_differ:pick(byLabel.A1?.report?.first)!==pick(byLabel.B1?.report?.first),
    page_iframe_worker_common_fields_equal:smoke.raw.every(r=>pick(r.report?.first)===pick(r.report?.iframe)&&pick(r.report?.first)===pick(r.report?.worker?.identity)),
    echo_UA_matches_first_script:smoke.raw.every(r=>r.report?.fetch?.['user-agent']===r.report?.first?.ua&&r.report?.worker?.headers?.['user-agent']===r.report?.first?.ua),
    cold_Cookie_LocalStorage_IndexedDB_restore:['A2','B2'].every(label=>{const r=byLabel[label]?.report;return r?.before?.cookie==='persist=durable'&&r.before.localStorage==='durable'&&r.idbBefore==='durable'}),
    separate_fresh_A_B_stores:['A1','B1'].every(label=>{const r=byLabel[label]?.report;return r?.before?.cookie===''&&r.before.localStorage===null&&r.idbBefore===null}),
    Worker_has_no_document_or_window:smoke.raw.every(r=>r.report?.worker?.scope?.document==='undefined'&&r.report?.worker?.scope?.window==='undefined'),
    required_GUI_complete:false,
    scope:'Only measured configuration/storage/Worker cases; not a full EnvironmentSpec, realm-isolation, security or identity gate'
  };
}
// Raw vectors and compiler logs already have immutable evidence paths.
if(smoke)report.smoke={artifact_sha256:smoke.sha256,started:smoke.started,finished:smoke.finished,labels:smoke.raw.map(r=>r.label),raw:'browsers/engine-bench/.local/lightpanda-cost/patched-controlled/results.json',protocol:'browsers/engine-bench/.local/lightpanda-cost/patched-controlled/protocol.json',http:'browsers/engine-bench/.local/lightpanda-cost/patched-controlled/http.json'};
for(const entry of Object.values(report.build_attempts)){delete entry.stdout;delete entry.stderr}
await writeFile(resolve(here,'recovery.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({artifact,patch:report.patch,build_attempts:Object.fromEntries(Object.entries(report.build_attempts).map(([k,r])=>[k,{status:r.status,elapsed_ms:r.elapsed_ms}])),smoke_rounds:smoke?.raw.map(r=>({label:r.label,error:r.error,before:r.report?.before,idb_before:r.report?.idbBefore,first:r.report?.first}))},null,2));
