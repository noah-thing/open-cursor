/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Semantic codebase index with a ripgrep keyword fallback. Result line numbers are 1-based inclusive.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import type { ICodebaseIndex, IProviderRegistry } from '../services';
import { chunkText } from './chunker';
import { isSecretFile, makeNestedIgnore } from './ignore';
import { VectorStore } from './vectorStore';
import { resolveEmbedder, type Embedder } from './embed';
import { keywordSearch } from './ripgrep';

type Status = ReturnType<ICodebaseIndex['getStatus']>;
type SearchResult = Awaited<ReturnType<ICodebaseIndex['search']>>[number];

const MAX_FILE_BYTES = 300 * 1024;
const MAX_FILES = 20_000;
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.gradle', 'Pods', '.idea', '.turbo', '.svelte-kit'];
const SKIP_DIR_RE = new RegExp(`(^|/)(${SKIP_DIRS.map(d => d.replace(/\./g, '\\.')).join('|')})(/|$)`);
const EXCLUDE_GLOB = `**/{${SKIP_DIRS.join(',')}}/**`;
const BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'svgz', 'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'war', 'class', 'o', 'a', 'so', 'dylib', 'dll', 'exe', 'bin', 'wasm', 'node', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'ogg', 'webm', 'psd', 'ai', 'sketch', 'fig', 'dmg', 'iso', 'pyc', 'sqlite', 'db', 'lock', 'map', 'glb', 'gltf', 'obj', 'fbx', 'usdz', 'ds_store']);
const SKIP_NAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'poetry.lock']);

interface FolderIgnore {
	root: string;
	ignored: (rel: string) => boolean;
}

export function createCodebaseIndex(ctx: vscode.ExtensionContext, registry: IProviderRegistry): ICodebaseIndex {
	void registry; // keys are read from ctx.secrets with the provider key convention, see embed.ts
	const onDidChange = new vscode.EventEmitter<void>();
	const store = new VectorStore();
	const dir = ctx.storageUri ? path.join(ctx.storageUri.fsPath, 'index') : undefined;

	let state: Status['state'] = 'idle';
	let error: string | undefined;
	let progress: number | undefined;
	let embedder: Embedder | undefined;
	let embedderResolved = false;
	let abort: AbortController | undefined;
	let running: Promise<void> | undefined;
	let loaded: Promise<void> | undefined;
	let disposed = false;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;

	const cfg = () => vscode.workspace.getConfiguration('openCursor.index');
	const enabled = () => cfg().get<boolean>('enabled', true);
	const fire = () => onDidChange.fire();

	/** Every .gitignore, .cursorignore and .open-cursorignore in each folder, at any depth. */
	async function loadIgnores(): Promise<FolderIgnore[]> {
		return Promise.all((vscode.workspace.workspaceFolders ?? []).map(async f => {
			const found = await vscode.workspace.findFiles(new vscode.RelativePattern(f, '**/{.gitignore,.cursorignore,.open-cursorignore}'), EXCLUDE_GLOB, 2000);
			const files = found.map(u => {
				let text = '';
				try { text = fs.readFileSync(u.fsPath, 'utf8'); } catch { /* gone */ }
				return { dir: path.relative(f.uri.fsPath, path.dirname(u.fsPath)).split(path.sep).join('/'), text };
			});
			return { root: f.uri.fsPath, ignored: makeNestedIgnore(files) };
		}));
	}

	function acceptable(fsPath: string, ignores: FolderIgnore[]): boolean {
		const folder = ignores.find(i => fsPath === i.root || fsPath.startsWith(i.root + path.sep));
		if (!folder) { return false; }
		const rel = path.relative(folder.root, fsPath).split(path.sep).join('/');
		const base = path.basename(fsPath);
		const ext = path.extname(base).slice(1).toLowerCase();
		if (SKIP_DIR_RE.test(rel) || BINARY_EXT.has(ext) || SKIP_NAMES.has(base) || /\.min\.(js|css)$/.test(base) || isSecretFile(rel)) { return false; }
		return !folder.ignored(rel);
	}

	async function listFiles(ignores: FolderIgnore[], signal: AbortSignal): Promise<string[]> {
		const out: string[] = [];
		const token = new vscode.CancellationTokenSource();
		signal.addEventListener('abort', () => token.cancel(), { once: true });
		try {
			for (const f of vscode.workspace.workspaceFolders ?? []) {
				const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(f, '**/*'), EXCLUDE_GLOB, MAX_FILES, token.token);
				for (const u of uris) {
					if (acceptable(u.fsPath, ignores)) { out.push(u.fsPath); }
				}
			}
		} finally {
			token.dispose();
		}
		return out;
	}

	interface Pending {
		key: string;
		sig: string;
		total: number;
		got: number;
		chunks: { startLine: number; endLine: number }[];
		vectors: Float32Array[];
	}
	interface Job { file: Pending; index: number; text: string }

	async function readIndexable(fsPath: string): Promise<{ text: string; sig: string } | undefined> {
		try {
			const st = await fs.promises.stat(fsPath);
			if (!st.isFile() || st.size > MAX_FILE_BYTES || st.size === 0) { return undefined; }
			const sig = `${Math.floor(st.mtimeMs)}:${st.size}`;
			return { text: '', sig };
		} catch {
			return undefined;
		}
	}

	async function indexFiles(files: string[], signal: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<void> {
		const emb = embedder;
		if (!emb || (!vscode.workspace.isTrusted && !emb.id.startsWith('ollama/'))) { return; }
		const keyOf = (p: string) => vscode.Uri.file(p).toString();
		const todo: { fsPath: string; key: string; sig: string }[] = [];
		for (const p of files) {
			const meta = await readIndexable(p);
			const key = keyOf(p);
			if (!meta) { store.delete(key); continue; }
			if (store.get(key)?.sig === meta.sig) { continue; }
			todo.push({ fsPath: p, key, sig: meta.sig });
		}
		if (!todo.length) { return; }

		let doneFiles = 0;
		let buffer: Job[] = [];
		const inflight = new Set<Promise<void>>();
		let failure: unknown;

		const finishFile = (f: Pending) => {
			const dim = f.vectors[0]?.length ?? 0;
			if (!dim) { return; }
			if (store.dim && store.dim !== dim) { throw new Error('Embedding dimension changed; rebuild the index.'); }
			store.dim = dim;
			const vectors = new Float32Array(f.chunks.length * dim);
			f.vectors.forEach((v, i) => vectors.set(v, i * dim));
			store.set({ key: f.key, sig: f.sig, chunks: f.chunks, vectors });
			doneFiles++;
			onProgress?.(doneFiles, todo.length);
			if (doneFiles % 200 === 0) { saveSoon(); }
		};

		const dispatch = async (jobs: Job[]) => {
			const vecs = await emb.embed(jobs.map(j => j.text), 'doc', signal);
			if (vecs.length !== jobs.length) { throw new Error('Embedding backend returned a wrong number of vectors'); }
			jobs.forEach((j, i) => {
				j.file.vectors[j.index] = vecs[i];
				if (++j.file.got === j.file.total) { finishFile(j.file); }
			});
		};

		const flush = async (force: boolean) => {
			while (buffer.length >= emb.batchSize || (force && buffer.length)) {
				const jobs = buffer.splice(0, emb.batchSize);
				while (inflight.size >= 2) { await Promise.race(inflight); }
				if (failure) { throw failure; }
				const p: Promise<void> = dispatch(jobs).catch(e => { failure ??= e; }).finally(() => { inflight.delete(p); });
				inflight.add(p);
			}
		};

		for (const t of todo) {
			if (signal.aborted) { throw new Error('aborted'); }
			if (failure) { throw failure; }
			let text: string;
			try {
				const buf = await fs.promises.readFile(t.fsPath);
				if (buf.subarray(0, 8000).includes(0)) { store.delete(t.key); continue; }
				text = buf.toString('utf8');
			} catch {
				store.delete(t.key);
				continue;
			}
			const chunks = chunkText(text);
			if (!chunks.length) { store.delete(t.key); continue; }
			const file: Pending = { key: t.key, sig: t.sig, total: chunks.length, got: 0, chunks: chunks.map(c => ({ startLine: c.startLine, endLine: c.endLine })), vectors: new Array(chunks.length) };
			chunks.forEach((c, i) => buffer.push({ file, index: i, text: `${path.basename(t.fsPath)}\n${c.text}` }));
			await flush(false);
		}
		await flush(true);
		await Promise.all(inflight);
		if (failure) { throw failure; }
	}

	async function ensureLoaded(): Promise<void> {
		loaded ??= (async () => {
			if (dir) { await store.load(dir); }
		})();
		return loaded;
	}

	// One time, per workspace: sending files to a cloud embedder needs a yes.
	async function cloudConsent(embedderId: string, setting: string): Promise<boolean> {
		const KEY = 'openCursor.index.cloudConsent';
		const MODEL_KEY = 'openCursor.index.cloudConsentSetting';
		const stored = ctx.workspaceState.get<boolean>(KEY);
		const askedFor = ctx.workspaceState.get<string>(MODEL_KEY);
		// asked again only when the user explicitly picks a different cloud model
		const changed = setting !== 'auto' && askedFor !== undefined && askedFor !== setting;
		if (stored !== undefined && !changed) { return stored; }
		const who = embedderId.startsWith('google/') ? 'Google' : 'OpenAI';
		const pick = await vscode.window.showInformationMessage(
			`Index this project for semantic search? Files that are not ignored (never secret files) are sent to ${who} to make embeddings. Without it, search uses plain text matching on this computer.`,
			'Allow', 'Not now');
		if (pick === undefined) { return false; } // dismissed: no answer stored, ask next time
		await ctx.workspaceState.update(KEY, pick === 'Allow');
		await ctx.workspaceState.update(MODEL_KEY, setting);
		return pick === 'Allow';
	}

	async function getEmbedder(refresh = false): Promise<Embedder | undefined> {
		if (!embedderResolved || refresh) {
			const setting = cfg().get<string>('embeddingModel', 'auto');
			embedder = await resolveEmbedder(ctx, setting);
			if (embedder && !embedder.id.startsWith('ollama/') && vscode.workspace.isTrusted && !(await cloudConsent(embedder.id, setting))) {
				embedder = undefined; // plain text search (ripgrep) takes over
			}
			embedderResolved = true;
		}
		// A folder that is not trusted never has its files sent to a cloud embedder; a local one is fine.
		return embedder && (vscode.workspace.isTrusted || embedder.id.startsWith('ollama/')) ? embedder : undefined;
	}

	function saveSoon(): void {
		if (!dir) { return; }
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => { void store.save(dir).catch(e => console.error('[open-cursor] index save failed', e)); }, 2000);
	}

	function scan(): Promise<void> {
		if (running) { return running; }
		if (!enabled() || !dir || !vscode.workspace.workspaceFolders?.length) {
			state = enabled() ? 'idle' : 'disabled';
			fire();
			return Promise.resolve();
		}
		const ac = new AbortController();
		abort = ac;
		running = (async () => {
			try {
				await ensureLoaded();
				const emb = await getEmbedder();
				if (!emb) { state = 'idle'; error = undefined; progress = undefined; fire(); return; }
				if (store.embedder !== emb.id) { store.clear(); store.embedder = emb.id; }
				state = 'indexing'; error = undefined; progress = 0; fire();
				const ignores = await loadIgnores();
				const files = await listFiles(ignores, ac.signal);
				const live = new Set(files.map(p => vscode.Uri.file(p).toString()));
				for (const k of store.keys()) { if (!live.has(k)) { store.delete(k); } }
				let lastFire = 0;
				await indexFiles(files, ac.signal, (done, total) => {
					progress = total ? done / total : 1;
					const now = Date.now();
					if (now - lastFire > 500) { lastFire = now; fire(); }
				});
				if (ac.signal.aborted) { return; }
				state = 'ready'; progress = undefined;
				if (dir) { await store.save(dir); }
			} catch (e) {
				if (ac.signal.aborted) { return; }
				state = 'error';
				error = e instanceof Error ? e.message : String(e);
				progress = undefined;
			} finally {
				if (abort === ac) { abort = undefined; }
				running = undefined;
				fire();
			}
		})();
		return running;
	}

	async function stopScan(): Promise<void> {
		abort?.abort();
		await running;
	}

	const dirty = new Set<string>();
	let dirtyTimer: ReturnType<typeof setTimeout> | undefined;
	function markDirty(uri: vscode.Uri): void {
		if (uri.scheme !== 'file' || !enabled() || state === 'disabled') { return; }
		dirty.add(uri.fsPath);
		clearTimeout(dirtyTimer);
		dirtyTimer = setTimeout(() => void flushDirty(), 1500);
	}
	async function flushDirty(): Promise<void> {
		if (!dirty.size || running || !embedder || !store.chunkCount && state !== 'ready') { dirty.clear(); return; }
		const paths = [...dirty];
		dirty.clear();
		const ignores = await loadIgnores();
		const keep: string[] = [];
		for (const p of paths) {
			if (acceptable(p, ignores)) { keep.push(p); } else { store.delete(vscode.Uri.file(p).toString()); }
		}
		const ac = new AbortController();
		try {
			await indexFiles(keep, ac.signal);
			saveSoon();
		} catch (e) {
			console.error('[open-cursor] incremental index failed', e);
		}
		fire();
	}

	async function readLines(cache: Map<string, string[] | undefined>, fsPath: string): Promise<string[] | undefined> {
		if (cache.has(fsPath)) { return cache.get(fsPath); }
		let lines: string[] | undefined;
		try { lines = (await fs.promises.readFile(fsPath, 'utf8')).replace(/\r\n?/g, '\n').split('\n'); } catch { lines = undefined; }
		cache.set(fsPath, lines);
		return lines;
	}

	async function toResult(cache: Map<string, string[] | undefined>, fsPath: string, start0: number, end0: number, score: number): Promise<SearchResult | undefined> {
		const lines = await readLines(cache, fsPath);
		if (!lines) { return undefined; }
		const end = Math.min(end0, lines.length - 1);
		const uri = vscode.Uri.file(fsPath);
		return {
			uri: uri.toString(),
			path: vscode.workspace.asRelativePath(uri, false),
			startLine: start0 + 1,
			endLine: end + 1,
			text: lines.slice(start0, end + 1).join('\n'),
			score,
		};
	}

	async function search(query: string, opts: { limit: number; includeGlob?: string; signal: AbortSignal }): Promise<SearchResult[]> {
		await ensureLoaded();
		const emb = enabled() ? await getEmbedder() : undefined;
		if (emb && !running && state !== 'ready' && state !== 'indexing') { void scan(); }
		const cache = new Map<string, string[] | undefined>();
		const out: SearchResult[] = [];
		if (emb && store.chunkCount > 0 && store.embedder === emb.id) {
			try {
				const [qv] = await emb.embed([query], 'query', opts.signal);
				if (qv && qv.length === store.dim) {
					const glob = opts.includeGlob;
					const filter = glob ? (key: string) => {
						const p = vscode.Uri.parse(key);
						const rel = vscode.workspace.asRelativePath(p, false);
						return minimatch(rel, glob, { dot: true, matchBase: !glob.includes('/') });
					} : undefined;
					for (const h of store.search(qv, opts.limit, filter)) {
						const r = await toResult(cache, vscode.Uri.parse(h.key).fsPath, h.startLine, h.endLine, h.score);
						if (r) { out.push(r); }
					}
					if (out.length) { return out; }
				}
			} catch (e) {
				if (opts.signal.aborted) { return []; }
				console.error('[open-cursor] semantic search failed, using keyword search', e);
			}
		}
		const hits = await keywordSearch(query, vscode.workspace.workspaceFolders ?? [], opts);
		for (const h of hits) {
			const r = await toResult(cache, h.file, h.startLine, h.endLine, h.score);
			if (r) { out.push(r); }
		}
		return out;
	}

	function getStatus(): Status {
		if (!enabled()) { return { state: 'disabled', files: 0, chunks: 0 }; }
		return { state, files: store.fileCount, chunks: store.chunkCount, ...(progress !== undefined ? { progress } : {}), ...(error ? { error } : {}) };
	}

	async function clear(): Promise<void> {
		await stopScan();
		store.clear();
		store.embedder = '';
		state = enabled() ? 'idle' : 'disabled';
		error = undefined;
		progress = undefined;
		if (dir) { await fs.promises.rm(dir, { recursive: true, force: true }); }
		fire();
	}

	async function rebuild(): Promise<void> {
		await clear();
		await getEmbedder(true);
		await scan();
	}

	const watcher = vscode.workspace.createFileSystemWatcher('**/*');
	watcher.onDidChange(markDirty);
	watcher.onDidCreate(markDirty);
	watcher.onDidDelete(uri => { store.delete(uri.toString()); saveSoon(); fire(); });

	let reconfigTimer: ReturnType<typeof setTimeout> | undefined;
	const reconfigure = () => {
		clearTimeout(reconfigTimer);
		reconfigTimer = setTimeout(async () => {
			if (disposed) { return; }
			await stopScan();
			if (!enabled()) { state = 'disabled'; fire(); return; }
			await getEmbedder(true);
			state = 'idle';
			void scan();
		}, 1500);
	};

	const startup = setTimeout(() => { if (enabled() && !disposed) { void scan(); } }, 5000);
	if (!enabled()) { state = 'disabled'; }

	ctx.subscriptions.push(
		onDidChange,
		watcher,
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('openCursor.index')) { reconfigure(); }
		}),
		ctx.secrets.onDidChange(e => {
			if (e.key === 'openCursor.key.openai' || e.key === 'openCursor.key.google') { reconfigure(); }
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => reconfigure()),
		vscode.workspace.onDidGrantWorkspaceTrust(() => reconfigure()),
		vscode.commands.registerCommand('openCursor.index.rebuild', async () => {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'OpenCursor: indexing codebase' }, () => rebuild());
		}),
		vscode.commands.registerCommand('openCursor.index.clear', () => clear()),
		{
			dispose() {
				disposed = true;
				clearTimeout(startup); clearTimeout(saveTimer); clearTimeout(dirtyTimer); clearTimeout(reconfigTimer);
				abort?.abort();
				if (dir && store.chunkCount) { void store.save(dir).catch(() => undefined); }
			},
		},
	);

	return { onDidChange: onDidChange.event, getStatus, search, rebuild, clear };
}
