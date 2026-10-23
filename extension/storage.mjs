import { id, parts, PREFIX, INTERNAL_DB, localKeyAllowed, databaseAllowed } from './model.mjs';
const breathe = () => new Promise(resolve => setTimeout(resolve, 0));

function base64(buffer) {
    const bytes = new Uint8Array(buffer);
    let str = '';
    for (let i = 0; i < bytes.length; i += 16384) str += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return btoa(str);
}
function binary(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)).buffer; }

// A graph format preserves structured-clone types, shared references and cycles without lossy JSON conversion.
export async function encode(value) {
    const seen = new Map(), nodes = [];
    let visited = 0;
    async function visit(v) {
        if (++visited % 2048 === 0) await breathe();
        if (v === undefined) return ['undefined'];
        if (typeof v === 'number' && !Number.isFinite(v)) return ['number', String(v)];
        if (Object.is(v, -0)) return ['number', '-0'];
        if (typeof v === 'bigint') return ['bigint', String(v)];
        if (v === null || typeof v !== 'object') {
            if (['function', 'symbol'].includes(typeof v)) throw new Error('数据库含无法同步的数据类型');
            return ['value', v];
        }
        if (seen.has(v)) return ['ref', seen.get(v)];
        const n = nodes.length;
        seen.set(v, n); nodes.push(null);
        let out;
        if (v instanceof Date) out = ['date', String(v.getTime())];
        else if (v instanceof RegExp) out = ['regexp', v.source, v.flags];
        else if (v instanceof File) out = ['file', base64(await v.arrayBuffer()), v.type, v.name, v.lastModified];
        else if (v instanceof Blob) out = ['blob', base64(await v.arrayBuffer()), v.type];
        else if (v instanceof ArrayBuffer) out = ['buffer', base64(v)];
        else if (ArrayBuffer.isView(v)) out = ['view', v.constructor.name, await visit(v.buffer), v.byteOffset, v.byteLength];
        else if (Array.isArray(v)) {
            out = ['array', v.length, []];
            for (const key of Object.keys(v).sort()) out[2].push([key, await visit(v[key])]);
        } else if (v instanceof Map) {
            out = ['map', []];
            for (const [k, x] of v) out[1].push([await visit(k), await visit(x)]);
        } else if (v instanceof Set) {
            out = ['set', []];
            for (const x of v) out[1].push(await visit(x));
        } else if (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) {
            out = ['object', []];
            for (const key of Object.keys(v).sort()) out[1].push([key, await visit(v[key])]);
        } else throw new Error(`数据库包含暂不支持的类型：${v.constructor?.name || 'unknown'}，已停止本次同步`);
        nodes[n] = out;
        return ['ref', n];
    }
    const root = await visit(value);
    return JSON.stringify({ root, nodes });
}

export function decode(text) {
    const { root, nodes } = JSON.parse(text), built = new Map();
    function visit(v) {
        switch (v[0]) {
            case 'value': return v[1];
            case 'undefined': return undefined;
            case 'bigint': return BigInt(v[1]);
            case 'number': return v[1] === '-0' ? -0 : Number(v[1]);
            case 'ref': break;
            default: throw new Error('同步数据编码无效');
        }
        const index = v[1];
        if (built.has(index)) return built.get(index);
        const n = nodes[index];
        let result;
        switch (n[0]) {
            case 'date': result = new Date(Number(n[1])); break;
            case 'regexp': result = new RegExp(n[1], n[2]); break;
            case 'buffer': result = binary(n[1]); break;
            case 'blob': result = new Blob([binary(n[1])], { type: n[2] }); break;
            case 'file': result = new File([binary(n[1])], n[3], { type: n[2], lastModified: n[4] }); break;
            case 'view': {
                const types = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
                if (!types[n[1]]) throw new Error('未知的二进制类型');
                if (typeof n[2] === 'string') result = new types[n[1]](binary(n[2]));
                else {
                    const buffer = visit(n[2]);
                    const length = n[1] === 'DataView' ? n[4] : n[4] / types[n[1]].BYTES_PER_ELEMENT;
                    result = new types[n[1]](buffer, n[3], length);
                }
                break;
            }
            case 'array': result = new Array(n[1]); break;
            case 'object': result = {}; break;
            case 'map': result = new Map(); break;
            case 'set': result = new Set(); break;
            default: throw new Error('未知的数据库类型');
        }
        built.set(index, result);
        if (n[0] === 'object' || n[0] === 'array') for (const [k, x] of n[n[0] === 'array' ? 2 : 1]) {
            Object.defineProperty(result, k, { value: visit(x), writable: true, enumerable: true, configurable: true });
        }
        if (n[0] === 'map') for (const [k, x] of n[1]) result.set(visit(k), visit(x));
        if (n[0] === 'set') for (const x of n[1]) result.add(visit(x));
        return result;
    }
    return visit(root);
}

const requestResult = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});
const transactionDone = transaction => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
        try { transaction.abort(); } catch { /* Already completed. */ }
        reject(new Error('浏览器存储操作超过 45 秒。请关闭同地址的其他酒馆标签页，并检查手机可用存储空间后重试。'));
    }, 45000);
    transaction.addEventListener('complete', () => { clearTimeout(timer); resolve(); }, { once: true });
    transaction.addEventListener('abort', () => { clearTimeout(timer); reject(transaction.error || new Error('数据库写入已取消')); }, { once: true });
    transaction.addEventListener('error', () => { clearTimeout(timer); reject(transaction.error); }, { once: true });
});

async function open(name, version, upgrade, existing = false) {
    return new Promise((resolve, reject) => {
        const request = version ? indexedDB.open(name, version) : indexedDB.open(name);
        let expired = false;
        const timer = setTimeout(() => { expired = true; reject(new Error(`数据库 ${name} 正被其他标签页占用，请关闭该地址的其他酒馆页面后重试`)); }, 12000);
        request.onupgradeneeded = () => {
            if (expired || existing) { request.transaction.abort(); return; }
            try { upgrade?.(request.result, request.transaction); } catch (e) { request.transaction.abort(); reject(e); }
        };
        request.onsuccess = () => {
            clearTimeout(timer);
            const db = request.result;
            db.onversionchange = () => db.close();
            if (expired) db.close(); else resolve(db);
        };
        request.onerror = () => { clearTimeout(timer); reject(request.error); };
    });
}
async function removeDatabase(name) {
    await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        const timer = setTimeout(() => reject(new Error(`无法替换 ${name}：请关闭同地址的其他酒馆标签页`)), 12000);
        request.onsuccess = () => { clearTimeout(timer); resolve(); };
        request.onerror = () => { clearTimeout(timer); reject(request.error); };
    });
}

export async function cacheGet(key) {
    const db = await open(INTERNAL_DB, 1, db => db.createObjectStore('cache'));
    try {
        const tx = db.transaction('cache');
        const [value] = await Promise.all([requestResult(tx.objectStore('cache').get(key)), transactionDone(tx)]);
        return value;
    } finally { db.close(); }
}

export async function cacheDelete(key) {
    const db = await open(INTERNAL_DB, 1, db => db.createObjectStore('cache'));
    try {
        const tx = db.transaction('cache', 'readwrite'), done = transactionDone(tx);
        tx.objectStore('cache').delete(key);
        await done;
    } finally { db.close(); }
}

export async function cleanupLocalBackups(user, now = Date.now()) {
    // Version 1 kept an undated full backup in IndexedDB. Expire it one day after migration without reading its contents.
    const marker = `${PREFIX}legacy-backup-expires:${user}`;
    let expires = Number(localStorage.getItem(marker));
    if (expires === -1) return;
    if (!expires) { expires = now + 86400000; localStorage.setItem(marker, String(expires)); }
    if (expires <= now) { await cacheDelete(`before-sync:${user}`); localStorage.setItem(marker, '-1'); }
}

export async function snapshotHashes(snapshot, previous = {}, hashes = {}, progress = () => {}) {
    const result = {};
    const keys = Object.keys(snapshot);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (snapshot[key] === previous[key] && hashes[key]) result[key] = hashes[key];
        else {
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot[key]));
            result[key] = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
        }
        if (i % 32 === 0 || i === keys.length - 1) { progress(i + 1, keys.length); await breathe(); }
    }
    return result;
}

async function readBatch(db, storeName, after) {
    const tx = db.transaction(storeName), done = transactionDone(tx);
    const rows = new Promise((resolve, reject) => {
        const result = [];
        const request = tx.objectStore(storeName).openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return resolve(result);
            result.push({ key: cursor.key, value: cursor.value });
            if (result.length >= 16) resolve(result); else cursor.continue();
        };
    });
    return (await Promise.all([rows, done]))[0];
}
export async function cacheSet(key, value) {
    const db = await open(INTERNAL_DB, 1, db => db.createObjectStore('cache'));
    try {
        const tx = db.transaction('cache', 'readwrite'), done = transactionDone(tx);
        tx.objectStore('cache').put(value, key);
        await done;
    } finally { db.close(); }
}

export class StorageMirror {
    constructor() { this.latest = {}; this.dirty = new Set(); this.lastWrite = 0; this.applying = false; }
    watch() {
        const mirror = this;
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args) {
            const tx = original.apply(this, args);
            if (args[1] === 'readwrite' && databaseAllowed(this.name) && !mirror.applying) {
                const name = this.name;
                tx.addEventListener('complete', () => { mirror.dirty.add(name); mirror.lastWrite = Date.now(); }, { once: true });
            }
            return tx;
        };
    }
    async names() {
        if (typeof indexedDB.databases !== 'function') throw new Error('浏览器不支持完整数据库枚举，请更新手机浏览器后再同步');
        return (await indexedDB.databases()).map(d => d.name).filter(n => n && databaseAllowed(n));
    }
    async scan(full = true, progress = () => {}) {
        const snapshot = { ...this.latest };
        for (const k of Object.keys(snapshot)) if (parts(k)[0] === 'ls') delete snapshot[k];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (localKeyAllowed(k)) snapshot[id('ls', k)] = localStorage.getItem(k);
        }
        const names = await this.names();
        for (const k of Object.keys(snapshot)) if (['schema', 'db'].includes(parts(k)[0]) && !names.includes(parts(k)[1])) delete snapshot[k];
        for (const name of names) {
            if (!full && !this.dirty.has(name) && snapshot[id('schema', name)]) continue;
            this.dirty.delete(name);
            const db = await open(name, undefined, null, true);
            try {
                progress(`正在读取 ${name}`); await breathe();
                const stores = [...db.objectStoreNames].sort();
                const schema = { name, version: db.version, stores: [] };
                if (stores.length) {
                    const tx = db.transaction(stores, 'readonly');
                    const done = transactionDone(tx);
                    for (const storeName of stores) {
                        const store = tx.objectStore(storeName);
                        schema.stores.push({ name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
                            indexes: [...store.indexNames].sort().map(i => { const ix = store.index(i); return { name: i, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry }; }) });
                    }
                    await done;
                }
                for (const k of Object.keys(snapshot)) if (parts(k)[0] === 'db' && parts(k)[1] === name) delete snapshot[k];
                snapshot[id('schema', name)] = JSON.stringify(schema);
                let count = 0;
                for (const storeName of stores) {
                    let after;
                    while (true) {
                        const rows = await readBatch(db, storeName, after);
                        for (const row of rows) {
                            snapshot[id('db', name, storeName, await encode(row.key))] = await encode(row.value);
                            row.value = null; count++;
                        }
                        progress(`正在读取 ${name} · ${count} 条记录`); await breathe();
                        if (rows.length < 16) break;
                        after = rows.at(-1).key;
                    }
                }
            } finally { db.close(); }
        }
        this.latest = snapshot;
        return snapshot;
    }
    async apply(current, target, progress = () => {}) {
        this.applying = true;
        try {
            const allKeys = new Set([...Object.keys(current), ...Object.keys(target)]);
            const schemas = [...allKeys].filter(k => parts(k)[0] === 'schema');
            const byDatabase = new Map();
            for (const key of allKeys) {
                const p = parts(key);
                if (p[0] !== 'db') continue;
                if (!byDatabase.has(p[1])) byDatabase.set(p[1], []);
                byDatabase.get(p[1]).push(key);
            }
            let completed = 0;
            for (const key of schemas) {
                const name = parts(key)[1];
                const report = detail => progress(`${detail}\n数据库 ${completed + 1} / ${schemas.length}`);
                report(`正在载入 ${name}`); await breathe();
                if (!target[key]) { await removeDatabase(name); completed++; continue; }
                const schema = JSON.parse(target[key]);
                const recreate = current[key] && current[key] !== target[key];
                if (recreate) await removeDatabase(name);
                const db = await open(name, schema.version, db => {
                    for (const s of schema.stores) {
                        const store = db.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
                        for (const i of s.indexes) store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
                    }
                });
                try {
                    const keys = (byDatabase.get(name) || []).filter(k => recreate || current[k] !== target[k]);
                    let index = 0;
                    while (index < keys.length) {
                        report(`正在载入 ${name} · ${index} / ${keys.length} 条`); await breathe();
                        const changes = [];
                        let size = 0;
                        // Decode and commit bounded batches so the phone can render progress and release memory.
                        while (index < keys.length && changes.length < 64 && size < 2 * 1024 * 1024) {
                            const k = keys[index++]; size += target[k]?.length || 0;
                            changes.push({ p: parts(k), deleted: target[k] === undefined, value: target[k] === undefined ? undefined : decode(target[k]) });
                        }
                        const storeNames = [...new Set(changes.map(c => c.p[2]))].filter(s => db.objectStoreNames.contains(s));
                        if (storeNames.length) {
                            const tx = db.transaction(storeNames, 'readwrite'), done = transactionDone(tx);
                            for (const c of changes) {
                                if (!storeNames.includes(c.p[2])) continue;
                                const store = tx.objectStore(c.p[2]);
                                if (c.deleted) store.delete(decode(c.p[3]));
                                else if (store.keyPath === null) store.put(c.value, decode(c.p[3]));
                                else store.put(c.value);
                            }
                            await done;
                        }
                    }
                } finally { db.close(); }
                completed++;
            }
            progress('正在载入浏览器设置'); await breathe();
            for (const key of allKeys) {
                const p = parts(key);
                if (p[0] !== 'ls' || !localKeyAllowed(p[1]) || current[key] === target[key]) continue;
                const oldValue = localStorage.getItem(p[1]);
                if (target[key] === undefined) localStorage.removeItem(p[1]); else localStorage.setItem(p[1], target[key]);
                window.dispatchEvent(new StorageEvent('storage', { key: p[1], oldValue, newValue: target[key] ?? null, storageArea: localStorage, url: location.href }));
            }
            this.latest = { ...target };
        } finally { this.applying = false; }
    }
}

export function deviceId(user) {
    const key = `${PREFIX}device:${user}`;
    let value = localStorage.getItem(key);
    if (!value) { value = crypto.randomUUID(); localStorage.setItem(key, value); }
    return value;
}
