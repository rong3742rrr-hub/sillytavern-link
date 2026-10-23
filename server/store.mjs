import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mergeSettings, parts, localKeyAllowed, databaseAllowed, isMutation } from './model.mjs';
import { pruneBackups } from './retention.mjs';

const MAX_BYTES = 256 * 1024 * 1024;
export function atomicWrite(file, value) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('同步数据超过 256 MB；原数据没有覆盖。请先减少大型图片缓存。');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function validateDevice(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) throw new Error('设备标识无效');
    return value;
}
function validateKey(key, value) {
    if (typeof key !== 'string' || key.length > 30000 || !(value === null || typeof value === 'string')) throw new Error('同步记录格式无效');
    const p = parts(key);
    if (p[0] === 'ls' && p.length === 2 && localKeyAllowed(p[1])) return;
    if (p[0] === 'schema' && p.length === 2 && databaseAllowed(p[1])) {
        if (value !== null) {
            const schema = JSON.parse(value);
            if (schema.name !== p[1] || !Number.isSafeInteger(schema.version) || schema.version < 1 || !Array.isArray(schema.stores)) throw new Error('数据库结构无效');
        }
        return;
    }
    if (p[0] === 'db' && p.length === 4 && databaseAllowed(p[1])) return;
    throw new Error('不支持的同步记录');
}

export class LinkStore {
    constructor(root) {
        this.root = root;
        this.directory = path.join(root, 'sillytavern-link');
        this.file = path.join(this.directory, 'state.json');
        this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {
            format: 1, epoch: crypto.randomUUID(), initialized: false, primary: null, revision: 0, entries: {},
        };
        if (this.state.format !== 1 || !this.state.entries || !Number.isSafeInteger(this.state.revision)) throw new Error('同步文件格式不正确，已停止写入');
        this.events = [];
        this.resourceRevision = 0;
        this.session = crypto.randomUUID();
        this.busyWriter = null;
        this.settingsHash = this.hashSettings();
        this.lastSeen = 0;
        this.switchRequest = null;
        pruneBackups(this.directory);
    }
    hashSettings() {
        const file = path.join(this.root, 'settings.json');
        if (!fs.existsSync(file)) return '';
        const stat = fs.statSync(file), fingerprint = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
        if (this.settingsFingerprint !== fingerprint) {
            this.settingsFingerprint = fingerprint;
            this.cachedSettingsHash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        }
        return this.cachedSettingsHash;
    }
    commit(next) { atomicWrite(this.file, next); this.state = next; }
    backup(label, data) {
        pruneBackups(this.directory);
        const dir = path.join(this.directory, 'backups');
        const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}-${crypto.randomUUID().slice(0, 8)}.json`;
        atomicWrite(path.join(dir, name), { format: 1, createdAt: new Date().toISOString(), label, data });
        return name;
    }
    initialize(device, snapshot, includeEntries = true) {
        validateDevice(device);
        if (this.state.initialized) throw new Error('同步基准已经存在，不能再次初始化');
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('同步快照无效');
        const entries = {};
        for (const [key, value] of Object.entries(snapshot)) { validateKey(key, value); entries[key] = { value, revision: 1, device }; }
        this.backup('computer-initial', { snapshot, settings: this.readSettings() });
        this.commit({ ...this.state, initialized: true, primary: device, revision: 1, entries });
        return this.status(0, includeEntries);
    }
    status(since = 0, includeEntries = true) {
        const entries = {};
        if (includeEntries) for (const [k, v] of Object.entries(this.state.entries)) if (v.revision > since) entries[k] = v.value;
        return { protocol: 2, initialized: this.state.initialized, epoch: this.state.epoch, primary: this.state.primary, revision: this.state.revision, entries,
            session: this.session, resourceRevision: this.resourceRevision, settingsHash: this.hashSettings(),
            active: this.state.active ?? null, switchRequest: this.switchRequest };
    }
    assertActive(device, client) {
        validateDevice(device); validateDevice(client);
        if (this.state.active?.device !== device || this.state.active?.client !== client) throw new Error('此页面已交接给另一设备；请点击“在此设备接着玩”后继续');
    }
    heartbeat(device, client) {
        if (this.state.active?.device === device && this.state.active?.client === client) this.lastSeen = Date.now();
    }
    claim(device, client, includeEntries = true) {
        const previous = this.state.active ?? null;
        if (previous?.device !== device || previous?.client !== client) this.commit({ ...this.state, active: { device, client } });
        this.lastSeen = Date.now(); this.switchRequest = null;
        return { granted: true, previous, ...this.status(0, includeEntries) };
    }
    requestSwitch(device, client, force = false, includeEntries = true) {
        validateDevice(device); validateDevice(client);
        if (!this.state.initialized) throw new Error('请先在电脑建立同步基准');
        if (!this.state.active || this.state.active.client === client || (!this.busyWriter && (force || Date.now() - this.lastSeen > 12000))) return this.claim(device, client, includeEntries);
        if (this.switchRequest?.client !== client) this.switchRequest = { device, client, requestedAt: Date.now() };
        return { granted: false, active: this.state.active };
    }
    handoff(device, client, busy = false) {
        this.assertActive(device, client);
        if (!this.switchRequest) return { handedOff: false };
        if (busy || this.busyWriter) { this.switchRequest.busy = true; return { handedOff: false, busy: true }; }
        const { device: nextDevice, client: nextClient } = this.switchRequest;
        this.claim(nextDevice, nextClient, false);
        return { handedOff: true };
    }
    snapshotPage(device, client, epoch, revision, cursor = 0, budget = 2 * 1024 * 1024) {
        this.assertActive(device, client);
        if (epoch !== this.state.epoch || revision !== this.state.revision) throw new Error('下载期间进度已更新，请重新接续');
        const keys = Object.keys(this.state.entries);
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > keys.length) throw new Error('下载位置无效');
        const entries = {};
        let size = 0, index = cursor;
        for (; index < keys.length; index++) {
            const key = keys[index], value = this.state.entries[key].value;
            // A single record may exceed a page; it is kept intact, never truncated.
            const estimate = key.length * 3 + (value?.length || 4) * 3 + 8;
            if (index > cursor && size + estimate > budget) break;
            entries[key] = value; size += estimate;
        }
        this.heartbeat(device, client);
        return { epoch, revision, entries, total: keys.length, processed: index, next: index < keys.length ? index : null };
    }
    patch(device, epoch, changes, client) {
        this.assertActive(device, client);
        validateDevice(device);
        if (!this.state.initialized || epoch !== this.state.epoch) throw new Error('同步基准已变更，请重新加载');
        if (!Array.isArray(changes) || changes.length > 200000) throw new Error('同步批次格式无效');
        const keys = new Set();
        for (const c of changes) {
            validateKey(c.key, c.value);
            if (Object.hasOwn(c, 'beforeHash')) {
                if (c.beforeHash !== null && !/^[a-f0-9]{64}$/.test(c.beforeHash)) throw new Error('同步基线摘要无效');
            } else if (c.before !== null && typeof c.before !== 'string') throw new Error('同步基线无效');
            if (keys.has(c.key)) throw new Error('重复的同步记录');
            keys.add(c.key);
        }
        // Entry values are immutable strings. Avoid duplicating the entire large snapshot for a small change.
        const next = { ...this.state, entries: { ...this.state.entries } };
        const conflicts = [];
        let changed = false;
        for (const c of changes) {
            const previous = next.entries[c.key]?.value ?? null;
            if (previous === c.value) continue;
            const conflict = Object.hasOwn(c, 'beforeHash')
                ? (previous === null ? null : crypto.createHash('sha256').update(previous).digest('hex')) !== c.beforeHash
                : previous !== c.before;
            if (conflict) conflicts.push({ key: c.key, current: previous, incoming: c.value });
            // Initial computer wins a simultaneous edit; otherwise keep the already committed version.
            if (conflict && device !== this.state.primary) continue;
            next.entries[c.key] = { value: c.value, revision: next.revision + 1, device };
            changed = true;
        }
        let backup = null;
        if (conflicts.length) backup = this.backup('storage-conflict', { device, conflicts });
        if (changed) { next.revision++; this.commit(next); }
        return { revision: this.state.revision, conflicts: conflicts.map(c => c.key), backup };
    }
    readSettings() { return JSON.parse(fs.readFileSync(path.join(this.root, 'settings.json'), 'utf8')); }
    saveSettings(device, base, next, client) {
        this.assertActive(device, client);
        validateDevice(device);
        for (const o of [base, next]) if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('酒馆设置格式无效');
        const current = this.readSettings();
        const { result, conflicts } = mergeSettings(base, next, current, device === this.state.primary);
        let backup = null;
        if (conflicts.length) backup = this.backup('settings-conflict', { device, current, incoming: next, conflicts });
        if (JSON.stringify(result) !== JSON.stringify(current)) {
            // Retain the previous settings separately from ST's own backups, including on the first write.
            atomicWrite(path.join(this.directory, 'settings-previous.json'), current);
            atomicWrite(path.join(this.root, 'settings.json'), result);
        }
        return { result: 'ok', merged: result, conflicts: conflicts.map(c => c.path), backup, settingsHash: this.hashSettings() };
    }
    resourceChanged(device, route) {
        this.resourceRevision++;
        this.events.push({ revision: this.resourceRevision, device, route });
        if (this.events.length > 3000) this.events.shift();
    }
    foreignChanges(device, since, session) {
        if (session !== this.session) return true;
        if (!Number.isSafeInteger(since) || since < 0 || since > this.resourceRevision) return true;
        if (this.events.length && since < this.events[0].revision - 1) return true;
        return this.events.some(e => e.revision > since && e.device !== device);
    }
}

export function protectRouter(router, name, resolveStore) {
    router.use((req, res, next) => {
        const store = resolveStore(req);
        if (!store.state.initialized || !isMutation(req.path, req.method)) return next();
        if (name === 'settings') return res.status(409).json({ error: 'sillytavern link: 请刷新旧页面后再保存设置。' });
        const device = req.get('X-STLink-Device');
        if (store.state.active?.client !== req.get('X-STLink-Client') || store.state.active?.device !== device) return res.status(409).json({ error: '此设备处于待接续状态，请点击“在此设备接着玩”。' });
        const stale = !device || store.foreignChanges(device, Number(req.get('X-STLink-Revision')), req.get('X-STLink-Session'));
        if (stale || (store.busyWriter && store.busyWriter.device !== device)) {
            const backup = store.backup('blocked-save', { route: `${name}${req.path}`, body: req.body });
            return res.status(409).json({ error: '另一端已更新内容，请先同步并重新载入。当前提交已备份。', backup });
        }
        if (store.busyWriter) store.busyWriter.count++;
        else store.busyWriter = { device, count: 1 };
        let ended = false;
        const finish = () => {
            if (ended) return;
            ended = true;
            if (store.busyWriter?.device === device && --store.busyWriter.count === 0) store.busyWriter = null;
            if (res.statusCode < 400) store.resourceChanged(device, `${name}${req.path}`);
        };
        res.once('finish', finish);
        res.once('close', finish);
        next();
    });
    router.stack.unshift(router.stack.pop());
}
