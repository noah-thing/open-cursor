// Launches the dev build of Open Cursor under Playwright and runs a small scenario.
// Usage: node scripts/open-cursor/drive.mjs <scenario.mjs> [workspace]
// A scenario exports `default async ({ app, page, shot, sleep, keys }) => {}`.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));
const appDir = fs.readdirSync(path.join(root, '.build/electron')).find(f => f.endsWith('.app'));
const packaged = process.env.OC_APP; // path to a packaged "Open Cursor.app"
const exe = packaged ? path.join(packaged, 'Contents/MacOS/Open Cursor') : path.join(root, '.build/electron', appDir, 'Contents/MacOS', product.nameShort === 'Open Cursor' && fs.existsSync(path.join(root, '.build/electron', appDir, 'Contents/MacOS/Open Cursor')) ? 'Open Cursor' : appDir.replace(/\.app$/, ''));
const scenario = process.argv[2];
const workspace = process.argv[3] ?? path.join(os.homedir(), 'oc-playground');
const shotsDir = process.env.OC_SHOTS ?? path.join(os.homedir(), 'oc-shots');
const userData = process.env.OC_USER_DATA ?? path.join(os.homedir(), '.oc-test/user-data');
fs.mkdirSync(shotsDir, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const app = await electron.launch({
	executablePath: exe,
	args: [...(packaged ? [] : [root]), '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', `--user-data-dir=${userData}`, `--extensions-dir=${path.join(os.homedir(), '.oc-test/extensions')}`, workspace],
	env: { ...process.env, ...(packaged ? {} : { VSCODE_DEV: '1', VSCODE_SKIP_PRELAUNCH: '1' }), ...(process.env.OC_ENV ? JSON.parse(process.env.OC_ENV) : {}) },
	timeout: 60000,
});
const page = await app.firstWindow();
const logs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') { logs.push(`[${m.type()}] ${m.text()}`); } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => { const p = path.join(shotsDir, `${name}.png`); await page.screenshot({ path: p }); console.log('shot', p); return p; };
await page.waitForSelector('.monaco-workbench', { timeout: 60000 });
await sleep(2500);
try {
	const mod = scenario ? await import(pathToFileURL(path.resolve(scenario)).href) : { default: async () => shot('startup') };
	await mod.default({ app, page, shot, sleep, root, workspace });
} catch (e) {
	console.error('scenario failed:', e);
	await shot('failure').catch(() => {});
	process.exitCode = 1;
} finally {
	fs.writeFileSync(path.join(shotsDir, 'console.log'), logs.join('\n'));
	await app.close().catch(() => {});
}
