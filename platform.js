/* English Coach — capa de plataforma independiente.
   Reemplaza las funciones que antes ponía Claude:
   - IA: Google Gemini (clave gratuita del usuario, guardada solo en este equipo)
   - Voz (listening): Web Speech API (speechSynthesis)
   - Dictado (speaking): Web Speech API (SpeechRecognition)
   - Descargas: archivo generado en el navegador
   Las interfaces imitan las que usaba la app original (sample, tts, dictation, downloads). */
(function(){
"use strict";
const KEY_LS="ec-gemini-key", MODEL_LS="ec-gemini-model";
const API="https://generativelanguage.googleapis.com/v1beta";

/* ---------------- IA: Gemini ---------------- */
function getKey(){try{return (localStorage.getItem(KEY_LS)||"").trim();}catch(e){return "";}}
function setKey(k){try{k?localStorage.setItem(KEY_LS,k.trim()):localStorage.removeItem(KEY_LS);localStorage.removeItem(MODEL_LS);}catch(e){}}

async function listModels(key){
  const r=await fetch(API+"/models?pageSize=1000",{headers:{"x-goog-api-key":key}});
  if(!r.ok) throw await apiError(r);
  const d=await r.json();
  return (d.models||[]).filter(m=>(m.supportedGenerationMethods||[]).includes("generateContent")).map(m=>m.name);
}
function chooseModel(names){
  const bad=/(lite|image|tts|audio|live|embedding|vision|thinking|learnlm|gemma|nano)/i;
  if(names.includes("models/gemini-flash-latest")) return "models/gemini-flash-latest";
  const ver=n=>{const m=n.match(/gemini-(\d+(?:\.\d+)?)/);return m?parseFloat(m[1]):0;};
  const stable=names.filter(n=>/^models\/gemini-\d+(\.\d+)?-flash$/.test(n)).sort((a,b)=>ver(b)-ver(a));
  if(stable.length) return stable[0];
  const flash=names.filter(n=>/flash/.test(n)&&!bad.test(n)).sort((a,b)=>ver(b)-ver(a));
  if(flash.length) return flash[0];
  const any=names.filter(n=>/gemini/.test(n)&&!bad.test(n)).sort((a,b)=>ver(b)-ver(a));
  if(any.length) return any[0];
  throw {code:"no_model",message:"Tu clave de Gemini no tiene modelos disponibles."};
}
async function getModel(key,force){
  let m=null; try{m=localStorage.getItem(MODEL_LS);}catch(e){}
  if(m&&!force) return m;
  m=chooseModel(await listModels(key));
  try{localStorage.setItem(MODEL_LS,m);}catch(e){}
  return m;
}
async function apiError(r){
  let body={}; try{body=await r.json();}catch(e){}
  const msg=(body.error&&body.error.message)||"";
  if(r.status===429) return {code:"rate_limited",status:429,message:"Llegaste al límite gratuito de Gemini por ahora. Espera un minuto (si es el límite diario, hasta mañana) y vuelve a intentar."};
  if(r.status===400&&/API key|API_KEY/i.test(msg)||r.status===401||r.status===403) return {code:"bad_key",status:r.status,message:"La clave de Gemini no es válida o no tiene permiso. Revísala en Ajustes."};
  if(r.status===404) return {code:"no_model",status:404,message:"El modelo de Gemini ya no está disponible."};
  return {code:"error",status:r.status,message:"Gemini respondió con un error ("+r.status+"). "+msg.slice(0,160)};
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
/* Velocidad: desactiva el "razonamiento" previo del modelo (lo que más demora)
   y recibe la respuesta en vivo (streaming) para mostrar el avance. */
function thinkingOptions(model){
  const v=(model.match(/gemini-(\d+)/)||[])[1];
  if(v&&+v<=2) return [{thinkingBudget:0},null];
  return [{thinkingLevel:"minimal"},{thinkingLevel:"low"},{thinkingBudget:0},null];
}
function thinkIdx(model){try{return +(localStorage.getItem("ec-think:"+model)||0);}catch(e){return 0;}}
function setThinkIdx(model,i){try{localStorage.setItem("ec-think:"+model,String(i));}catch(e){}}

let progressHook=null;
function reportProgress(chars){ try{ progressHook&&progressHook(chars); }catch(e){} }

async function readStream(r){
  const reader=r.body.getReader(), dec=new TextDecoder();
  let buf="", text="", block=null;
  for(;;){
    const {done,value}=await reader.read(); if(done) break;
    buf+=dec.decode(value,{stream:true});
    let i;
    while((i=buf.indexOf("\n"))>=0){
      const line=buf.slice(0,i).trim(); buf=buf.slice(i+1);
      if(!line.startsWith("data:")) continue;
      let d; try{d=JSON.parse(line.slice(5));}catch(e){continue;}
      if(d.promptFeedback&&d.promptFeedback.blockReason) block=d.promptFeedback.blockReason;
      const c=(d.candidates||[])[0];
      const parts=(c&&c.content&&c.content.parts)||[];
      parts.forEach(p=>{ if(!p.thought&&typeof p.text==="string") text+=p.text; });
      reportProgress(text.length);
    }
  }
  if(!text) throw {code:block?"blocked":"empty",message:block?"Gemini no respondió ("+block+"). Intenta de nuevo.":"Gemini devolvió una respuesta vacía. Intenta de nuevo."};
  return text;
}

async function generate(contents,json){
  const key=getKey(); if(!key) throw {code:"no_sample",message:"Configura tu clave gratuita de Gemini en Ajustes para usar la IA."};
  if(!navigator.onLine) throw {code:"offline",message:"Sin conexión a internet: la IA necesita conexión."};
  let model=await getModel(key), lastErr=null;
  for(let attempt=0;attempt<6;attempt++){
    const opts=thinkingOptions(model), ti=Math.min(thinkIdx(model),opts.length-1);
    const body={contents,generationConfig:{temperature:0.7,maxOutputTokens:8192}};
    if(json) body.generationConfig.responseMimeType="application/json";
    if(opts[ti]) body.generationConfig.thinkingConfig=opts[ti];
    let r;
    try{ r=await fetch(API+"/"+model+":streamGenerateContent?alt=sse",{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":key},body:JSON.stringify(body)}); }
    catch(e){ lastErr={code:"network",message:"No se pudo conectar con Gemini. Revisa tu conexión."}; await sleep(1200); continue; }
    if(r.ok) return await readStream(r);
    lastErr=await apiError(r);
    if(r.status===400&&/think|budget|level/i.test(lastErr.message)&&ti<opts.length-1){ setThinkIdx(model,ti+1); continue; }
    if(lastErr.code==="no_model"&&attempt===0){ model=await getModel(key,true); continue; }
    if(r.status>=500){ await sleep(1500*(attempt+1)); continue; }
    throw lastErr;
  }
  throw lastErr||{code:"error",message:"No se pudo obtener respuesta de la IA."};
}
function toContents(input){
  if(typeof input==="string") return [{role:"user",parts:[{text:input}]}];
  return (input||[]).map(m=>({role:m.role==="assistant"?"model":"user",parts:[{text:String(m.content||"")}]}));
}
function parseLoose(t){
  t=String(t||"").trim().replace(/^```(?:json)?\s*/i,"").replace(/```\s*$/,"");
  try{return JSON.parse(t);}catch(e){}
  const a=t.indexOf("{"),b=t.lastIndexOf("}");
  if(a<0||b<0) throw {code:"bad_json",message:"La IA no devolvió un formato válido. Intenta de nuevo."};
  return JSON.parse(t.slice(a,b+1));
}
function makeSample(){
  if(!getKey()) return null;
  const sample=async(input,opts)=>{
    const text=await generate(toContents(input),false);
    if(opts&&opts.onText) try{opts.onText({text});}catch(e){}
    return {text};
  };
  sample.json=async(prompt)=>{
    const text=await generate(toContents(prompt+"\n\nRespond ONLY with valid JSON."),true);
    try{return parseLoose(text);}
    catch(e){ const again=await generate(toContents(prompt+"\n\nRespond ONLY with valid JSON."),true); return parseLoose(again); }
  };
  return sample;
}
async function testKey(key){
  const names=await listModels(key.trim());
  return chooseModel(names).replace("models/","");
}

/* ---------------- Voz: speechSynthesis ---------------- */
let voices=[];
function loadVoices(){ try{voices=speechSynthesis.getVoices()||[];}catch(e){voices=[];} return voices; }
if("speechSynthesis" in window){ loadVoices(); speechSynthesis.onvoiceschanged=loadVoices; }
function englishVoices(){
  const list=loadVoices().filter(v=>/^en[-_]/i.test(v.lang));
  const score=v=>(/en[-_]US/i.test(v.lang)?100:0)+(/(premium|enhanced|natural|neural)/i.test(v.name)?40:0)+(/(Samantha|Ava|Allison|Evan|Zoe|Nathan|Joelle|Google US English|Aaron|Nicky)/i.test(v.name)?20:0)+(v.localService?5:0)-(/(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Kathy|Ralph|Grandma|Grandpa|Rocko|Shelley|Sandy|Flo|Eddy|Reed)/i.test(v.name)?200:0);
  return list.sort((a,b)=>score(b)-score(a));
}
function pickVoice(name){
  const en=englishVoices();
  return (name&&en.find(v=>v.name===name))||en[0]||null;
}
function chunks(text){
  const parts=String(text||"").replace(/\s+/g," ").match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g)||[];
  const out=[]; let cur="";
  parts.forEach(p=>{ if((cur+p).length>220&&cur){out.push(cur.trim());cur=p;} else cur+=p; });
  if(cur.trim()) out.push(cur.trim());
  return out;
}
function makeTTS(){
  if(!("speechSynthesis" in window)||typeof SpeechSynthesisUtterance==="undefined") return null;
  let token=0, finishCurrent=null;
  return {
    speak(text,opts){
      opts=opts||{};
      this.stop();
      const my=++token;
      const list=chunks(text); const voice=pickVoice(opts.voice);
      const rate=Math.max(0.5,Math.min(1.6,+opts.rate||1));
      return new Promise((resolve)=>{
        finishCurrent=resolve;
        let i=0;
        const next=()=>{
          if(my!==token) return resolve();
          if(i>=list.length){ finishCurrent=null; return resolve(); }
          const u=new SpeechSynthesisUtterance(list[i++]);
          if(voice){u.voice=voice;u.lang=voice.lang;} else u.lang="en-US";
          u.rate=rate;
          u.onend=next; u.onerror=next;
          speechSynthesis.speak(u);
        };
        next();
      });
    },
    stop(){ token++; try{speechSynthesis.cancel();}catch(e){} if(finishCurrent){const f=finishCurrent;finishCurrent=null;f();} }
  };
}
function voiceOptions(selected){
  const en=englishVoices();
  if(!en.length) return '<option value="">Voz del sistema</option>';
  const cur=pickVoice(selected);
  return en.map(v=>'<option value="'+v.name.replace(/"/g,"&quot;")+'" '+(cur&&v.name===cur.name?"selected":"")+'>'+v.name.replace(/</g,"&lt;")+' ('+v.lang+')</option>').join("");
}

/* ---------------- Dictado: SpeechRecognition ---------------- */
function makeDict(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR) return null;
  const H={partial:[],final:[],state:[]};
  const emit=(k,v)=>H[k].forEach(f=>{try{f(v);}catch(e){}});
  let rec=null, wanted=false, starts=0, endWaiters=[];
  function create(){
    const r=new SR();
    r.lang="en-US"; r.continuous=true; r.interimResults=true; r.maxAlternatives=1;
    r.onresult=e=>{
      let interim="";
      for(let i=e.resultIndex;i<e.results.length;i++){
        const res=e.results[i], t=res[0]&&res[0].transcript||"";
        if(res.isFinal){ const f=t.trim(); if(f) emit("final",{text:f}); }
        else interim+=t;
      }
      emit("partial",{text:interim.trim()});
    };
    r.onend=()=>{
      if(wanted&&starts<20){ starts++; try{r.start();return;}catch(e){} }
      wanted=false; rec=null; emit("state",{state:"idle"});
      const w=endWaiters; endWaiters=[]; w.forEach(f=>f());
    };
    return r;
  }
  return {
    onPartial(f){H.partial.push(f);}, onFinal(f){H.final.push(f);}, onState(f){H.state.push(f);},
    start(){
      return new Promise((resolve,reject)=>{
        if(rec){ try{rec.abort();}catch(e){} rec=null; }
        const r=create(); rec=r; wanted=true; starts=0;
        let started=false;
        r.onstart=()=>{ if(!started){started=true;emit("state",{state:"listening"});resolve();} };
        r.onerror=e=>{
          const err=e&&e.error;
          if(err==="no-speech"||err==="aborted") return;
          wanted=false;
          const out=(err==="not-allowed"||err==="service-not-allowed")?{code:"not_granted"}
            :err==="audio-capture"?{code:"no_mic",message:"No se encontró un micrófono."}
            :err==="network"?{code:"network",message:"El dictado necesita conexión a internet."}
            :{code:err||"error",message:"Error de reconocimiento de voz: "+(err||"desconocido")};
          if(!started){ started=true; reject(out); }
        };
        try{ r.start(); }catch(e){ wanted=false; reject({code:"error",message:String(e&&e.message||e)}); }
      });
    },
    stop(){
      wanted=false;
      if(!rec) return Promise.resolve();
      return new Promise(res=>{ endWaiters.push(res); try{rec.stop();}catch(e){res();} setTimeout(res,2000); });
    }
  };
}

/* ---------------- Descargas ---------------- */
function makeDls(){
  return {save({filename,data,mimeType}){
    const blob=data instanceof Blob?data:new Blob([data],{type:mimeType||"application/json"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=filename||"archivo";
    document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1500);
    return Promise.resolve();
  }};
}

/* ---------------- Ajustes: tarjeta de la clave de Gemini ---------------- */
function keyCard(){
  const k=getKey(); let model=""; try{model=(localStorage.getItem(MODEL_LS)||"").replace("models/","");}catch(e){}
  return '<div class="card" style="grid-column:1/-1"><h3>Inteligencia artificial (Google Gemini)</h3>'+
    (k?'<p class="small" style="margin-top:8px"><span class="pill ok">Conectada</span> La IA está activa'+(model?' (modelo '+model+')':'')+'. Tu clave se guarda solo en este computador.</p>'
      :'<p class="small" style="margin-top:8px"><span class="pill warn">Falta la clave</span> Las lecciones, las correcciones y el Speaking Lab necesitan una clave gratuita de Gemini.</p>'+
       '<ol class="small" style="margin:8px 0 0;padding-left:18px;display:grid;gap:4px"><li>Abre <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> e inicia sesión con tu cuenta de Google.</li><li>Pulsa «Create API key» y copia la clave.</li><li>Pégala aquí abajo y pulsa «Guardar y probar».</li></ol>')+
    '<div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap"><input type="password" id="gk" autocomplete="off" spellcheck="false" placeholder="'+(k?"••••••••  (pega una nueva para cambiarla)":"Pega aquí tu clave de Gemini")+'" style="flex:1;min-width:220px">'+
    '<button class="btn pri" id="gks">Guardar y probar</button>'+(k?'<button class="btn" id="gkd" style="color:var(--bad)">Quitar clave</button>':'')+'</div>'+
    '<p class="tiny muted" style="margin-top:8px">El plan gratuito de Gemini tiene límites por minuto y por día; si los alcanzas, espera y vuelve a intentar. En el plan gratuito Google puede usar lo que envías para mejorar sus productos.</p></div>';
}
function wireKeyCard(root,onChange){
  const s=root.querySelector("#gks"), d=root.querySelector("#gkd"), inp=root.querySelector("#gk");
  if(s) s.onclick=async()=>{
    const v=(inp.value||"").trim(); if(!v){inp.focus();return;}
    s.disabled=true; s.textContent="Probando…";
    try{ const m=await testKey(v); setKey(v); try{localStorage.setItem(MODEL_LS,"models/"+m);}catch(e){} toastLite("Clave guardada. IA activa con "+m+"."); onChange&&onChange(); }
    catch(e){ toastLite((e&&e.message)||"No se pudo comprobar la clave.",6000); s.disabled=false; s.textContent="Guardar y probar"; }
  };
  if(d) d.onclick=()=>{ setKey(""); toastLite("Clave eliminada de este computador."); onChange&&onChange(); };
}
function toastLite(t,ms){const el=document.createElement("div");el.className="toast";el.textContent=t;document.body.appendChild(el);setTimeout(()=>el.remove(),ms||3500);}

function afterBoot(){
  try{ navigator.storage&&navigator.storage.persist&&navigator.storage.persist(); }catch(e){}
  if(!getKey()) setTimeout(()=>toastLite("Para lecciones y correcciones con IA, agrega tu clave gratuita de Gemini en «Ajustes y respaldo».",7000),1200);
}

/* ---------------- App instalable (service worker) ---------------- */
if("serviceWorker" in navigator && /^https?:$/.test(location.protocol)){
  addEventListener("load",()=>{ navigator.serviceWorker.register("sw.js").catch(()=>{}); });
}

/* ---------------- Botón «Instalar app» ---------------- */
let installEvt=null;
function installButton(){
  let b=document.getElementById("ec-install");
  if(!installEvt||matchMedia("(display-mode: standalone)").matches){ if(b) b.remove(); return; }
  if(b) return;
  b=document.createElement("button");
  b.id="ec-install"; b.className="btn pri"; b.textContent="⬇ Instalar app";
  b.style.cssText="position:fixed;right:18px;bottom:max(18px, calc(env(safe-area-inset-bottom) + 18px));z-index:50;box-shadow:0 6px 20px rgba(20,26,46,.25)";
  b.onclick=async()=>{ const e=installEvt; if(!e) return; installEvt=null; b.remove();
    try{ await e.prompt(); const c=await e.userChoice; if(c&&c.outcome==="accepted") toastLite("English Coach se instaló en tu computador."); }catch(err){} };
  document.body.appendChild(b);
}
addEventListener("beforeinstallprompt",e=>{ e.preventDefault(); installEvt=e; installButton(); });
addEventListener("appinstalled",()=>{ installEvt=null; installButton(); });

window.EC={onProgress:f=>{progressHook=f;},makeSample,makeTTS,makeDict,makeDls,voiceOptions,keyCard,wireKeyCard,afterBoot,hasKey:()=>!!getKey()};
})();
