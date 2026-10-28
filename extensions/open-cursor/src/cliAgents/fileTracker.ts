/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Detects which files a CLI changed during a turn, for CLIs that cannot route edits through us
 *  (Codex, Gemini). Snapshot strategy: before the turn remember the content of every file that
 *  is already dirty in git; the original of any other file is `git show HEAD:<path>`. After each
 *  tool call we re-scan `git status` and diff against what we saw last. No vscode import.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { diffLines } from 'diff';
import { readTextFile, runQuick, countLines } from './util';

export interface ChangedFile {
	readonly absPath: string;
	/** Content before the turn; undefined = file did not exist. */
	readonly original: string | undefined;
	/** Content now; undefined = deleted. */
	readonly current: string | undefined;
	readonly added: number;
	readonly removed: number;
	/** True the first time this file is reported in the turn. */
	readonly first: boolean;
}

interface StatusEntry {
	readonly rel: string;
	readonly xy: string;
}

export function parseStatusZ(out: string): StatusEntry[] {
	const entries: StatusEntry[] = [];
	const parts = out.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p.length < 4) {
			continue;
		}
		const xy = p.slice(0, 2);
		entries.push({ xy, rel: p.slice(3) });
		if (xy[0] === 'R' || xy[0] === 'C') {
			i++; // the next field is the rename source
			const src = parts[i];
			if (src) {
				entries.push({ xy: ' D', rel: src });
			}
		}
	}
	return entries;
}

export function diffStat(a: string | undefined, b: string | undefined): { added: number; removed: number } {
	if (a === undefined) {
		return { added: countLines(b ?? ''), removed: 0 };
	}
	if (b === undefined) {
		return { added: 0, removed: countLines(a) };
	}
	let added = 0;
	let removed = 0;
	for (const part of diffLines(a, b)) {
		if (part.added) {
			added += part.count ?? 0;
		} else if (part.removed) {
			removed += part.count ?? 0;
		}
	}
	return { added, removed };
}

export class GitTracker {
	private readonly baseline = new Map<string, string | undefined>(); // abs -> original content at turn start (undefined = absent/unreadable)
	private readonly skipped = new Set<string>();
	private readonly lastSeen = new Map<string, string | undefined>();
	private readonly reported = new Set<string>();
	private chain: Promise<unknown> = Promise.resolve();

	private constructor(private readonly root: string, private readonly env: NodeJS.ProcessEnv) {}

	static async create(cwd: string, env: NodeJS.ProcessEnv): Promise<GitTracker | undefined> {
		const top = await runQuick('git', ['rev-parse', '--show-toplevel'], { cwd, env, timeoutMs: 5000 });
		if (!top || top.code !== 0 || !top.stdout.trim()) {
			return undefined;
		}
		// Report paths in the same spelling as the workspace folder (macOS /var vs /private/var).
		let root = top.stdout.trim();
		try {
			const rel = path.relative(fs.realpathSync(cwd), fs.realpathSync(root));
			root = path.resolve(cwd, rel);
		} catch {
			/* keep git's spelling */
		}
		const t = new GitTracker(root, env);
		const entries = await t.status();
		if (!entries) {
			return undefined;
		}
		for (const e of entries) {
			const abs = path.join(t.root, e.rel);
			const text = readTextFile(abs);
			if (text === 'skip') {
				t.skipped.add(abs);
			} else {
				t.baseline.set(abs, text);
				t.lastSeen.set(abs, text);
			}
		}
		return t;
	}

	private async status(): Promise<StatusEntry[] | undefined> {
		const r = await runQuick('git', ['status', '--porcelain=v1', '-z', '-uall'], { cwd: this.root, env: this.env, timeoutMs: 20_000 });
		if (!r || r.code !== 0) {
			return undefined;
		}
		return parseStatusZ(r.stdout);
	}

	private async headContent(abs: string): Promise<string | undefined> {
		const rel = path.relative(this.root, abs).split(path.sep).join('/');
		const r = await runQuick('git', ['show', `HEAD:${rel}`], { cwd: this.root, env: this.env, timeoutMs: 8000 });
		if (!r || r.code !== 0) {
			return undefined;
		}
		return r.stdout;
	}

	/** Returns files that changed since the previous scan. Calls are serialised. */
	scan(): Promise<ChangedFile[]> {
		const run = this.chain.then(() => this.doScan());
		this.chain = run.catch(() => undefined);
		return run;
	}

	private async doScan(): Promise<ChangedFile[]> {
		const entries = await this.status();
		if (!entries) {
			return [];
		}
		const candidates = new Set<string>([...this.baseline.keys(), ...this.reported]);
		for (const e of entries) {
			candidates.add(path.join(this.root, e.rel));
		}
		const out: ChangedFile[] = [];
		for (const abs of candidates) {
			if (this.skipped.has(abs)) {
				continue;
			}
			const current = readTextFile(abs);
			if (current === 'skip') {
				this.skipped.add(abs);
				continue;
			}
			let original: string | undefined;
			if (this.baseline.has(abs)) {
				original = this.baseline.get(abs);
			} else if (this.reported.has(abs)) {
				original = this.originals.get(abs);
			} else {
				const entry = entries.find(e => path.join(this.root, e.rel) === abs);
				original = entry && (entry.xy === '??' || entry.xy[0] === 'A') ? undefined : await this.headContent(abs);
				this.originals.set(abs, original);
			}
			const seen = this.lastSeen.has(abs) ? this.lastSeen.get(abs) : original;
			if (current === seen) {
				continue;
			}
			this.lastSeen.set(abs, current);
			const first = !this.reported.has(abs);
			this.reported.add(abs);
			const st = diffStat(original, current);
			out.push({ absPath: abs, original, current, added: st.added, removed: st.removed, first });
		}
		return out;
	}

	private readonly originals = new Map<string, string | undefined>();
}
