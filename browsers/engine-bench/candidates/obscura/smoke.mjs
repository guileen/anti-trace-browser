import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer-core';
const root=resolve(import.meta.dirname,'../..'),work=resolve(root,'.local/obscura-cost'),out=resolve(work,`schema3-smoke-${Date.now()}`);
const mode=process.argv.includes('--release')?'release':process.argv.includes('--optimized')?'patched-optimized':'patched';
const binary=mode==='release'?resolve(root,'.local/runtimes/obscura-0.2.6/obscura'):resolve(work,mode==='patched-optimized'?'target/release/obscura':'target/debug/obscura');
await mkdir(out,{recursive:true});
const save=(name,value)=>writeFile(resolve(out,name),JSON.stringify(value,null,2));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const identity=`({ua:navigator.userAgent,platform:navigator.platform,language:navigator.language,languages:navigator.languages,hardware:navigator.hardwareConcurrency,memory:navigator.deviceMemory,screen:[screen.width,screen.height],workerGlobal:typeof WorkerGlobalScope})`;
const echo=[];
const fixture=createServer((req,res)=>{
 echo.push({at:new Date().toISOString(),method:req.method,url:req.url,headers:req.headers,raw_headers:req.rawHeaders,http_version:req.httpVersion});
 if(req.url.startsWith('/echo')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({headers:req.headers,http_version:req.httpVersion}));return;}
 if(req.url.startsWith('/redirect')){res.writeHead(302,{location:'/page'});res.end();return;}
 if(req.url.startsWith('/worker.js')){res.setHeader('Content-Type','text/javascript');res.end(`postMessage({...${identity},documentType:typeof document,windowType:typeof window});`);return;}
 if(req.url.startsWith('/frame')){res.setHeader('Content-Type','text/html');res.end(`<script>globalThis.initial=${identity};</script><p>Frame</p>`);return;}
 if(req.url.startsWith('/style.css')){res.setHeader('Content-Type','text/css');res.end('body {font:18px sans-serif;} input,button {height:40px;width:220px;display:block;margin:10px;}');return;}
 res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Obscura cost fixture</title><link rel="stylesheet" href="/style.css"><script>globalThis.initial=${identity};</script><h1>Real page text 中文</h1><input id="entry"><button id="commit" onclick="document.querySelector('#result').textContent=document.querySelector('#entry').value">Commit</button><p id="result">unset</p><iframe src="/frame"></iframe>`);
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${fixture.address().port}`;
class CDP {
 constructor(ws,frames){this.ws=ws;this.frames=frames;this.seq=0;this.pending=new Map();ws.addEventListener('message',e=>{const v=JSON.parse(String(e.data));frames.push({direction:'in',frame:v});if(!v.id)return;const p=this.pending.get(v.id);if(!p)return;this.pending.delete(v.id);clearTimeout(p.timer);v.error?p.reject(new Error(JSON.stringify(v.error))):p.resolve(v.result||{});});}
 static async open(url,frames){const ws=new WebSocket(url);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});return new CDP(ws,frames);}
 send(method,params={},sessionId){const frame={id:++this.seq,method,params,...(sessionId?{sessionId}:{})};this.frames.push({direction:'out',frame});return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(frame.id);reject(new Error(method+' deadline'));},10000);this.pending.set(frame.id,{resolve,reject,timer});this.ws.send(JSON.stringify(frame));});}
 close(){this.ws.close();}
}
const result={schema:1,mode,binary,origin,started_at:new Date().toISOString(),runs:[],scope:{protocol:'HTTP/1.1 loopback; TLS/H2, two schemeful sites, cross-origin realms not covered',configuration:mode==='release'?'release UA CLI only; candidate patch is not present':'runtime-owned environment JSON before page script; no CDP replacements',gui:'screenshot and coordinate/text commands only; no human viewer acceptance'}};
result.output_directory=out;
const configs={};
const overrides={
 A:{hardware_concurrency:4,device_memory:4,locale:'en-US',languages:['en-US','en'],screen_width:1280,screen_height:720,avail_width:1280,avail_height:696,user_agent:'ObscuraCost/A'},
 B:{hardware_concurrency:12,device_memory:8,locale:'de-DE',languages:['de-DE','de'],screen_width:1920,screen_height:1080,avail_width:1920,avail_height:1056,user_agent:'ObscuraCost/B'},
};
const schemaSource="import json,sys; sys.path.insert(0,sys.argv[1]); from anti_trace.native_spec import create_native_spec,native_config_bytes; value=create_native_spec(sys.argv[2],runtime='obscura',storage_path=sys.argv[3],seed=sys.argv[4],overrides=json.loads(sys.argv[5]),network={'allow_private_network':True},binary=sys.argv[6]); sys.stdout.buffer.write(native_config_bytes(value))";
const safe=async(fn)=>{try{return {status:'observed',value:await fn()};}catch(e){return {status:'error',error:String(e)};}};
for(const label of ['A1','B1','A2','B2']){
 const env=label[0],frames=[],run={label,frames_file:`smoke-${mode}-${label}-frames.json`,operations:{}};result.runs.push(run);
 const storage=resolve(out,`profiles-${mode}/${env}`),config=resolve(out,`environment-${env}.json`),ready=resolve(out,`ready-${mode}-${label}.json`);
 await mkdir(storage,{recursive:true});
 if(!configs[env]){
  if(mode==='release')configs[env]={overrides:overrides[env]};
  else{
   const generated=spawnSync('python3',['-c',schemaSource,resolve(root,'../../cli'),env,storage,createHash('sha256').update(`native-schema3-${env}`).digest('hex'),JSON.stringify(overrides[env]),binary],{encoding:'utf8'});
   if(generated.status!==0)throw new Error(generated.stderr||'schema3 generator failed');
   configs[env]=JSON.parse(generated.stdout);
  }
 }
 await save(`environment-${env}.json`,configs[env]);
 await unlink(ready).catch(e=>{if(e.code!=='ENOENT')throw e;});
 const args=['--allow-private-network',...(mode==='release'?['--user-agent',configs[env].overrides.user_agent]:['--environment-config',config]),'serve','--workers','1','--storage-dir',storage,'--host','127.0.0.1','--port','0','--ready-file',ready];
 run.args=args;const log=[];
 const childEnv={...process.env};
 for(const key of ['OBSCURA_ENVIRONMENT','OBSCURA_PROXY','OBSCURA_ENVIRONMENT_GL_BACKEND'])delete childEnv[key];
 const child=spawn(binary,args,{env:childEnv,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>log.push(b.toString()));child.stderr.on('data',b=>log.push(b.toString()));
 let cdp,browser;
 try{
  let readyData;
  for(let i=0;i<1200;i++){try{readyData=JSON.parse(await readFile(ready,'utf8'));break;}catch{}if(child.exitCode!==null)throw new Error('runtime exited '+child.exitCode);await sleep(50);}
  if(!readyData)throw new Error('ready-file deadline');run.ready=readyData;
  const port=readyData.port||Number(new URL(readyData.ws_url||readyData.websocket_url||readyData.url).port);
  const ws=`ws://127.0.0.1:${port}${readyData.websocket_path || '/devtools/browser'}`;
  cdp=await CDP.open(ws,frames);
  run.operations.version=await safe(()=>cdp.send('Browser.getVersion'));
  if(mode!=='release'){
   const receipt=await cdp.send('Environment.getInfo');
   const digest=createHash('sha256').update(await readFile(config)).digest('hex');
   if(receipt.environment_sha256!==digest||receipt.id!==configs[env].id||receipt.revision!==configs[env].revision)throw new Error('native Environment.getInfo binding mismatch');
   run.operations.environment_receipt={status:'observed',value:receipt};
  }
  const ctx=await cdp.send('Target.createBrowserContext');run.context=ctx;
  const target=await cdp.send('Target.createTarget',{url:'about:blank'});run.target=target;run.storage_scope='default persistent context; separately created context is an incognito protocol probe';
  const attached=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});const sid=attached.sessionId;
  const cmd=(m,p)=>cdp.send(m,p,sid);
  const evaluate=async(expression)=>{const r=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
  await cmd('Page.enable');await cmd('Network.enable');
  run.operations.navigate=await safe(()=>cmd('Page.navigate',{url:origin+'/redirect',waitUntil:'load'}));
  run.operations.initial_identity=await safe(()=>evaluate('globalThis.initial'));
  run.operations.realms=await safe(()=>evaluate(`new Promise(resolve=>{const f=document.querySelector('iframe');const w=new Worker('/worker.js');w.onmessage=e=>resolve({page:${identity},frame:f.contentWindow.initial,worker:e.data});setTimeout(()=>resolve({error:'worker deadline',frame:f.contentWindow.initial}),2000)})`));
  run.operations.network=await safe(()=>evaluate(`fetch('/echo?kind=fetch').then(r=>r.json())`));
  run.operations.storage=await safe(()=>evaluate(`(async()=>{const before={cookie:document.cookie,local:localStorage.getItem('visit')};localStorage.setItem('visit',String(Number(before.local||0)+1));document.cookie='persist=${env}; Max-Age=86400; Path=/';const db=await new Promise((r,j)=>{const q=indexedDB.open('cost',1);q.onupgradeneeded=()=>q.result.createObjectStore('values');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});const previous=await new Promise((r,j)=>{const tx=db.transaction('values','readonly'),q=tx.objectStore('values').get('visit');q.onsuccess=()=>r(q.result===undefined?null:q.result);q.onerror=()=>j(q.error)});await new Promise((r,j)=>{const tx=db.transaction('values','readwrite');tx.objectStore('values').put(Number(previous||0)+1,'visit');tx.oncomplete=r;tx.onerror=()=>j(tx.error)});db.close();return {before,indexed_before:previous,after_cookie:document.cookie,after_local:localStorage.getItem('visit')}})()`));
  run.operations.canvas=await safe(()=>evaluate(`(()=>{const c=document.createElement('canvas');c.width=96;c.height=32;const x=c.getContext('2d');x.font='18px serif';x.fillText('Ab中文',1,22);return {text_pixels:Array.from(x.getImageData(0,0,96,32).data),measure:x.measureText('Ab中文').width,webgl:c.getContext('webgl')===null,webgl2:c.getContext('webgl2')===null}})()`));
  run.operations.webgl=await safe(()=>evaluate(`(()=>{
    const c=document.createElement('canvas');c.width=4;c.height=4;const g=c.getContext('webgl');
    if(!g)throw new Error('WebGL unavailable');
    const shader=(type,source)=>{const s=g.createShader(type);g.shaderSource(s,source);g.compileShader(s);if(!g.getShaderParameter(s,g.COMPILE_STATUS))throw new Error(g.getShaderInfoLog(s));return s;};
    const p=g.createProgram();g.attachShader(p,shader(g.VERTEX_SHADER,'attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}'));g.attachShader(p,shader(g.FRAGMENT_SHADER,'precision mediump float;uniform vec4 color;void main(){gl_FragColor=color;}'));g.linkProgram(p);
    if(!g.getProgramParameter(p,g.LINK_STATUS))throw new Error(g.getProgramInfoLog(p));
    g.useProgram(p);const b=g.createBuffer();g.bindBuffer(g.ARRAY_BUFFER,b);g.bufferData(g.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),g.STATIC_DRAW);
    const a=g.getAttribLocation(p,'position');g.enableVertexAttribArray(a);g.vertexAttribPointer(a,2,g.FLOAT,false,0,0);g.viewport(0,0,4,4);
    const color=g.getUniformLocation(p,'color'),pixels=new Uint8Array(64);
    g.uniform4f(color,1,0,0,1);g.drawArrays(g.TRIANGLES,0,3);g.readPixels(0,0,4,4,g.RGBA,g.UNSIGNED_BYTE,pixels);const red=Array.from(pixels);
    g.uniform4f(color,0,1,0,1);g.drawArrays(g.TRIANGLES,0,3);g.readPixels(0,0,4,4,g.RGBA,g.UNSIGNED_BYTE,pixels);
    return {vendor:g.getParameter(g.VENDOR),renderer:g.getParameter(g.RENDERER),version:g.getParameter(g.VERSION),red,green:Array.from(pixels),error:g.getError()};
  })()`));
  run.operations.audio=await safe(()=>evaluate(`(async()=>{const render=async(f)=>{const c=new OfflineAudioContext(1,8192,44100),o=c.createOscillator();o.frequency.value=f;o.connect(c.destination);o.start();return Array.from((await c.startRendering()).getChannelData(0))};return {hz440:await render(440),hz880:await render(880)}})()`));
  run.operations.input=await safe(async()=>{const box=await evaluate(`(()=>{const b=document.querySelector('#entry').getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);await cmd('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});await cmd('Input.insertText',{text:'真实输入-'+label});const button=await evaluate(`(()=>{const b=document.querySelector('#commit').getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);await cmd('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...button});await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...button});return evaluate(`({input:document.querySelector('#entry').value,result:document.querySelector('#result').textContent})`);});
  run.operations.screenshot=await safe(async()=>{const r=await cmd('Page.captureScreenshot',{format:'png'});const bytes=Buffer.from(r.data,'base64');const file=`smoke-${mode}-${label}.png`;await writeFile(resolve(out,file),bytes);return {file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};});
  await cdp.send('Target.closeTarget',{targetId:target.targetId});await cdp.send('Target.disposeBrowserContext',{browserContextId:ctx.browserContextId});cdp.close();cdp=null;
  run.operations.upstream_puppeteer=await safe(async()=>{browser=await puppeteer.connect({browserWSEndpoint:ws,protocolTimeout:10000});const page=await browser.newPage();await page.goto(origin+'/page',{waitUntil:'load',timeout:10000});const value={title:await page.title(),identity:await page.evaluate(()=>globalThis.initial)};await page.close();await browser.disconnect();browser=null;return value;});
 }catch(e){run.error=String(e);}finally{
  if(browser)await browser.disconnect().catch(()=>{});if(cdp)cdp.close();
  if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),sleep(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
  run.exit_code=child.exitCode;run.signal=child.signalCode;
  await writeFile(resolve(out,`smoke-${mode}-${label}.log`),log.join(''));await save(run.frames_file,frames);await save(`smoke-${mode}.json`,result);
 }
}
await new Promise(r=>fixture.close(r));await save(`smoke-${mode}-server.json`,echo);result.server_echo_file=`smoke-${mode}-server.json`;
await save(`smoke-${mode}.json`,result);console.log(JSON.stringify({mode,runs:result.runs.map(r=>({label:r.label,error:r.error,operations:Object.fromEntries(Object.entries(r.operations).map(([k,v])=>[k,k==='canvas'||k==='audio'?{status:v.status,error:v.error}:v]))}))},null,2));
