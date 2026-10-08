'use strict';
/* ================= data + sanitising ================= */
const KEY='stopzfighting_v1';
const KINDS=['grievances','rules','zombies','affirms','photos'];
const STATUSES=['open','ruled','ready','burned'];
const ID_RE=/^x[a-z0-9]{1,12}$/;
const IMG_DATA_RE=/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+\/=]+$/;
const IMG_URL_RE=/^https:\/\/[a-z0-9.-]+\.public\.blob\.vercel-storage\.com\/[A-Za-z0-9._\-\/%]+$/i;
const $=id=>document.getElementById(id);
const str=(v,n)=>String(v==null?'':v).slice(0,n);
const side=v=>v==='B'?'B':'A';
const isHostedImg=u=>typeof u==='string'&&IMG_URL_RE.test(u);
const safeImg=u=>{
  if(typeof u!=='string'||!u) return '';
  if(isHostedImg(u)&&u.length<500) return u;
  if(IMG_DATA_RE.test(u)&&u.length<600000) return u;
  return '';
};
const cleanProof=p=>({text:str(p&&p.text,4000),photo:safeImg(p&&p.photo)});
const emptyProof=()=>({A:{text:'',photo:''},B:{text:'',photo:''}});

function cleanItem(k,x){
  if(!x||typeof x!=='object'||!ID_RE.test(x.id)) return null;
  const b={id:x.id,ts:+x.ts||0,u:+x.u||0};
  if(x.del) b.del=true;
  if(k==='grievances'){
    const pr=x.proof||{};
    Object.assign(b,{title:str(x.title,80),detail:str(x.detail,4000),by:side(x.by),photo:safeImg(x.photo),
      status:STATUSES.includes(x.status)?x.status:'open',proof:{A:cleanProof(pr.A),B:cleanProof(pr.B)}});
  } else if(k==='rules') Object.assign(b,{text:str(x.text,120),breaks:Math.max(0,Math.floor(+x.breaks||0))});
  else if(k==='zombies') Object.assign(b,{who:side(x.who),kind:x.kind==='rule'?'rule':'buried',ref:str(x.ref,120)});
  else if(k==='affirms') Object.assign(b,{to:side(x.to),by:side(x.by),text:str(x.text,1000)});
  else Object.assign(b,{url:safeImg(x.url),cap:str(x.cap,80),by:side(x.by)});
  return b;
}
function clean(db){
  db=(db&&typeof db==='object')?db:{};
  const n=db.names||{};
  const o={names:{A:str(n.A,24).trim()||'Partner A',B:str(n.B,24).trim()||'Partner B'},namesU:+db.namesU||0,
    device:side(db.device||db.holder),room:(typeof db.room==='string'&&db.room)?str(db.room,120):null,
    updatedAt:+db.updatedAt||0};
  KINDS.forEach(k=>{ o[k]=(Array.isArray(db[k])?db[k]:[]).map(x=>cleanItem(k,x)).filter(Boolean); });
  return o;
}

/* merge: per item, newest edit wins; deletes are tombstones (del:true) */
const itemU=x=>x.u||x.ts||0;
function keepImages(k,win,lose){
  if(win.del) return;
  if(k==='photos'){ if(!win.url&&lose.url) win.url=lose.url; }
  else if(k==='grievances'){
    if(!win.photo&&lose.photo) win.photo=lose.photo;
    ['A','B'].forEach(p=>{ if(!win.proof[p].photo&&lose.proof[p].photo) win.proof[p].photo=lose.proof[p].photo; });
  }
}
function mergeDB(local,remote){
  const out={names:local.names,namesU:local.namesU||0,device:local.device,room:local.room,
    updatedAt:Math.max(local.updatedAt||0,remote.updatedAt||0)};
  let push=false,got=false;
  if((remote.namesU||0)>(local.namesU||0)){
    out.names=remote.names; out.namesU=remote.namesU;
    if(remote.names.A!==local.names.A||remote.names.B!==local.names.B) got=true;
  } else if((local.namesU||0)>(remote.namesU||0)) push=true;
  KINDS.forEach(k=>{
    const lm=new Map((local[k]||[]).map(x=>[x.id,x])), rm=new Map((remote[k]||[]).map(x=>[x.id,x]));
    const res=[];
    new Set([...lm.keys(),...rm.keys()]).forEach(id=>{
      const lo=lm.get(id), re=rm.get(id); let win,lose;
      if(lo&&!re){ win=lo; push=true; }
      else if(re&&!lo){ win=re; got=true; }
      else if(itemU(lo)>itemU(re)){ win=lo; lose=re; push=true; }
      else { win=re; lose=lo; if(itemU(re)>itemU(lo)) got=true; }
      win=JSON.parse(JSON.stringify(win));
      if(lose) keepImages(k,win,lose);
      res.push(win);
    });
    out[k]=res.sort((a,b)=>(b.ts||0)-(a.ts||0));
  });
  return {db:out,push:push,got:got};
}
/* Only strip heavy base64 data URLs. Hosted blob URLs are tiny and must stay so both phones can load them. */
function stripImages(s){
  s.photos.forEach(p=>{ if(p.url&&!isHostedImg(p.url)) p.url=''; });
  s.grievances.forEach(g=>{
    if(g.photo&&!isHostedImg(g.photo)) g.photo='';
    ['A','B'].forEach(p=>{ if(g.proof[p].photo&&!isHostedImg(g.proof[p].photo)) g.proof[p].photo=''; });
  });
}
/*--PURE-END--*/

let DB;
try{ DB=clean(JSON.parse(localStorage.getItem(KEY))); }catch(e){ DB=clean({}); }
let pushT=null, syncBusy=false, pushAgain=false, lastCreated=0, liteNoted=false, renderPending=false;
const live=k=>DB[k].filter(x=>!x.del);
function save(opts){
  DB.updatedAt=Date.now();
  try{ localStorage.setItem(KEY,JSON.stringify(DB)); }catch(e){ toast('Storage full. Delete some photos.'); }
  if(!(opts&&opts.nopush)){ clearTimeout(pushT); pushT=setTimeout(syncPush,1500); }
}
function uid(){ const a=crypto.getRandomValues(new Uint32Array(2)); return 'x'+(a[0].toString(36)+a[1].toString(36)).slice(0,10); }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
let toastT=null;
function toast(m){ const t=$('toast'); t.textContent=m; t.classList.add('show');
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),2200); }
function nm(p){ return DB.names[p]||('Partner '+p); }
function initials(p){
  const a=(nm('A').trim()[0]||'A').toUpperCase(), b=(nm('B').trim()[0]||'B').toUpperCase();
  if(a===b) return p; /* same first letter: fall back to A / B */
  return p==='A'?a:b;
}
function removeItem(k,id){
  const x=DB[k].find(i=>i.id===id); if(!x) return false;
  x.del=true; x.u=Date.now();
  ['title','detail','text','ref','cap','photo','url'].forEach(f=>{ if(f in x) x[f]=''; });
  if(x.proof) x.proof=emptyProof();
  return true;
}
function safeRenderAll(){
  const a=document.activeElement;
  if(a&&a.closest&&a.closest('.pform')){ renderPending=true; return; }
  renderAll();
}
document.addEventListener('focusout',()=>{
  if(!renderPending) return;
  setTimeout(()=>{ const a=document.activeElement;
    if(!(a&&a.closest&&a.closest('.pform'))){ renderPending=false; renderAll(); } },60);
});

/* ================= device + link ================= */
function setDevice(p){ DB.device=p; zWho=p; aTo=(p==='A'?'B':'A'); save({nopush:true}); renderDevice(); renderAll(); spotlight(); }
function renderDevice(){
  const b=$('devbadge');
  b.className=DB.device;
  $('devLetter').textContent=initials(DB.device);
  $('devA').className=DB.device==='A'?'on':'';
  $('devB').className=DB.device==='B'?'on':'';
  $('devA').textContent=initials('A'); $('devB').textContent=initials('B');
  $('zNameA').textContent=nm('A');
  $('zNameB').textContent=nm('B');
  const zA=document.querySelectorAll('#zWhoSeg button'), aA=document.querySelectorAll('#aToSeg button');
  if(zA[0]){ zA[0].textContent=initials('A'); zA[1].textContent=initials('B');
    zA[0].className=zWho==='A'?'on':''; zA[1].className=zWho==='B'?'on':''; }
  if(aA[0]){ aA[0].textContent='to '+initials('A'); aA[1].textContent='to '+initials('B');
    aA[0].className=aTo==='A'?'on':''; aA[1].className=aTo==='B'?'on':''; }
}
const CODEWORDS='apple river moon zombie fire storm honey tiger neon piano comet wolf ember ivy ocean drum falcon grape harbor ink jungle kite lemon mango north olive pepper quill raven stone thorn unity vapor whale xenon yarn zephyr amber blaze cinder dawn echo flint grove hazel isle jade karma lotus mist nova opal prism reef solar terra umber veldt willow'.split(' ');
function makeCode(){ const r=crypto.getRandomValues(new Uint32Array(6)); return [...r].map(n=>CODEWORDS[n%CODEWORDS.length]).join('-'); }
function createRoom(){
  DB.room=makeCode(); K=null; save({nopush:true}); renderLink(); setSync('sync'); syncPush();
  toast('Code made. Other phone: enter it.');
}
function joinRoom(){
  const c=$('joinCode').value.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  if(c.split('-').length<4){ toast('That code looks short.'); return; }
  DB.room=c; K=null; save({nopush:true}); renderLink(); setSync('sync'); syncPull(true);
}
function unlinkRoom(){ DB.room=null; K=null; save({nopush:true}); renderLink(); setSync('off'); toast('Unlinked.'); }
function copyCode(){
  if(!navigator.clipboard){ toast('Select the code and copy it.'); return; }
  navigator.clipboard.writeText(DB.room).then(()=>toast('Code copied.'),()=>toast('Copy failed. Select the code instead.'));
}
function renderLink(){
  const a=$('linkArea');
  if(!DB.room){
    a.innerHTML='<div class="toolrow"><button class="bigbtn" onclick="createRoom()">Create code</button></div>'
      +'<div class="or">or</div>'
      +'<input type="text" id="joinCode" aria-label="Code from the other phone" placeholder="code from the other phone…" autocapitalize="none" autocomplete="off" spellcheck="false" style="margin-bottom:10px">'
      +'<div class="toolrow"><button class="ghostbtn" onclick="joinRoom()">Link phones</button></div>'
      +'<div class="or">newest edit wins, item by item</div>';
  } else {
    a.innerHTML='<div style="text-align:center;color:var(--dim);font-size:13px">other phone enters:</div>'
      +'<div class="code">'+esc(DB.room)+'</div>'
      +'<div class="toolrow"><button class="ghostbtn" onclick="copyCode()">Copy code</button>'
      +'<button class="ghostbtn" onclick="syncNow()">Sync now</button></div>'
      +'<div class="toolrow"><button class="ghostbtn" style="border-color:#ff6b6b;color:#ff6b6b" onclick="unlinkRoom()">Unlink</button></div>';
  }
}
function toggleSettings(open){
  $('settings').classList.toggle('show',open);
  if(open){ $('nameA').value=DB.names.A; $('nameB').value=DB.names.B; }
}
function saveNames(){
  DB.names.A=$('nameA').value.trim()||'Partner A';
  DB.names.B=$('nameB').value.trim()||'Partner B';
  DB.namesU=Date.now();
  save(); renderDevice(); renderAll(); toggleSettings(false); toast('Saved.');
}

/* ================= sync: encrypted snapshots over nostr relays ================= */
const RELAYS=['wss://relay.primal.net','wss://relay.damus.io','wss://nos.lol'];
const MAXC=60000; /* most relays cap an event around 64 KB */
const enc=new TextEncoder();
function hexBytes(h){ const b=new Uint8Array(h.length/2); for(let i=0;i<b.length;i++) b[i]=parseInt(h.substr(i*2,2),16); return b; }
function bytesHex(b){ return [...b].map(x=>x.toString(16).padStart(2,'0')).join(''); }
function sha256hex(s){ return bytesHex(nobleSchnorr.sha256(enc.encode(s))); }
function b64e(bytes){ let s=''; for(let i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]); return btoa(s); }
function b64d(s){ const bin=atob(s); const b=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) b[i]=bin.charCodeAt(i); return b; }
let K=null;
/* 4-word codes (old) keep the old key derivation so linked phones keep working.
   5+ word codes use PBKDF2, which makes guessing the code from relay data very slow. */
async function keys(){
  if(K&&K.room===DB.room) return K;
  const room=DB.room; let priv,aes,dseed;
  if(room.split('-').length>=5){
    const base=await crypto.subtle.importKey('raw',enc.encode(room),'PBKDF2',false,['deriveBits']);
    const bits=new Uint8Array(await crypto.subtle.deriveBits(
      {name:'PBKDF2',hash:'SHA-256',salt:enc.encode('stopzfighting:v2'),iterations:210000},base,768));
    priv=bits.slice(0,32); aes=bits.slice(32,64); dseed=bytesHex(bits.slice(64,96));
  } else {
    priv=hexBytes(sha256hex('stopzfighting:v1:'+room));
    aes=nobleSchnorr.sha256(enc.encode('enc:'+room));
    dseed=sha256hex('room:'+room);
  }
  const k={room:room,priv:priv,pub:bytesHex(await nobleSchnorr.schnorr.getPublicKey(priv)),d:'szf:'+dseed.slice(0,16),
    aes:await crypto.subtle.importKey('raw',aes,'AES-GCM',false,['encrypt','decrypt'])};
  K=k; return k;
}
async function encState(plain,k){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},k.aes,enc.encode(plain)));
  const out=new Uint8Array(12+ct.length); out.set(iv); out.set(ct,12);
  return b64e(out);
}
async function decState(payload,k){
  const raw=b64d(payload);
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:raw.slice(0,12)},k.aes,raw.slice(12));
  return new TextDecoder().decode(pt);
}
async function signEvent(ev,k){
  const id=sha256hex(JSON.stringify([0,ev.pubkey,ev.created_at,ev.kind,ev.tags,ev.content]));
  const sig=bytesHex(await nobleSchnorr.schnorr.sign(hexBytes(id),k.priv));
  return Object.assign({id:id,sig:sig},ev);
}
/*--CRYPTO-END--*/
function relayOp(url,msgs,onMsg,ms){
  return new Promise(resolve=>{
    let done=false, ws, to;
    const fin=v=>{ if(!done){ done=true; clearTimeout(to); try{ws.close();}catch(e){} resolve(v); } };
    try{ ws=new WebSocket(url); }catch(e){ resolve(null); return; }
    to=setTimeout(()=>fin(null),ms);
    ws.onopen=()=>{ msgs.forEach(m=>{ try{ws.send(JSON.stringify(m));}catch(e){} }); };
    ws.onmessage=e=>{ try{ const r=onMsg(JSON.parse(e.data)); if(r) fin(r); }catch(err){} };
    ws.onerror=()=>fin(null);
    ws.onclose=()=>fin(null);
  });
}
const SYNC_LABEL={off:'Not linked',sync:'Syncing',ok:'Synced',err:'Sync failed'};
function setSync(s){ const d=$('syncDot'); if(!d) return; d.className=s; d.title=SYNC_LABEL[s]||''; d.setAttribute('aria-label',SYNC_LABEL[s]||''); }
async function syncPush(){
  if(!DB.room) return;
  if(syncBusy){ pushAgain=true; return; }
  syncBusy=true; setSync('sync'); let state='err';
  try{
    const k=await keys();
    const snap=JSON.parse(JSON.stringify(DB)); delete snap.device; delete snap.room;
    let content=await encState(JSON.stringify(snap),k), lite=false;
    if(content.length>MAXC){ stripImages(snap); snap.lite=true; lite=true; content=await encState(JSON.stringify(snap),k); }
    if(content.length>MAXC){ toast('Too much text to sync. Delete old entries.'); }
    else {
      lastCreated=Math.max(Math.floor(Date.now()/1000),lastCreated+1);
      const ev=await signEvent({kind:30078,pubkey:k.pub,created_at:lastCreated,
        tags:[['d',k.d],['t','stopzfighting']],content:content},k);
      let ok=false;
      await Promise.all(RELAYS.map(url=>
        relayOp(url,[['EVENT',ev]],m=>(m[0]==='OK'&&m[2]===true)?true:null,8000).then(r=>{ if(r) ok=true; })));
      state=ok?'ok':'err';
      if(ok&&lite&&!liteNoted){ liteNoted=true; toast('Synced. Old local-only photos may stay on one phone; new uploads share to both.'); }
    }
  }catch(e){ state='err'; }
  setSync(state); syncBusy=false;
  if(pushAgain){ pushAgain=false; syncPush(); }
}
async function syncPull(manual){
  if(!DB.room||syncBusy) return;
  syncBusy=true; setSync('sync'); let state='err', needPush=false;
  try{
    const k=await keys();
    const sub='s'+Math.random().toString(36).slice(2,8);
    const f={kinds:[30078],authors:[k.pub],'#d':[k.d],limit:5};
    let best=null, reached=0;
    await Promise.all(RELAYS.map(url=>
      relayOp(url,[['REQ',sub,f]],m=>{
        if(m[0]==='EVENT'&&m[2]&&m[2].pubkey===k.pub&&(!best||m[2].created_at>best.created_at)) best=m[2];
        if(m[0]==='EOSE') return true;
      },10000).then(r=>{ if(r) reached++; })));
    if(!reached){ if(manual) toast('Can\u2019t reach the relays. Check your connection.'); }
    else {
      state='ok';
      let remote=null;
      if(best){
        try{ remote=clean(JSON.parse(await decState(best.content,k))); }
        catch(e){ toast('Could not read that code\u2019s data. Check the code.'); state='err'; }
      }
      if(remote){
        const device=DB.device, room=DB.room;
        const m=mergeDB(DB,remote);
        DB=clean(m.db); DB.device=device; DB.room=room;
        save({nopush:true});
        if(m.got){ safeRenderAll(); renderDevice(); spotlight(); toast('Synced new changes.'); }
        else if(manual) toast('Up to date.');
        needPush=m.push;
      } else if(!best){
        needPush=KINDS.some(k2=>DB[k2].length);
        if(manual&&!needPush) toast('Nothing on the relays yet.');
      }
    }
  }catch(e){ state='err'; }
  setSync(state); syncBusy=false;
  if(needPush) syncPush();
}
function syncNow(){ syncPull(true); }

/* ================= nav ================= */
const TABS={book:'tab-book',rules:'tab-rules',burn:'tab-burn',zombies:'tab-zombies',love:'tab-love',photos:'tab-photos'};
function go(t){
  document.querySelectorAll('.phase').forEach(p=>p.classList.remove('show'));
  $('phase-'+t).classList.add('show');
  Object.keys(TABS).forEach(k=>{
    const b=$(TABS[k]), on=k===t; b.classList.toggle('on',on);
    if(on) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current');
  });
  window.scrollTo(0,0);
}
function renderAll(){ renderBook(); renderRules(); renderBurn(); renderZombies(); renderLove(); renderPhotos(); }

/* ================= photos: compress → upload to Vercel Blob → store URL ================= */
let tmpGPhoto='';
function fileToBlob(file,cb){
  if(!file||!/^image\//.test(file.type)){ toast('That is not a photo.'); return; }
  const img=new Image(), url=URL.createObjectURL(file);
  img.onload=()=>{
    const max=900; let w=img.naturalWidth,h=img.naturalHeight;
    if(Math.max(w,h)>max){ const s=max/Math.max(w,h); w=Math.round(w*s); h=Math.round(h*s); }
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    c.getContext('2d').drawImage(img,0,0,w,h);
    URL.revokeObjectURL(url);
    c.toBlob(async blob=>{
      if(!blob){ toast('Could not process that photo.'); return; }
      try{
        toast('Uploading…');
        const r=await fetch('/api/upload',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:blob});
        const j=await r.json().catch(()=>({}));
        if(!r.ok||!j.url){
          toast(j.error||'Upload failed. Is Blob connected?');
          return;
        }
        cb(j.url);
      }catch(e){ toast('Upload failed. Check connection.'); }
    },'image/jpeg',0.72);
  };
  img.onerror=()=>{ URL.revokeObjectURL(url); toast('Could not read that photo.'); };
  img.src=url;
}
/* legacy name used by older handlers */
function fileToPhoto(file,cb){ fileToBlob(file,cb); }
$('gPhoto').addEventListener('change',function(){
  const f=this.files[0]; tmpGPhoto=''; if(!f) return;
  fileToBlob(f,d=>{ tmpGPhoto=d; toast('Photo attached.'); });
});
function addGrievance(){
  const t=$('gTitle').value.trim();
  if(!t){ toast('Name it first.'); return; }
  const now=Date.now(), g={id:uid(),title:t,detail:$('gDetail').value.trim(),by:DB.device,
    proof:emptyProof(),photo:tmpGPhoto,status:'open',ts:now,u:now};
  g.proof[DB.device].text=$('gProof').value.trim();
  DB.grievances.unshift(g);
  $('gTitle').value=''; $('gDetail').value=''; $('gProof').value=''; $('gPhoto').value=''; tmpGPhoto='';
  save(); renderBook(); toast('Filed.');
}
function proofSlot(g,p){
  const pr=g.proof[p], me=DB.device===p;
  let h='<div class="proof"><div class="ph"><span class="'+(p==='A'?'whoA':'whoB')+'">'+esc(nm(p).toUpperCase())+'</span><span>PROOF</span></div>';
  if(pr.text) h+='<div class="ptext">'+esc(pr.text)+'</div>';
  if(pr.photo) h+='<img src="'+esc(pr.photo)+'" alt="Proof photo">';
  if(!pr.text&&!pr.photo) h+='<div class="ptext" style="color:var(--dim);font-style:italic">nothing yet</div>';
  if(me){
    h+='<div class="toolrow"><button class="ghostbtn" onclick="togglePForm(\''+g.id+'\',\''+p+'\')">'+(pr.text||pr.photo?'Edit proof':'＋ Proof')+'</button></div>'
      +'<div class="pform" id="pf-'+g.id+'-'+p+'" style="display:none">'
      +'<textarea id="pft-'+g.id+'-'+p+'" maxlength="4000" aria-label="Your proof" placeholder="texts, times, witnesses…">'+esc(pr.text)+'</textarea>'
      +'<input type="file" accept="image/*" aria-label="Proof photo" onchange="proofPhoto(\''+g.id+'\',\''+p+'\',this)">'
      +'<div class="toolrow"><button class="ghostbtn" onclick="saveProof(\''+g.id+'\',\''+p+'\')">Save</button></div></div>';
  }
  return h+'</div>';
}
const tmpProofPhoto={};
function proofPhoto(gid,p,input){
  const f=input.files[0]; if(!f) return;
  fileToPhoto(f,d=>{ tmpProofPhoto[gid+'_'+p]=d; toast('Photo attached. Tap Save.'); });
}
function togglePForm(gid,p){
  const el=$('pf-'+gid+'-'+p);
  el.style.display=el.style.display==='none'?'block':'none';
}
function saveProof(gid,p){
  const g=DB.grievances.find(x=>x.id===gid); if(!g) return;
  g.proof[p].text=$('pft-'+gid+'-'+p).value.trim();
  const k=gid+'_'+p; if(tmpProofPhoto[k]){ g.proof[p].photo=tmpProofPhoto[k]; delete tmpProofPhoto[k]; }
  g.u=Date.now(); renderPending=false;
  save(); renderBook(); toast('Proof in.');
}
function renderBook(){
  const box=$('gList'); box.innerHTML='';
  const open=live('grievances').filter(g=>g.status==='open');
  if(!open.length){ box.innerHTML='<div class="empty">Nothing filed. Peace… for now.</div>'; return; }
  open.forEach((g,i)=>{
    const d=document.createElement('div'); d.className='gcard'; d.style.animationDelay=(i*0.05)+'s';
    let h='<div class="gtop"><b>'+esc(g.title)+'</b><span class="filed '+g.by+'">'+esc(initials(g.by))+'</span></div>';
    if(g.detail) h+='<div class="gdetail">'+esc(g.detail)+'</div>';
    if(g.photo) h+='<img src="'+esc(g.photo)+'" alt="Attached photo" class="gimg">';
    h+=proofSlot(g,'A')+proofSlot(g,'B');
    h+='<div class="toolrow"><button class="ghostbtn" onclick="makeRule(\''+g.id+'\')">📏 Rule</button>'
      +'<button class="ghostbtn" style="border-color:var(--ember);color:var(--ember2)" onclick="readyBurn(\''+g.id+'\')">🔥 Burn</button>'
      +'<button class="ghostbtn" aria-label="Delete entry" onclick="delGrievance(\''+g.id+'\')">🗑</button></div>';
    d.innerHTML=h; box.appendChild(d);
  });
}
function delGrievance(gid){
  if(!confirm('Delete this entry for both phones?')) return;
  if(removeItem('grievances',gid)){ save(); renderBook(); renderBurn(); toast('Deleted.'); }
}
function makeRule(gid){
  const g=DB.grievances.find(x=>x.id===gid); if(!g) return;
  const now=Date.now();
  DB.rules.unshift({id:uid(),text:g.title.slice(0,120),ts:now,u:now,breaks:0});
  g.status='ruled'; g.u=now;
  save(); renderBook(); renderRules(); toast('Hard rule set.'); go('rules');
}
function readyBurn(gid){
  const g=DB.grievances.find(x=>x.id===gid); if(!g) return;
  g.status='ready'; g.u=Date.now(); save(); renderBook(); renderBurn(); toast('Ready to burn.'); go('burn');
}

/* ================= rules ================= */
function addRule(){
  const t=$('rText').value.trim();
  if(!t){ toast('Write the rule.'); return; }
  const now=Date.now();
  DB.rules.unshift({id:uid(),text:t,ts:now,u:now,breaks:0});
  $('rText').value='';
  save(); renderRules(); toast('Set in stone.');
}
function renderRules(){
  const box=$('rList'); box.innerHTML='';
  const rules=live('rules');
  if(!rules.length){ box.innerHTML='<div class="empty">No hard rules yet.</div>'; return; }
  rules.forEach((r,i)=>{
    const d=document.createElement('div'); d.className='rule'; d.style.animationDelay=(i*0.05)+'s';
    d.innerHTML='<div class="rt">'+esc(r.text)+'<span class="br">'+(r.breaks?('broken ×'+r.breaks):'unbroken')+'</span></div>'
      +'<button class="zombtn" onclick="brokeRule(\''+r.id+'\')">🧟 broke it</button>'
      +'<button class="xbtn" aria-label="Delete rule" onclick="delRule(\''+r.id+'\')">✕</button>';
    box.appendChild(d);
  });
}
function brokeRule(rid){
  const r=DB.rules.find(x=>x.id===rid); if(!r) return;
  r.breaks++; r.u=Date.now();
  addZombie(DB.device,'rule',r.text,true);
  save(); renderRules(); renderZombies(); toast('Zombie logged.');
}
function delRule(rid){
  if(!confirm('Delete this rule for both phones?')) return;
  if(removeItem('rules',rid)){ save(); renderRules(); toast('Deleted.'); }
}

/* ================= burn ================= */
let burnId=null, holdTimer=null;
function renderBurn(){
  const ready=$('burnReady'), yard=$('burnYard');
  ready.innerHTML=''; yard.innerHTML='';
  const rd=live('grievances').filter(g=>g.status==='ready');
  const buried=live('grievances').filter(g=>g.status==='burned');
  ready.innerHTML=rd.length?'':'<div class="empty">Nothing waiting.</div>';
  rd.forEach(g=>{
    const d=document.createElement('div'); d.className='gcard';
    d.innerHTML='<div class="gtop"><b>'+esc(g.title)+'</b></div>'
      +'<div class="toolrow"><button class="bigbtn" onclick="startBurn(\''+g.id+'\')">🔥 Burn it</button></div>';
    ready.appendChild(d);
  });
  yard.innerHTML=buried.length?'':'<div class="empty">No ashes yet.</div>';
  buried.forEach(g=>{
    const d=document.createElement('div'); d.className='bury';
    d.innerHTML='<div class="bt">🪦 <s>'+esc(g.title)+'</s></div>'
      +'<button class="zombtn" onclick="dugUp(\''+g.id+'\')">dug up</button>';
    yard.appendChild(d);
  });
}
function startBurn(gid){
  const g=DB.grievances.find(x=>x.id===gid); if(!g) return;
  burnId=gid;
  $('burnTitle').textContent=g.title;
  $('burnOverlay').classList.add('show');
  $('holdBtn').focus();
}
function closeBurn(){ burnId=null; stopHold(); $('burnOverlay').classList.remove('show'); }
function stopHold(){ clearInterval(holdTimer); holdTimer=null; $('holdFill').style.width='0%'; }
(function(){
  const btn=$('holdBtn');
  const start=()=>{
    if(!burnId||holdTimer) return;
    let p=0;
    holdTimer=setInterval(()=>{
      p+=8; $('holdFill').style.width=Math.min(100,p)+'%';
      if(p>=100) finishBurn();
    },100);
  };
  btn.addEventListener('pointerdown',e=>{ e.preventDefault(); start(); });
  ['pointerup','pointerleave','pointercancel','blur'].forEach(ev=>btn.addEventListener(ev,stopHold));
  btn.addEventListener('keydown',e=>{ if((e.key===' '||e.key==='Enter')&&!e.repeat){ e.preventDefault(); start(); } });
  btn.addEventListener('keyup',e=>{ if(e.key===' '||e.key==='Enter') stopHold(); });
  btn.addEventListener('contextmenu',e=>e.preventDefault());
})();
function finishBurn(){
  const id=burnId; stopHold();
  const g=DB.grievances.find(x=>x.id===id);
  if(g){ g.status='burned'; g.u=Date.now(); save(); }
  closeBurn(); renderBook(); renderBurn(); toast('Ashes. Let it stay dead.');
}
function dugUp(gid){
  const g=DB.grievances.find(x=>x.id===gid); if(!g) return;
  addZombie(DB.device,'buried',g.title,true);
  save(); renderZombies(); toast('🧟 Zombie.');
}

/* ================= zombies ================= */
let zWho='A';
function zWhoSet(p,btn){
  zWho=p;
  document.querySelectorAll('#zWhoSeg button').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
}
function addZombie(who,kind,ref,silent){
  const now=Date.now();
  DB.zombies.unshift({id:uid(),who:who,kind:kind,ref:str(ref,120),ts:now,u:now});
  if(!silent){ save(); renderZombies(); }
}
function addZombieForm(){
  const ref=$('zRef').value.trim();
  if(!ref){ toast('Say what happened.'); return; }
  addZombie(zWho,$('zKind').value,ref,true);
  $('zRef').value='';
  save(); renderZombies(); toast('🧟 Logged.');
}
function delZombie(zid){
  if(!confirm('Remove this zombie for both phones?')) return;
  if(removeItem('zombies',zid)){ save(); renderZombies(); toast('Removed.'); }
}
function renderZombies(){
  const zs=live('zombies');
  $('zCountA').textContent=zs.filter(z=>z.who==='A').length;
  $('zCountB').textContent=zs.filter(z=>z.who==='B').length;
  const box=$('zList'); box.innerHTML='';
  if(!zs.length){ box.innerHTML='<div class="empty">No zombies. Keep it that way.</div>'; return; }
  zs.forEach((z,i)=>{
    const d=document.createElement('div'); d.className='zcard'; d.style.animationDelay=(i*0.05)+'s';
    const what=z.kind==='rule'?'broke a hard rule':'dug up the dead';
    const dt=new Date(z.ts);
    d.innerHTML='<div class="zt"><span class="zz">🧟 '+esc(nm(z.who))+'</span> '+what+':<br>“'+esc(z.ref)+'”</div>'
      +'<div class="zm">'+esc(dt.toLocaleDateString())+' · '+esc(dt.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}))
      +' <button class="xbtn" aria-label="Remove zombie" onclick="delZombie(\''+z.id+'\')">remove</button></div>';
    box.appendChild(d);
  });
}

/* ================= love ================= */
let aTo='B';
function aToSet(p,btn){
  aTo=p;
  document.querySelectorAll('#aToSeg button').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
}
function addAffirm(){
  const t=$('aText').value.trim();
  if(!t){ toast('Say something.'); return; }
  const now=Date.now();
  DB.affirms.unshift({id:uid(),to:aTo,text:t.slice(0,1000),by:DB.device,ts:now,u:now});
  $('aText').value='';
  save(); renderLove(); spotlight(); toast('Sent.');
}
function renderLove(){
  const box=$('aList'); box.innerHTML='';
  const as=live('affirms');
  if(!as.length){ box.innerHTML='<div class="empty">No love letters yet.</div>'; return; }
  as.forEach((a,i)=>{
    const d=document.createElement('div'); d.className='acard'; d.style.animationDelay=(i*0.05)+'s';
    d.innerHTML='<div class="at">“'+esc(a.text)+'”</div>'
      +'<div class="am">for '+esc(nm(a.to))+' · from '+esc(nm(a.by))+'</div>';
    box.appendChild(d);
  });
}
function spotlight(){
  const all=live('affirms'), mine=all.filter(a=>a.to===DB.device);
  const pool=mine.length?mine:all;
  if(!pool.length){ $('spotText').textContent='No affirmations yet. Write one.'; $('spotMeta').textContent=''; return; }
  const a=pool[Math.floor(Math.random()*pool.length)];
  $('spotText').textContent='“'+a.text+'”';
  $('spotMeta').textContent='for '+nm(a.to)+' · from '+nm(a.by);
}

/* ================= photos ================= */
let viewing=null;
async function addPhoto(){
  const inp=$('phFile');
  const files=[...(inp.files||[])];
  if(!files.length){ toast('Pick a photo.'); return; }
  const cap=$('phCap').value.trim();
  let done=0;
  toast(files.length>1?('Uploading '+files.length+' photos…'):'Uploading…');
  for(const f of files){
    await new Promise(resolve=>{
      let settled=false;
      const finish=()=>{ if(!settled){ settled=true; resolve(); } };
      fileToBlob(f,url=>{
        const now=Date.now();
        DB.photos.unshift({id:uid(),url:url,cap:cap,by:DB.device,ts:now,u:now});
        done++; finish();
      });
      setTimeout(finish,25000);
    });
  }
  inp.value=''; $('phCap').value='';
  if(done){ save(); renderPhotos(); toast(done===1?'In the book.':(done+' photos in the book.')); }
  else toast('Could not upload photos. Connect Vercel Blob or check connection.');
}
function renderPhotos(){
  const g=$('phGrid'); g.innerHTML='';
  const ps=live('photos');
  if(!ps.length){ g.innerHTML='<div class="empty" style="grid-column:1/-1">No photos yet.</div>'; return; }
  ps.forEach(p=>{
    const d=document.createElement('button'); d.type='button'; d.className='ph';
    d.setAttribute('aria-label',p.cap?('Open photo: '+p.cap):'Open photo');
    if(p.url){
      const img=document.createElement('img'); img.src=p.url; img.alt=p.cap||''; img.loading='lazy';
      d.appendChild(img);
    } else { d.classList.add('far'); d.textContent='On the other phone'; }
    d.onclick=()=>openViewer(p.id);
    g.appendChild(d);
  });
}
function openViewer(pid){
  const p=DB.photos.find(x=>x.id===pid); if(!p) return;
  if(!p.url){ toast('That photo lives on the phone that added it.'); return; }
  viewing=pid;
  $('viewImg').src=p.url;
  $('viewCap').textContent=(p.cap?p.cap+' · ':'')+nm(p.by);
  $('viewer').classList.add('show');
  $('viewClose').focus();
}
function closeViewer(){ viewing=null; $('viewer').classList.remove('show'); }
function delPhoto(){
  if(!viewing) return;
  if(removeItem('photos',viewing)){ save(); renderPhotos(); closeViewer(); toast('Deleted.'); }
}

/* ================= init ================= */
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    if($('burnOverlay').classList.contains('show')) closeBurn();
    else if($('viewer').classList.contains('show')) closeViewer();
    else if($('settings').classList.contains('show')) toggleSettings(false);
  }
});
$('rText').addEventListener('keydown',e=>{ if(e.key==='Enter') addRule(); });
$('zRef').addEventListener('keydown',e=>{ if(e.key==='Enter') addZombieForm(); });
$('gTitle').addEventListener('keydown',e=>{ if(e.key==='Enter') $('gDetail').focus(); });

zWho=DB.device; aTo=DB.device==='A'?'B':'A';
renderDevice(); renderLink(); renderAll(); spotlight();
setSync(DB.room?'sync':'off');
if(DB.room) setTimeout(()=>syncPull(),1200);
setInterval(()=>{ if(DB.room&&!document.hidden) syncPull(); },25000);
document.addEventListener('visibilitychange',()=>{ if(!document.hidden&&DB.room) syncPull(); });
window.addEventListener('online',()=>{ if(DB.room) syncPull(); });
(function(){
  const sp=$('splash');
  const hide=()=>sp.classList.add('gone');
  sp.addEventListener('click',hide);
  setTimeout(hide,1700);
})();
