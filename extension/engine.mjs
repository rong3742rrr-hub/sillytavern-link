import { StorageMirror, cacheGet, cacheSet, deviceId, snapshotHashes, cleanupLocalBackups } from './storage.mjs';
import { storageChanges, isMutation, parts, PREFIX } from './model.mjs';

const API = '/api/plugins/sillytavern-link';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export class LinkEngine {
    constructor() {
        this.fetch = window.fetch.bind(window);
        this.mirror = new StorageMirror();
        this.client = crypto.randomUUID();
        this.base = {}; this.settingsBase = null;
        this.active = false; this.running = false; this.generating = false;
        this.inFlight = 0; this.serialSave = Promise.resolve();
        this.message = '正在连接同步服务…'; this.lastUpload = null; this.problem = '';
        this.fullScanAt = 0; this.pendingSettings = null; this.warning = '';
        this.overlay = null;
    }
    status(message, problem = '') {
        this.message = message; this.problem = problem;
        window.dispatchEvent(new CustomEvent('stlink:status', { detail: this.diagnostics() }));
    }
    diagnostics() {
        const keys = Object.keys(this.base);
        return { version: '1.0.2', message: this.message, problem: this.problem, active: this.active, backupEnabled: this.backupEnabled,
            primary: this.device === this.state?.primary, lastUpload: this.lastUpload,
            storageKeys: keys.filter(k => parts(k)[0] === 'ls').length,
            databases: keys.filter(k => parts(k)[0] === 'schema').map(k => parts(k)[1]),
            records: keys.filter(k => parts(k)[0] === 'db').length };
    }
    screen(title, message, actions = []) {
        this.overlay?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'stlink-overlay';
        const panel = document.createElement('section'); panel.className = 'stlink-card';
        panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
        const heading = document.createElement('h2'); heading.textContent = title;
        heading.id = 'stlink-dialog-title'; panel.setAttribute('aria-labelledby', heading.id);
        const text = document.createElement('p'); text.textContent = message;
        const buttons = document.createElement('div'); buttons.className = 'stlink-buttons';
        for (const [label, action] of actions) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
            button.addEventListener('click', () => Promise.resolve().then(action).catch(e => this.fail(e)));
            buttons.append(button);
        }
        panel.append(heading, text, buttons); overlay.append(panel); document.body.append(overlay);
        this.overlay = overlay;
        return { text, buttons, panel };
    }
    progress(title, message) {
        const screen = this.screen(title, message);
        const detail = document.createElement('p'); detail.className = 'stlink-progress-detail';
        detail.setAttribute('role', 'status');
        const bar = document.createElement('progress'); bar.className = 'stlink-progress'; bar.setAttribute('aria-label', title);
        screen.panel.insertBefore(detail, screen.buttons); screen.panel.insertBefore(bar, screen.buttons);
        return (text, current, total) => {
            detail.textContent = text;
            if (total > 0) { bar.max = total; bar.value = current; }
            else bar.removeAttribute('value');
        };
    }
    get backupEnabled() { return localStorage.getItem(`${PREFIX}backup-disabled:${this.user}`) !== '1'; }
    setBackupEnabled(enabled) {
        localStorage.setItem(`${PREFIX}backup-disabled:${this.user}`, enabled ? '0' : '1');
        this.status(this.message, this.problem);
    }
    async sendBackup(snapshot, pendingSettings, signal, progress) {
        // Build a Blob in small pieces. Avoid one huge JSON string and an additional IndexedDB copy on mobile.
        const chunks = [JSON.stringify({ device: this.device, pendingSettings }).slice(0, -1), ',"snapshot":{'];
        const entries = Object.entries(snapshot);
        for (let i = 0; i < entries.length; i++) {
            signal.throwIfAborted();
            const [key, value] = entries[i];
            chunks.push(new Blob([i ? ',' : '', JSON.stringify(key), ':', JSON.stringify(value)]));
            if (i % 16 === 0 || String(value).length > 262144) {
                progress(`正在准备备份 · ${i + 1} / ${entries.length} 项`);
                await wait(0);
            }
        }
        chunks.push('}}');
        const body = new Blob(chunks, { type: 'application/json' });
        signal.throwIfAborted();
        await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const cancel = () => { xhr.abort(); reject(signal.reason || new DOMException('备份已跳过', 'AbortError')); };
            xhr.open('POST', `${API}/backup`); xhr.timeout = 45000;
            xhr.setRequestHeader('Content-Type', 'application/json'); xhr.setRequestHeader('X-CSRF-Token', this.token);
            xhr.upload.onprogress = event => {
                const loaded = (event.loaded / 1048576).toFixed(1), total = (body.size / 1048576).toFixed(1);
                progress(event.loaded >= body.size ? `已上传 ${total} MB，正在等待电脑确认` : `正在上传备份 · ${loaded} / ${total} MB`);
            };
            xhr.onload = () => {
                let result; try { result = JSON.parse(xhr.responseText); } catch { /* Report below. */ }
                if (xhr.status >= 200 && xhr.status < 300 && result?.name) resolve();
                else reject(new Error(result?.error || `备份服务返回 ${xhr.status}`));
            };
            xhr.onerror = () => reject(new Error('备份上传失败，请检查网络，或跳过本次备份继续同步。'));
            xhr.ontimeout = () => reject(new Error('备份上传超过 45 秒，已停止等待。可以重试，也可以跳过备份继续同步。'));
            xhr.onabort = () => reject(new DOMException('备份已跳过', 'AbortError'));
            xhr.onloadend = () => signal.removeEventListener('abort', cancel);
            signal.addEventListener('abort', cancel, { once: true });
            xhr.send(body);
        });
    }
    async backupBeforeSync(snapshot, pendingSettings) {
        if (!this.backupEnabled) return;
        await new Promise(resolve => {
            let finished = false, controller, retry, timer;
            const finish = () => {
                if (finished) return;
                finished = true; clearInterval(timer); controller?.abort(); resolve();
            };
            const attempt = async () => {
                controller = new AbortController(); retry.disabled = true;
                const started = Date.now(); let phase = '正在准备备份';
                const render = () => { detail.textContent = `${phase}\n已等待 ${Math.floor((Date.now() - started) / 1000)} 秒 · 可以随时跳过备份`;
                };
                clearInterval(timer); timer = setInterval(render, 1000); render();
                try {
                    await wait(50);
                    await this.sendBackup(snapshot, pendingSettings, controller.signal, text => { if (!finished) { phase = text; render(); } });
                    finish();
                } catch (error) {
                    if (finished) return;
                    clearInterval(timer); detail.textContent = error.message; retry.disabled = false;
                }
            };
            const screen = this.screen('正在备份本设备原数据', '这是接续前的额外备份，保存到你的电脑，24 小时后自动删除。跳过备份仍会同步并载入最新进度，但本设备将被替换的旧数据不会另存一份。', [
                ['跳过本次备份', finish],
                ['以后不备份', () => { this.setBackupEnabled(false); finish(); }],
                ['重试备份', attempt],
            ]);
            const detail = document.createElement('p'); detail.className = 'stlink-progress-detail'; detail.setAttribute('role', 'status');
            screen.panel.insertBefore(detail, screen.buttons);
            retry = screen.buttons.lastElementChild;
            void attempt();
        });
    }
    hide() { this.overlay?.remove(); this.overlay = null; }
    fail(error) {
        this.status('同步暂未完成', error.message);
        this.screen('sillytavern link · 同步暂停', error.message, [['重试连接', () => location.reload()]]);
    }
    async api(route, data) {
        const response = await this.fetch(`${API}${route}`, {
            method: data ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.token },
            ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(120000),
        });
        if (response.status === 404) {
            const error = new Error('同步服务尚未启动，请重启酒馆后刷新此页。');
            error.code = 'SERVER_MISSING'; throw error;
        }
        let result;
        try { result = await response.json(); } catch { throw new Error('同步服务尚未启动。请重启酒馆服务，再刷新此页。'); }
        if (!response.ok) throw new Error(result.error || `同步服务返回 ${response.status}`);
        return result;
    }
    async stateNow() {
        const q = new URLSearchParams({ meta: '1', device: this.device || '', client: this.client, since: String(this.state?.revision || 0),
            resources: String(this.resources || 0), session: this.session || '' });
        return this.api(`/state?${q}`);
    }
    credentials() { return { device: this.device, client: this.client, epoch: this.state.epoch }; }
    async persist(progress = () => {}) {
        const hashes = await snapshotHashes(this.base, this.hashedSnapshot, this.hashes, progress);
        await cacheSet(`baseline:${this.user}`, { version: 2, epoch: this.state.epoch, hashes, lastUpload: this.lastUpload });
        this.hashes = hashes; this.hashedSnapshot = this.base;
    }
    async initialize() {
        try { await this.initializeStorage(); } finally { clearInterval(this.receiveTimer); }
    }
    async receiveSnapshot(state) {
        const report = this.progress('正在下载最新进度', '正在从电脑读取同步数据。大数据库会分批下载，请保持本页打开。');
        const target = {};
        let cursor = 0;
        do {
            const query = new URLSearchParams({ device: this.device, client: this.client, epoch: state.epoch, revision: String(state.revision), cursor: String(cursor) });
            const page = await this.api(`/snapshot?${query}`);
            for (const [key, value] of Object.entries(page.entries)) if (value !== null) target[key] = value;
            report(`已下载 ${page.processed} / ${page.total} 项`, page.processed, page.total);
            cursor = page.next; await wait(0);
        } while (cursor !== null);
        return target;
    }
    async checkReceiveOwner() {
        const state = await this.stateNow();
        if (state.active?.client !== this.client || state.epoch !== this.state.epoch || state.revision !== this.state.revision) throw new Error('接续期间另一页面更新了进度，请重新接续本设备。');
    }
    async initializeStorage() {
        this.screen('sillytavern link', '正在检查已保存的数据…');
        const tokenResponse = await this.fetch('/csrf-token', { credentials: 'same-origin', cache: 'no-store' });
        if (!tokenResponse.ok) throw new Error('请先登录酒馆，再打开同步扩展');
        this.token = (await tokenResponse.json()).token;
        let state = await this.stateNow();
        if (state.protocol !== 2) throw new Error('sillytavern link 已更新，请在电脑关闭并重新启动一次酒馆服务，再刷新此页。原同步基准会保留，不需要重新建立。');
        this.user = state.user; this.device = deviceId(this.user);
        await cleanupLocalBackups(this.user);
        this.mirror.watch();
        let report = this.progress('正在检查本设备数据', '正在读取浏览器设置和数据库。此步骤用于确定哪些内容需要接续。');
        let local = await this.mirror.scan(true, report);
        if (!state.initialized) {
            await new Promise(resolve => {
                this.screen('首次连接 · 以电脑为基准', '请在平时使用的电脑浏览器中建立基准。它会保存当前地址下的设置和本地数据库。手机请选择等待电脑；两端必须登录同一个酒馆账户。', [
                    ['这是电脑，建立同步基准', async () => {
                        const progress = this.progress('正在保存电脑数据', '首次同步可能需要一些时间，请保持页面打开。');
                        local = await this.mirror.scan(true, progress);
                        state = await this.api('/initialize', { device: this.device, snapshot: local, meta: true });
                        resolve();
                    }],
                    ['这是手机，等待电脑', async () => {
                        this.screen('等待电脑建立同步基准', '在原来的电脑浏览器打开酒馆，点击“建立同步基准”。完成后此页会继续。');
                        while (true) { await wait(2000); state = await this.stateNow(); if (state.initialized) { resolve(); break; } }
                    }],
                ]);
            });
        }
        const previousDevice = state.active?.device;
        const interruptedReceive = await cacheGet(`receiving:${this.user}`);
        // Mark before claiming: an interrupted hydration must never be mistaken for offline edits on the next launch.
        await cacheSet(`receiving:${this.user}`, true);
        this.screen('正在接续此设备', '正在让上一设备保存最新进度。游玩过程中不会自动重载页面。');
        let claim;
        let force = false, offered = false;
        const switchStarted = Date.now();
        while (true) {
            claim = await this.api('/switch', { device: this.device, client: this.client, force, meta: true });
            if (claim.granted) break;
            const progress = await this.stateNow();
            if (!offered && (progress.switchRequest?.busy || Date.now() - switchStarted > 8000)) {
                offered = true;
                this.screen('正在等待上一设备保存', '上一设备可能正在生成回复、留有草稿或已被浏览器暂停。通常完成操作后会自动交接。若你已经出门，可以使用最后一次成功上传的进度；尚未上传的内容仍留在原设备。', [
                    ['使用已上传的进度接续', () => { force = true; }],
                ]);
            }
            await wait(1000);
        }
        this.state = claim; this.session = claim.session; this.resources = claim.resourceRevision;
        this.active = true;
        this.receiveTimer = setInterval(() => { void this.stateNow().catch(() => {}); }, 3000);
        const canRecover = previousDevice === this.device && !interruptedReceive;
        this.screen('正在检查上次进度', '正在检查本设备上次离开时是否有尚未上传的修改。');
        const saved = canRecover ? await cacheGet(`baseline:${this.user}`) : null;
        const pendingSettings = await cacheGet(`pending-settings:${this.user}`);
        let pendingToBackup = null;
        if (pendingSettings) {
            if (pendingSettings.epoch === claim.epoch && canRecover) {
                await this.api('/settings', { ...this.credentials(), base: pendingSettings.base, next: pendingSettings.next });
            } else pendingToBackup = pendingSettings;
        }
        // On a normal reload of the active device, preserve edits made just before closing/offline.
        if (saved?.epoch === claim.epoch && canRecover) {
            if (saved.hashes) {
                const progress = this.progress('正在保存本设备修改', '正在检查上次离开后本地是否有新的内容。');
                const hashes = await snapshotHashes(local, {}, {}, (current, total) => progress(`已检查 ${current} / ${total} 项`, current, total));
                const changes = [...new Set([...Object.keys(saved.hashes), ...Object.keys(hashes)])]
                    .filter(key => saved.hashes[key] !== hashes[key])
                    .map(key => ({ key, beforeHash: saved.hashes[key] ?? null, value: local[key] ?? null }));
                if (changes.length) await this.api('/patch', { ...this.credentials(), changes });
                this.hashes = hashes; this.hashedSnapshot = local;
            } else if (saved.base) {
                this.base = saved.base;
                await this.upload(local);
            }
            claim = await this.stateNow(); this.state = claim;
        }
        const target = await this.receiveSnapshot(claim);
        const changed = storageChanges(local, target).length > 0;
        if (changed || pendingToBackup) await this.backupBeforeSync(local, pendingToBackup);
        await this.checkReceiveOwner();
        if (changed) {
            report = this.progress('正在载入最新数据', '正在把最新进度写入本设备。备份步骤已结束，完成后会自动进入酒馆。');
            await this.mirror.apply(local, target, report);
        }
        this.base = target; this.lastUpload = saved?.lastUpload || null;
        report = this.progress('即将进入酒馆', '正在保存同步校验记录，供下次接续使用。');
        await this.persist((current, total) => report(`已校验 ${current} / ${total} 项`, current, total));
        await this.checkReceiveOwner();
        if (pendingSettings) await cacheSet(`pending-settings:${this.user}`, null);
        await cacheSet(`receiving:${this.user}`, false);
        this.installFetch();
        this.hide();
        this.status('此设备正在使用 · 修改自动保存到电脑服务器');
    }
    async decodeBody(request) {
        const encoding = request.headers.get('Content-Encoding');
        if (encoding && encoding !== 'identity') {
            if (!['gzip', 'deflate'].includes(encoding)) throw new Error('不支持的酒馆请求压缩格式');
            return JSON.parse(await new Response(request.body.pipeThrough(new DecompressionStream(encoding))).text());
        }
        return request.json();
    }
    installFetch() {
        const engine = this;
        window.fetch = async function (input, options) {
            const request = new Request(input instanceof Request ? input : new URL(input, location.href), options);
            const url = new URL(request.url);
            if (url.origin !== location.origin || url.pathname.startsWith(API)) return engine.fetch(input, options);
            if (url.pathname === '/api/settings/get') {
                const response = await engine.fetch(input, options);
                if (response.ok) {
                    const data = await response.clone().json();
                    if (data.settings) engine.settingsBase = JSON.parse(data.settings);
                }
                return response;
            }
            if (url.pathname === '/api/settings/save') {
                const next = await engine.decodeBody(request);
                const save = async () => {
                    if (!engine.active || !engine.settingsBase) throw new Error('本页面已交接或设置尚未载入，已阻止旧设置覆盖');
                    engine.inFlight++;
                    try {
                        engine.pendingSettings = { base: engine.settingsBase, next, epoch: engine.state.epoch };
                        await cacheSet(`pending-settings:${engine.user}`, engine.pendingSettings);
                        const result = await engine.api('/settings', { ...engine.credentials(), base: engine.settingsBase, next });
                        engine.settingsBase = next;
                        engine.pendingSettings = null;
                        await cacheSet(`pending-settings:${engine.user}`, null);
                        if (result.conflicts.length) { engine.warning = '设置冲突已留存备份'; engine.status(engine.warning, '电脑的同项修改优先；完整冲突见同步备份。'); }
                        return Response.json({ result: 'ok' });
                    } finally { engine.inFlight--; }
                };
                const result = engine.serialSave.then(save);
                engine.serialSave = result.catch(() => {});
                return result.catch(e => { engine.status('设置未保存', e.message); return Response.json({ error: e.message }, { status: 409 }); });
            }
            const mutating = url.pathname.startsWith('/api/') && isMutation(url.pathname, request.method);
            if (!mutating) return engine.fetch(input, options);
            if (!engine.active) return Response.json({ error: '此页面已交接，请在此设备接续后再操作。' }, { status: 409 });
            request.headers.set('X-STLink-Device', engine.device);
            request.headers.set('X-STLink-Client', engine.client);
            request.headers.set('X-STLink-Revision', String(engine.resources));
            request.headers.set('X-STLink-Session', engine.session);
            engine.inFlight++;
            try {
                const response = await engine.fetch(request);
                if (response.status === 409) engine.status('有新进度等待接续', '本次保存被阻止以保护最新数据；点击“在此设备接着玩”重新载入。');
                return response;
            } finally { engine.inFlight--; }
        };
    }
    busy() {
        const context = window.SillyTavern?.getContext?.();
        const stream = context?.streamingProcessor;
        if (this.generating || (stream && !stream.isFinished)) return true;
        if (document.querySelector('#send_textarea')?.value.trim()) return true;
        if (document.querySelector('dialog[open], .mes .edit_textarea')) return true;
        const focus = document.activeElement;
        return Boolean(focus?.matches('input:not([type=button]):not([type=checkbox]):not([type=range]),textarea,[contenteditable=true]') && focus.id !== 'send_textarea');
    }
    async upload(snapshot) {
        const changes = storageChanges(this.base, snapshot);
        if (changes.length) {
            const result = await this.api('/patch', { ...this.credentials(), changes });
            if (result.conflicts.length) { this.warning = '有同步冲突，两个版本均已备份'; this.status(this.warning, '冲突记录位于电脑服务器的 sillytavern-link/backups。'); }
            // The local baseline is the submitted snapshot, not an unseen remote state.
            this.base = snapshot;
            this.lastUpload = new Date().toISOString();
            await this.persist();
        }
        return changes.length;
    }
    standby() {
        this.active = false;
        this.status('已交接给另一设备');
        this.screen('已在另一设备继续游玩', '进度会自动保存到电脑上的酒馆服务器。本页面保持待接续状态，不会在你游玩时自动刷新。回来后点击下方按钮载入最新进度。', [
            ['在此设备接着玩', () => location.reload()],
        ]);
    }
    async tick(full = false) {
        if (this.running || !this.active) return;
        this.running = true;
        try {
            const state = await this.stateNow();
            if (state.epoch !== this.state.epoch) throw new Error('同步基准已变化，请主动重新载入此页');
            if (state.active?.client !== this.client) { this.standby(); return; }
            if (this.pendingSettings && !this.inFlight) {
                const pending = this.pendingSettings;
                const retryWork = async () => {
                    if (this.pendingSettings !== pending) return;
                    this.inFlight++;
                    try {
                        const retry = await this.api('/settings', { ...this.credentials(), base: pending.base, next: pending.next });
                        this.settingsBase = pending.next;
                        if (this.pendingSettings === pending) { this.pendingSettings = null; await cacheSet(`pending-settings:${this.user}`, null); }
                        if (retry.conflicts.length) this.warning = '断线期间的设置冲突已备份';
                    } finally { this.inFlight--; }
                };
                const job = this.serialSave.then(retryWork);
                this.serialSave = job.catch(() => {});
                await job;
            }
            if (!state.foreign) { this.resources = state.resourceRevision; this.session = state.session; }
            const rescan = full || Date.now() - this.fullScanAt > 30000;
            if (rescan) this.fullScanAt = Date.now();
            await this.upload(await this.mirror.scan(rescan));
            this.state.revision = state.revision;
            if (state.switchRequest?.client && state.switchRequest.client !== this.client) {
                if (this.busy()) { await this.api('/handoff', { ...this.credentials(), busy: true }); return; }
                // Flush ST's debounced settings before allowing the next device to read them.
                if (this.context) {
                    const { saveSettings } = await import('/script.js');
                    await saveSettings();
                }
                await this.serialSave;
                if (this.inFlight || this.pendingSettings) return;
                await this.upload(await this.mirror.scan(true));
                const result = await this.api('/handoff', { ...this.credentials(), busy: false });
                if (result.handedOff) this.standby();
            } else this.status(this.warning || '此设备正在使用 · 修改自动保存到电脑服务器');
        } catch (e) {
            this.status('暂未同步，正在重试', e.message);
        } finally { this.running = false; }
    }
    start(context) {
        if (this.timer) return;
        this.context = context;
        if (context) {
            const events = context.eventSource, types = context.eventTypes || context.event_types;
            if (types.GENERATION_STARTED) events.on(types.GENERATION_STARTED, () => { this.generating = true; });
            for (const type of ['GENERATION_ENDED', 'GENERATION_STOPPED']) if (types[type]) events.on(types[type], () => { this.generating = false; });
        }
        this.timer = setInterval(() => this.tick(), 1500);
        this.cleanupTimer = setInterval(() => { void cleanupLocalBackups(this.user).catch(() => {}); }, 60000);
        window.addEventListener('online', () => this.tick(true));
        document.addEventListener('visibilitychange', () => { if (!document.hidden) this.tick(true); });
        window.addEventListener('pagehide', () => {
            // Large databases are uploaded periodically; never falsely claim an asynchronous unload flush succeeded.
            if (this.active) this.status('页面已离开，以上一次成功上传为准');
        });
        this.tick(true);
    }
    async downloadBackups() {
        const names = await this.api('/backups');
        const panel = this.screen('同步备份', '备份保存在你的电脑，保留 24 小时，服务运行时每分钟检查清理。当前同步进度不会删除。下载到其他位置的文件由你保管。', [['返回酒馆', () => this.hide()]]);
        for (const name of names.slice(0, 50)) {
            const link = document.createElement('a'); link.textContent = name;
            link.href = `${API}/backup/${encodeURIComponent(name)}`; link.download = name;
            link.className = 'stlink-backup'; panel.buttons.append(link);
        }
    }
}
