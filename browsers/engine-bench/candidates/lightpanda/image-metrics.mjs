import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { resolve } from 'node:path';
const path=resolve(process.argv[2]);
const png=await readFile(path);
if(!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('not PNG');
let width,height,channels,parts=[];
for(let p=8;p<png.length;){const n=png.readUInt32BE(p),type=png.toString('ascii',p+4,p+8),data=png.subarray(p+8,p+8+n);p+=n+12;if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);channels=({2:3,6:4})[data[9]];if(data[8]!==8||!channels||data[12]!==0)throw new Error('only noninterlaced RGB/RGBA 8-bit PNG supported')}if(type==='IDAT')parts.push(data);if(type==='IEND')break}
const bytes=inflateSync(Buffer.concat(parts)),stride=width*channels,pixels=Buffer.alloc(stride*height);
const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c};
for(let y=0;y<height;y++){const filter=bytes[y*(stride+1)];for(let x=0;x<stride;x++){const a=x>=channels?pixels[y*stride+x-channels]:0,b=y?pixels[(y-1)*stride+x]:0,c=y&&x>=channels?pixels[(y-1)*stride+x-channels]:0;const predictor=[()=>0,()=>a,()=>b,()=>Math.floor((a+b)/2),()=>paeth(a,b,c)][filter];if(!predictor)throw new Error('bad filter');pixels[y*stride+x]=(bytes[y*(stride+1)+1+x]+predictor())&255}}
const pixel=(x,y)=>[...pixels.subarray((y*width+x)*channels,(y*width+x)*channels+3),channels===4?pixels[(y*width+x)*channels+3]:255];
const counts=new Map();for(let y=0;y<height;y++)for(let x=0;x<width;x++){const key=pixel(x,y).join(',');counts.set(key,(counts.get(key)||0)+1)}
const expected={body:[231,238,249,255],button:[255,176,0,255],canvas:[0,136,68,255]};
const result={image:path,width,height,samples:Object.fromEntries([[10,10],[140,115],[500,115],[750,130]].map(([x,y])=>[`${x},${y}`,pixel(x,y)])),expected_css:expected,expected_color_counts:Object.fromEntries(Object.entries(expected).map(([k,v])=>[k,counts.get(v.join(','))||0])),top_colors:[...counts].sort((a,b)=>b[1]-a[1]).slice(0,5)};
await writeFile(resolve(path,'../image-metrics.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
