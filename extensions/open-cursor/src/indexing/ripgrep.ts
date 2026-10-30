/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { keywordsOf, rankHits, type KeywordHit } from './keywords';

// secrets and heavy dirs never reach the search results
// Exact secret names only: wide globs hid real source (credentials.ts, secrets.go, .env.d.ts).
// Build output is left to .gitignore, which ripgrep honours.
const EXCLUDE_GLOBS = [
	'.env', '.env.local', '.env.*.local', '.env.development', '.env.production', '.env.test',
	'*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
	'credentials', 'credentials.json', 'credentials.yml', 'secrets.json', 'secrets.yml', 'secrets.yaml', 'secrets.toml', 'service-account*.json',
	'node_modules', '.git', '.venv', '__pycache__',
];

export function findRipgrep(): string | undefined {
	const tail = path.join('@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
	for (const mod of ['node_modules', 'node_modules.asar.unpacked']) {
		const p = path.join(vscode.env.appRoot, mod, tail);
		if (fs.existsSync(p)) { return p; }
	}
	return undefined;
}

export async function keywordSearch(query: string, folders: readonly vscode.WorkspaceFolder[], opts: { limit: number; includeGlob?: string; signal: AbortSignal }): Promise<KeywordHit[]> {
	const rg = findRipgrep();
	const kws = keywordsOf(query);
	if (!rg || !kws.length || !folders.length) { return []; }
	const perFile = new Map<string, { line: number; kws: Set<string> }[]>();
	for (const folder of folders) {
		const args = ['--line-number', '--no-heading', '--with-filename', '--ignore-case', '--fixed-strings', '--max-columns', '300', '--max-count', '30', '--max-filesize', '300K', '--color', 'never', '--no-require-git'];
		for (const g of EXCLUDE_GLOBS) { args.push('--glob', '!' + g); }
		for (const k of kws) { args.push('-e', k); }
		for (const name of ['.cursorignore', '.open-cursorignore']) {
			const f = path.join(folder.uri.fsPath, name);
			if (fs.existsSync(f)) { args.push('--ignore-file', f); }
		}
		if (opts.includeGlob) { args.push('--glob', opts.includeGlob); }
		args.push('--', '.');
		await new Promise<void>(resolve => {
			const child = spawn(rg, args, { cwd: folder.uri.fsPath, stdio: ['ignore', 'pipe', 'ignore'] });
			const onAbort = () => child.kill();
			if (opts.signal.aborted) { child.kill(); }
			opts.signal.addEventListener('abort', onAbort, { once: true });
			let buf = '';
			const eat = (final: boolean) => {
				const lines = buf.split('\n');
				buf = final ? '' : lines.pop() ?? '';
				for (const l of lines) {
					const m = /^(.+?):(\d+):(.*)$/.exec(l);
					if (!m) { continue; }
					const file = path.join(folder.uri.fsPath, m[1]);
					const text = m[3].toLowerCase();
					const hit = new Set(kws.filter(k => text.includes(k)));
					let arr = perFile.get(file);
					if (!arr) { arr = []; perFile.set(file, arr); }
					arr.push({ line: Number(m[2]) - 1, kws: hit });
				}
			};
			child.stdout.on('data', d => { buf += d.toString('utf8'); eat(false); if (perFile.size > 5000) { child.kill(); } });
			child.on('close', () => { eat(true); opts.signal.removeEventListener('abort', onAbort); resolve(); });
			child.on('error', () => resolve());
		});
	}
	return rankHits(perFile, kws.length, opts.limit);
}
