'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {spawn}=require('child_process');
const Database=require(path.join(__dirname,'..','node_modules','better-sqlite3'));
const APP=path.join(__dirname,'..');
const DATA=path.join(os.tmpdir(),'dly-pp-'+process.pid);
const PORT=4890, BASE=`http://127.0.0.1:${PORT}`;
fs.mkdirSync(DATA,{recursive:true});
for(const f of fs.readdirSync(path.join(APP,'data'))) if(f.startsWith('app.sqlite')) fs.copyFileSync(path.join(APP,'data',f),path.join(DATA,f));
for(const d of ['image-cache','logo-cache']){try{fs.cpSync(path.join(APP,'data',d),path.join(DATA,d),{recursive:true});}catch(e){}}
const db=new Database(path.join(DATA,'app.sqlite'),{readonly:true});
const token=(db.prepare('SELECT token FROM photo_selections LIMIT 1').get()||{}).token||'';
const pkg=(db.prepare('SELECT slug FROM packages LIMIT 1').get()||{}).slug;
const article=(db.prepare('SELECT slug FROM articles WHERE is_published=1 LIMIT 1').get()||{}).slug;
const city=(db.prepare('SELECT slug FROM cities LIMIT 1').get()||{}).slug;
db.close();
const app=spawn(process.execPath,[path.join(APP,'server.js')],{env:{...process.env,PORT:String(PORT),DLY_DATA_DIR:DATA},stdio:['ignore','ignore','pipe']});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const withTimeout=(p,ms)=>Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error('TIMEOUT '+ms+'ms')),ms))]);
(async()=>{
  for(let i=0;i<80;i++){try{const r=await fetch(BASE+'/');if(r.ok)break;}catch(e){}await sleep(250);}
  const pages=['/','/gallery','/portfolio','/pricelist','/city',city?`/city/${city}`:null,'/cara-order','/ulasan','/syarat-ketentuan','/tentang','/artikel','/faq','/booking','/sitemap.xml','/robots.txt',pkg?`/paket/${pkg}`:null,article?`/artikel/${article}`:null,token?`/selection/${token}`:null].filter(Boolean);
  const imgs=new Set();
  for(const u of pages){
    const t=Date.now();
    try{
      const r=await withTimeout(fetch(BASE+u),25000);
      const html=await withTimeout(r.text(),25000);
      console.log(`${String(Date.now()-t).padStart(5)}ms ${r.status} ${u}`);
      const re=/(?:src|data-src)="([^"]+\.(?:jpe?g|png|webp|gif|svg)(?:\?[^"]*)?)"/gi; let m;
      while((m=re.exec(html))) imgs.add(m[1]);
      const setRe=/srcset="([^"]+)"/gi;
      while((m=setRe.exec(html))) m[1].split(',').forEach(p=>{const u2=p.trim().split(/\s+/)[0]; if(u2) imgs.add(u2);});
    }catch(e){ console.log(`  ERR ${u} → ${e.message}`); }
  }
  console.log('total gambar unik:',imgs.size);
  let n=0;
  for(const src of imgs){
    const abs=src.startsWith('http')?src:BASE+(src.startsWith('/')?'':'/')+src;
    const t=Date.now();
    try{ const r=await withTimeout(fetch(abs),25000); await withTimeout(r.arrayBuffer(),25000); if(r.status!==200) console.log(`  BAD ${r.status} ${src.slice(0,60)}`); }
    catch(e){ console.log(`  ERR ${src.slice(0,70)} → ${e.message}`); }
    n++; if(n%40===0) console.log(`   ...${n}/${imgs.size} gambar (${Date.now()}ms)`);
  }
  console.log('selesai', n, 'gambar');
  app.kill('SIGTERM'); await sleep(500); fs.rmSync(DATA,{recursive:true,force:true});
})();
