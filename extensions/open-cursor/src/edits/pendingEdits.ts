/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Pending AI edits: per-file review sessions with hunks, Keep/Undo, persistence and rendering.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { IPendingEdits, PendingHunk } from '../services';
import type { PendingFileEdit } from '../shared/protocol';
import { computeHunks, countChanges, foldAccept, applyReject, norm, type Hunk } from './hunks';
import { readCurrent, writeDocument, deleteOnDisk } from './fileOps';

const ORIGINAL_SCHEME = 'open-cursor-original';
const STATE_KEY = 'openCursor.pendingEdits.v1';

export interface IPendingEditsInternal extends IPendingEdits {
	/** Drop review state for these files without touching their content (used by checkpoint restore). */
	forget(uris: readonly vscode.Uri[]): void;
}

interface Session {
	readonly uri: vscode.Uri;
	readonly key: string;
	original: string;
	/** Did the file exist before the review began? */
	readonly existed: boolean;
	deleted: boolean;
	current: string;
	source: 'agent' | 'inline';
	chatId?: string;
	hunks: Hunk[];
	timer?: ReturnType<typeof setTimeout>;
}

interface PersistedSession {
	uri: string;
	original: string;
	existed: boolean;
	deleted: boolean;
	source: 'agent' | 'inline';
	chatId?: string;
}

type UriArg = string | vscode.Uri | undefined;

export function createPendingEdits(ctx: vscode.ExtensionContext): IPendingEditsInternal {
	const sessions = new Map<string, Session>();
	const onDidChange = new vscode.EventEmitter<void>();
	const originalChanged = new vscode.EventEmitter<vscode.Uri>();
	const lensChanged = new vscode.EventEmitter<void>();
	const disposables: vscode.Disposable[] = [onDidChange, originalChanged, lensChanged];

	let chain: Promise<unknown> = Promise.resolve();
	const excl = <T>(fn: () => Promise<T>): Promise<T> => {
		const p = chain.then(fn);
		chain = p.then(() => undefined, () => undefined);
		return p;
	};

	// ---- core bridge detection -------------------------------------------------------------
	let coreAvailable = false;
	const coreReady = Promise.resolve(vscode.commands.getCommands(false)).then(cmds => {
		coreAvailable = cmds.includes('_openCursor.diff.set');
	}, () => undefined);

	// ---- helpers ---------------------------------------------------------------------------
	const keyOf = (uri: vscode.Uri) => uri.toString();

	async function refreshCurrent(s: Session): Promise<void> {
		if (s.deleted) {
			s.current = '';
			return;
		}
		const cur = await readCurrent(s.uri);
		if (cur !== undefined) {
			s.current = cur;
		}
	}

	function recompute(s: Session): void {
		s.hunks = s.deleted ? [] : computeHunks(s.original, s.current);
	}

	function toPending(h: Hunk): PendingHunk {
		return { id: h.id, startLine: h.curStart, addedCount: h.curCount, removedLines: h.removedLines };
	}

	function stats(s: Session): { added: number; removed: number } {
		if (s.deleted) {
			const lines = s.original.split('\n');
			if (lines[lines.length - 1] === '') {
				lines.pop();
			}
			return { added: 0, removed: lines.length };
		}
		return countChanges(s.hunks);
	}

	function sessionList(): Session[] {
		return [...sessions.values()];
	}

	// ---- persistence -----------------------------------------------------------------------
	let persistTimer: ReturnType<typeof setTimeout> | undefined;
	function persistSoon(): void {
		clearTimeout(persistTimer);
		persistTimer = setTimeout(() => {
			const data: PersistedSession[] = sessionList().map(s => ({
				uri: s.key, original: s.original, existed: s.existed, deleted: s.deleted, source: s.source, chatId: s.chatId,
			}));
			void ctx.workspaceState.update(STATE_KEY, data.length ? data : undefined);
		}, 300);
	}

	// ---- lifecycle -------------------------------------------------------------------------
	function changed(s?: Session): void {
		if (s) {
			originalChanged.fire(originalUri(s.uri));
		}
		persistSoon();
		scheduleRender();
		onDidChange.fire();
	}

	function endSession(s: Session): void {
		if (sessions.get(s.key) !== s) {
			return;
		}
		clearTimeout(s.timer);
		sessions.delete(s.key);
		changed(s);
	}

	/** Recompute hunks; the review ends when original == current (never for deleted files). */
	function settle(s: Session): void {
		recompute(s);
		if (!s.deleted && s.original === s.current) {
			endSession(s);
		} else {
			changed(s);
		}
	}

	function originalUri(uri: vscode.Uri): vscode.Uri {
		return vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: uri.path, query: encodeURIComponent(uri.toString()) });
	}

	// ---- IPendingEdits ---------------------------------------------------------------------
	async function applyContent(uri: vscode.Uri, newContent: string, source: 'agent' | 'inline', chatId?: string) {
		return excl(async () => {
			const key = keyOf(uri);
			let s = sessions.get(key);
			if (!s) {
				const cur = await readCurrent(uri);
				s = { uri, key, original: cur ?? '', existed: cur !== undefined, deleted: false, current: cur ?? '', source, chatId, hunks: [] };
			} else {
				s.source = source;
				s.chatId = chatId ?? s.chatId;
			}
			await writeDocument(uri, newContent);
			s.deleted = false;
			s.current = norm(newContent);
			sessions.set(key, s);
			settle(s);
			const st = sessions.has(key) ? stats(s) : { added: 0, removed: 0 };
			return { ...st, isNew: !s.existed };
		});
	}

	async function deleteFile(uri: vscode.Uri, chatId?: string): Promise<void> {
		return excl(async () => {
			const key = keyOf(uri);
			let s = sessions.get(key);
			if (s && !s.existed) {
				endSession(s);
				await deleteOnDisk(uri);
				return;
			}
			if (!s) {
				const cur = await readCurrent(uri);
				if (cur === undefined) {
					return;
				}
				s = { uri, key, original: cur, existed: true, deleted: false, current: cur, source: 'agent', chatId, hunks: [] };
			}
			s.deleted = true;
			s.current = '';
			sessions.set(key, s);
			await deleteOnDisk(uri);
			settle(s);
		});
	}

	function getFiles(): PendingFileEdit[] {
		return sessionList().map(s => {
			const st = stats(s);
			return {
				uri: s.key,
				path: vscode.workspace.asRelativePath(s.uri, false),
				added: st.added,
				removed: st.removed,
				isNew: s.existed ? undefined : true,
				deleted: s.deleted ? true : undefined,
			};
		});
	}

	function getHunks(uri: vscode.Uri): PendingHunk[] {
		return sessions.get(keyOf(uri))?.hunks.map(toPending) ?? [];
	}

	async function acceptFileInner(s: Session): Promise<void> {
		endSession(s);
	}

	async function rejectFileInner(s: Session): Promise<void> {
		if (!s.existed) {
			await deleteOnDisk(s.uri);
		} else {
			await writeDocument(s.uri, s.original);
		}
		endSession(s);
	}

	function acceptHunk(uri: vscode.Uri, hunkId: string): Promise<void> {
		return excl(async () => {
			const s = sessions.get(keyOf(uri));
			if (!s) {
				return;
			}
			if (s.deleted) {
				return acceptFileInner(s);
			}
			await refreshCurrent(s);
			recompute(s);
			const h = s.hunks.find(x => x.id === hunkId);
			if (!h) {
				return;
			}
			s.original = foldAccept(s.original, h);
			settle(s);
		});
	}

	function rejectHunk(uri: vscode.Uri, hunkId: string): Promise<void> {
		return excl(async () => {
			const s = sessions.get(keyOf(uri));
			if (!s) {
				return;
			}
			if (s.deleted) {
				return rejectFileInner(s);
			}
			await refreshCurrent(s);
			recompute(s);
			const h = s.hunks.find(x => x.id === hunkId);
			if (!h) {
				return;
			}
			const next = applyReject(s.current, h);
			if (!s.existed && next === s.original) {
				return rejectFileInner(s);
			}
			await writeDocument(s.uri, next);
			s.current = next;
			settle(s);
		});
	}

	function acceptFile(uri: vscode.Uri): Promise<void> {
		return excl(async () => {
			const s = sessions.get(keyOf(uri));
			if (s) {
				await acceptFileInner(s);
			}
		});
	}

	function rejectFile(uri: vscode.Uri): Promise<void> {
		return excl(async () => {
			const s = sessions.get(keyOf(uri));
			if (s) {
				await rejectFileInner(s);
			}
		});
	}

	function acceptAll(): Promise<void> {
		return excl(async () => {
			for (const s of sessionList()) {
				await acceptFileInner(s);
			}
		});
	}

	function rejectAll(): Promise<void> {
		return excl(async () => {
			for (const s of sessionList()) {
				try {
					await rejectFileInner(s);
				} catch (e) {
					console.error('[open-cursor] rejectFile failed', s.key, e);
				}
			}
		});
	}

	async function openDiff(uri: vscode.Uri): Promise<void> {
		const s = sessions.get(keyOf(uri));
		if (!s) {
			await vscode.window.showTextDocument(uri);
			return;
		}
		const left = originalUri(s.uri);
		const name = uri.path.split('/').pop() ?? uri.path;
		if (s.deleted) {
			await vscode.window.showTextDocument(left);
			return;
		}
		await vscode.commands.executeCommand('vscode.diff', left, uri, `${name} (Original ↔ Current)`);
	}

	function forget(uris: readonly vscode.Uri[]): void {
		for (const uri of uris) {
			const s = sessions.get(keyOf(uri));
			if (s) {
				endSession(s);
			}
		}
	}

	// ---- original content provider ---------------------------------------------------------
	disposables.push(vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, {
		onDidChange: originalChanged.event,
		provideTextDocumentContent(uri) {
			let key = '';
			try { key = decodeURIComponent(uri.query); } catch { /* ignore */ }
			return sessions.get(key)?.original ?? '';
		},
	}));

	// ---- manual edits keep the review alive ------------------------------------------------
	disposables.push(vscode.workspace.onDidChangeTextDocument(e => {
		const s = sessions.get(keyOf(e.document.uri));
		if (!s || s.deleted || e.contentChanges.length === 0) {
			return;
		}
		clearTimeout(s.timer);
		s.timer = setTimeout(() => {
			void excl(async () => {
				if (sessions.get(s.key) !== s) {
					return;
				}
				s.current = norm(e.document.getText());
				settle(s);
			});
		}, 100);
	}));

	disposables.push(vscode.workspace.onDidDeleteFiles(e => {
		for (const uri of e.files) {
			const s = sessions.get(keyOf(uri));
			if (s && !s.deleted) {
				endSession(s);
			}
		}
	}));

	// ---- rendering: core bridge or decorations + CodeLens ----------------------------------
	const sentToCore = new Map<string, string>();
	let renderTimer: ReturnType<typeof setTimeout> | undefined;

	function scheduleRender(): void {
		clearTimeout(renderTimer);
		renderTimer = setTimeout(() => void render(), 0);
	}

	const addedType = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
		borderWidth: '0 0 0 3px',
		borderStyle: 'solid',
		borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});
	const removedType = vscode.window.createTextEditorDecorationType({
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});
	disposables.push(addedType, removedType);

	function decorate(editor: vscode.TextEditor, s: Session | undefined): void {
		if (coreAvailable || !s || s.deleted) {
			editor.setDecorations(addedType, []);
			editor.setDecorations(removedType, []);
			return;
		}
		const doc = editor.document;
		const lastLine = Math.max(0, doc.lineCount - 1);
		const added: vscode.Range[] = [];
		const removed: vscode.DecorationOptions[] = [];
		for (const h of s.hunks) {
			if (h.curCount > 0) {
				added.push(new vscode.Range(Math.min(h.curStart, lastLine), 0, Math.min(h.curStart + h.curCount - 1, lastLine), 0));
			}
			if (h.origCount > 0) {
				const line = Math.min(Math.max(0, h.curStart - 1), lastLine);
				const md = new vscode.MarkdownString();
				const shown = h.removedLines.slice(0, 40);
				md.appendCodeblock(shown.join('\n') + (h.removedLines.length > shown.length ? '\n…' : ''), doc.languageId);
				removed.push({
					range: doc.lineAt(line).range,
					hoverMessage: md,
					renderOptions: {
						after: {
							contentText: `− ${h.origCount} line${h.origCount === 1 ? '' : 's'} removed`,
							color: new vscode.ThemeColor('descriptionForeground'),
							fontStyle: 'italic',
							margin: '0 0 0 2em',
						},
					},
				});
			}
		}
		editor.setDecorations(addedType, added);
		editor.setDecorations(removedType, removed);
	}

	async function render(): Promise<void> {
		await coreReady;
		const list = sessionList();
		if (coreAvailable) {
			const live = new Set<string>();
			list.forEach((s, i) => {
				live.add(s.key);
				if (s.deleted) {
					return;
				}
				const hunks = s.hunks.map(toPending);
				const meta = { fileIndex: i, fileCount: list.length };
				const sig = JSON.stringify([hunks, meta]);
				if (sentToCore.get(s.key) !== sig) {
					sentToCore.set(s.key, sig);
					void vscode.commands.executeCommand('_openCursor.diff.set', s.key, hunks, meta);
				}
			});
			for (const key of [...sentToCore.keys()]) {
				if (!live.has(key) || sessions.get(key)?.deleted) {
					sentToCore.delete(key);
					void vscode.commands.executeCommand('_openCursor.diff.clear', key);
				}
			}
		}
		for (const editor of vscode.window.visibleTextEditors) {
			decorate(editor, sessions.get(keyOf(editor.document.uri)));
		}
		lensChanged.fire();
		updateContexts();
	}

	disposables.push(vscode.window.onDidChangeVisibleTextEditors(editors => {
		for (const editor of editors) {
			decorate(editor, sessions.get(keyOf(editor.document.uri)));
		}
	}));

	disposables.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
		onDidChangeCodeLenses: lensChanged.event,
		provideCodeLenses(doc) {
			const s = sessions.get(keyOf(doc.uri));
			if (coreAvailable || !s || s.deleted || !s.hunks.length) {
				return [];
			}
			const uri = s.key;
			const last = Math.max(0, doc.lineCount - 1);
			const lenses: vscode.CodeLens[] = [];
			const top = new vscode.Range(0, 0, 0, 0);
			lenses.push(
				new vscode.CodeLens(top, { title: 'Keep File', command: 'openCursor.diff.acceptFile', arguments: [uri] }),
				new vscode.CodeLens(top, { title: 'Undo File', command: 'openCursor.diff.rejectFile', arguments: [uri] }),
				new vscode.CodeLens(top, { title: 'Open Diff', command: 'openCursor.diff.openDiff', arguments: [uri] }),
			);
			for (const h of s.hunks) {
				const line = Math.min(h.curStart, last);
				const r = new vscode.Range(line, 0, line, 0);
				lenses.push(
					new vscode.CodeLens(r, { title: 'Keep ⌘Y', command: 'openCursor.diff.acceptHunk', arguments: [uri, h.id] }),
					new vscode.CodeLens(r, { title: 'Undo ⌘N', command: 'openCursor.diff.rejectHunk', arguments: [uri, h.id] }),
				);
			}
			return lenses;
		},
	}));

	// ---- context keys ----------------------------------------------------------------------
	const ctxCache = new Map<string, boolean>();
	function setCtx(key: string, value: boolean): void {
		if (ctxCache.get(key) !== value) {
			ctxCache.set(key, value);
			void vscode.commands.executeCommand('setContext', key, value);
		}
	}

	function hunkAtCursor(editor: vscode.TextEditor | undefined): { s: Session; h: Hunk } | undefined {
		if (!editor) {
			return undefined;
		}
		const s = sessions.get(keyOf(editor.document.uri));
		if (!s || s.deleted) {
			return undefined;
		}
		const line = editor.selection.active.line;
		const h = s.hunks.find(x => line >= x.curStart && line < x.curStart + Math.max(1, x.curCount));
		return h ? { s, h } : undefined;
	}

	function updateContexts(): void {
		const editor = vscode.window.activeTextEditor;
		const s = editor ? sessions.get(keyOf(editor.document.uri)) : undefined;
		setCtx('openCursor.diff.hasPending', sessions.size > 0);
		setCtx('openCursor.diff.fileHasPending', !!s);
		setCtx('openCursor.diff.cursorInHunk', !!hunkAtCursor(editor));
	}
	disposables.push(
		vscode.window.onDidChangeActiveTextEditor(updateContexts),
		vscode.window.onDidChangeTextEditorSelection(e => {
			if (e.textEditor === vscode.window.activeTextEditor) {
				updateContexts();
			}
		}),
	);

	// ---- navigation ------------------------------------------------------------------------
	async function reveal(s: Session, hunk?: Hunk): Promise<void> {
		const editor = await vscode.window.showTextDocument(s.uri, { preserveFocus: false });
		const h = hunk ?? s.hunks[0];
		if (h) {
			const line = Math.min(h.curStart, editor.document.lineCount - 1);
			const pos = new vscode.Position(line, 0);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}
	}

	function stepFile(dir: 1 | -1): Session | undefined {
		const list = sessionList().filter(s => !s.deleted);
		if (!list.length) {
			return undefined;
		}
		const active = vscode.window.activeTextEditor;
		const idx = active ? list.findIndex(s => s.key === keyOf(active.document.uri)) : -1;
		if (idx === -1) {
			return dir === 1 ? list[0] : list[list.length - 1];
		}
		return list[(idx + dir + list.length) % list.length];
	}

	async function step(dir: 1 | -1): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const s = editor ? sessions.get(keyOf(editor.document.uri)) : undefined;
		if (editor && s && !s.deleted && s.hunks.length) {
			const line = editor.selection.active.line;
			const inside = s.hunks.findIndex(x => line >= x.curStart && line < x.curStart + Math.max(1, x.curCount));
			const h = dir === 1
				? s.hunks.find(x => x.curStart > line)
				: inside > 0 ? s.hunks[inside - 1] : inside === 0 ? undefined : [...s.hunks].reverse().find(x => x.curStart < line);
			if (h) {
				return reveal(s, h);
			}
		}
		const next = stepFile(dir);
		if (next) {
			await reveal(next, dir === 1 ? next.hunks[0] : next.hunks[next.hunks.length - 1]);
		}
	}

	// ---- commands --------------------------------------------------------------------------
	const toUri = (arg: UriArg): vscode.Uri | undefined => {
		if (typeof arg === 'string') { return vscode.Uri.parse(arg); }
		if (arg) { return arg; }
		return vscode.window.activeTextEditor?.document.uri;
	};
	const reg = (id: string, fn: (...args: any[]) => unknown) => disposables.push(vscode.commands.registerCommand(id, fn));

	reg('openCursor.diff.acceptHunk', async (uri?: UriArg, hunkId?: string) => {
		if (uri && hunkId) { return acceptHunk(toUri(uri)!, hunkId); }
		const at = hunkAtCursor(vscode.window.activeTextEditor);
		if (at) { return acceptHunk(at.s.uri, at.h.id); }
	});
	reg('openCursor.diff.rejectHunk', async (uri?: UriArg, hunkId?: string) => {
		if (uri && hunkId) { return rejectHunk(toUri(uri)!, hunkId); }
		const at = hunkAtCursor(vscode.window.activeTextEditor);
		if (at) { return rejectHunk(at.s.uri, at.h.id); }
	});
	reg('openCursor.diff.acceptFile', async (uri?: UriArg) => { const u = toUri(uri); if (u) { return acceptFile(u); } });
	reg('openCursor.diff.rejectFile', async (uri?: UriArg) => { const u = toUri(uri); if (u) { return rejectFile(u); } });
	reg('openCursor.diff.acceptAll', () => acceptAll());
	reg('openCursor.diff.rejectAll', () => rejectAll());
	reg('openCursor.diff.openDiff', async (uri?: UriArg) => { const u = toUri(uri); if (u) { return openDiff(u); } });
	reg('openCursor.diff.nextFile', async () => { const s = stepFile(1); if (s) { return reveal(s); } });
	reg('openCursor.diff.prevFile', async () => { const s = stepFile(-1); if (s) { return reveal(s); } });
	reg('openCursor.diff.nextHunk', () => step(1));
	reg('openCursor.diff.prevHunk', () => step(-1));

	// ---- restore after reload --------------------------------------------------------------
	void (async () => {
		const saved = ctx.workspaceState.get<PersistedSession[]>(STATE_KEY) ?? [];
		for (const p of saved) {
			const uri = vscode.Uri.parse(p.uri);
			const cur = p.deleted ? '' : await readCurrent(uri);
			if (cur === undefined) {
				continue;
			}
			if (!p.deleted && cur === p.original) {
				continue;
			}
			const s: Session = { uri, key: p.uri, original: p.original, existed: p.existed, deleted: p.deleted, current: cur, source: p.source, chatId: p.chatId, hunks: [] };
			recompute(s);
			sessions.set(s.key, s);
		}
		if (sessions.size) {
			onDidChange.fire();
		}
		scheduleRender();
	})();

	disposables.push({ dispose() { clearTimeout(renderTimer); clearTimeout(persistTimer); for (const s of sessions.values()) { clearTimeout(s.timer); } } });
	ctx.subscriptions.push(...disposables);
	updateContexts();

	return {
		onDidChange: onDidChange.event,
		applyContent, deleteFile, getFiles, getHunks,
		acceptHunk, rejectHunk, acceptFile, rejectFile, acceptAll, rejectAll, openDiff,
		forget,
	};
}
