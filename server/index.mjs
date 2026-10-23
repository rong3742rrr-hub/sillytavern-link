import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LinkStore, validateDevice, protectRouter } from './store.mjs';
import { pruneBackups, isBackupName, CLEANUP_INTERVAL } from './retention.mjs';

export const info = { id: 'sillytavern-link', name: 'sillytavern link', description: '电脑与手机的双向同步，包含浏览器本地数据库。' };
const stores = new Map();
let cleanupTimer;
export function storeFor(req) {
    const root = req.user?.directories?.root;
    if (!root || !req.user?.profile?.handle) throw new Error('需要先登录酒馆账户');
    const key = path.resolve(root);
    if (!stores.has(key)) stores.set(key, new LinkStore(key));
    return stores.get(key);
}
function route(handler) {
    return (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { handler(req, res, storeFor(req)); }
        catch (e) { res.status(400).json({ error: String(e.message) }); }
    };
}
export function register(router) {
    router.get('/state', route((req, res, store) => {
        const since = Number(req.query.since || 0);
        const device = String(req.query.device || '');
        store.heartbeat(device, String(req.query.client || ''));
        const state = store.status(Number.isSafeInteger(since) && since >= 0 && since <= store.state.revision ? since : 0, req.query.meta !== '1');
        res.json({ ...state, user: req.user.profile.handle,
            foreign: store.foreignChanges(device, Number(req.query.resources || 0), req.query.session) });
    }));
    router.post('/initialize', route((req, res, store) => res.json(store.initialize(req.body.device, req.body.snapshot, req.body.meta !== true))));
    router.post('/switch', route((req, res, store) => res.json(store.requestSwitch(req.body.device, req.body.client, req.body.force === true, req.body.meta !== true))));
    router.get('/snapshot', route((req, res, store) => res.json(store.snapshotPage(
        req.query.device, req.query.client, req.query.epoch, Number(req.query.revision), Number(req.query.cursor || 0),
    ))));
    router.post('/handoff', route((req, res, store) => res.json(store.handoff(req.body.device, req.body.client, req.body.busy))));
    router.post('/patch', route((req, res, store) => res.json(store.patch(req.body.device, req.body.epoch, req.body.changes, req.body.client))));
    router.post('/settings', route((req, res, store) => {
        if (!store.state.initialized || req.body.epoch !== store.state.epoch) throw new Error('同步尚未初始化或基准已变更');
        res.json(store.saveSettings(req.body.device, req.body.base, req.body.next, req.body.client));
    }));
    router.post('/backup', route((req, res, store) => {
        validateDevice(req.body.device);
        res.json({ name: store.backup('device-before-sync', { device: req.body.device, snapshot: req.body.snapshot, pendingSettings: req.body.pendingSettings }) });
    }));
    router.get('/backups', route((req, res, store) => {
        pruneBackups(store.directory);
        const dir = path.join(store.directory, 'backups');
        res.json(fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter(n => n.isFile() && isBackupName(n.name)).map(n => n.name).sort().reverse() : []);
    }));
    router.get('/backup/:name', route((req, res, store) => {
        pruneBackups(store.directory);
        if (!isBackupName(req.params.name)) throw new Error('备份名称无效');
        const file = path.join(store.directory, 'backups', req.params.name);
        res.download(file);
    }));
}
export async function init(router) {
    register(router);
    const stRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    // Use the existing authenticated routers; no extra listening port and no authentication bypass.
    for (const name of ['settings', 'chats', 'presets', 'worldinfo', 'characters', 'groups', 'quick-replies', 'themes', 'backgrounds', 'files']) {
        const { router: host } = await import(pathToFileURL(path.join(stRoot, 'src/endpoints', `${name}.js`)));
        if (!host?.stack) throw new Error(`不兼容的酒馆路由：${name}`);
        protectRouter(host, name, storeFor);
    }
    const { getUserDirectoriesList } = await import(pathToFileURL(path.join(stRoot, 'src/users.js')));
    const cleanup = async () => {
        try {
            for (const user of await getUserDirectoriesList()) pruneBackups(path.join(user.root, 'sillytavern-link'));
        } catch { /* Account storage may be shutting down. */ }
    };
    await cleanup();
    clearInterval(cleanupTimer);
    cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL);
    cleanupTimer.unref();
    console.log('[sillytavern link] 双端同步服务已启动。');
}
export async function exit() { clearInterval(cleanupTimer); }
