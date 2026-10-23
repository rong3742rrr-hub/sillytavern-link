import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { register, storeFor } from '../server/index.mjs';
import { protectRouter } from '../server/store.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(),'stlink-browser-'));
const userRoot = path.join(root,'test-user'); fs.mkdirSync(userRoot);
fs.writeFileSync(path.join(userRoot,'settings.json'),JSON.stringify({ temperature:1, extension_settings:{memory:{mode:'desktop'}} }));
const app=express(); app.use(express.json({limit:'256mb'}));
app.get('/csrf-token',(req,res)=>res.json({token:'test-csrf'}));
app.use('/api',(req,res,next)=>{
    if (!req.headers.cookie?.includes('stlink-test=1')) return res.sendStatus(401);
    if(req.method==='POST' && req.get('X-CSRF-Token')!=='test-csrf') return res.sendStatus(403);
    req.user={profile:{handle:'test-user'},directories:{root:userRoot}}; next();
});
const settings=express.Router();
settings.post('/get',(req,res)=>res.json({settings:fs.readFileSync(path.join(userRoot,'settings.json'),'utf8')}));
settings.post('/save',(req,res)=>res.json({result:'unguarded'}));
protectRouter(settings,'settings',storeFor); app.use('/api/settings',settings);
const chats=express.Router();
chats.post('/save',(req,res)=>{fs.writeFileSync(path.join(userRoot,'chat-test.json'),JSON.stringify(req.body));res.json({result:'ok'});});
protectRouter(chats,'chats',storeFor); app.use('/api/chats',chats);
const api=express.Router();register(api);app.use('/api/plugins/sillytavern-link',api);
app.use('/extension',express.static(path.resolve('extension')));
app.get('/seed',(req,res)=>res.type('html').send('<html><body>seed</body></html>'));
app.get('/',(req,res)=>res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/extension/style.css"></head><body><textarea id="send_textarea"></textarea><div id="loaded"></div>
<script type="module">import {LinkEngine} from '/extension/engine.mjs'; window.SillyTavernLink=new LinkEngine(); try {await SillyTavernLink.initialize(); await fetch('/api/settings/get',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'test-csrf'},body:'{}'}); document.getElementById('loaded').textContent='ready'; SillyTavernLink.start(null);}catch(e){SillyTavernLink.fail(e);console.error(e);}</script></body></html>`));
const server=await new Promise(resolve=>{const s=app.listen(0,'0.0.0.0',()=>resolve(s));});
const port=server.address().port;
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const events=[];
async function context(host,mobile=false){
    const c=await browser.newContext(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{});
    await c.addCookies([{name:'stlink-test',value:'1',url:`http://${host}:${port}`}]);
    const p=await c.newPage();p.on('pageerror',e=>events.push(e.message));
    return {c,p,url:`http://${host}:${port}`};
}
async function loaded(page){await page.locator('#loaded').filter({hasText:'ready'}).waitFor({timeout:45000});}
async function settle(page){await page.waitForFunction(()=>!SillyTavernLink.running);await page.evaluate(()=>SillyTavernLink.tick(true));}
async function put(page,key,value){await page.evaluate(async({key,value})=>{
    const db=await new Promise((res,rej)=>{const r=indexedDB.open('Engram_demo');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
    await new Promise((res,rej)=>{const tx=db.transaction('events','readwrite');tx.objectStore('events').put({id:key,text:value});tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});db.close();
},{key,value});}
async function read(page,key){return page.evaluate(async key=>{
    const db=await new Promise(res=>{const r=indexedDB.open('Engram_demo');r.onsuccess=()=>res(r.result);});
    const value=await new Promise(res=>{const r=db.transaction('events').objectStore('events').get(key);r.onsuccess=()=>res(r.result);});db.close();return value;
},key);}
try {
    const pc=await context('127.0.0.1'),phone=await context('localhost',true);
    await pc.p.goto(pc.url+'/seed');
    await pc.p.evaluate(async()=>{
        localStorage.setItem('script.preferences',JSON.stringify({mode:'computer',depth:3}));
        localStorage.setItem('script.delete-me','gone-later');
        const db=await new Promise((res,rej)=>{const r=indexedDB.open('Engram_demo',30);r.onupgradeneeded=()=>{const s=r.result.createObjectStore('events',{keyPath:'id'});s.createIndex('byText','text');r.result.createObjectStore('blobs');};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
        await new Promise((res,rej)=>{const tx=db.transaction(['events','blobs'],'readwrite');tx.objectStore('events').put({id:'memory',text:'computer memory'});tx.objectStore('blobs').put(new Blob(['image bytes'],{type:'image/png'}),'picture');tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});db.close();
    });
    await pc.p.goto(pc.url);
    await pc.p.getByRole('button',{name:'这是电脑，建立同步基准'}).click();await loaded(pc.p);await settle(pc.p);
    console.log('PASS desktop initial baseline including real IndexedDB');
    // Round-trip types that JSON cannot preserve.
    await pc.p.evaluate(async()=>{
        const {encode,decode}=await import('/extension/storage.mjs');
        const a={date:new Date(12345),set:new Set([1,'a']),map:new Map([['k',2]]),bytes:new Uint16Array([2,500]),big:123n,undef:undefined,nan:NaN};a.self=a;
        const b=decode(await encode(a));
        if(b.self!==b||b.date.getTime()!==12345||b.bytes[1]!==500||b.big!==123n||!b.set.has('a')||b.map.get('k')!==2||!Number.isNaN(b.nan))throw new Error('codec round trip');
    });
    console.log('PASS structured-clone binary/date/map/set/cycle types');
    await pc.p.evaluate(()=>localStorage.setItem('script.preferences','latest-before-switch'));
    await phone.p.goto(phone.url);await loaded(phone.p);
    assert.equal(await phone.p.evaluate(()=>localStorage.getItem('script.preferences')),'latest-before-switch');
    assert.equal((await read(phone.p,'memory')).text,'computer memory');
    await pc.p.getByRole('heading',{name:'已在另一设备继续游玩'}).waitFor();
    assert.equal(await pc.p.evaluate(()=>SillyTavernLink.active),false);
    console.log('PASS cross-origin PC → phone handoff flush and standby');
    // A stale desktop cannot overwrite the phone's settings or chat.
    const stale=await pc.p.evaluate(async()=>{
        const r=await fetch('/api/settings/save',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'test-csrf'},body:JSON.stringify({temperature:99})});return r.status;
    });assert.equal(stale,409);
    const raw=await browser.newContext();const rawPage=await raw.newPage();
    const unauthorized=await rawPage.request.get(`${pc.url}/api/plugins/sillytavern-link/state`);assert.equal(unauthorized.status(),401);await raw.close();
    console.log('PASS old-page write guard and authentication');
    await put(phone.p,'memory','phone updated memory');
    await put(phone.p,'new','phone-only new record');
    await phone.p.evaluate(()=>{localStorage.setItem('script.preferences','phone choice');localStorage.removeItem('script.delete-me');});
    const saved=await phone.p.evaluate(async()=>{const e=SillyTavernLink;const r=await fetch('/api/settings/save',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'test-csrf'},body:JSON.stringify({...e.settingsBase,temperature:0.35})});return r.status;});assert.equal(saved,200);
    await settle(phone.p);
    assert.equal(JSON.parse(fs.readFileSync(path.join(userRoot,'settings.json'))).temperature,0.35);
    const beforeNavigation=phone.p.url();
    await phone.p.locator('#send_textarea').fill('unfinished draft');
    await phone.p.waitForTimeout(2200);
    assert.equal(await phone.p.locator('#send_textarea').inputValue(),'unfinished draft');assert.equal(phone.p.url(),beforeNavigation);
    console.log('PASS phone writes and no reload during typing');
    await phone.p.locator('#send_textarea').fill('');await phone.p.locator('#loaded').click();
    await pc.p.getByRole('button',{name:'在此设备接着玩'}).click();await loaded(pc.p);
    assert.equal(await pc.p.evaluate(()=>localStorage.getItem('script.preferences')),'phone choice');
    assert.equal(await pc.p.evaluate(()=>localStorage.getItem('script.delete-me')),null);
    assert.equal((await read(pc.p,'memory')).text,'phone updated memory');
    assert.equal((await read(pc.p,'new')).text,'phone-only new record');
    assert.equal(await pc.p.evaluate(()=>SillyTavernLink.settingsBase.temperature),0.35);
    console.log('PASS phone → PC round trip: settings, localStorage, memory records, deletes');
    // Blob survives the two handoffs.
    assert.equal(await pc.p.evaluate(async()=>{
        const db=await new Promise(res=>{const r=indexedDB.open('Engram_demo');r.onsuccess=()=>res(r.result);});
        const blob=await new Promise(res=>{const r=db.transaction('blobs').objectStore('blobs').get('picture');r.onsuccess=()=>res(r.result);});db.close();return blob.text();
    }),'image bytes');
    console.log('PASS blob preserved across both devices');
    const external=await pc.p.evaluate(async()=>{
        const e=SillyTavernLink;const r=await e.fetch('/api/chats/save',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'test-csrf'},body:JSON.stringify({chat:'old tab'})});return r.status;
    });assert.equal(external,409);
    await settle(pc.p);
    const valid=await pc.p.evaluate(async()=>{const r=await fetch('/api/chats/save',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'test-csrf'},body:JSON.stringify({chat:'phone-to-pc'})});return r.status;});assert.equal(valid,200);
    console.log('PASS guarded chat save on active device');
    // Simulate lost connectivity: writes stay locally, and upload after recovery.
    await pc.c.setOffline(true);await pc.p.evaluate(()=>localStorage.setItem('script.offline','survives'));
    await pc.p.waitForTimeout(1700);await pc.c.setOffline(false);await settle(pc.p);
    const restored=await pc.p.evaluate(()=>SillyTavernLink.api('/state'));
    assert.equal(restored.entries['ls|script.offline'],'survives');
    console.log('PASS offline edit uploads after reconnect');
    await pc.c.setOffline(true);
    await pc.p.evaluate(async()=>{await fetch('/api/settings/save',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'test-csrf'},body:JSON.stringify({...SillyTavernLink.settingsBase,temperature:0.22})});});
    await pc.c.setOffline(false);await settle(pc.p);
    assert.equal(JSON.parse(fs.readFileSync(path.join(userRoot,'settings.json'))).temperature,0.22);
    console.log('PASS offline settings retry without losing edits');
    await settle(pc.p);
    await pc.p.evaluate(() => { clearInterval(SillyTavernLink.timer); localStorage.setItem('script.reload-offline', 'saved after timer stopped'); });
    await pc.p.reload(); await loaded(pc.p);
    assert.equal((await pc.p.evaluate(() => SillyTavernLink.api('/state'))).entries['ls|script.reload-offline'], 'saved after timer stopped');
    console.log('PASS compact baseline restores unsent offline edits across a page reload');
    await settle(pc.p);
    await pc.p.evaluate(async () => {
        clearInterval(SillyTavernLink.timer);
        const { cacheSet } = await import('/extension/storage.mjs');
        await cacheSet(`baseline:${SillyTavernLink.user}`, { epoch: SillyTavernLink.state.epoch, base: SillyTavernLink.base, lastUpload: null });
        localStorage.setItem('script.legacy-reload', 'legacy offline edit');
    });
    await pc.p.reload(); await loaded(pc.p);
    assert.equal((await pc.p.evaluate(() => SillyTavernLink.api('/state'))).entries['ls|script.legacy-reload'], 'legacy offline edit');
    assert.equal(await pc.p.evaluate(async () => (await import('/extension/storage.mjs').then(m => m.cacheGet(`baseline:${SillyTavernLink.user}`))).version), 2);
    console.log('PASS version 1 full baseline migrates without losing offline edits');
    await pc.p.evaluate(async()=>{
        const {cacheSet}=await import('/extension/storage.mjs');
        await cacheSet(`receiving:${SillyTavernLink.user}`,true);
        localStorage.setItem('script.preferences','partial-stale-copy');
    });
    await pc.p.reload();await loaded(pc.p);
    assert.equal(await pc.p.evaluate(()=>localStorage.getItem('script.preferences')),'phone choice');
    console.log('PASS interrupted hydration cannot overwrite the latest server data');
    await pc.c.close();
    const savedStore=storeFor({user:{profile:{handle:'test-user'},directories:{root:userRoot}}}); savedStore.lastSeen=0;
    await phone.p.getByRole('button',{name:'在此设备接着玩'}).click();await loaded(phone.p);
    assert.equal(await phone.p.evaluate(()=>SillyTavernLink.settingsBase.temperature),0.22);
    console.log('PASS closed computer browser still permits phone use from saved data');
    await phone.p.screenshot({path:path.resolve('tests/mobile-standby.png'),fullPage:true});
    assert.deepEqual(events,[]);
    console.log('ALL BROWSER CHECKS PASSED');
} finally {await browser.close();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
