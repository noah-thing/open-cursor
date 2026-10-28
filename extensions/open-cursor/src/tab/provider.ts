/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Cursor-style Tab: debounced, cancellable inline completions over registry.fim (or a tight chat
 *  prompt for models without FIM), typed-through cache, status bar toggle, latency log.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Services } from '../services';
import type { ModelInfo } from '../providers/types';
import {
	CHAT_TAB_SYSTEM, CompletionCache, NEXT_EDIT_SYSTEM, buildChatTabPrompt, buildHeader, buildNextEditPrompt,
	extractWindow, indentOf, numberLines, parseNextEdit, postProcess, restOfLineAllowsTab,
	type Snippet,
} from './logic';

const CFG = 'openCursor.tab';
const MAX_RECENT = 12;
const FIM_STOP = ['\n\n\n', '<|file_sep|>', '<|endoftext|>'];

interface RecentEdit { uri: vscode.Uri; line: number; ts: number }

class LatencyLog {
	private readonly samples: number[] = [];
	constructor(private readonly out: vscode.OutputChannel) { }
	record(kind: string, model: string, ttftMs: number | undefined, totalMs: number, chars: number): void {
		this.samples.push(totalMs);
		if (this.samples.length > 200) { this.samples.shift(); }
		const sorted = [...this.samples].sort((a, b) => a - b);
		const p50 = sorted[Math.floor(sorted.length / 2)];
		this.out.appendLine(`${new Date().toISOString().slice(11, 23)} ${kind} ${model} ttft=${ttftMs === undefined ? '-' : Math.round(ttftMs) + 'ms'} total=${Math.round(totalMs)}ms chars=${chars} p50=${Math.round(p50)}ms n=${sorted.length}`);
	}
	line(s: string): void { this.out.appendLine(`${new Date().toISOString().slice(11, 23)} ${s}`); }
}

function sleep(ms: number, token: vscode.CancellationToken): Promise<boolean> {
	return new Promise(resolve => {
		const t = setTimeout(() => { sub.dispose(); resolve(true); }, ms);
		const sub = token.onCancellationRequested(() => { clearTimeout(t); sub.dispose(); resolve(false); });
	});
}

export function registerTab(ctx: vscode.ExtensionContext, services: Services): void {
	const out = vscode.window.createOutputChannel('Open Cursor Tab');
	const log = new LatencyLog(out);
	const cache = new CompletionCache();
	const recent: RecentEdit[] = [];
	let current: AbortController | undefined;
	let lastEditDiff = '';
	const changeEmitter = new vscode.EventEmitter<vscode.InlineCompletionChangeHint | void>();
	const cfg = () => vscode.workspace.getConfiguration(CFG);

	// ---- recent edits ring buffer --------------------------------------------------------
	ctx.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
		if ((e.document.uri.scheme !== 'file' && e.document.uri.scheme !== 'untitled') || e.contentChanges.length === 0) { return; }
		const c = e.contentChanges[0];
		const last = recent[0];
		if (last && last.uri.toString() === e.document.uri.toString() && Math.abs(last.line - c.range.start.line) <= 2) {
			last.line = c.range.start.line; last.ts = Date.now();
		} else {
			recent.unshift({ uri: e.document.uri, line: c.range.start.line, ts: Date.now() });
			if (recent.length > MAX_RECENT) { recent.length = MAX_RECENT; }
		}
		const rel = vscode.workspace.asRelativePath(e.document.uri, false);
		const removed = e.document.lineCount > 0 ? c.rangeLength : 0;
		lastEditDiff = `${rel}:${c.range.start.line + 1}: replaced ${removed} chars with ${JSON.stringify(c.text.slice(0, 300))}`;
	}));

	function gatherSnippets(doc: vscode.TextDocument, cursorLine: number): Snippet[] {
		const snippets: Snippet[] = [];
		const seen = new Set<string>();
		const take = (d: vscode.TextDocument, from: number, to: number) => {
			const key = `${d.uri.toString()}:${Math.floor(from / 10)}`;
			if (seen.has(key)) { return; }
			seen.add(key);
			const a = Math.max(0, from);
			const b = Math.min(d.lineCount - 1, to);
			if (b < a) { return; }
			const text = d.getText(new vscode.Range(a, 0, b, d.lineAt(b).text.length)).slice(0, 500);
			if (text.trim()) { snippets.push({ path: vscode.workspace.asRelativePath(d.uri, false), text }); }
		};
		for (const r of recent) {
			if (snippets.length >= 3) { break; }
			const d = vscode.workspace.textDocuments.find(x => x.uri.toString() === r.uri.toString());
			if (!d || d.isClosed) { continue; }
			if (d.uri.toString() === doc.uri.toString() && Math.abs(r.line - cursorLine) < 40) { continue; }
			take(d, r.line - 2, r.line + 5);
		}
		for (const ed of vscode.window.visibleTextEditors) {
			if (snippets.length >= 4) { break; }
			if (ed.document.uri.toString() === doc.uri.toString() || ed.document.uri.scheme !== 'file') { continue; }
			const vr = ed.visibleRanges[0];
			if (vr) { take(ed.document, vr.start.line, Math.min(vr.end.line, vr.start.line + 12)); }
		}
		return snippets;
	}

	// ---- model selection -----------------------------------------------------------------
	function tabModel(): ModelInfo | undefined { return services.registry.getDefaultModel('tab'); }

	// ---- provider ------------------------------------------------------------------------
	const provider: vscode.InlineCompletionItemProvider = {
		onDidChange: changeEmitter.event,

		async provideInlineCompletionItems(doc, pos, context, token) {
			const c = cfg();
			if (!c.get<boolean>('enabled', true)) { return undefined; }
			if (c.get<string[]>('disabledLanguages', ['plaintext', 'scminput']).includes(doc.languageId)) { return undefined; }
			if (context.selectedCompletionInfo) { return undefined; }
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document === doc && !editor.selection.isEmpty) { return undefined; }
			if (doc.uri.scheme === 'output' || doc.uri.scheme === 'vscode-terminal') { return undefined; }

			const line = doc.lineAt(pos.line).text;
			const linePrefix = line.slice(0, pos.character);
			const lineSuffix = line.slice(pos.character);
			const automatic = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;
			if (automatic && !restOfLineAllowsTab(lineSuffix)) { return undefined; }

			const text = doc.getText();
			const offset = doc.offsetAt(pos);
			const fileKey = doc.uri.toString();
			const prefixAll = text.slice(0, offset);
			const suffixAll = text.slice(offset);

			const cached = cache.get(fileKey, prefixAll, suffixAll);
			if (cached) {
				log.line(`cache hit ${cached.length} chars`);
				return [new vscode.InlineCompletionItem(cached, new vscode.Range(pos, pos))];
			}

			// Next edit chain after an accepted completion (experimental).
			const hint = (context as { changeHint?: { data?: unknown } }).changeHint;
			if (hint?.data === 'accepted' && c.get<boolean>('nextEdit', false)) {
				const ne = await predictNextEdit(doc, pos, token);
				if (ne) { return ne; }
			}

			const debounce = Math.max(0, c.get<number>('debounceMs', 75));
			if (debounce > 0 && !(await sleep(debounce, token))) { return undefined; }
			if (token.isCancellationRequested) { return undefined; }

			const model = tabModel();
			if (!model) { return undefined; }

			current?.abort();
			const ac = new AbortController();
			current = ac;
			const sub = token.onCancellationRequested(() => ac.abort());
			const t0 = performance.now();
			try {
				const maxLines = Math.max(1, c.get<number>('maxLines', 10));
				const win = extractWindow(text, offset);
				const header = buildHeader(vscode.workspace.asRelativePath(doc.uri, false), doc.languageId, gatherSnippets(doc, pos.line));
				const baseIndent = indentOf(line);
				const midLine = lineSuffix.trim() !== '';
				const maxTokens = Math.min(512, Math.max(32, maxLines * 24));
				let raw = '';
				let ttft: number | undefined;
				let result = '';
				const finishRaw = (final: boolean) => postProcess(raw, { maxLines, baseIndent, midLine, final, linePrefix, suffix: suffixAll });
				const consume = (chunk: string): boolean => {
					if (ttft === undefined) { ttft = performance.now() - t0; }
					raw += chunk;
					const r = finishRaw(false);
					return r.stopped;
				};
				if (model.supportsFim) {
					const stream = services.registry.fim({
						model, prefix: header + win.prefix, suffix: win.suffix, maxTokens, stop: FIM_STOP, temperature: 0.1, signal: ac.signal,
					});
					for await (const chunk of stream) {
						if (token.isCancellationRequested) { return undefined; }
						if (consume(chunk)) { ac.abort(); break; }
					}
				} else {
					const user = buildChatTabPrompt(header, win.prefix, win.suffix);
					const stream = services.registry.stream({
						model, system: CHAT_TAB_SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
						maxTokens, temperature: 0, thinking: false, signal: ac.signal,
					});
					for await (const ev of stream) {
						if (token.isCancellationRequested) { return undefined; }
						if (ev.type === 'text' && consume(ev.text)) { ac.abort(); break; }
						if (ev.type === 'done') { break; }
					}
				}
				if (token.isCancellationRequested) { return undefined; }
				result = finishRaw(true).text;
				log.record(model.supportsFim ? 'fim' : 'chat', model.id, ttft, performance.now() - t0, result.length);
				if (!result.trim()) { return undefined; }
				cache.put(fileKey, prefixAll, suffixAll, result);
				return [new vscode.InlineCompletionItem(result, new vscode.Range(pos, pos))];
			} catch (err) {
				if (ac.signal.aborted || token.isCancellationRequested) {
					// Aborted early because the boundary was reached: use what we have.
					return undefined;
				}
				log.line(`error ${err instanceof Error ? err.message : String(err)}`);
				return undefined;
			} finally {
				sub.dispose();
				if (current === ac) { current = undefined; }
			}
		},

		handleEndOfLifetime(item, reason) {
			if (reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Accepted && !item.isInlineEdit && cfg().get<boolean>('nextEdit', false)) {
				changeEmitter.fire({ data: 'accepted' });
			}
		},
	};

	// ---- next edit (experimental, proposed inlineCompletionsAdditions) -----------------------
	async function predictNextEdit(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.InlineCompletionItem[] | undefined> {
		const model = services.registry.getDefaultModel('inline');
		if (!model || !lastEditDiff || doc.lineCount > 4000) { return undefined; }
		const ac = new AbortController();
		const sub = token.onCancellationRequested(() => ac.abort());
		const t0 = performance.now();
		try {
			const from = Math.max(0, pos.line - 120);
			const to = Math.min(doc.lineCount - 1, pos.line + 160);
			const body = doc.getText(new vscode.Range(from, 0, to, doc.lineAt(to).text.length));
			const prompt = buildNextEditPrompt(vscode.workspace.asRelativePath(doc.uri, false), numberLines(body, from + 1), lastEditDiff, pos.line + 1);
			let raw = '';
			for await (const ev of services.registry.stream({ model, system: NEXT_EDIT_SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens: 600, temperature: 0, thinking: false, signal: ac.signal })) {
				if (ev.type === 'text') { raw += ev.text; }
			}
			log.record('next-edit', model.id, undefined, performance.now() - t0, raw.length);
			const ne = parseNextEdit(raw, doc.lineCount);
			if (!ne || token.isCancellationRequested) { return undefined; }
			const range = new vscode.Range(ne.startLine - 1, 0, ne.endLine - 1, doc.lineAt(ne.endLine - 1).text.length);
			if (doc.getText(range) === ne.text) { return undefined; }
			const item = new vscode.InlineCompletionItem(ne.text, range);
			item.isInlineEdit = true;
			item.showRange = new vscode.Range(Math.min(pos.line, range.start.line), 0, Math.max(pos.line, range.end.line), 0);
			item.jumpToPosition = range.start;
			return [item];
		} catch {
			return undefined;
		} finally {
			sub.dispose();
		}
	}

	let registration: vscode.Disposable;
	try {
		registration = vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider, { displayName: 'Open Cursor Tab', debounceDelayMs: 0 });
	} catch {
		// Proposed API not enabled (stock VS Code): plain registration.
		registration = vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider);
	}
	ctx.subscriptions.push(registration, out, changeEmitter);

	// ---- status bar ----------------------------------------------------------------------
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	item.command = 'openCursor.tab.toggle';
	function refresh(): void {
		const on = cfg().get<boolean>('enabled', true);
		const m = tabModel();
		item.text = on ? '$(sparkle) Tab' : '$(circle-slash) Tab';
		item.tooltip = new vscode.MarkdownString(on
			? `Open Cursor Tab is **on**${m ? ` (${m.label || m.id})` : ' (no model available)'}. Click to turn off.`
			: 'Open Cursor Tab is **off**. Click to turn on.');
		item.backgroundColor = on && !m ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
		item.show();
	}
	refresh();
	ctx.subscriptions.push(
		item,
		services.registry.onDidChangeModels(refresh),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CFG) || e.affectsConfiguration('openCursor.models')) { refresh(); }
			if (e.affectsConfiguration(CFG + '.enabled')) { current?.abort(); }
		}),
		vscode.commands.registerCommand('openCursor.tab.toggle', async () => {
			const on = cfg().get<boolean>('enabled', true);
			await cfg().update('enabled', !on, vscode.ConfigurationTarget.Global);
		}),
		vscode.commands.registerCommand('openCursor.tab.showLog', () => out.show(true)),
		vscode.commands.registerCommand('openCursor.tab.trigger', () => vscode.commands.executeCommand('editor.action.inlineSuggest.trigger')),
	);
}
