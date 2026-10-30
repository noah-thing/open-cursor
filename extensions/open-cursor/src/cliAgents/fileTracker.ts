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
import { readTextFile, runQuick, countLines, exists } from './util';

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

/** Gives `original` the line endings of `current` when git handed back LF and the working file is CRLF (core.autocrlf on Windows). */
export function matchEol(original: string | undefined, current: string | undefined): string | undefined {
	if (original === undefined || current === undefined || original.includes('\r') || !original.includes('\n')) {
		return original;
	}
	const crlf = (current.match(/\r\n/g) ?? []).length;
	const lf = (current.match(/\n/g) ?? []).length - crlf;
	return crlf > 0 && lf === 0 ? original.replace(/\n/g, '\r\n') : original;
}

let gitBin: { at: number; value: Promise<string | undefined> } | undefined;

/**
 * The git to use, or undefined when there is none that works. On a Mac without the Command Line Tools,
 * /usr/bin/git is a stub that opens an install dialog on every call, so it is never run until
 * `xcode-select -p` says the tools are there (or a Homebrew git exists). Cached; a miss is rechecked after a minute.
 */
export function usableGit(env: NodeJS.ProcessEnv): Promise<string | undefined> {
	if (gitBin && (Date.now() - gitBin.at < 60_000 || process.platform !== 'darwin')) {
		return gitBin.value;
	}
	const value = (async () => {
		if (process.platform !== 'darwin') {
			return 'git';
		}
		const xc = await runQuick('xcode-select', ['-p'], { env, timeoutMs: 4000 });
		if (xc && xc.code === 0) {
			return 'git';
		}
		return ['/opt/homebrew/bin/git', '/usr/local/bin/git'].find(exists);
	})();
	gitBin = { at: Date.now(), value };
	return value;
}

export function resetUsableGit(): void {
	gitBin = undefined;
}

/** What the tracker needs from either implementation. */
export interface FileScanner {
	scan(): Promise<ChangedFile[]>;
}

/** Git when the folder is a repository and git works, else the plain file watcher. */
export async function createFileTracker(cwd: string, env: NodeJS.ProcessEnv): Promise<FileScanner | undefined> {
	const git = await GitTracker.create(cwd, env).catch(() => undefined);
	return git ?? FsTracker.create(cwd);
}

export class GitTracker {
	private readonly baseline = new Map<string, string | undefined>(); // abs -> original content at turn start (undefined = absent/unreadable)
	private readonly skipped = new Set<string>();
	private readonly lastSeen = new Map<string, string | undefined>();
	private readonly reported = new Set<string>();
	private chain: Promise<unknown> = Promise.resolve();

	private constructor(private readonly root: string, private readonly env: NodeJS.ProcessEnv, private readonly git: string) {}

	static async create(cwd: string, env: NodeJS.ProcessEnv): Promise<GitTracker | undefined> {
		const git = await usableGit(env);
		if (!git) {
			return undefined;
		}
		const top = await runQuick(git, ['rev-parse', '--show-toplevel'], { cwd, env, timeoutMs: 5000 });
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
		const t = new GitTracker(root, env, git);
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
		const r = await runQuick(this.git, ['status', '--porcelain=v1', '-z', '-uall'], { cwd: this.root, env: this.env, timeoutMs: 20_000 });
		if (!r || r.code !== 0) {
			return undefined;
		}
		return parseStatusZ(r.stdout);
	}

	private async headContent(abs: string): Promise<string | undefined> {
		const rel = path.relative(this.root, abs).split(path.sep).join('/');
		// --filters gives the file as it would be checked out (autocrlf, .gitattributes eol), so line endings match the working copy
		const f = await runQuick(this.git, ['cat-file', '--filters', `HEAD:${rel}`], { cwd: this.root, env: this.env, timeoutMs: 8000 });
		if (f && f.code === 0) {
			return f.stdout;
		}
		const r = await runQuick(this.git, ['show', `HEAD:${rel}`], { cwd: this.root, env: this.env, timeoutMs: 8000 });
		if (!r || r.code !== 0) {
			return undefined;
		}
		const now = readTextFile(abs);
		return matchEol(r.stdout, now === 'skip' ? undefined : now);
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

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.cache', '.Trash', 'Library', '.npm', '.cargo', '.gradle', 'target']);
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_WALK_MS = 3000;

interface FileStamp { readonly mtimeMs: number; readonly size: number }

/**
 * Change detection for folders git cannot cover (the scratch chat folder, no git installed). Remembers
 * size, mtime and content of the small text files below the folder when the turn starts, and diffs
 * against them on every scan. The walk is bounded: skips dependency folders and big files, and stops
 * at a file count and time limit so a huge folder never stalls a turn.
 */
export class FsTracker implements FileScanner {
	private readonly stamps = new Map<string, FileStamp>();
	private readonly baseline = new Map<string, string | undefined>(); // abs -> content at turn start (undefined = absent)
	private readonly lastSeen = new Map<string, string | undefined>();
	private readonly reported = new Set<string>();
	private readonly unreadable = new Set<string>();
	private readonly startedAt = Date.now();
	private total = 0;
	private chain: Promise<unknown> = Promise.resolve();

	private constructor(private readonly root: string) {}

	static create(cwd: string): FsTracker | undefined {
		try {
			if (!fs.statSync(cwd).isDirectory()) {
				return undefined;
			}
		} catch {
			return undefined;
		}
		const t = new FsTracker(cwd);
		for (const [abs, st] of t.walk()) {
			t.stamps.set(abs, st);
			const text = st.size <= MAX_FILE_BYTES && t.total + st.size <= MAX_TOTAL_BYTES ? readTextFile(abs, MAX_FILE_BYTES) : 'skip';
			if (text !== 'skip' && text !== undefined) {
				t.total += st.size;
				t.baseline.set(abs, text);
				t.lastSeen.set(abs, text);
			} else {
				t.unreadable.add(abs);
			}
		}
		return t;
	}

	private walk(): Map<string, FileStamp> {
		const out = new Map<string, FileStamp>();
		const deadline = Date.now() + MAX_WALK_MS;
		const stack = [this.root];
		while (stack.length && out.size < MAX_FILES && Date.now() < deadline) {
			const dir = stack.pop()!;
			let names: fs.Dirent[];
			try {
				names = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const d of names) {
				const abs = path.join(dir, d.name);
				if (d.isDirectory()) {
					if (!SKIP_DIRS.has(d.name)) {
						stack.push(abs);
					}
				} else if (d.isFile()) {
					try {
						const st = fs.statSync(abs);
						out.set(abs, { mtimeMs: st.mtimeMs, size: st.size });
					} catch {
						/* gone */
					}
				}
			}
		}
		return out;
	}

	scan(): Promise<ChangedFile[]> {
		const run = this.chain.then(() => this.doScan());
		this.chain = run.catch(() => undefined);
		return run;
	}

	private doScan(): ChangedFile[] {
		const now = this.walk();
		const out: ChangedFile[] = [];
		const candidates = new Set<string>();
		for (const [abs, st] of now) {
			const was = this.stamps.get(abs);
			// a file the start-up walk never reached (the walk is capped) is only new if it was written during the turn
			if (was ? was.mtimeMs !== st.mtimeMs || was.size !== st.size : st.mtimeMs >= this.startedAt - 2000) {
				candidates.add(abs);
			}
		}
		for (const abs of this.stamps.keys()) {
			if (!now.has(abs)) {
				candidates.add(abs);
			}
		}
		for (const abs of candidates) {
			const st = now.get(abs);
			if (st) {
				this.stamps.set(abs, st);
			} else {
				this.stamps.delete(abs);
			}
			const current = st ? readTextFile(abs, MAX_FILE_BYTES) : undefined;
			if (current === 'skip') {
				continue;
			}
			// too big or binary at the start: no content to restore, so it must not look new
			if (this.unreadable.has(abs)) {
				continue;
			}
			const original = this.baseline.has(abs) ? this.baseline.get(abs) : undefined;
			const seen = this.lastSeen.has(abs) ? this.lastSeen.get(abs) : original;
			if (current === seen) {
				continue;
			}
			this.lastSeen.set(abs, current);
			const first = !this.reported.has(abs);
			this.reported.add(abs);
			const stat = diffStat(original, current);
			out.push({ absPath: abs, original, current, added: stat.added, removed: stat.removed, first });
		}
		return out;
	}
}
