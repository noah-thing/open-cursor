/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Keyword search fallback over the bundled ripgrep, used when no embedding backend exists.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { keywordsOf, rankHits, type KeywordHit } from './keywords';

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
		const args = ['--line-number', '--no-heading', '--with-filename', '--ignore-case', '--fixed-strings', '--max-columns', '300', '--max-count', '30', '--max-filesize', '300K', '--color', 'never'];
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
