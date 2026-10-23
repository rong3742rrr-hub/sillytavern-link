import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') throw new Error('The installer regression suite requires Windows PowerShell and Git.');
const source = path.resolve(import.meta.dirname, '..');
const runtime = path.join(source, 'tests/runtime');
fs.mkdirSync(runtime, { recursive: true });
const sandbox = fs.mkdtempSync(path.join(runtime, 'install-check-'));
const originalHtml = '<html><script type="module" src="scripts/i18n.js"></script>\n<script type="module" src="script.js"></script></html>';
const entry = 'scripts/extensions/third-party/sillytavern-link/boot.js';
const extensionPath = 'public/scripts/extensions/third-party/sillytavern-link';
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
function command(exe, args, cwd = sandbox, expected = 0) {
    const result = spawnSync(exe, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    if (result.error) throw result.error;
    if (expected === 0) assert.equal(result.status, 0, `${exe} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    else assert.notEqual(result.status, 0, 'Expected setup to refuse without changing host files');
    return `${result.stdout}${result.stderr}`;
}
function git(cwd, ...args) { return command('git', args, cwd).trim(); }
function commit(cwd, message) {
    git(cwd, 'add', '--all');
    git(cwd, '-c', 'user.name=Link installer test', '-c', 'user.email=installer-test@example.invalid', 'commit', '-qm', message);
}
function setup(packagePath, host, expected = 0, uninstall = false) {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(packagePath, uninstall ? 'uninstall.ps1' : 'install.ps1')];
    if (host) args.push('-SillyTavernPath', host);
    return command('powershell.exe', args, sandbox, expected);
}
function copyPackage(target) {
    fs.mkdirSync(target, { recursive: true });
    for (const folder of ['extension', 'server', 'shared', 'tools']) fs.cpSync(path.join(source, folder), path.join(target, folder), { recursive: true });
    for (const file of ['manifest.json', 'boot.js', '.gitignore', 'install.ps1', 'uninstall.ps1', 'Install.cmd', 'Uninstall.cmd', 'package.json', 'package-lock.json', 'README.md', 'TESTED.md', 'LICENSE']) fs.copyFileSync(path.join(source, file), path.join(target, file));
}
function host(name, config = 'enableServerPlugins: false # keep this comment\r\n', version = '1.19.0') {
    const root = path.join(sandbox, name);
    fs.mkdirSync(path.join(root, 'public'), { recursive: true });
    fs.writeFileSync(path.join(root, 'server.js'), '// isolated installer fixture\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
    fs.writeFileSync(path.join(root, 'public/index.html'), originalHtml);
    fs.writeFileSync(path.join(root, 'config.yaml'), config);
    const data = path.join(root, 'data/default-user/sillytavern-link');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'state.json'), '{"existing":"preserve this baseline"}\n');
    return root;
}
function checkInstalled(root, packagePath, repository) {
    const target = path.join(root, extensionPath);
    assert.equal(json(path.join(target, 'manifest.json')).js, repository ? 'extension/index.js' : 'index.js');
    assert.equal(read(path.join(root, 'public/index.html')).split(entry).length - 1, 1);
    assert.match(read(path.join(root, 'config.yaml')), /enableServerPlugins: true # keep this comment/);
    for (const file of fs.readdirSync(path.join(packagePath, 'server'))) assert.equal(read(path.join(root, 'plugins/sillytavern-link', file)), read(path.join(packagePath, 'server', file)));
    assert.equal(read(path.join(root, 'data/default-user/sillytavern-link/state.json')), '{"existing":"preserve this baseline"}\n');
}

// Exercise a real clone + pull, then setup inside the clone without dirtying it.
const origin = path.join(sandbox, 'published-repository');
copyPackage(origin); git(origin, 'init', '-q', '-b', 'main'); commit(origin, 'Synthetic initial release');
const root = host('GitHub install with spaces');
const installed = path.join(root, extensionPath);
fs.mkdirSync(path.dirname(installed), { recursive: true });
git(sandbox, 'clone', '-q', origin, installed);
assert.match(setup(installed), /Installed SillyTavern Link 1\.0\.2/);
checkInstalled(root, installed, true); assert.equal(git(installed, 'status', '--porcelain'), '');
const firstBackup = fs.readdirSync(path.join(root, 'backups'))[0];
assert.equal(read(path.join(root, 'backups', firstBackup, 'index.html')), originalHtml);
console.log('PASS cloned GitHub layout: auto-detected host, clean Git tree, original files backed up, existing baseline retained');

fs.appendFileSync(path.join(origin, 'server/index.mjs'), '\n// Synthetic update for the installer regression.\n');
commit(origin, 'Synthetic update'); git(installed, 'pull', '--ff-only', '-q');
setup(installed); checkInstalled(root, installed, true); assert.equal(git(installed, 'status', '--porcelain'), '');
console.log('PASS git pull + setup updates the server component without changing tracked files');

const countBefore = fs.readdirSync(path.join(root, 'backups')).length;
assert.match(setup(source, root, 1), /Git-managed extension already exists/);
assert.equal(fs.readdirSync(path.join(root, 'backups')).length, countBefore);
assert.equal(git(installed, 'status', '--porcelain'), '');
console.log('PASS standalone installer refuses to overwrite a Git-managed extension');

for (const [name, config, version] of [['invalid-config', '# missing setting\n', '1.19.0'], ['unsupported-version', 'enableServerPlugins: false\n', '1.18.0']]) {
    const target = host(name, config, version);
    setup(source, target, 1);
    assert.equal(read(path.join(target, 'public/index.html')), originalHtml);
    assert.equal(read(path.join(target, 'config.yaml')), config);
    assert.equal(fs.existsSync(path.join(target, 'backups')), false);
    assert.equal(fs.existsSync(path.join(target, 'plugins')), false);
}
console.log('PASS unsupported hosts/configuration rejected before mutation');

const perUserHost = host('per-user');
const perUser = path.join(perUserHost, 'data/default-user/extensions/sillytavern-link');
copyPackage(perUser); assert.match(setup(perUser, undefined, 1), /Per-user extension installs are not supported/);
assert.equal(fs.existsSync(path.join(perUserHost, 'backups')), false);
console.log('PASS per-user installation refused with all-users guidance');

const standalone = host('standalone');
setup(source, standalone); checkInstalled(standalone, source, false);
console.log('PASS standalone ZIP mode retains the original flat extension layout');

const result = setup(installed, undefined, 0, true);
assert.match(result, /Uninstalled/);
assert.equal(read(path.join(root, 'public/index.html')), originalHtml);
assert.equal(fs.existsSync(installed), false);
assert.equal(fs.existsSync(path.join(root, 'plugins/sillytavern-link')), false);
assert.equal(read(path.join(root, 'data/default-user/sillytavern-link/state.json')), '{"existing":"preserve this baseline"}\n');
const removed = fs.readdirSync(path.join(root, 'backups')).find(name => name.startsWith('sillytavern-link-uninstall-'));
assert.ok(fs.existsSync(path.join(root, 'backups', removed, 'extension/.git')));
assert.ok(fs.existsSync(path.join(root, 'backups', removed, 'server/index.mjs')));
console.log('PASS repository-local uninstall restores startup, preserves baseline and moves code into a recoverable backup');
console.log(`INSTALLER CHECKS PASSED; isolated evidence: ${sandbox}`);
