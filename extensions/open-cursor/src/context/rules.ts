/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nodePath from 'path';
import { firstLine, globsMatch, parseFrontmatter } from './frontmatter';
import { homeDir, normaliseToRelative, toDisplayPath, workspaceRoots } from './paths';

export type RuleKind = 'always' | 'glob' | 'agent' | 'manual' | 'instructions' | 'user';

export interface RuleEntry {
	readonly name: string;
	/** Display path of the file ("user setting" for the setting). */
	readonly source: string;
	readonly uri?: string;
	readonly content: string;
	readonly description?: string;
	readonly globs: string[];
	readonly alwaysApply: boolean;
	readonly kind: RuleKind;
}

export interface CommandEntry {
	readonly name: string;
	readonly description: string;
	readonly source: string;
	readonly content: string;
}

const MAX_RULE_CHARS = 24000;
const RULE_DIRS = ['.open-cursor/rules', '.cursor/rules'];
const COMMAND_DIRS = ['.open-cursor/commands', '.cursor/commands'];
const decoder = new TextDecoder('utf-8');

async function readText(uri: vscode.Uri): Promise<string | undefined> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const text = decoder.decode(bytes);
		return text.length > MAX_RULE_CHARS ? text.slice(0, MAX_RULE_CHARS) + '\n[truncated]' : text;
	} catch {
		return undefined;
	}
}

async function listFilesRecursive(dir: vscode.Uri, exts: string[], depth = 0): Promise<vscode.Uri[]> {
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return [];
	}
	const out: vscode.Uri[] = [];
	entries.sort((a, b) => a[0].localeCompare(b[0]));
	for (const [name, type] of entries) {
		if (name.startsWith('.')) {
			continue;
		}
		const child = vscode.Uri.joinPath(dir, name);
		if (type & vscode.FileType.Directory) {
			if (depth < 4) {
				out.push(...await listFilesRecursive(child, exts, depth + 1));
			}
		} else if (exts.includes(nodePath.extname(name).toLowerCase())) {
			out.push(child);
		}
	}
	return out;
}

function toRule(name: string, source: string, uri: vscode.Uri | undefined, text: string): RuleEntry {
	const { fm, body } = parseFrontmatter(text);
	const content = body.trim();
	let kind: RuleKind;
	if (fm.alwaysApply) {
		kind = 'always';
	} else if (fm.globs.length) {
		kind = 'glob';
	} else if (fm.description) {
		kind = 'agent';
	} else {
		kind = 'manual';
	}
	return { name, source, uri: uri?.toString(), content, description: fm.description, globs: fm.globs, alwaysApply: fm.alwaysApply, kind };
}

export class RulesStore implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private rules: Promise<RuleEntry[]> | undefined;
	private commands: Promise<CommandEntry[]> | undefined;
	private readonly nested = new Map<string, Promise<RuleEntry | undefined>>();
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor() {
		const invalidate = () => {
			this.rules = undefined;
			this.commands = undefined;
			this.nested.clear();
			this._onDidChange.fire();
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const debounced = () => {
			clearTimeout(timer);
			timer = setTimeout(invalidate, 150);
		};
		this.disposables.push({ dispose: () => clearTimeout(timer) });
		const patterns = ['**/.open-cursor/{rules,commands}/**', '**/.cursor/{rules,commands}/**', '**/AGENTS.md', '**/CLAUDE.md', '**/.cursorrules'];
		for (const p of patterns) {
			const w = vscode.workspace.createFileSystemWatcher(p);
			this.disposables.push(w, w.onDidCreate(debounced), w.onDidChange(debounced), w.onDidDelete(debounced));
		}
		for (const sub of ['.open-cursor/rules', '.open-cursor/commands', '.cursor/commands']) {
			try {
				const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(nodePath.join(homeDir(), sub)), '*'));
				this.disposables.push(w, w.onDidCreate(debounced), w.onDidChange(debounced), w.onDidDelete(debounced));
			} catch {
				// watcher outside the workspace may be unsupported (virtual FS); the cache then refreshes on config change only
			}
		}
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('openCursor.rules')) {
					debounced();
				}
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(debounced),
			this._onDidChange,
		);
	}

	getAll(): Promise<RuleEntry[]> {
		this.rules ??= this.loadRules().catch(() => []);
		return this.rules;
	}

	getCommands(): Promise<CommandEntry[]> {
		this.commands ??= this.loadCommands().catch(() => []);
		return this.commands;
	}

	private async loadRules(): Promise<RuleEntry[]> {
		const byName = new Map<string, RuleEntry>();
		const out: RuleEntry[] = [];
		for (const root of workspaceRoots()) {
			// .open-cursor first so it wins on name conflicts
			for (const dir of RULE_DIRS) {
				const base = vscode.Uri.joinPath(root, dir);
				for (const file of await listFilesRecursive(base, ['.mdc', '.md'])) {
					const rel = nodePath.posix.relative(base.path, file.path).replace(/\.(mdc|md)$/i, '');
					if (byName.has(rel)) {
						continue;
					}
					const text = await readText(file);
					if (text === undefined) {
						continue;
					}
					const rule = toRule(rel, toDisplayPath(file), file, text);
					byName.set(rel, rule);
					out.push(rule);
				}
			}
			for (const f of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
				const uri = vscode.Uri.joinPath(root, f);
				const text = await readText(uri);
				if (text?.trim()) {
					out.push({ name: f, source: toDisplayPath(uri), uri: uri.toString(), content: text.trim(), globs: [], alwaysApply: true, kind: 'instructions' });
				}
			}
		}
		const userSetting = vscode.workspace.getConfiguration('openCursor').get<string>('rules.user', '').trim();
		if (userSetting) {
			out.push({ name: 'user-rules', source: 'User rules (settings)', content: userSetting, globs: [], alwaysApply: true, kind: 'user' });
		}
		const userDir = vscode.Uri.file(nodePath.join(homeDir(), '.open-cursor', 'rules'));
		for (const file of await listFilesRecursive(userDir, ['.md', '.mdc'])) {
			const text = await readText(file);
			if (text?.trim()) {
				const name = 'user/' + nodePath.basename(file.path).replace(/\.(mdc|md)$/i, '');
				const r = toRule(name, '~/.open-cursor/rules/' + nodePath.basename(file.path), file, text);
				// User rule files without frontmatter are treated as always on, like the user rules setting.
				out.push(r.kind === 'manual' ? { ...r, kind: 'user', alwaysApply: true } : r);
			}
		}
		return out;
	}

	private async loadCommands(): Promise<CommandEntry[]> {
		const seen = new Set<string>();
		const out: CommandEntry[] = [];
		const dirs: vscode.Uri[] = [];
		for (const root of workspaceRoots()) {
			for (const d of COMMAND_DIRS) {
				dirs.push(vscode.Uri.joinPath(root, d));
			}
		}
		dirs.push(vscode.Uri.file(nodePath.join(homeDir(), '.open-cursor', 'commands')), vscode.Uri.file(nodePath.join(homeDir(), '.cursor', 'commands')));
		for (const dir of dirs) {
			for (const file of await listFilesRecursive(dir, ['.md'], 3)) {
				const name = nodePath.posix.relative(dir.path, file.path).replace(/\.md$/i, '');
				if (seen.has(name)) {
					continue;
				}
				const text = await readText(file);
				if (text === undefined) {
					continue;
				}
				const { fm, body } = parseFrontmatter(text);
				seen.add(name);
				out.push({ name, description: fm.description ?? firstLine(body), source: file.scheme === 'file' ? file.fsPath : file.toString(), content: body.trim() });
			}
		}
		return out;
	}

	/** AGENTS.md files in directories between a file and its workspace root (root-level is in getAll). */
	async getNestedInstructions(files: string[]): Promise<RuleEntry[]> {
		const roots = workspaceRoots();
		if (!roots.length) {
			return [];
		}
		const dirs = new Set<string>();
		for (const f of files) {
			const rel = normaliseToRelative(f);
			let dir = nodePath.posix.dirname(rel);
			while (dir && dir !== '.' && dir !== '/' && !dir.startsWith('..')) {
				dirs.add(dir);
				dir = nodePath.posix.dirname(dir);
			}
		}
		const out: RuleEntry[] = [];
		for (const dir of [...dirs].sort((a, b) => a.length - b.length)) {
			for (const root of roots) {
				const uri = vscode.Uri.joinPath(root, dir, 'AGENTS.md');
				const key = uri.toString();
				let p = this.nested.get(key);
				if (!p) {
					p = readText(uri).then(text => text?.trim() ? { name: `${dir}/AGENTS.md`, source: toDisplayPath(uri), uri: key, content: text.trim(), globs: [], alwaysApply: true, kind: 'instructions' as const } : undefined);
					this.nested.set(key, p);
				}
				const r = await p;
				if (r) {
					out.push(r);
				}
			}
		}
		return out;
	}

	async select(files: string[]): Promise<RuleEntry[]> {
		const all = await this.getAll();
		const rel = files.map(normaliseToRelative);
		const picked = all.filter(r => {
			switch (r.kind) {
				case 'always': case 'instructions': case 'user': return true;
				case 'glob': return globsMatch(r.globs, rel);
				case 'agent': return true;
				default: return false;
			}
		});
		return [...picked, ...await this.getNestedInstructions(files)];
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
