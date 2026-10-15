// Test-only WishOS/web/device/raster.js snapshot; SHA256 d2949428130181dd5e29ea05f0a4277486bd5856ca5367de21676338b953c03f
// Independent legacy wire fixture; excluded from release packages.
/* Offline native six-color encoder. No libraries, network fonts or external requests. */
(function(root){
'use strict';
const colors=[0,1,2,3,5,6],rgb=[[0,0,0],[255,255,255],[255,255,0],[255,0,0],[0,0,255],[0,255,0]];
function nearest(r,g,b){let best=0,cost=Infinity;for(let i=0;i<6;i++){const d=(r-rgb[i][0])**2+(g-rgb[i][1])**2+(b-rgb[i][2])**2;if(d<cost){cost=d;best=i;}}return best;}
function quantize(rgba,w,h,mode='nearest'){
 if(rgba.length!==w*h*4)throw Error('像素尺寸不符');
 const out=new Uint8Array(w*h),err=mode==='dither'?new Float32Array(w*h*3):null;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
 const at=y*w+x,a=rgba[at*4+3]/255,v=[0,1,2].map(k=>rgba[at*4+k]*a+255*(1-a));
 let ix;
 if(mode==='exact'){ix=rgb.findIndex(c=>c.every((n,k)=>n===v[k]));if(ix<0)ix=0;}
 else {
 if(err)for(let k=0;k<3;k++)v[k]=Math.max(0,Math.min(255,v[k]+err[at*3+k]));
 if(Math.max(...v)-Math.min(...v)<24)ix=(v[0]*299+v[1]*587+v[2]*114)>=155000?1:0;
 else ix=nearest(...v);
 }
 out[at]=colors[ix];
 if(err)for(const [dx,dy,f] of [[1,0,7/16],[-1,1,3/16],[0,1,5/16],[1,1,1/16]])if(x+dx>=0&&x+dx<w&&y+dy<h)for(let k=0;k<3;k++)err[((y+dy)*w+x+dx)*3+k]+=(v[k]-rgb[ix][k])*f;
 }
 return out;
}
function crc32(a){let c=0xffffffff;for(const b of a){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function lz4(a){
 const out=[],table=new Int32Array(4096).fill(-1),n=a.length;let anchor=0,i=0;
 const hash=p=>Math.imul((a[p]|a[p+1]<<8|a[p+2]<<16|a[p+3]<<24),-1640531535)>>>20;
 const length=n=>{while(n>=255){out.push(255);n-=255;}out.push(n);};
 while(i<=n-12){const h=hash(i),prev=table[h];table[h]=i;
 if(prev<0||i-prev>65535||a[prev]!==a[i]||a[prev+1]!==a[i+1]||a[prev+2]!==a[i+2]||a[prev+3]!==a[i+3]){i++;continue;}
 let count=4;while(i+count<n-5&&a[prev+count]===a[i+count])count++;
 const literal=i-anchor,match=count-4;out.push(Math.min(15,literal)<<4|Math.min(15,match));if(literal>=15)length(literal-15);
 for(let p=anchor;p<i;p++)out.push(a[p]);const distance=i-prev;out.push(distance&255,distance>>>8);if(match>=15)length(match-15);
 i+=count;anchor=i;
 }
 const literal=n-anchor;out.push(Math.min(15,literal)<<4);if(literal>=15)length(literal-15);for(let p=anchor;p<n;p++)out.push(a[p]);return Uint8Array.from(out);
}
function encode(pixels,orientation='portrait',maxBytes=8000){
 if(pixels.length!==480*720||!['portrait','landscape'].includes(orientation))throw Error('画布尺寸或方向错误');
 for(const p of pixels){if(!colors.includes(p))throw Error('无效色码');}
 const palette=[...colors],bits=4;
 const body=[bits,palette.length,...palette],lookup=new Map(palette.map((p,i)=>[p,i]));
 for(let band=0;band<30;band++){
 const packed=new Uint8Array(16*720*bits/8);let i=0;
 for(let x=band*16;x<band*16+16;x++)for(let y=719;y>=0;y--){
 const source=orientation==='landscape'?x*720+(719-y):y*480+x;
 const v=lookup.get(pixels[source]);packed[(i*bits)>>>3]|=v<<(8-bits-(i*bits%8));i++;
 }
 const block=lz4(packed);body.push(block.length&255,block.length>>>8,...block);
 }
 const bytes=new Uint8Array(12+body.length),v=new DataView(bytes.buffer);bytes.set([78,77,80,49]);v.setUint16(4,480,true);v.setUint16(6,720,true);bytes.set(body,12);v.setUint32(8,crc32(bytes.subarray(12)),true);
 if(bytes.length>maxBytes)throw Error(`图片转换后 ${bytes.length} 字节，超过 ${maxBytes} 字节。请改用最近色、简化背景或减少照片混色；不会自动降低分辨率。`);
 return bytes;
}
const api={colors,rgb,quantize,crc32,lz4,encode};root.NotesRaster=api;
if(typeof module!=='undefined')module.exports=api;
})(globalThis);
