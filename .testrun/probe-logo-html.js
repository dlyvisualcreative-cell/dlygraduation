'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {spawn}=require('child_process');
const APP=path.join(__dirname,'..');
const DATA=path.join(os.tmpdir(),'dly-lh-'+process.pid);
const PORT=4895;
fs.mkdirSync(DATA,{recursive:true});
for(const f of fs.readdirSync(path.join(APP,'data'))) if(f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP,'data',f),path.join(DATA,f));
for(const d of ['image-cache','logo-cache']){try{fs.cpSync(path.join(APP,'data',d),path.join(DATA,d),{recursive:true});}catch(e){}}
const app=spawn(process.execPath,[path.join(APP,'server.js')],{env:{...process.env,NODE_ENV:'production',PORT:String(PORT),DLY_DATA_DIR:DATA,DLY_DISABLE_PUSH_SCHEDULER:'1'},stdio:['ignore','ignore','ignore']});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  for(let i=0;i<300;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/`);if(r.ok)break;}catch(e){}await sleep(100);}
  const html=await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  const logos=html.match(/<picture>[\s\S]*?<\/picture>/g)||[];
  const logoPics=logos.filter(p=>p.includes('/logo/'));
  console.log('picture logo:',logoPics.length);
  logoPics.slice(0,2).forEach(p=>console.log('IMG:', (p.match(/<img[^>]*>/)||[''])[0].replace(/srcset="[^"]*"/,'srcset="…"').slice(0,220),'\n'));
  const login=await (await fetch(`http://127.0.0.1:${PORT}/portal`)).text();
  const lp=(login.match(/<picture>[\s\S]*?<\/picture>/g)||[]).filter(p=>p.includes('/logo/'));
  console.log('logo di halaman login portal:',lp.length, lp[0]?lp[0].replace(/\s+/g,' ').slice(0,220):'');
  app.kill('SIGTERM'); await sleep(400); fs.rmSync(DATA,{recursive:true,force:true});
})();
