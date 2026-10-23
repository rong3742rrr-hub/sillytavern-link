export const FORMAT = 1;
export const PREFIX = '__stlink:';
export const INTERNAL_DB = '__sillytavern_link';
// Leases and in-flight work must stay local, otherwise receiving a copy can run a job twice.
export const excludedDatabases = new Set([INTERNAL_DB, 'xb_image_backend_jobs', '__Dexie__DatabaseNames']);
export const localKeyAllowed = key => !key.startsWith(PREFIX) && !/(^|[.:_-])(csrf|lease|lock|heartbeat|farewell|pagehide)([.:_-]|$)/i.test(key);
export const databaseAllowed = name => !excludedDatabases.has(name);
export const id = (...parts) => parts.map(p => encodeURIComponent(p)).join('|');
export const parts = key => key.split('|').map(decodeURIComponent);
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => o != null && Object.hasOwn(o, k);

export function differences(base, next, path = []) {
    if (same(base, next)) return [];
    if (object(base) && object(next)) {
        return [...new Set([...Object.keys(base), ...Object.keys(next)])].flatMap(k => differences(base[k], next[k], [...path, k]));
    }
    return [{ path, before: base, after: next, deleted: next === undefined }];
}

function get(o, path) {
    for (const k of path) { if (!own(o, k)) return undefined; o = o[k]; }
    return o;
}

function set(o, path, value, deleted) {
    if (!path.length) return deleted ? {} : structuredClone(value);
    for (const k of path.slice(0, -1)) {
        if (!own(o, k) || !object(o[k])) Object.defineProperty(o, k, { value: {}, writable: true, enumerable: true, configurable: true });
        o = o[k];
    }
    const k = path.at(-1);
    if (deleted) delete o[k];
    else Object.defineProperty(o, k, { value: structuredClone(value), writable: true, enumerable: true, configurable: true });
}

export function mergeSettings(base, next, current, preferIncoming = false) {
    let result = structuredClone(current);
    const conflicts = [];
    for (const change of differences(base, next)) {
        const existing = get(current, change.path);
        const conflict = !same(existing, change.before) && !same(existing, change.after);
        if (conflict) conflicts.push({ path: change.path, current: existing, incoming: change.after, deleted: change.deleted });
        if (!conflict || preferIncoming) {
            if (change.path.length) set(result, change.path, change.after, change.deleted);
            else result = change.deleted ? {} : structuredClone(change.after);
        }
    }
    return { result, conflicts };
}

export function storageChanges(base, next) {
    return [...new Set([...Object.keys(base), ...Object.keys(next)])].filter(k => base[k] !== next[k]).map(key => ({
        key, before: base[key] ?? null, value: next[key] ?? null,
    }));
}

export function isMutation(path, method = 'POST') {
    return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && /\/(save|create|edit(?:-[a-z]+)?|delete|rename|import|duplicate|merge-attributes|upload|restore|update|set)(?:\/|$)/.test(path);
}
