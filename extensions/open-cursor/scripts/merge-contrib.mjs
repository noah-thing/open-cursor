// Merges contrib/*.json into package.json "contributes". Run: node scripts/merge-contrib.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const out = { commands: [], keybindings: [], menus: {}, viewsContainers: {}, views: {}, configuration: [] };
for (const file of fs.readdirSync(path.join(root, 'contrib')).filter(f => f.endsWith('.json')).sort()) {
	const c = JSON.parse(fs.readFileSync(path.join(root, 'contrib', file), 'utf8'));
	out.commands.push(...(c.commands ?? []));
	out.keybindings.push(...(c.keybindings ?? []));
	if (c.configuration) { out.configuration.push(c.configuration); }
	for (const key of ['menus', 'viewsContainers', 'views']) {
		for (const [k, v] of Object.entries(c[key] ?? {})) {
			out[key][k] = [...(out[key][k] ?? []), ...v];
		}
	}
	for (const [k, v] of Object.entries(c)) {
		if (!(k in out)) { out[k] = v; }
	}
}
for (const k of Object.keys(out)) {
	const v = out[k];
	if ((Array.isArray(v) && !v.length) || (!Array.isArray(v) && typeof v === 'object' && !Object.keys(v).length)) { delete out[k]; }
}
pkg.contributes = out;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');
console.log('merged', Object.keys(out).join(', '));
