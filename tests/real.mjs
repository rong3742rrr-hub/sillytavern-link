import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base='http://127.0.0.1:18190';
const root=path.resolve('tests/runtime/SillyTavern-test');
const settingsFile=path.join(root,'data/default-user/settings.json');
if(fs.existsSync(settingsFile)) {
    const s=JSON.parse(fs.readFileSync(settingsFile,'utf8'));s.firstRun=false;
    fs.writeFileSync(settingsFile,JSON.stringify(s));
}
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const contexts=[]; const errors=[];
async function page(mobile=false){
    const c=await browser.newContext(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{});contexts.push(c);
    const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));
    await p.route('**/*',route=>{const u=new URL(route.request().url());return u.hostname==='127.0.0.1'||u.protocol==='data:'?route.continue():route.abort();});
    return p;
}
try{
    // Simulate the first GitHub download before Install.cmd has patched startup.
    const setupPreview=await page();
    await setupPreview.route(base+'/',async route=>{
        const response=await route.fetch();
        const html=(await response.text())
            .replace('<!-- sillytavern link: i18n is loaded after browser data -->','<script type="module" src="scripts/i18n.js"></script>')
            .replace('<script type="module" src="scripts/extensions/third-party/sillytavern-link/boot.js"></script>','<script type="module" src="script.js"></script>');
        await route.fulfill({response,body:html});
    });
    await setupPreview.goto(base);
    await setupPreview.locator('.stlink-settings [data-link-status]').filter({hasText:'配套安装'}).waitFor({state:'attached',timeout:120000});
    assert.equal(await setupPreview.locator('.stlink-settings button:not(:disabled)').count(),0);
    assert.match(await setupPreview.locator('.stlink-settings [data-link-detail]').textContent(),/Install\.cmd/);
    await setupPreview.context().close();contexts.splice(contexts.indexOf(setupPreview.context()),1);
    console.log('PASS GitHub first-download setup instructions and disabled sync buttons before bootstrap installation');
    const pc=await page();await pc.goto(base+'/csrf-token');
    await pc.evaluate(()=>localStorage.setItem('stlink-real-example','desktop configuration'));
    await pc.goto(base);
    const init=pc.getByRole('button',{name:'这是电脑，建立同步基准'});
    await Promise.race([init.waitFor({timeout:45000}),pc.waitForFunction(()=>Boolean(window.SillyTavernLink?.timer),{},{timeout:45000})]);
    if(await init.isVisible()) await init.click();
    await pc.waitForFunction(()=>Boolean(window.SillyTavern?.getContext && window.SillyTavernLink?.timer),{},{timeout:120000});
    await pc.waitForFunction(()=>SillyTavernLink.settingsBase!==null);
    assert.equal(await pc.locator('.stlink-settings b').textContent(),'SillyTavern Link');
    console.log('PASS real SillyTavern 1.19.0 startup, extension manifest, APP_READY, UI panel');
    await pc.evaluate(async()=>{const c=SillyTavern.getContext();c.extensionSettings.stlink_validation={value:'from desktop'};await import('/script.js').then(m=>m.saveSettings());});
    await pc.waitForFunction(()=>!SillyTavernLink.inFlight);
    const phone=await page(true);await phone.goto(base);
    await phone.waitForFunction(()=>Boolean(window.SillyTavern?.getContext && window.SillyTavernLink?.timer),{},{timeout:120000});
    assert.equal(await phone.evaluate(()=>localStorage.getItem('stlink-real-example')),'desktop configuration');
    assert.equal(await phone.evaluate(()=>SillyTavern.getContext().extensionSettings.stlink_validation.value),'from desktop');
    console.log('PASS real ST computer → mobile settings and browser storage');
    await phone.evaluate(async()=>{const c=SillyTavern.getContext();c.extensionSettings.stlink_validation.value='from mobile';localStorage.setItem('stlink-real-example','mobile configuration');await import('/script.js').then(m=>m.saveSettings());await SillyTavernLink.tick(true);});
    await pc.getByRole('button',{name:'在此设备接着玩',exact:true}).first().click();
    await pc.waitForFunction(()=>Boolean(window.SillyTavernLink?.timer),{},{timeout:120000});
    assert.equal(await pc.evaluate(()=>SillyTavern.getContext().extensionSettings.stlink_validation.value),'from mobile');
    assert.equal(await pc.evaluate(()=>localStorage.getItem('stlink-real-example')),'mobile configuration');
    console.log('PASS real ST mobile → computer round trip');
    await phone.screenshot({path:path.resolve('tests/real-mobile-standby.png'),fullPage:false});
    const relevant=errors.filter(e=>/stlink|sillytavern.link|engine.mjs|storage.mjs/i.test(e));
    assert.deepEqual(relevant,[]);
    console.log('Real ST non-link page errors:',errors.length);
    if(errors.length) console.log(errors.slice(0,5));
    console.log('REAL SILLYTAVERN CHECKS PASSED');
}catch(e){
    console.error(e);
    for(let i=0;i<contexts.length;i++){const p=contexts[i].pages()[0];if(p){await p.screenshot({path:path.resolve(`tests/real-failure-${i}.png`)});console.error('Page',i,await p.locator('body').innerText().then(t=>t.slice(-2200)));}}
    console.error('Page errors:',errors);process.exitCode=1;
}finally{await browser.close();}
