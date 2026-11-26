/* English Coach — funcionamiento sin conexión.
   La app se guarda en caché; la IA (Gemini) siempre usa la red. */
const CACHE="english-coach-v3";
const SHELL=["./","index.html","platform.js","manifest.webmanifest","icon.svg","icon-192.png","icon-512.png","maskable-512.png","apple-touch-icon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener("fetch",e=>{
  const req=e.request; if(req.method!=="GET") return;
  const url=new URL(req.url);
  if(url.hostname==="generativelanguage.googleapis.com") return;
  const isFont=/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if(url.origin!==location.origin&&!isFont) return;
  if(isFont){
    e.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(r=>{const cp=r.clone();caches.open(CACHE).then(c=>c.put(req,cp));return r;})));
    return;
  }
  // Red primero (para recibir actualizaciones), caché si no hay conexión.
  e.respondWith(fetch(req).then(r=>{ if(r.ok){const cp=r.clone();caches.open(CACHE).then(c=>c.put(req,cp));} return r; })
    .catch(()=>caches.match(req).then(hit=>hit||caches.match("index.html"))));
});
