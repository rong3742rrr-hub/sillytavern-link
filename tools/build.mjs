import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
for (const target of ['server', 'extension']) fs.copyFileSync(path.join(root, 'shared/model.mjs'), path.join(root, target, 'model.mjs'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ ...manifest, js: 'extension/index.js', css: 'extension/style.css' }, null, 2) + '\n');
console.log('SillyTavern Link: shared model and GitHub manifest built');
