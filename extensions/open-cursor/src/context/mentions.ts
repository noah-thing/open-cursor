/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nodePath from 'path';
import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import type { ContextItem, ContextKind } from '../shared/protocol';
import { formatDiagnostics } from './diagnostics';
import { fuzzyScore } from './fuzzy';
import { htmlToText, stripAnsi } from './html';
import { safeFetch } from './safeFetch';
import { primaryRoot, toDisplayPath } from './paths';
import type { RulesStore } from './rules';

const MAX_READ_BYTES = 4 * 1024 * 1024;
const HEAD_BYTES = 1024 * 1024;

export const MAX_FILE_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_GIT_CHARS = 60000;
const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/target/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/.DS_Store,**/*.{png,jpg,jpeg,gif,webp,ico,icns,pdf,zip,gz,tar,mp3,mp4,mov,wasm,woff,woff2,ttf,eot,lock}}';
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export interface ContextHooks {
	/** Past chats matching the query (controller owned). */
	searchChats?(query: string): ContextItem[];
	/** Summary text of a past chat for injection into a prompt. */
	resolveChat?(chatId: string): Promise<string | undefined>;
}

export class FileIndex implements vscode.Disposable {
	private files = new Set<string>(); // uri strings
	private ready: Promise<void> | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		const w = vscode.workspace.createFileSystemWatcher('**/*');
		const skip = (u: vscode.Uri) => /\/(node_modules|\.git|dist|out|build|\.next|target|__pycache__)\//.test(u.path);
		this.disposables.push(
			w,
			w.onDidCreate(u => { if (!skip(u)) { this.files.add(u.toString()); } }),
			w.onDidDelete(u => { this.files.delete(u.toString()); }),
			vscode.workspace.onDidChangeWorkspaceFolders(() => { this.ready = undefined; }),
		);
	}

	private load(): Promise<void> {
		this.ready ??= (async () => {
			try {
				const found = await vscode.workspace.findFiles('**/*', EXCLUDE, 30000);
				this.files = new Set(found.map(u => u.toString()));
			} catch {
				this.files = new Set();
			}
		})();
		return this.ready;
	}

	async list(): Promise<vscode.Uri[]> {
		await this.load();
		return [...this.files].map(s => vscode.Uri.parse(s));
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}

function openEditorRecency(): Map<string, number> {
	const rank = new Map<string, number>();
	let i = 0;
	const active = vscode.window.activeTextEditor?.document.uri.toString();
	if (active) {
		rank.set(active, i++);
	}
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const input = tab.input as { uri?: vscode.Uri } | undefined;
			const u = input?.uri?.toString();
			if (u && !rank.has(u)) {
				rank.set(u, i++);
			}
		}
	}
	return rank;
}

function fileItem(uri: vscode.Uri): ContextItem {
	const rel = toDisplayPath(uri);
	const dir = nodePath.posix.dirname(rel);
	return { id: `file:${uri.toString()}`, kind: 'file', label: nodePath.posix.basename(rel), detail: dir === '.' ? undefined : dir, uri: uri.toString() };
}

const STATIC_ITEMS: ContextItem[] = [
	{ id: 'git:diff', kind: 'git', label: 'Git: working tree', detail: 'Uncommitted changes', content: 'diff' },
	{ id: 'git:branch', kind: 'git', label: 'Git: branch diff', detail: 'Changes vs main', content: 'branch' },
	{ id: 'lints:workspace', kind: 'lints', label: 'Lints', detail: 'Errors and warnings in the workspace' },
	{ id: 'terminal:last', kind: 'terminal', label: 'Terminal', detail: 'Last command output' },
	{ id: 'web', kind: 'web', label: 'Web', detail: 'Let the agent search the web' },
	{ id: 'docs', kind: 'docs', label: 'Docs', detail: 'Paste a documentation URL' },
	{ id: 'chat:past', kind: 'chat', label: 'Past chats', detail: 'Reference an earlier conversation' },
	{ id: 'rule:all', kind: 'rule', label: 'Rules', detail: 'Attach a rule' },
];

export class Mentions {
	constructor(
		private readonly index: FileIndex,
		private readonly rules: RulesStore,
		private readonly getTerminalOutput: () => string | undefined,
		private readonly hooks: () => ContextHooks,
	) { }

	async search(query: string, kind?: ContextKind): Promise<ContextItem[]> {
		const q = query.trim();
		if (q.startsWith('/') && !kind) {
			return this.searchCommands(q.slice(1));
		}
		switch (kind) {
			case 'file': return this.searchFiles(q, 40);
			case 'folder': return this.searchFolders(q, 40);
			case 'code': case 'selection': return this.searchSymbols(q);
			case 'git': return this.searchGit(q);
			case 'lints': return [STATIC_ITEMS[2]];
			case 'terminal': return [STATIC_ITEMS[3]];
			case 'web': return [{ ...STATIC_ITEMS[4], content: q || undefined }];
			case 'docs': return [this.docsItem(q)];
			case 'chat': return this.hooks().searchChats?.(q) ?? [];
			case 'rule': return this.searchRules(q);
			default: break;
		}
		if (!q) {
			const recent = await this.searchFiles('', 6);
			return [...recent, ...STATIC_ITEMS];
		}
		const [files, folders, symbols] = await Promise.all([this.searchFiles(q, 12), this.searchFolders(q, 4), q.length >= 2 ? this.searchSymbols(q) : Promise.resolve([])]);
		const staticMatches = STATIC_ITEMS.filter(s => s.label.toLowerCase().includes(q.toLowerCase()));
		const extra: ContextItem[] = /^https?:\/\//i.test(q) ? [this.docsItem(q)] : [];
		const chats = q.length >= 2 ? (this.hooks().searchChats?.(q) ?? []).slice(0, 3) : [];
		return [...extra, ...files, ...folders, ...symbols.slice(0, 6), ...staticMatches, ...chats];
	}

	private docsItem(q: string): ContextItem {
		const url = q && /^https?:\/\//i.test(q) ? q : q ? `https://${q}` : undefined;
		return url
			? { id: `docs:${url}`, kind: 'docs', label: url.replace(/^https?:\/\//, '').slice(0, 60), detail: url, content: url }
			: STATIC_ITEMS[5];
	}

	private async searchCommands(q: string): Promise<ContextItem[]> {
		const all = await this.rules.getCommands();
		return all
			.filter(c => c.name.toLowerCase().includes(q.toLowerCase()))
			.map(c => ({ id: `command:${c.name}`, kind: 'rule' as const, label: '/' + c.name, detail: c.description, content: c.name }));
	}

	async searchFiles(q: string, limit: number): Promise<ContextItem[]> {
		const recency = openEditorRecency();
		const files = await this.index.list();
		const scored: { uri: vscode.Uri; score: number }[] = [];
		for (const uri of files) {
			const rel = toDisplayPath(uri);
			const s = fuzzyScore(q, rel);
			if (s === undefined) {
				continue;
			}
			const r = recency.get(uri.toString());
			const bonus = r !== undefined ? 400 - Math.min(r, 20) * 10 : 0;
			scored.push({ uri, score: s + bonus });
		}
		// Open editors that are outside the workspace index (e.g. untitled or external files).
		for (const key of recency.keys()) {
			const u = vscode.Uri.parse(key);
			if (u.scheme === 'file' && !scored.some(s => s.uri.toString() === key)) {
				const s = fuzzyScore(q, toDisplayPath(u));
				if (s !== undefined) {
					scored.push({ uri: u, score: s + 400 });
				}
			}
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit).map(s => fileItem(s.uri));
	}

	private async searchFolders(q: string, limit: number): Promise<ContextItem[]> {
		const files = await this.index.list();
		const dirs = new Map<string, vscode.Uri>();
		for (const f of files) {
			const rel = toDisplayPath(f);
			let dir = nodePath.posix.dirname(rel);
			let uri = vscode.Uri.joinPath(f, '..');
			while (dir && dir !== '.' && !dirs.has(dir)) {
				dirs.set(dir, uri);
				dir = nodePath.posix.dirname(dir);
				uri = vscode.Uri.joinPath(uri, '..');
			}
		}
		const scored: { rel: string; uri: vscode.Uri; score: number }[] = [];
		for (const [rel, uri] of dirs) {
			const s = fuzzyScore(q, rel);
			if (s !== undefined) {
				scored.push({ rel, uri, score: s });
			}
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit).map(s => ({
			id: `folder:${s.uri.toString()}`, kind: 'folder' as const, label: nodePath.posix.basename(s.rel) + '/',
			detail: nodePath.posix.dirname(s.rel) === '.' ? undefined : nodePath.posix.dirname(s.rel), uri: s.uri.toString(),
		}));
	}

	private async searchSymbols(q: string): Promise<ContextItem[]> {
		if (!q) {
			return [];
		}
		try {
			const syms = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', q);
			return (syms ?? []).slice(0, 20).map(s => ({
				id: `code:${s.location.uri.toString()}#${s.name}:${s.location.range.start.line}`,
				kind: 'code' as const,
				label: s.name,
				detail: `${vscode.SymbolKind[s.kind]} ${toDisplayPath(s.location.uri)}`,
				uri: s.location.uri.toString(),
				range: { startLine: s.location.range.start.line + 1, endLine: s.location.range.end.line + 1 },
			}));
		} catch {
			return [];
		}
	}

	private async searchGit(q: string): Promise<ContextItem[]> {
		const items = [STATIC_ITEMS[0], STATIC_ITEMS[1]];
		const root = primaryRoot();
		if (root?.scheme === 'file') {
			try {
				const out = await git(root.fsPath, ['log', '-n', '15', '--pretty=format:%h%x09%s']);
				for (const line of out.split('\n')) {
					const [sha, ...rest] = line.split('\t');
					const subject = rest.join('\t');
					if (sha && (!q || subject.toLowerCase().includes(q.toLowerCase()) || sha.startsWith(q))) {
						items.push({ id: `git:commit:${sha}`, kind: 'git', label: `${sha} ${subject}`.slice(0, 70), detail: 'Commit', content: `commit:${sha}` });
					}
				}
			} catch {
				// not a git repo
			}
		}
		return items;
	}

	private async searchRules(q: string): Promise<ContextItem[]> {
		const all = await this.rules.getAll();
		return all
			.filter(r => r.kind !== 'user' && (!q || r.name.toLowerCase().includes(q.toLowerCase())))
			.map(r => ({ id: `rule:${r.name}`, kind: 'rule' as const, label: r.name, detail: r.description ?? r.source, uri: r.uri }));
	}

	async resolve(item: ContextItem): Promise<string> {
		try {
			return await this.resolveInner(item);
		} catch (e) {
			return `[Could not resolve ${item.kind} "${item.label}": ${e instanceof Error ? e.message : String(e)}]`;
		}
	}

	private async resolveInner(item: ContextItem): Promise<string> {
		switch (item.kind) {
			case 'file': {
				if (!item.uri) { return `[File ${item.label} has no path]`; }
				const uri = vscode.Uri.parse(item.uri);
				if (IMAGE_EXT.has(nodePath.extname(uri.path).toLowerCase())) {
					return `[Image file: ${toDisplayPath(uri)}. Use read_file to view it.]`;
				}
				return this.fileText(uri, item.range);
			}
			case 'code': {
				if (item.uri) {
					return this.fileText(vscode.Uri.parse(item.uri), item.range);
				}
				return item.content ?? '';
			}
			case 'selection': {
				const where = item.uri ? toDisplayPath(vscode.Uri.parse(item.uri)) : item.label;
				const range = item.range ? ` lines ${item.range.startLine}-${item.range.endLine}` : '';
				return `Selection from ${where}${range}:\n\`\`\`${item.languageId ?? ''}\n${item.content ?? ''}\n\`\`\``;
			}
			case 'folder': return item.uri ? this.folderText(vscode.Uri.parse(item.uri)) : '';
			case 'terminal': {
				const text = item.content ?? this.getTerminalOutput();
				return text ? `Terminal output:\n\`\`\`\n${text}\n\`\`\`` : '[No terminal output captured yet]';
			}
			case 'git': return this.gitText(item);
			case 'lints': {
				const uris = item.uri ? [vscode.Uri.parse(item.uri)] : undefined;
				const r = formatDiagnostics({ uris });
				return r.count ? `Current diagnostics (${r.count}):\n${r.text}` : 'No errors or warnings reported by the language servers.';
			}
			case 'web': return `The user wants you to look this up on the web${item.content ? `: ${item.content}` : '.'} Use fetch_url on relevant pages.`;
			case 'docs': {
				const url = item.content ?? item.detail;
				if (!url) { return ''; }
				return this.docsText(url);
			}
			case 'rule': {
				if (item.id.startsWith('command:')) { return ''; }
				const all = await this.rules.getAll();
				const rule = all.find(r => `rule:${r.name}` === item.id || (item.uri && r.uri === item.uri));
				return rule ? `Rule "${rule.name}":\n${rule.content}` : `[Rule ${item.label} not found]`;
			}
			case 'chat': {
				const text = await this.hooks().resolveChat?.(item.id.replace(/^chat:/, ''));
				return text ? `Earlier conversation "${item.label}":\n${text}` : `[Chat ${item.label} unavailable]`;
			}
			case 'image': return `[Attached image: ${item.label}]`;
			default: return item.content ?? '';
		}
	}

	async fileText(uri: vscode.Uri, range?: { startLine: number; endLine: number }): Promise<string> {
		const text = await readDocumentText(uri);
		const rel = toDisplayPath(uri);
		if (text === undefined) {
			return `[File ${rel} could not be read]`;
		}
		if (text.includes('\u0000')) {
			return `[File ${rel} is binary]`;
		}
		const lines = text.split(/\r?\n/);
		const start = Math.max(1, range?.startLine ?? 1);
		const end = Math.min(lines.length, range ? range.endLine : lines.length, start + MAX_FILE_LINES - 1);
		const body = numberLines(lines, start, end);
		const note = end < (range?.endLine ?? lines.length) || (!range && lines.length > MAX_FILE_LINES)
			? `\n[Truncated at ${MAX_FILE_LINES} lines; file has ${lines.length} lines. Use read_file with offset to read more.]` : '';
		const hdr = range ? ` (lines ${start}-${end} of ${lines.length})` : '';
		return `File ${rel}${hdr}:\n\`\`\`\n${body}\n\`\`\`${note}`;
	}

	private async folderText(uri: vscode.Uri): Promise<string> {
		const lines: string[] = [];
		let count = 0;
		const walk = async (dir: vscode.Uri, depth: number, prefix: string): Promise<void> => {
			let entries: [string, vscode.FileType][];
			try {
				entries = await vscode.workspace.fs.readDirectory(dir);
			} catch {
				return;
			}
			entries.sort((a, b) => Number(!!(b[1] & vscode.FileType.Directory)) - Number(!!(a[1] & vscode.FileType.Directory)) || a[0].localeCompare(b[0]));
			for (const [name, type] of entries) {
				if (name === 'node_modules' || name === '.git' || name === '.DS_Store') { continue; }
				if (count++ > 400) { return; }
				const isDir = !!(type & vscode.FileType.Directory);
				lines.push(`${prefix}${name}${isDir ? '/' : ''}`);
				if (isDir && depth < 2) {
					await walk(vscode.Uri.joinPath(dir, name), depth + 1, prefix + '  ');
				}
			}
		};
		await walk(uri, 1, '');
		return `Folder ${toDisplayPath(uri)}/ (depth 2${count > 400 ? ', truncated' : ''}):\n${lines.join('\n')}`;
	}

	private async gitText(item: ContextItem): Promise<string> {
		const root = primaryRoot();
		if (!root || root.scheme !== 'file') { return '[No local git repository]'; }
		const cwd = root.fsPath;
		const mode = item.content ?? 'diff';
		let out: string;
		let title: string;
		if (mode.startsWith('commit:')) {
			title = `Commit ${mode.slice(7)}`;
			out = await git(cwd, ['show', '--stat', '--patch', '--no-color', mode.slice(7)]);
		} else if (mode === 'branch') {
			let base = 'main';
			for (const cand of ['main', 'master', 'origin/main', 'origin/master']) {
				try { await git(cwd, ['rev-parse', '--verify', cand]); base = cand; break; } catch { /* try next */ }
			}
			title = `Branch diff vs ${base}`;
			out = await git(cwd, ['diff', '--no-color', `${base}...HEAD`]);
		} else {
			title = 'Working tree changes';
			const [diff, status] = await Promise.all([git(cwd, ['diff', 'HEAD', '--no-color']).catch(() => git(cwd, ['diff', '--no-color'])), git(cwd, ['status', '--short']).catch(() => '')]);
			const untracked = status.split('\n').filter(l => l.startsWith('??')).join('\n');
			out = diff + (untracked ? `\n\nUntracked files:\n${untracked}` : '');
		}
		if (!out.trim()) { return `${title}: no changes.`; }
		const trimmed = out.length > MAX_GIT_CHARS ? out.slice(0, MAX_GIT_CHARS) + '\n[diff truncated]' : out;
		return `${title}:\n\`\`\`diff\n${trimmed}\n\`\`\``;
	}

	private async docsText(url: string): Promise<string> {
		try {
			const res = await safeFetch(url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15000 });
			if (res.status < 200 || res.status >= 300) { return `[Docs ${url}: HTTP ${res.status}]`; }
			const raw = res.text;
			const text = res.contentType.includes('html') || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw;
			return `Documentation from ${url}:\n${text.length > 20000 ? text.slice(0, 20000) + '\n[truncated]' : text}`;
		} catch (e) {
			return `[Docs ${url} could not be fetched: ${e instanceof Error ? e.message : String(e)}]`;
		}
	}
}

export function numberLines(lines: string[], start: number, end: number): string {
	const out: string[] = [];
	for (let i = start; i <= end; i++) {
		const l = lines[i - 1];
		out.push(`${i}|${l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + '…' : l}`);
	}
	return out.join('\n');
}

/** Reads text through an open (possibly dirty) document when there is one, else from disk. */
export async function readDocumentText(uri: vscode.Uri): Promise<string | undefined> {
	const key = uri.toString();
	const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
	if (open) {
		return open.getText();
	}
	try {
		// stat first: a multi GB file must not be pulled into memory just to be truncated to a few hundred lines
		const size = (await vscode.workspace.fs.stat(uri)).size;
		if (size > MAX_READ_BYTES) {
			if (uri.scheme !== 'file') {
				// no handle API for virtual files: read, keep only the head
				const all = await vscode.workspace.fs.readFile(uri);
				return new TextDecoder('utf-8').decode(all.subarray(0, HEAD_BYTES)) + '\n[file is larger than 4 MB, only the start was read]';
			}
			const fh = await fsp.open(uri.fsPath, 'r');
			try {
				const buf = Buffer.alloc(HEAD_BYTES);
				const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
				return new TextDecoder('utf-8').decode(buf.subarray(0, bytesRead)) + '\n[file is larger than 4 MB, only the start was read]';
			} finally { await fh.close(); }
		}
		const bytes = await vscode.workspace.fs.readFile(uri);
		return new TextDecoder('utf-8').decode(bytes);
	} catch {
		return undefined;
	}
}

export function git(cwd: string, args: string[], timeoutMs = 15000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(stripAnsi(String(stderr || err.message)).trim()));
			} else {
				resolve(String(stdout));
			}
		});
	});
}
