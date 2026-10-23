import fs from 'node:fs';
import path from 'node:path';

export const BACKUP_TTL = 24 * 60 * 60 * 1000;
export const CLEANUP_INTERVAL = 60 * 1000;
const backupName = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(computer-initial|device-before-sync|storage-conflict|settings-conflict|blocked-save)-[a-f0-9]{8}\.json$/;

export function isBackupName(name) { return backupName.test(name); }

// Only our own timestamped backup files are eligible. Never follow directory links.
export function pruneBackups(directory, now = Date.now()) {
    let removed = 0;
    const cutoff = now - BACKUP_TTL;
    try {
        if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) return 0;
        const backups = path.join(directory, 'backups');
        if (fs.existsSync(backups) && !fs.lstatSync(backups).isSymbolicLink()) {
            for (const item of fs.readdirSync(backups, { withFileTypes: true })) {
                const match = item.name.match(backupName);
                if (!item.isFile() || !match) continue;
                const created = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
                if (created <= cutoff) {
                    try { fs.unlinkSync(path.join(backups, item.name)); removed++; } catch { /* Retry on the next sweep. */ }
                }
            }
        }
        const previous = path.join(directory, 'settings-previous.json');
        if (fs.existsSync(previous)) {
            const stat = fs.lstatSync(previous);
            if (stat.isFile() && stat.mtimeMs <= cutoff) { fs.unlinkSync(previous); removed++; }
        }
    } catch { /* A locked backup must not stop chat or synchronization. */ }
    return removed;
}
