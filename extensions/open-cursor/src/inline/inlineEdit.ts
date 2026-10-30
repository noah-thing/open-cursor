/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Cmd+K inline edit. Streams into the document as a pending edit; has a quick input fallback for stock VS Code.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Services } from '../services';
import { FenceParser } from './fence';
import { holdSaves } from '../edits/fileOps';
import { pickInlineModel } from './oneshot';
import { INLINE_SYSTEM, buildInlinePrompt, computeRegion, type Region, type Sel } from './region';

export interface InlineSubmitArgs {
	sessionId: string;
	uri: string;
	selection: Sel;
	prompt: string;
	modelId?: string;
}

interface Session {
	uri: vscode.Uri;
	instructions: string[];
	/** What the user originally selected; Undo puts it back. */
	original: string;
	/** Text around the edited region, and the replacement currently in the document. */
	before: string;
	after: string;
	replacement: string;
	startLine: number;
	kind: Region['kind'];
	applied: boolean;
	/** Replacement before the running follow-up; undefined on the first run. */
	prior?: string;
	abort?: AbortController;
}

const APPLY_INTERVAL_MS = 100;

export function registerInlineEdit(ctx: vscode.ExtensionContext, services: Services): void {
	const sessions = new Map<string, Session>();

	/** The quick input fallback has no core box, so it listens here instead. */
	const listeners = new Map<string, (state: 'generating' | 'done' | 'error', message?: string) => void>();

	async function status(sessionId: string, state: 'generating' | 'done' | 'error', message?: string): Promise<void> {
		listeners.get(sessionId)?.(state, message);
		try { await vscode.commands.executeCommand('_openCursor.inline.status', sessionId, state, message); } catch { /* stock VS Code: no core box */ }
	}

	/**
	 * Re-anchors `s.before` and `s.after` on the replacement after edits elsewhere in the file.
	 * False when the replacement is gone or was edited.
	 */
	async function relocate(s: Session): Promise<boolean> {
		let text: string;
		try { text = (await vscode.workspace.openTextDocument(s.uri)).getText(); } catch { return false; }
		if (text === s.before + s.replacement + s.after) { return true; }
		let idx = -1;
		if (s.replacement) {
			let best = Infinity;
			for (let i = text.indexOf(s.replacement); i >= 0; i = text.indexOf(s.replacement, i + 1)) {
				const d = Math.abs(i - s.before.length);
				if (d < best) { best = d; idx = i; }
			}
		} else if (text.startsWith(s.before)) {
			idx = s.before.length;
		} else if (text.endsWith(s.after)) {
			idx = text.length - s.after.length;
		}
		if (idx < 0) { return false; }
		s.before = text.slice(0, idx);
		s.after = text.slice(idx + s.replacement.length);
		return true;
	}

	/**
	 * Applies the session's replacement without saving the file (partial code must not hit disk or trigger
	 * format on save). `expectedBefore` makes pendingEdits refuse if the buffer moved since we looked, so
	 * keystrokes typed meanwhile are never reverted; on a mismatch we relocate and retry once.
	 */
	async function applyReplacement(s: Session, replacement: string): Promise<boolean> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const release = holdSaves(s.uri);
			try {
				await services.pendingEdits.applyContent(s.uri, s.before + replacement + s.after, 'inline', undefined, undefined, s.before + s.replacement + s.after);
				return true;
			} catch (e) {
				if (attempt === 1 || !/changed since/.test(e instanceof Error ? e.message : '')) { throw e; }
				if (!(await relocate(s))) { return false; }
			} finally {
				release();
			}
		}
		return false;
	}

	function eolOf(doc: vscode.TextDocument): string { return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'; }

	async function submit(args: InlineSubmitArgs): Promise<void> {
		const uri = vscode.Uri.parse(args.uri);
		const doc = await vscode.workspace.openTextDocument(uri);
		const eol = eolOf(doc);
		const model = pickInlineModel(services, args.modelId);
		if (!model) { return void await status(args.sessionId, 'error', 'No model available for inline edits. Add an API key or start a local model.'); }

		let s = sessions.get(args.sessionId);
		s?.abort?.abort();
		const text = doc.getText();
		let region: Region;
		let followUp = false;
		if (s && s.applied && s.uri.toString() === uri.toString()) {
			followUp = true;
			const expected = s.before + s.replacement + s.after;
			let start = s.before.length;
			if (text !== expected) {
				const idx = s.replacement ? text.indexOf(s.replacement) : -1;
				if (idx >= 0) { start = idx; }
				else { return void await status(args.sessionId, 'error', `The edited region changed. Close this box and start a new ${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+K.`); }
			}
			const end = start + s.replacement.length;
			region = { kind: s.kind, start, end, startLine: s.startLine, endLine: s.startLine, before: text.slice(0, start), selected: s.replacement, after: text.slice(end) };
			s.instructions.push(args.prompt);
		} else {
			region = computeRegion(text, args.selection);
			s = { uri, instructions: [args.prompt], original: region.selected, before: region.before, after: region.after, replacement: region.selected, startLine: region.startLine, kind: region.kind, applied: false };
			sessions.set(args.sessionId, s);
		}
		const session = s;
		session.prior = followUp ? session.replacement : undefined;
		const rel = vscode.workspace.asRelativePath(uri, false);
		let rules: { name: string; content: string }[] = [];
		try { rules = (await services.context.getRules([rel])).map(r => ({ name: r.name, content: r.content })); } catch { /* rules are optional */ }

		const prompt = buildInlinePrompt({
			path: rel, languageId: doc.languageId,
			region: { ...region, before: region.before.replace(/\r\n/g, '\n'), selected: region.selected.replace(/\r\n/g, '\n'), after: region.after.replace(/\r\n/g, '\n') },
			instructions: session.instructions, rules,
		});
		const ac = new AbortController();
		session.abort = ac;
		await status(args.sessionId, 'generating');

		const parser = new FenceParser();
		const previousReplacement = session.replacement;
		const toDoc = (code: string) => (eol === '\r\n' ? code.replace(/\r?\n/g, '\r\n') : code);
		let lastApplied: string | undefined = followUp ? previousReplacement : undefined;
		let applying: Promise<void> = Promise.resolve();
		let lost = false;
		const applyNow = (code: string): Promise<void> => {
			if (code === lastApplied) { return applying; }
			lastApplied = code;
			applying = applying.then(async () => {
				if (ac.signal.aborted) { return; }
				if (!(await relocate(session))) { lost = true; ac.abort(); return; }
				const repl = toDoc(code);
				if (!(await applyReplacement(session, repl))) { lost = true; ac.abort(); return; }
				session.replacement = repl;
				session.applied = true;
			}).catch(() => undefined);
			return applying;
		};
		const timer = setInterval(() => { if (parser.opened) { void applyNow(parser.content); } }, APPLY_INTERVAL_MS);
		const maxTokens = Math.min(model.maxOutputTokens || 8192, Math.max(1024, Math.ceil(region.selected.length / 2.5) * 2 + 1024));

		try {
			for await (const ev of services.registry.stream({
				model, system: INLINE_SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
				maxTokens, temperature: 0.2, thinking: false, signal: ac.signal,
			})) {
				if (ev.type === 'text') { parser.push(ev.text); }
				if (ev.type === 'done' && ev.stopReason === 'error') { throw new Error('The model stopped with an error.'); }
			}
			clearInterval(timer);
			if (ac.signal.aborted) { await applying; if (lost) { await status(args.sessionId, 'error', 'File changed during edit'); } return; }
			const finalCode = parser.finish();
			if (!finalCode.trim() && region.selected.trim() === '') { throw new Error('The model returned no code.'); }
			if (!finalCode.trim() && !parser.text.trim()) { throw new Error('The model returned no code.'); }
			await applyNow(finalCode);
			await applying;
			await status(args.sessionId, 'done');
		} catch (err) {
			clearInterval(timer);
			if (ac.signal.aborted) { await applying; if (lost) { await status(args.sessionId, 'error', 'File changed during edit'); } return; }
			await applying;
			// roll back to the last good state so a failed run leaves no half edit
			try {
				if (session.applied && await relocate(session)) {
					const good = followUp ? previousReplacement : undefined;
					if (good !== undefined) {
						await applyReplacement(session, good);
						session.replacement = good;
					} else {
						await applyReplacement(session, session.original);
						session.replacement = session.original;
						session.applied = false;
					}
				}
			} catch { /* best effort */ }
			if (followUp) { session.instructions.pop(); }
			await status(args.sessionId, 'error', err instanceof Error ? err.message : String(err));
		} finally {
			if (session.abort === ac) { session.abort = undefined; }
		}
	}

	async function cancel(sessionId: string): Promise<void> {
		const s = sessions.get(sessionId);
		if (!s?.abort) { return; }
		s.abort.abort();
		s.abort = undefined;
		// aborting mid stream leaves a partial edit
		try {
			if (s.applied && await relocate(s)) {
				if (s.prior === undefined) {
					await applyReplacement(s, s.original);
					s.applied = false;
					s.replacement = '';
				} else {
					await applyReplacement(s, s.prior);
					s.replacement = s.prior;
					s.instructions.pop();
				}
			}
		} catch { /* best effort */ }
	}

	async function accept(sessionId: string): Promise<void> {
		const s = sessions.get(sessionId);
		if (!s) { return; }
		s.abort?.abort();
		sessions.delete(sessionId);
		if (s.applied) {
			await services.pendingEdits.acceptFile(s.uri);
			// the one save, now that the edit is final
			try { const d = await vscode.workspace.openTextDocument(s.uri); if (d.isDirty) { await d.save(); } } catch { /* leave it dirty */ }
		}
	}

	async function reject(sessionId: string): Promise<void> {
		const s = sessions.get(sessionId);
		if (!s) { return; }
		s.abort?.abort();
		sessions.delete(sessionId);
		if (!s.applied) { return; }
		// only the replaced range is undone; the user's edits elsewhere stay
		try {
			if (await relocate(s)) {
				await applyReplacement(s, s.original);
				return;
			}
		} catch { /* report below */ }
		void vscode.window.showWarningMessage('OpenCursor could not undo the inline edit because the file changed around it. Use Undo File in the review bar.');
	}

	async function openFallback(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) { return; }
		const sel = editor.selection;
		const prompt = await vscode.window.showInputBox({
			title: sel.isEmpty ? 'Generate code at cursor' : 'Edit selected code',
			prompt: sel.isEmpty ? 'Describe the code to generate' : 'Describe how to change the selection',
			placeHolder: 'e.g. add error handling',
			ignoreFocusOut: true,
		});
		if (!prompt?.trim()) { return; }
		const sessionId = `fallback-${Date.now().toString(36)}`;
		const failure: { message?: string } = {};
		listeners.set(sessionId, (st, m) => { if (st === 'error') { failure.message = m ?? 'Edit failed'; } });
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'OpenCursor: editing…', cancellable: true }, async (_p, token) => {
			token.onCancellationRequested(() => { void cancel(sessionId); });
			await submit({ sessionId, uri: editor.document.uri.toString(), selection: { startLine: sel.start.line, startCol: sel.start.character, endLine: sel.end.line, endCol: sel.end.character }, prompt });
		});
		listeners.delete(sessionId);
		if (failure.message) { void vscode.window.showErrorMessage(failure.message); return; }
		if (!sessions.get(sessionId)?.applied) { return; }
		const pick = await vscode.window.showInformationMessage('Edit ready.', 'Keep', 'Undo');
		if (pick === 'Keep') { await accept(sessionId); }
		else if (pick === 'Undo') { await reject(sessionId); }
	}

	ctx.subscriptions.push(
		vscode.commands.registerCommand('openCursor.inline.submit', (a: InlineSubmitArgs) => submit(a)),
		vscode.commands.registerCommand('openCursor.inline.cancel', (id: string) => cancel(id)),
		vscode.commands.registerCommand('openCursor.inline.accept', (id: string) => accept(id)),
		vscode.commands.registerCommand('openCursor.inline.reject', (id: string) => reject(id)),
		vscode.commands.registerCommand('openCursor.inline.openFallback', openFallback),
		{ dispose: () => { for (const s of sessions.values()) { s.abort?.abort(); } sessions.clear(); } },
	);
}
