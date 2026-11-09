'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {spawn}=require('child_process');
const APP=path.join(__dirname,'..');
const DATA=path.join(os.tmpdir(),'dly-probe-'+process.pid);
const PORT=4880;
fs.mkdirSync(DATA,{recursive:true});
for(const f of fs.readdirSync(path.join(APP,'data'))) if(f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP,'data',f),path.join(DATA,f));
for(const d of ['image-cache','logo-cache']){try{fs.cpSync(path.join(APP,'data',d),path.join(DATA,d),{recursive:true});}catch(e){fs.mkdirSync(path.join(DATA,d),{recursive:true});}}
const app=spawn(process.execPath,[path.join(APP,'server.js')],{env:{...process.env,NODE_ENV:'production',PORT:String(PORT),DLY_DATA_DIR:DATA,DLY_DISABLE_PUSH_SCHEDULER:'1'},stdio:['ignore','ignore','pipe']});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  for(let i=0;i<300;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/`);if(r.ok)break;}catch(e){}await sleep(100);}
  for (const page of ['/','/gallery','/pricelist','/cara-order']) {
    const html=await (await fetch(`http://127.0.0.1:${PORT}${page}`)).text();
    const urls=new Set();
    (html.match(/(?:src|href|data-src|srcset)="[^"]+"/g)||[]).forEach(a=>{
      a.replace(/^[a-z-]+="/,'').replace(/"$/,'')
        .split(',').forEach(part=>{
          const u=part.trim().split(/\s+/)[0];
          if(/^\/(media|logo|uploads|avatars|appicon|favicon)\//.test(u)) urls.add(u);
        });
    });
    let slow=[];
    for(const u of urls){
      const t=Date.now();
      const r=await fetch(`http://127.0.0.1:${PORT}${u}`);
      await r.arrayBuffer();
      const ms=Date.now()-t;
      if(ms>500||r.status!==200) slow.push(`${ms}ms ${r.status} ${u.slice(0,60)}`);
    }
    console.log(`${page}: ${urls.size} aset, lambat/gagal: ${slow.length}`);
    slow.slice(0,6).forEach(s=>console.log('   ',s));
  }
  app.kill('SIGTERM'); await sleep(500); fs.rmSync(DATA,{recursive:true,force:true});
})();
