import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

// Run only against the isolated local ST fixture while its server is running.
const directory = path.resolve(import.meta.dirname, 'runtime/SillyTavern-test/data/default-user/sillytavern-link');
const backups = path.join(directory, 'backups');
const stateHash = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, 'state.json'))).digest('hex');
const before = stateHash();
const expired = path.join(backups, '2020-01-01T00-00-00-000Z-device-before-sync-ddeeff11.json');
const fresh = path.join(backups, `${new Date().toISOString().replace(/[:.]/g, '-')}-device-before-sync-ddeeff11.json`);
fs.mkdirSync(backups, { recursive: true });
fs.writeFileSync(expired, '{}'); fs.writeFileSync(fresh, '{}');
const started = Date.now();
try {
    while (fs.existsSync(expired) && Date.now() - started < 70000) await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(fs.existsSync(expired), false, 'Running server did not expire the old backup');
    assert.equal(fs.existsSync(fresh), true); assert.equal(stateHash(), before);
    console.log(`PASS live server cleanup removed expired backup in ${Math.round((Date.now() - started) / 1000)} seconds; fresh backup and current state unchanged`);
} finally {
    for (const file of [expired, fresh]) if (fs.existsSync(file)) fs.unlinkSync(file);
}
