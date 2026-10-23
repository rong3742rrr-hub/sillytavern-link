import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { register, storeFor } from '../server/index.mjs';
import { id } from '../shared/model.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stlink-mobile-'));
const user = { profile: { handle: 'mobile-test' }, directories: { root } };
fs.writeFileSync(path.join(root, 'settings.json'), '{}');
const store = storeFor({ user });
store.initialize('original-computer', { 'ls|sync-test': 'latest-progress' }, false);
let backupMode = 'hold', backupRequests = 0, abortedBackups = 0;
const app = express(); app.use(express.json({ limit: '256mb' }));
app.get('/csrf-token', (req, res) => res.json({ token: 'test-token' }));
app.use('/api', (req, res, next) => {
    if (!req.headers.cookie?.includes('fixture=1')) return res.sendStatus(401);
    if (req.method === 'POST' && req.get('X-CSRF-Token') !== 'test-token') return res.sendStatus(403);
    req.user = user; next();
});
app.post('/api/plugins/sillytavern-link/backup', (req, res, next) => {
    backupRequests++;
    if (backupMode === 'hold') { res.on('close', () => { if (!res.writableEnded) abortedBackups++; }); return; }
    if (backupMode === 'fail') return res.status(503).json({ error: '测试：备份失败，可重试或跳过' });
    next();
});
const api = express.Router(); register(api); app.use('/api/plugins/sillytavern-link', api);
app.use('/extension', express.static(path.resolve('extension')));
if (!process.env.STLINK_HOST) throw new Error('Set STLINK_HOST to a SillyTavern 1.19.0 folder for the real stylesheet layout checks.');
const hostStyle = path.resolve(process.env.STLINK_HOST, 'public/style.css');
app.get('/host.css', (req, res) => fs.existsSync(hostStyle) ? res.sendFile(hostStyle) : res.type('css').send(''));
app.get('/seed', (req, res) => res.send('<html><body>seed</body></html>'));
app.get('/', (req, res) => res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/host.css"><link rel="stylesheet" href="/extension/style.css"></head><body><div id="loaded"></div><script type="module">
import {LinkEngine} from '/extension/engine.mjs'; window.SillyTavernLink = new LinkEngine(); window.applyCount=0; window.stages=[];
const e=SillyTavernLink, apply=e.mirror.apply.bind(e.mirror), screen=e.screen.bind(e);
e.screen=(...args)=>{stages.push(args[0]);return screen(...args);};
e.mirror.apply=async(...args)=>{applyCount++;await new Promise(r=>setTimeout(r,100));return apply(...args);};
try {await e.initialize();document.getElementById('loaded').textContent='ready';}catch(error){e.fail(error);console.error(error);}
</script></body></html>`));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const errors = [];
async function mobile() {
    const context = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
    await context.addCookies([{ name: 'fixture', value: '1', url: base }]);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    return { context, page };
}
async function ready(page, timeout = 30000) { await page.locator('#loaded').filter({ hasText: 'ready' }).waitFor({ timeout }); }
function remoteChange(value) {
    const { device, client } = store.state.active;
    store.patch(device, store.state.epoch, [{ key: 'ls|sync-test', before: store.state.entries['ls|sync-test'].value, value }], client);
    // This fixture deliberately does not run the normal play-time heartbeat/handoff loop.
    store.lastSeen = 0;
}
async function geometry(page) {
    const sizes = await page.evaluate(() => {
        const card = document.querySelector('.stlink-card'), r = card.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, client: card.clientWidth, scroll: card.scrollWidth };
    });
    assert.ok(sizes.left >= 0 && sizes.right <= sizes.width + 1, JSON.stringify(sizes));
    assert.ok(sizes.top >= 0 && sizes.bottom <= sizes.height + 1, JSON.stringify(sizes));
    assert.ok(sizes.scroll <= sizes.client + 1, JSON.stringify(sizes));
    for (const button of await page.locator('.stlink-card button').all()) {
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox();
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= sizes.width + 1 && box.y + box.height <= sizes.height + 1);
    }
    await page.locator('.stlink-card').evaluate(card => { card.scrollTop = 0; });
}
try {
    const phone = await mobile(), p = phone.page;
    await p.goto(base + '/seed'); await p.evaluate(() => localStorage.setItem('sync-test', 'old-phone'));
    await p.goto(base);
    await p.getByRole('heading', { name: '正在备份本设备原数据' }).waitFor();
    await p.waitForFunction(() => document.querySelector('.stlink-progress-detail')?.textContent.includes('正在等待电脑确认'));
    for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }]) {
        await p.setViewportSize(size); await geometry(p);
        await p.screenshot({ path: `tests/backup-${size.width}x${size.height}.png` });
    }
    console.log('PASS mobile backup dialog fits 320px, 390px and short landscape viewports with actual ST stylesheet');
    await p.getByRole('button', { name: '跳过本次备份', exact: true }).click(); await ready(p);
    assert.equal(await p.evaluate(() => localStorage.getItem('sync-test')), 'latest-progress');
    assert.equal(await p.evaluate(() => SillyTavernLink.backupEnabled), true);
    assert.equal(await p.evaluate(() => applyCount), 1);
    assert.ok(abortedBackups >= 1);
    assert.ok((await p.evaluate(() => stages)).includes('正在载入最新数据'));
    console.log('PASS an unresponsive backup can be cancelled; sync continues once with latest data');

    remoteChange('second-progress'); await p.reload();
    await p.getByRole('heading', { name: '正在备份本设备原数据' }).waitFor();
    await p.getByRole('button', { name: '以后不备份', exact: true }).click(); await ready(p);
    assert.equal(await p.evaluate(() => SillyTavernLink.backupEnabled), false);
    const before = backupRequests;
    remoteChange('third-progress'); await p.reload(); await ready(p);
    assert.equal(backupRequests, before); assert.equal(await p.evaluate(() => localStorage.getItem('sync-test')), 'third-progress');
    assert.ok(!(await p.evaluate(() => stages)).includes('正在备份本设备原数据'));
    console.log('PASS permanent no-backup preference survives reload without disabling synchronization');

    await p.evaluate(() => SillyTavernLink.setBackupEnabled(true)); backupMode = 'fail';
    remoteChange('fourth-progress'); await p.reload();
    await p.getByText('测试：备份失败，可重试或跳过', { exact: true }).waitFor();
    backupMode = 'pass'; await p.getByRole('button', { name: '重试备份', exact: true }).click(); await ready(p);
    const backups = fs.readdirSync(path.join(store.directory, 'backups')).filter(n => n.includes('device-before-sync'));
    assert.equal(backups.length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(store.directory, 'backups', backups[0]), 'utf8'));
    assert.equal(saved.data.snapshot['ls|sync-test'], 'third-progress');
    console.log('PASS failed backup can be retried; streamed JSON backup preserves original local data');

    backupMode = 'hold'; remoteChange('fifth-progress'); await p.reload();
    await p.getByRole('heading', { name: '正在备份本设备原数据' }).waitFor();
    await p.getByText(/备份上传超过 45 秒/).waitFor({ timeout: 55000 });
    await p.getByRole('button', { name: '跳过本次备份', exact: true }).click(); await ready(p);
    console.log('PASS stalled backup times out after 45 seconds and leaves usable skip/retry controls');

    const cacheChecks = await p.evaluate(async () => {
        const { cacheGet, cacheSet, cleanupLocalBackups } = await import('/extension/storage.mjs');
        const user = SillyTavernLink.user;
        const baseline = await cacheGet(`baseline:${user}`);
        await cacheSet(`before-sync:${user}`, { only: 'legacy backup' });
        await cleanupLocalBackups(user, Date.now() + 86401000);
        return { version: baseline.version, hasFullCopy: Object.hasOwn(baseline, 'base'), oldBackup: await cacheGet(`before-sync:${user}`), baselineSurvives: Boolean(await cacheGet(`baseline:${user}`)) };
    });
    assert.equal(cacheChecks.version, 2); assert.equal(cacheChecks.hasFullCopy, false);
    assert.equal(cacheChecks.oldBackup, undefined); assert.equal(cacheChecks.baselineSurvives, true);
    console.log('PASS compact baseline and 24-hour migration cleanup of old browser backups');
    await phone.context.close();

    const recordKey = value => JSON.stringify({ root: ['value', value], nodes: [] });
    const schema = { name: 'Large_prompts', version: 1, stores: [{ name: 'records', keyPath: null, autoIncrement: false, indexes: [] }] };
    const additions = [{ key: id('schema', schema.name), before: null, value: JSON.stringify(schema) }];
    for (let i = 0; i < 7; i++) additions.push({ key: id('db', schema.name, 'records', recordKey(i)), before: null, value: recordKey(String(i) + 'x'.repeat((i < 6 ? 24 : 6) * 1048576)) });
    for (let i = 7; i < 2007; i++) additions.push({ key: id('db', schema.name, 'records', recordKey(i)), before: null, value: recordKey('small-' + i + 'y'.repeat(800)) });
    const { device, client } = store.state.active;
    store.patch(device, store.state.epoch, additions, client); store.lastSeen = 0;
    const bytes = fs.statSync(store.file).size;
    assert.ok(bytes >= 150 * 1048576);
    console.log(`Large fixture: ${(bytes / 1048576).toFixed(1)} MiB; largest record 24 MiB; 2,007 database records`);
    const large = await mobile();
    await large.page.goto(base + '/seed');
    await large.page.evaluate(() => localStorage.setItem('__stlink:backup-disabled:mobile-test', '1'));
    const cdp = await large.context.newCDPSession(large.page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const start = Date.now(), count = backupRequests;
    await large.page.goto(base); await ready(large.page, 180000);
    assert.equal(backupRequests, count);
    const check = await large.page.evaluate(async () => {
        const { cacheGet } = await import('/extension/storage.mjs');
        const baseline = await cacheGet('baseline:mobile-test');
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open('Large_prompts'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        const request = q => new Promise((resolve, reject) => { q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
        const count = await request(db.transaction('records').objectStore('records').count());
        for (let i = 0; i < 7; i++) {
            const value = await request(db.transaction('records').objectStore('records').get(i));
            if (value !== String(i) + 'x'.repeat((i < 6 ? 24 : 6) * 1048576)) throw new Error('Large record content mismatch');
        }
        db.close();
        return { count, baselineBytes: JSON.stringify(baseline).length, fullBackup: Boolean(await cacheGet('before-sync:mobile-test')), applyCount };
    });
    assert.equal(check.count, 2007); assert.ok(check.baselineBytes < 1024 * 1024); assert.equal(check.fullBackup, false); assert.equal(check.applyCount, 1);
    console.log(`PASS ${(bytes / 1048576).toFixed(1)} MiB import, all large records verified, ${Math.round(check.baselineBytes / 1024)} KiB baseline, ${Math.round((Date.now() - start) / 1000)} seconds on local test with 4x CPU throttling`);
    await large.page.evaluate(() => {
        SillyTavernLink.setBackupEnabled(true);
        window.largeBackupStopped = false;
        void SillyTavernLink.backupBeforeSync(SillyTavernLink.base, null).then(() => { window.largeBackupStopped = true; });
    });
    await large.page.getByRole('heading', { name: '正在备份本设备原数据' }).waitFor();
    const skipStarted = Date.now();
    await large.page.getByRole('button', { name: '跳过本次备份', exact: true }).click();
    await large.page.waitForFunction(() => window.largeBackupStopped, {}, { timeout: 10000 });
    assert.ok(Date.now() - skipStarted < 10000);
    console.log('PASS 151.9 MiB backup preparation/upload can also be cancelled from the mobile UI');
    assert.deepEqual(errors, []);
    console.log('ALL MOBILE FIX CHECKS PASSED');
} catch (error) {
    for (const context of browser.contexts()) for (const page of context.pages()) {
        console.error('Mobile failure:', (await page.locator('body').innerText()).slice(-2000));
        await page.screenshot({ path: 'tests/mobile-fix-failure.png' });
    }
    throw error;
} finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'stlink-mobile-')));
    fs.rmSync(root, { recursive: true, force: true });
}
