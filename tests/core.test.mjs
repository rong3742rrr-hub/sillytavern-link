import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { mergeSettings } from '../shared/model.mjs';
import { LinkStore } from '../server/store.mjs';
import { BACKUP_TTL, pruneBackups } from '../server/retention.mjs';

const PC = 'computer-device', PHONE = 'phone-device', A = 'computer-page', B = 'phone-page';
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stlink-test-'));
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ temperature: 1, extension_settings: { memory: { enabled: true } } }));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new LinkStore(root);
    store.initialize(PC, { 'ls|test': 'original' });
    store.requestSwitch(PC, A);
    return store;
}
test('three-way settings keeps unrelated changes, arrays stay atomic, deletions propagate', () => {
    const base = { a: 1, b: 1, remove: 4, list: [1,2] };
    const { result } = mergeSettings(base, { a: 2, b: 1, list: [2,1] }, { ...base, b: 3 });
    assert.deepEqual(result, { a: 2, b: 3, list: [2,1] });
});
test('conflict policy and prototype names do not pollute objects', () => {
    assert.equal(mergeSettings({ a: 1 }, { a: 2 }, { a: 3 }).result.a, 3);
    assert.equal(mergeSettings({ a: 1 }, { a: 2 }, { a: 3 }, true).result.a, 2);
    const next = JSON.parse('{"__proto__":{"polluted":true}}');
    const result = mergeSettings({}, next, {}).result;
    assert.equal({}.polluted, undefined); assert.equal(Object.hasOwn(result, '__proto__'), true);
});
test('phone waits for desktop flush; old desktop cannot write after handoff', t => {
    const s = fixture(t);
    assert.equal(s.requestSwitch(PHONE, B).granted, false);
    s.patch(PC, s.state.epoch, [{ key:'ls|test', before:'original', value:'pc-new' }], A);
    assert.equal(s.handoff(PC, A, true).handedOff, false);
    assert.equal(s.handoff(PC, A).handedOff, true);
    assert.throws(() => s.patch(PC, s.state.epoch, [{ key:'ls|test', before:'pc-new', value:'stale' }], A));
    s.patch(PHONE, s.state.epoch, [{ key:'ls|test', before:'pc-new', value:'phone-new' }], B);
    assert.equal(s.status().entries['ls|test'], 'phone-new');
    assert.throws(() => s.saveSettings(PC, {}, { x: 2 }, A));
});
test('offline page can be replaced; tombstones survive server restart', t => {
    const s = fixture(t); s.lastSeen = 0;
    assert.equal(s.requestSwitch(PHONE, B).granted, true);
    s.patch(PHONE, s.state.epoch, [{ key:'ls|test', before:'original', value:null }], B);
    const restored = new LinkStore(s.root);
    assert.equal(restored.status().entries['ls|test'], null);
    assert.equal(restored.state.active.device, PHONE);
});
test('invalid or duplicate patches never partially change the snapshot', t => {
    const s = fixture(t), before = JSON.stringify(s.state);
    assert.throws(() => s.patch(PC, s.state.epoch, [{ key:'ls|test', before:'original', value:'valid' }, { key:'../bad', before:null, value:'bad' }], A));
    assert.equal(JSON.stringify(s.state), before);
    assert.throws(() => s.patch(PC, s.state.epoch, [{ key:'ls|test', before:null, value:'a' },{ key:'ls|test', before:null, value:'b' }], A));
});
test('conflicting phone edits retained in recoverable backup', t => {
    const s = fixture(t); s.lastSeen = 0; s.requestSwitch(PHONE, B);
    const reply = s.patch(PHONE, s.state.epoch, [{ key:'ls|test', before:'old', value:'phone-conflict' }], B);
    assert.equal(s.status().entries['ls|test'], 'original');
    assert.equal(reply.conflicts.length, 1);
    const backup = JSON.parse(fs.readFileSync(path.join(s.directory, 'backups', reply.backup)));
    assert.equal(backup.data.conflicts[0].incoming, 'phone-conflict');
});
test('failed persistence does not acknowledge the new in-memory state', t => {
    const s = fixture(t), before = JSON.stringify(s.state);
    s.file = path.join(s.root, 'settings.json', 'cannot-write.json');
    assert.throws(() => s.patch(PC, s.state.epoch, [{ key:'ls|test', before:'original', value:'new' }], A));
    assert.equal(JSON.stringify(s.state), before);
});
test('corrupt existing state fails closed rather than initializing empty', t => {
    const s = fixture(t); fs.writeFileSync(s.file, '{broken');
    assert.throws(() => new LinkStore(s.root));
});
test('settings merge saves actual file and keeps prior version', t => {
    const s = fixture(t), base = s.readSettings();
    s.saveSettings(PC, base, { ...base, temperature: 0.7 }, A);
    assert.equal(s.readSettings().temperature, 0.7);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.directory, 'settings-previous.json'))).temperature, 1);
});
test('user roots remain separate and resource guards detect unseen remote writes', t => {
    const a = fixture(t), b = fixture(t);
    a.patch(PC, a.state.epoch, [{key:'ls|test',before:'original',value:'user-a'}], A);
    assert.equal(b.status().entries['ls|test'],'original');
    a.resourceChanged(PC,'chats/save');
    assert.equal(a.foreignChanges(PC,0,a.session),false);
    assert.equal(a.foreignChanges(PHONE,0,a.session),true);
    assert.equal(a.foreignChanges(PC,0,'old-session'),true);
});
test('compact hash baselines preserve offline edits and detect remote conflicts', t => {
    const s = fixture(t);
    const digest = text => crypto.createHash('sha256').update(text).digest('hex');
    s.patch(PC, s.state.epoch, [{ key: 'ls|test', beforeHash: digest('original'), value: 'offline' }], A);
    assert.equal(s.status().entries['ls|test'], 'offline');
    s.lastSeen = 0; s.requestSwitch(PHONE, B);
    const conflict = s.patch(PHONE, s.state.epoch, [{ key: 'ls|test', beforeHash: digest('original'), value: 'phone-stale' }], B);
    assert.equal(conflict.conflicts.length, 1); assert.equal(s.status().entries['ls|test'], 'offline');
    s.patch(PHONE, s.state.epoch, [{ key: 'ls|new', beforeHash: null, value: 'new' }, { key: 'ls|test', beforeHash: digest('offline'), value: null }], B);
    assert.equal(s.status().entries['ls|test'], null); assert.equal(s.status().entries['ls|new'], 'new');
    assert.throws(() => s.patch(PHONE, s.state.epoch, [{ key: 'ls|new', beforeHash: 'bad', value: 'bad' }], B));
});
test('paged downloads preserve oversized records and enforce snapshot identity and active device', t => {
    const s = fixture(t);
    const big = '大记录'.repeat(3000);
    s.patch(PC, s.state.epoch, [{ key: 'ls|big', before: null, value: big }, { key: 'ls|end', before: null, value: 'last' }], A);
    const result = {}; let cursor = 0, pages = 0;
    do {
        const page = s.snapshotPage(PC, A, s.state.epoch, s.state.revision, cursor, 1024);
        Object.assign(result, page.entries); cursor = page.next; pages++;
    } while (cursor !== null);
    assert.ok(pages >= 3); assert.deepEqual(result, s.status().entries);
    assert.throws(() => s.snapshotPage(PHONE, B, s.state.epoch, s.state.revision));
    assert.throws(() => s.snapshotPage(PC, A, s.state.epoch, s.state.revision - 1));
    assert.throws(() => s.snapshotPage(PC, A, s.state.epoch, s.state.revision, -1));
    assert.deepEqual(s.requestSwitch(PC, A, false, false).entries, {});
});
test('backups expire at 24 hours; live state, fresh backups and unrelated files survive', t => {
    const s = fixture(t), now = Date.now(), dir = path.join(s.directory, 'backups');
    const nameAt = (time, label) => `${new Date(time).toISOString().replace(/[:.]/g, '-')}-${label}-aabbccdd.json`;
    const old = nameAt(now - BACKUP_TTL - 1, 'device-before-sync');
    const exact = nameAt(now - BACKUP_TTL, 'storage-conflict');
    const fresh = nameAt(now - BACKUP_TTL + 1000, 'computer-initial');
    const future = nameAt(now + BACKUP_TTL, 'blocked-save');
    for (const name of [old, exact, fresh, future, 'my-private-backup.json']) fs.writeFileSync(path.join(dir, name), '{}');
    const previous = path.join(s.directory, 'settings-previous.json');
    fs.writeFileSync(previous, '{}'); const aged = new Date(now - BACKUP_TTL - 1000); fs.utimesSync(previous, aged, aged);
    assert.equal(pruneBackups(s.directory, now), 3);
    for (const name of [old, exact]) assert.equal(fs.existsSync(path.join(dir, name)), false);
    for (const name of [fresh, future, 'my-private-backup.json']) assert.equal(fs.existsSync(path.join(dir, name)), true);
    assert.equal(fs.existsSync(s.file), true); assert.equal(s.readSettings().temperature, 1);
    assert.equal(fs.existsSync(previous), false);
});
