import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const owned = resolve(here, '../../.local/lightpanda-cost');
const binary = resolve(process.env.LIGHTPANDA_BINARY || resolve(here, '../../.local/runtimes/lightpanda-1.0.2/lightpanda'));
const output = resolve(owned, process.env.LIGHTPANDA_RUN || 'release-smoke');
await mkdir(output, {recursive:true});
const records = [], requests = [];
const hash = data => createHash('sha256').update(data).digest('hex');
const delay = ms => new Promise(r=>setTimeout(r,ms));
const identity = `({ua:navigator.userAgent,language:navigator.language,languages:navigator.languages,platform:navigator.platform,hardwareConcurrency:navigator.hardwareConcurrency,deviceMemory:navigator.deviceMemory,screen:typeof screen==='undefined'?null:{width:screen.width,height:screen.height,colorDepth:screen.colorDepth},timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.NumberFormat().resolvedOptions().locale})`;
const functionalProbes = `
report.probeDone=false;
report.audio=[];
(async()=>{
 const Audio=globalThis.OfflineAudioContext||globalThis.webkitOfflineAudioContext;
 if(typeof Audio!=='function'){report.audio=[{status:'unsupported',api:typeof Audio}];return}
 for(const frequency of [440,880]){
  try{
   const context=new Audio(1,512,48000),oscillator=context.createOscillator();
   oscillator.type='sine';oscillator.frequency.value=frequency;oscillator.connect(context.destination);oscillator.start(0);
   let timer;
   const buffer=await Promise.race([context.startRendering(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('render deadline3000ms')),3000)})]);
   clearTimeout(timer);
   const samples=Array.from(buffer.getChannelData(0));
   report.audio.push({frequency,sampleRate:buffer.sampleRate,length:samples.length,samples,rms:Math.sqrt(samples.reduce((sum,x)=>sum+x*x,0)/samples.length),status:'observed'});
  }catch(error){report.audio.push({frequency,status:'error',error:String(error)})}
 }
})().catch(error=>report.audioError=String(error)).finally(()=>report.probeDone=true);
try{
 const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;
 const gl=canvas.getContext('webgl');
 if(!gl){report.webgl={status:'unsupported',context:null}}
 else{
  const compile=(kind,source)=>{const shader=gl.createShader(kind);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader)||'shader compile failed');return shader};
  const vertex=compile(gl.VERTEX_SHADER,'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}');
  const fragment=compile(gl.FRAGMENT_SHADER,'precision mediump float;uniform vec4 color;void main(){gl_FragColor=color;}');
  const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program)||'program link failed');
  gl.useProgram(program);
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  const position=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);gl.viewport(0,0,8,8);
  const color=gl.getUniformLocation(program,'color'),outputs=[];
  for(const input of [[1,0,0,1],[0,1,0,1]]){gl.uniform4fv(color,input);gl.drawArrays(gl.TRIANGLES,0,3);const pixel=new Uint8Array(4);gl.readPixels(4,4,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);outputs.push({input,pixel:Array.from(pixel),error:gl.getError()})}
  report.webgl={status:'observed',outputs};
 }
}catch(error){report.webgl={status:'error',error:String(error)}}
`;
const fixture = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#e7eef9;font:24px sans-serif;height:2500px}
button{position:absolute;width:200px;height:70px;background:#ffb000}
#go{left:40px;top:80px}#other{left:400px;top:80px}
input{position:absolute;left:40px;top:180px;width:280px;height:50px}
#result{position:absolute;top:260px;left:40px}#canvas{position:absolute;left:700px;top:80px}
</style><script>
window.first=${identity};window.report={first,clicks:[]};
${functionalProbes}
report.before={cookie:document.cookie,localStorage:localStorage.getItem('persist')};
document.cookie='persist=durable; Max-Age=86400; Path=/';localStorage.setItem('persist','durable');
try{
 const r=indexedDB.open('persist',1);r.onupgradeneeded=()=>r.result.createObjectStore('entries');
 r.onsuccess=()=>{const tx=r.result.transaction('entries','readwrite');const os=tx.objectStore('entries');
 const get=os.get('value');get.onsuccess=()=>{report.idbBefore=get.result??null;os.put('durable','value')};
 tx.oncomplete=()=>{report.idbCommitted=true;r.result.close()}};
 r.onerror=()=>report.idbError=String(r.error);
}catch(e){report.idbError=String(e)}
fetch('/echo?kind=fetch').then(r=>r.json()).then(x=>report.fetch=x);
try{const w=new Worker('/worker.js');w.onmessage=e=>report.worker=e.data;w.onerror=e=>report.workerError=String(e.message)}catch(e){report.workerError=String(e)}
</script>
<button id="go" onclick="report.clicks.push('left');document.getElementById('result').textContent='clicked'">Left button</button>
<button id="other" onclick="report.clicks.push('right')">Right button</button>
<input id="text" aria-label="Chinese text"><div id="result">not clicked</div>
<canvas id="canvas" width="100" height="100"></canvas><iframe src="/frame"></iframe><img src="/pixel.svg">
<script>
try{const c=document.getElementById('canvas').getContext('2d');c.fillStyle='#008844';c.fillRect(0,0,100,100);report.canvasPixel=Array.from(c.getImageData(50,50,1,1).data)}catch(e){report.canvasError=String(e)}
onload=()=>report.loaded=true;
</script>`;
await writeFile(resolve(output,'fixture.html'),fixture);
const server = createServer((req,res)=>{
  requests.push({url:req.url,headers:req.headers,time:new Date().toISOString()});
  if(req.url.startsWith('/echo')) {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.headers));}
  else if(req.url==='/worker.js') {res.setHeader('Content-Type','application/javascript');res.end(`fetch('/echo?kind=worker').then(r=>r.json()).then(headers=>postMessage({identity:${identity},scope:{document:typeof document,window:typeof window,brand:Object.prototype.toString.call(globalThis)},headers}));`);}
  else if(req.url==='/frame') {res.setHeader('Content-Type','text/html');res.end(`<script>window.first=${identity};parent.report.iframe=window.first;fetch('/echo?kind=iframe')</script>`);}
  else if(req.url==='/pixel.svg') {res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');}
  else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixture);}
});
await new Promise((r,j)=>{server.once('error',j);server.listen(18762,'127.0.0.1',r)});
const url='http://127.0.0.1:18762/';
class CDP {
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.onmessage=e=>{const m=JSON.parse(String(e.data));records.push({direction:'receive',...m});if(m.id){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}}};}
  static async open(endpoint){const ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});return new CDP(ws)}
  send(method,params={},sessionId){const id=++this.id;const m={id,method,params,...(sessionId?{sessionId}:{})};records.push({direction:'send',...m});return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method} deadline`))},8000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify(m))})}
  close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('closed'))}this.pending.clear();this.ws.close()}
}
async function start(config){
  const cookiePath=resolve(output,config.locale==='fr-FR'?'cookies-B.json':'cookies-A.json');
  const args=['serve','--host','127.0.0.1','--port','18763','--load-resources','iframe','--load-resources','worker','--load-resources','image','--load-resources','stylesheet','--locale',config.locale,'--timezone',config.timezone,'--cookie-jar',cookiePath];
  try {await stat(cookiePath);args.push('--cookie',cookiePath);}catch{}
  if(config.ua)args.push('--user-agent',config.ua);
  if(process.env.LIGHTPANDA_PATCHED){
    const environment={schema:3,revision:config.locale==='fr-FR'?2:1,resolved:{user_agent:config.locale==='fr-FR'?'Mozilla/5.0 CostSlice-B':'Mozilla/5.0 CostSlice-A',locale:config.locale,timezone:config.timezone,platform:config.locale==='fr-FR'?'Linux x86_64':'MacIntel',hardware_concurrency:config.locale==='fr-FR'?8:4,device_memory:config.locale==='fr-FR'?4:8},storage:{path:resolve(output,'storage',config.locale==='fr-FR'?'B':'A')}};
    const path=resolve(output,`resolved-${config.locale}.json`);
    await writeFile(path,JSON.stringify(environment,null,2));args.push('--environment-config',path);
  }else if(process.env.LIGHTPANDA_ENVIRONMENT)args.push('--environment-config',resolve(process.env.LIGHTPANDA_ENVIRONMENT));
  const child=spawn(binary,args,{env:{...process.env,LIGHTPANDA_DISABLE_TELEMETRY:'true',LIGHTPANDA_DISABLE_CORE_DUMP:'1'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  for(let i=0;i<80;i++){if(child.exitCode!==null)throw new Error(`process exit ${child.exitCode}: ${logs}`);try{const r=await fetch('http://127.0.0.1:18763/json/version');if(r.ok)return {child,args,endpoint:(await r.json()).webSocketDebuggerUrl,logs:()=>logs};}catch{}await delay(50)}
  child.kill('SIGKILL');throw new Error('startup deadline: '+logs);
}
async function stop(process,label){process.child.kill('SIGTERM');await Promise.race([new Promise(r=>process.child.once('exit',r)),delay(2000)]);if(process.child.exitCode===null)process.child.kill('SIGKILL');await writeFile(resolve(output,`${label}.log`),process.logs());}
async function raw(config,label){
  let process,cdp;const result={config};
  try{
    process=await start(config);result.args=process.args;cdp=await CDP.open(process.endpoint);
    result.version=await cdp.send('Browser.getVersion');
    const {browserContextId}=await cdp.send('Target.createBrowserContext');result.context=browserContextId;
    const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank',browserContextId});result.target=targetId;
    const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
    await cdp.send('Runtime.enable',{},sessionId);await cdp.send('Network.enable',{},sessionId);await cdp.send('Page.enable',{},sessionId);
    result.navigation=await cdp.send('Page.navigate',{url},sessionId);
    for(let i=0;i<90;i++){
      result.report=await cdp.send('Runtime.evaluate',{expression:'JSON.stringify(window.report)',returnByValue:true},sessionId);
      if(result.report.result?.value?.includes('"loaded":true')&&result.report.result.value.includes('"probeDone":true'))break;
      await delay(100);
    }
    result.report=JSON.parse(result.report.result.value);
    result.geometry=await cdp.send('Runtime.evaluate',{expression:'JSON.stringify({rects:Array.from(document.querySelectorAll("button,input,canvas")).map(e=>({id:e.id,rect:e.getBoundingClientRect().toJSON()})),hit:[document.elementFromPoint(140,115)?.id,document.elementFromPoint(500,115)?.id,document.elementFromPoint(140,205)?.id]})',returnByValue:true},sessionId);
    const screenshot=await cdp.send('Page.captureScreenshot',{format:'png'},sessionId);
    const png=Buffer.from(screenshot.data,'base64');await writeFile(resolve(output,`${label}.png`),png);
    result.screenshot={bytes:png.length,sha256:hash(png),claim:'upstream text-only renderer; not a genuine CSS page screenshot'};
    async function click(x,y){for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1},sessionId)}
    for(const [name,x,y]of [['left',140,115],['right',500,115],['focus',140,205]]){
      try{await click(x,y);result[name]=await cdp.send('Runtime.evaluate',{expression:'JSON.stringify({clicks:report.clicks,active:document.activeElement?.id})',returnByValue:true},sessionId)}catch(e){result[name]={error:String(e)}}
    }
    try{await cdp.send('Input.insertText',{text:'中文输入'},sessionId)}catch(e){result.textError=String(e)}
    result.afterInput=await cdp.send('Runtime.evaluate',{expression:'JSON.stringify({clicks:report.clicks,clicked:document.querySelector("#result").textContent,text:document.querySelector("#text").value})',returnByValue:true},sessionId);
    try{await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:140,y:400,deltaX:0,deltaY:600},sessionId);await click(500,115);result.afterScroll=await cdp.send('Runtime.evaluate',{expression:'JSON.stringify({scrollY,clicks:report.clicks})',returnByValue:true},sessionId)}catch(e){result.scrollError=String(e)}
    try{
      const current=await cdp.send('Runtime.evaluate',{expression:'JSON.stringify(Array.from(document.querySelectorAll("button,input")).map(e=>({id:e.id,x:e.getBoundingClientRect().x+e.getBoundingClientRect().width/2,y:e.getBoundingClientRect().y+e.getBoundingClientRect().height/2})))',returnByValue:true},sessionId);
      for(const p of JSON.parse(current.result.value))await click(p.x,p.y);
      await cdp.send('Input.insertText',{text:'中文输入'},sessionId);
      result.computedGeometryInput=await cdp.send('Runtime.evaluate',{expression:'JSON.stringify({clicks:report.clicks,text:document.querySelector("#text").value,active:document.activeElement?.id})',returnByValue:true},sessionId);
    }catch(e){result.computedGeometryInput={error:String(e)}}
    await cdp.send('Target.disposeBrowserContext',{browserContextId});
  }catch(e){result.error=String(e)}finally{cdp?.close();if(process)await stop(process,label)}
  return result;
}
const results={binary,sha256:hash(await readFile(binary)),started:new Date().toISOString(),raw:[],official:{}};
try{
  for(const [label,config] of [['A1',{locale:'en-US',timezone:'UTC'}],['B1',{locale:'fr-FR',timezone:'Europe/Paris'}],['A2',{locale:'en-US',timezone:'UTC'}],['B2',{locale:'fr-FR',timezone:'Europe/Paris'}]])results.raw.push({label,...await raw(config,label)});
  if(process.env.LIGHTPANDA_VIEWER){
    let runtime;
    try{runtime=await start({locale:'en-US',timezone:'UTC'});
      const viewer=spawn(resolve(process.env.LIGHTPANDA_VIEWER),[runtime.endpoint,url,resolve(output,'native-viewer.png')]);
      let stdout='',stderr='';viewer.stdout.on('data',d=>stdout+=d);viewer.stderr.on('data',d=>stderr+=d);
      const timer=setTimeout(()=>viewer.kill('SIGKILL'),15000);
      const exit=await new Promise(r=>{viewer.once('error',e=>r({error:String(e)}));viewer.once('exit',(status,signal)=>r({status,signal}))});clearTimeout(timer);
      results.viewer={...exit,stdout,stderr,component:'system AppKit NSImageView displaying unaltered Lightpanda text-only PNG; not genuine page rendering'};
    }catch(e){results.viewer={error:String(e)}}finally{if(runtime)await stop(runtime,'viewer')}
  }
  let runtime,browser;
  try{
    runtime=await start({locale:'en-US',timezone:'UTC'});
    browser=await puppeteer.connect({browserWSEndpoint:runtime.endpoint,protocolTimeout:8000});
    const context=await browser.createBrowserContext();const page=await context.newPage();
    await page.goto(url,{waitUntil:'load',timeout:8000});
    results.official={client:'puppeteer-core@24.31.0',url:await page.url(),report:await page.evaluate(()=>window.report)};
    await context.close();
  }catch(e){results.official.error=String(e)}finally{browser?.disconnect();if(runtime)await stop(runtime,'official')}
}finally{results.finished=new Date().toISOString();await writeFile(resolve(output,'results.json'),JSON.stringify(results,null,2));await writeFile(resolve(output,'protocol.json'),JSON.stringify(records,null,2));await writeFile(resolve(output,'http.json'),JSON.stringify(requests,null,2));server.close()}
console.log(JSON.stringify({
  binary:results.binary,sha256:results.sha256,output,
  rounds:results.raw.map(r=>({
    label:r.label,error:r.error,first:r.report?.first,storage_before:r.report?.before,idb_before:r.report?.idbBefore,idb_committed:r.report?.idbCommitted,
    worker_scope:r.report?.worker?.scope,audio:r.report?.audio?.map(a=>({frequency:a.frequency,status:a.status,error:a.error,length:a.length,rms:a.rms})),
    webgl:r.report?.webgl,canvas_pixel:r.report?.canvasPixel,input:r.computedGeometryInput?.result?.value
  })),official_error:results.official.error,viewer:results.viewer,
  raw_artifacts:['results.json','protocol.json','http.json']
},null,2));
