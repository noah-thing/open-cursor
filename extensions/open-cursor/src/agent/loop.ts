/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  The native agent loop: stream a model turn, run its tool calls, feed the results back, repeat.
 *--------------------------------------------------------------------------------------------*/

import type { ChatRequest, LLMContent, LLMMessage, ModelInfo, StreamEvent } from '../providers/types';
import { ProviderError } from '../providers/types';
import type { IProviderRegistry, Services } from '../services';
import type { ChatMode, ToolPart } from '../shared/protocol';
import { needsApproval, suggestAllowPrefix, type ApprovalPolicy } from './approval';
import { transcriptMessages, type TranscriptEntry } from './history';
import {
	applySummary, appendUserContent, capText, chooseSplit, estimateRequestTokens, pruneOldToolResults, renderForSummary,
} from './tokens';
import {
	DEBUG_MARKER, cleanupReminder, formatTodoState, openTodos, toolBlockedReason, turnEndReminders, type MarkerHit,
} from './modes';
import type { ToolContext, ToolDef, ToolResult } from './tools/types';
import type { ToolSet } from './tools';

export interface LoopSettings {
	readonly maxIterations: number;
	readonly thinking: boolean;
	getPolicy(): ApprovalPolicy;
	addSessionAllow(prefix: string): void;
}

export interface LoopHooks {
	onText(delta: string): void;
	onThinking(delta: string): void;
	/** Thinking block is finished (first text or tool call after it). */
	onThinkingDone(): void;
	/** Insert or replace a tool row (matched by id). */
	onToolPart(part: ToolPart): void;
	requestApproval(part: ToolPart): Promise<'run' | 'skip' | 'allowAlways'>;
	onUsage(u: { inputTokens: number; outputTokens: number }): void;
	onContextUsage(used: number, limit: number): void;
	/** The transcript changed and should be persisted. */
	onTranscript(): void;
	onError(message: string, action?: 'openSettings' | 'retry'): void;
}

export interface LoopParams {
	readonly services: Services;
	readonly chatId: string;
	readonly mode: ChatMode;
	readonly model: ModelInfo;
	readonly system: string;
	/** Includes the new user message as its last entry. Mutated: assistant and tool result messages are appended. */
	readonly transcript: TranscriptEntry[];
	readonly turn: string;
	readonly tools: ToolSet;
	readonly toolCtx: Omit<ToolContext, 'signal' | 'onProgress' | 'mode' | 'services' | 'chatId'>;
	readonly settings: LoopSettings;
	readonly hooks: LoopHooks;
	readonly signal: AbortSignal;
}

export type StopReason = 'done' | 'aborted' | 'error' | 'max_iterations';

const MAX_TOOL_RESULT_CHARS = 40000;
const UI_OUTPUT_CHARS = 8000;
const COMPACT_THRESHOLD = 0.8;

const SUMMARY_SYSTEM = 'You compress a coding assistant conversation so work can continue after older messages are dropped. Write a dense, factual summary in markdown with these sections: Goal (the user\'s original request and any later changes, near verbatim), Done (files changed with what changed, commands run and their outcomes), Findings (facts about the codebase that matter: paths, function names, conventions, errors seen), State (what is in progress, open problems, next step). Keep exact paths, identifiers, commands and error messages. No preamble.';

export function toolPartBase(call: { id: string; name: string }, tool: ToolDef | undefined, args: Record<string, unknown>, status: ToolPart['status']): ToolPart {
	return { type: 'tool', id: call.id, name: call.name, args, status, title: tool ? safeTitle(tool, args, status) : call.name };
}

function safeTitle(tool: ToolDef, args: Record<string, unknown>, status: ToolPart['status'], result?: ToolResult): string {
	try {
		return tool.title(args, status, result);
	} catch {
		return tool.schema.name;
	}
}

function asArgs(input: unknown): Record<string, unknown> | undefined {
	if (input && typeof input === 'object' && !Array.isArray(input)) { return input as Record<string, unknown>; }
	if (typeof input === 'string') {
		try {
			const p: unknown = JSON.parse(input);
			return p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : undefined;
		} catch { return undefined; }
	}
	return input === undefined || input === null ? {} : undefined;
}

/** Best effort parse of a partially streamed JSON object so the UI can show the target path early. */
export function parsePartialJson(text: string): Record<string, unknown> | undefined {
	const t = text.trim();
	if (!t.startsWith('{')) { return undefined; }
	for (const closer of ['', '}', '"}', '"]}', '}}']) {
		try {
			const v: unknown = JSON.parse(t + closer);
			if (v && typeof v === 'object') { return v as Record<string, unknown>; }
		} catch { /* try next */ }
	}
	return undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		if (signal.aborted) { resolve(); return; }
		const t = setTimeout(done, ms);
		function done(): void { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
		signal.addEventListener('abort', done, { once: true });
	});
}

async function collectText(registry: IProviderRegistry, req: ChatRequest): Promise<string> {
	let out = '';
	for await (const ev of registry.stream(req)) {
		if (ev.type === 'text') { out += ev.text; }
		if (ev.type === 'done' && ev.stopReason === 'error') { throw new Error('summary request failed'); }
	}
	return out.trim();
}

/** Summarise `older` with the model. Falls back to a mechanical note if the call fails. */
export async function summarizeMessages(registry: IProviderRegistry, model: ModelInfo, older: LLMMessage[], signal: AbortSignal): Promise<string> {
	try {
		const text = await collectText(registry, {
			model, system: SUMMARY_SYSTEM, signal, maxTokens: Math.min(3000, model.maxOutputTokens || 3000),
			messages: [{ role: 'user', content: [{ type: 'text', text: `Conversation to compress:\n\n${renderForSummary(older)}` }] }],
		});
		if (text) { return text; }
	} catch {
		if (signal.aborted) { throw new Error('aborted'); }
	}
	const firstUser = older.find(m => m.role === 'user')?.content.find(c => c.type === 'text');
	return `(Automatic summary unavailable; older messages were dropped.)\nOriginal request: ${firstUser && firstUser.type === 'text' ? capText(firstUser.text, 3000) : 'unknown'}`;
}

/**
 * Compacts the transcript in place: summarises everything before the split point and keeps the recent
 * turns verbatim. Returns false when nothing could be compacted.
 */
export async function compactTranscript(registry: IProviderRegistry, model: ModelInfo, transcript: TranscriptEntry[], signal: AbortSignal, keepTurns = 3): Promise<boolean> {
	const messages = transcriptMessages(transcript);
	const split = chooseSplit(messages, keepTurns);
	if (split === undefined) { return false; }
	const older = messages.slice(0, split);
	const summary = await summarizeMessages(registry, model, older, signal);
	if (signal.aborted) { return false; }
	const keptEntries = transcript.slice(split);
	const merged = applySummary(summary, keptEntries.map(e => e.msg));
	const mergesIntoFirst = keptEntries[0]?.msg.role === 'user';
	const next: TranscriptEntry[] = merged.map((msg, i) => ({
		msg,
		turn: mergesIntoFirst ? keptEntries[i].turn : i === 0 ? 'summary' : keptEntries[i - 1].turn,
	}));
	transcript.splice(0, transcript.length, ...next);
	return true;
}

function describeError(e: unknown, provider: string): { message: string; action?: 'openSettings' | 'retry'; kind: string } {
	if (e instanceof ProviderError) {
		switch (e.kind) {
			case 'auth': {
				const said = (e.message || 'Authentication failed').replace(/[.\s]+$/, '');
				return { kind: 'auth', message: /no api key/i.test(said) ? `${said}. Add one in Settings, or pick a subscription you are signed in to from the model menu.` : `${said}. The ${e.provider} key was refused; check it in Settings.`, action: 'openSettings' };
			}
			case 'rate': return { kind: 'rate', message: `Rate limited by ${e.provider}: ${e.message}`, action: 'retry' };
			case 'context': return { kind: 'context', message: `The conversation is too long for this model: ${e.message}`, action: 'retry' };
			case 'network': return { kind: 'network', message: `Network error talking to ${e.provider}: ${e.message}`, action: 'retry' };
			default: return { kind: 'other', message: e.message || `Request to ${e.provider} failed`, action: 'retry' };
		}
	}
	const m = e instanceof Error ? e.message : String(e);
	return { kind: 'other', message: m || `Request to ${provider} failed`, action: 'retry' };
}

/** What happened this turn, for the checks that decide whether the turn may end. */
export interface TurnTracking {
	readonly edited: Set<string>;
	/** Debug: marker lines per file before this turn first touched it. */
	readonly baseline: Map<string, number>;
	lintsRun: boolean;
	todoWritten: boolean;
	readonly sent: Set<string>;
	cleanupAttempts: number;
}

export const MAX_CLEANUP_REMINDERS = 3;

interface PendingCall { id: string; name: string; argsText: string; input?: unknown; finished: boolean; shown: boolean }

export async function runAgentLoop(p: LoopParams): Promise<StopReason> {
	const { services, model, hooks, signal, transcript, settings } = p;
	const registry = services.registry;
	const limit = model.contextWindow > 0 ? model.contextWindow : 128000;
	const recentCalls: string[] = [];
	let continuations = 0;
	let forcedCompaction = false;
	let iterations = 0;

	const push = (msg: LLMMessage): void => {
		if (msg.role === 'user') {
			const last = transcript[transcript.length - 1];
			if (last && last.msg.role === 'user') {
				const msgs = transcriptMessages(transcript);
				appendUserContent(msgs, msg.content);
				transcript[transcript.length - 1] = { turn: last.turn, msg: msgs[msgs.length - 1] };
				return;
			}
		}
		transcript.push({ turn: p.turn, msg });
	};

	const manageContext = async (force: boolean): Promise<void> => {
		let est = estimateRequestTokens(p.system, transcriptMessages(transcript), p.tools.schemas);
		hooks.onContextUsage(est, limit);
		if (!force && est <= limit * COMPACT_THRESHOLD) { return; }
		const pruned = pruneOldToolResults(transcriptMessages(transcript), 8, 800);
		pruned.forEach((m, i) => { transcript[i] = { turn: transcript[i].turn, msg: m }; });
		est = estimateRequestTokens(p.system, pruned, p.tools.schemas);
		if (!force && est <= limit * COMPACT_THRESHOLD) { hooks.onContextUsage(est, limit); return; }
		const id = `summarize_${Date.now()}`;
		hooks.onToolPart({ type: 'tool', id, name: 'summarize', status: 'running', title: 'Summarizing earlier context' });
		let ok = false;
		try {
			ok = await compactTranscript(registry, model, transcript, signal, force ? 1 : 3);
		} catch { ok = false; }
		hooks.onToolPart({ type: 'tool', id, name: 'summarize', status: ok ? 'done' : 'cancelled', title: ok ? 'Summarized earlier context' : 'Could not summarize context' });
		if (ok) {
			hooks.onTranscript();
			est = estimateRequestTokens(p.system, transcriptMessages(transcript), p.tools.schemas);
			hooks.onContextUsage(est, limit);
		}
	};

	const tracking: TurnTracking = { edited: new Set(), baseline: new Map(), lintsRun: false, todoWritten: false, sent: new Set(), cleanupAttempts: 0 };

	// A todo list left open (typically by a Plan turn the user just pressed Build on) is handed to the model with the message.
	if (p.mode !== 'ask') {
		const todos = p.toolCtx.getTodos();
		if (openTodos(todos).length) { push({ role: 'user', content: [{ type: 'text', text: formatTodoState(todos, p.mode) }] }); }
	}

	// Small local reasoning models sometimes spend the whole budget thinking and never answer.
	// When that happens the turn is retried once with thinking off.
	let thinkingOff = false;

	while (true) {
		if (signal.aborted) { return 'aborted'; }
		if (iterations >= settings.maxIterations) {
			hooks.onError(`Stopped after ${settings.maxIterations} steps. Send a message such as "continue" to keep going, or raise openCursor.agent.maxIterations.`);
			return 'max_iterations';
		}
		iterations++;
		await manageContext(false);
		if (signal.aborted) { return 'aborted'; }

		// retry the model call only while nothing has been emitted yet
		const calls = new Map<string, PendingCall>();
		let text = '';
		let thinking = '';
		let signature: string | undefined;
		let stopReason: Extract<StreamEvent, { type: 'done' }>['stopReason'] | undefined;
		let emitted = false;
		let thinkingOpen = false;
		let attempt = 0;
		let failure: unknown;

		for (;;) {
			calls.clear(); text = ''; thinking = ''; signature = undefined; stopReason = undefined; failure = undefined;
			const req: ChatRequest = {
				model, system: p.system, messages: transcriptMessages(transcript), tools: p.tools.schemas.length ? p.tools.schemas : undefined,
				maxTokens: Math.min(model.maxOutputTokens || 8192, 32000), thinking: !thinkingOff && settings.thinking && model.supportsThinking, signal,
			};
			try {
				for await (const ev of registry.stream(req)) {
					if (signal.aborted) { break; }
					switch (ev.type) {
						case 'thinking':
							emitted = true; thinkingOpen = true; thinking += ev.text; hooks.onThinking(ev.text); break;
						case 'thinking_signature': signature = ev.signature; break;
						case 'text':
							emitted = true;
							if (thinkingOpen) { thinkingOpen = false; hooks.onThinkingDone(); }
							text += ev.text; hooks.onText(ev.text); break;
						case 'tool_call_start': {
							emitted = true;
							if (thinkingOpen) { thinkingOpen = false; hooks.onThinkingDone(); }
							calls.set(ev.id, { id: ev.id, name: ev.name, argsText: '', finished: false, shown: false });
							hooks.onToolPart(toolPartBase({ id: ev.id, name: ev.name }, p.tools.byName.get(ev.name), {}, 'streaming'));
							break;
						}
						case 'tool_call_delta': {
							const c = calls.get(ev.id);
							if (c) {
								c.argsText += ev.argsDelta;
								if (!c.shown && c.argsText.length < 6000) {
									const partial = parsePartialJson(c.argsText);
									if (partial && Object.keys(partial).length) {
										c.shown = true;
										hooks.onToolPart(toolPartBase(c, p.tools.byName.get(c.name), partial, 'streaming'));
									}
								}
							}
							break;
						}
						case 'tool_call': {
							emitted = true;
							const c = calls.get(ev.id) ?? { id: ev.id, name: ev.name, argsText: '', finished: false, shown: false };
							c.name = ev.name || c.name; c.input = ev.input; c.finished = true;
							calls.set(ev.id, c);
							break;
						}
						case 'usage': hooks.onUsage({ inputTokens: ev.inputTokens, outputTokens: ev.outputTokens }); break;
						case 'done': stopReason = ev.stopReason; break;
					}
				}
			} catch (e) {
				failure = e;
			}
			if (thinkingOpen) { thinkingOpen = false; hooks.onThinkingDone(); }
			if (signal.aborted) { break; }
			if (!failure) { break; }

			const info = describeError(failure, model.provider);
			if (info.kind === 'context' && !forcedCompaction) {
				forcedCompaction = true;
				await manageContext(true);
				continue;
			}
			if (!emitted && attempt < 3 && (info.kind === 'rate' || info.kind === 'network')) {
				attempt++;
				await sleep(attempt * 2500, signal);
				if (signal.aborted) { break; }
				continue;
			}
			break;
		}

		if (signal.aborted) {
			// keep what the user saw as model history, without half finished tool calls
			if (text.trim()) { push({ role: 'assistant', content: [{ type: 'text', text }] }); }
			for (const c of calls.values()) {
				hooks.onToolPart({ type: 'tool', id: c.id, name: c.name, status: 'cancelled', title: c.name });
			}
			hooks.onTranscript();
			return 'aborted';
		}
		if (failure) {
			// drop calls from the failed turn; keep any text the user already saw out of the model history
			const info = describeError(failure, model.provider);
			for (const c of calls.values()) {
				hooks.onToolPart({ type: 'tool', id: c.id, name: c.name, status: 'cancelled', title: p.tools.byName.get(c.name)?.schema.name ?? c.name });
			}
			if (text.trim()) { push({ role: 'assistant', content: [{ type: 'text', text }] }); hooks.onTranscript(); }
			hooks.onError(info.message, info.action);
			return 'error';
		}

		const finished = [...calls.values()].filter(c => c.finished);
		for (const c of calls.values()) {
			if (!c.finished) { hooks.onToolPart({ type: 'tool', id: c.id, name: c.name, status: 'cancelled', title: c.name }); }
		}
		const content: LLMContent[] = [];
		if (thinking && signature) { content.push({ type: 'thinking', text: thinking, signature }); }
		if (text) { content.push({ type: 'text', text }); }
		for (const c of finished) { content.push({ type: 'tool_use', id: c.id, name: c.name, input: asArgs(c.input) ?? {} }); }

		if (!text && !finished.length && thinking && !thinkingOff && stopReason !== 'error') {
			thinkingOff = true;
			continue;
		}
		if (!content.length) {
			hooks.onError(stopReason === 'error' ? 'The model stream ended with an error.' : 'The model returned an empty response.', 'retry');
			return 'error';
		}
		push({ role: 'assistant', content });
		hooks.onTranscript();

		if (!finished.length) {
			if (stopReason === 'max_tokens' && continuations < 2) {
				continuations++;
				push({ role: 'user', content: [{ type: 'text', text: 'Your previous response was cut off by the output limit. Continue exactly where you left off.' }] });
				hooks.onTranscript();
				continue;
			}
			const reminder = await endOfTurnReminder(p, tracking, text);
			if (reminder) {
				push({ role: 'user', content: [{ type: 'text', text: reminder }] });
				hooks.onTranscript();
				continue;
			}
			return 'done';
		}

		// consecutive readonly calls run in parallel, mutating ones one at a time
		const results = new Map<string, LLMContent>();
		const runCall = async (c: PendingCall): Promise<void> => {
			results.set(c.id, await executeCall(c));
		};
		const executeCall = (c: PendingCall): Promise<LLMContent> => executeToolCall(p, c, recentCalls, tracking);
		let i = 0;
		while (i < finished.length) {
			if (signal.aborted) { break; }
			const tool = p.tools.byName.get(finished[i].name);
			if (tool?.readOnly) {
				const group: PendingCall[] = [];
				while (i < finished.length && p.tools.byName.get(finished[i].name)?.readOnly) { group.push(finished[i++]); }
				await Promise.all(group.map(runCall));
			} else {
				await runCall(finished[i++]);
			}
		}
		// every tool_use needs a result, even when we were stopped
		const blocks: LLMContent[] = finished.map(c => results.get(c.id) ?? { type: 'tool_result', toolUseId: c.id, content: 'Cancelled by the user before it ran.', isError: true });
		for (const c of finished) {
			if (!results.has(c.id)) {
				hooks.onToolPart({ ...toolPartBase(c, p.tools.byName.get(c.name), asArgs(c.input) ?? {}, 'cancelled'), title: `Cancelled ${c.name}` });
			}
		}
		push({ role: 'user', content: blocks });
		hooks.onTranscript();
		if (signal.aborted) { return 'aborted'; }
	}
}

async function executeToolCall(p: LoopParams, c: PendingCall, recent: string[], tracking: TurnTracking): Promise<LLMContent> {
	const { hooks, signal } = p;
	const tool = p.tools.byName.get(c.name);
	const args = asArgs(c.input);
	const fail = (message: string, title?: string): LLMContent => {
		hooks.onToolPart({ type: 'tool', id: c.id, name: c.name, args: args ?? {}, status: 'error', title: title ?? `${c.name} failed`, output: message });
		return { type: 'tool_result', toolUseId: c.id, content: message, isError: true };
	};
	if (!tool) {
		const available = [...p.tools.byName.keys()].join(', ');
		return fail(`Unknown tool "${c.name}" in ${p.mode} mode. Available tools: ${available}.`, `Unknown tool ${c.name}`);
	}
	if (!args) { return fail(`Arguments for ${c.name} must be a JSON object.`); }
	// the tool set already leaves write tools out of Plan and Ask; this is the second lock
	const blocked = toolBlockedReason(p.mode, { name: c.name, readOnly: tool.readOnly }, args);
	if (blocked) { return fail(blocked, `${c.name} blocked in ${p.mode} mode`); }

	let part: ToolPart = toolPartBase(c, tool, args, 'running');
	const isCommand = c.name === 'run_terminal_cmd';
	const policy = p.settings.getPolicy();
	const command = isCommand && typeof args.command === 'string' ? args.command : undefined;
	// MCP tools reach outside the editor: ask unless the user chose Full access. fetch_url only reads, so Auto lets it through.
	const mcpAsk = (c.name.startsWith('mcp_') || (c.name === 'fetch_url' && policy.autoRun !== 'auto')) && policy.autoRun !== 'always';
	const agentSaysAsk = typeof args.requires_approval === 'boolean' ? args.requires_approval : undefined;
	if ((command !== undefined && needsApproval(command, policy, agentSaysAsk)) || mcpAsk) {
		part = {
			...toolPartBase(c, tool, args, 'awaiting-approval'),
			command: command !== undefined ? { text: command, cwd: typeof args.cwd === 'string' ? args.cwd : undefined, background: args.is_background === true } : undefined,
			title: command !== undefined ? tool.title(args, 'awaiting-approval') : `Allow ${tool.title(args, 'running')}?`,
		};
		hooks.onToolPart(part);
		const abortWait = new Promise<'skip'>(res => { if (signal.aborted) { res('skip'); } else { signal.addEventListener('abort', () => res('skip'), { once: true }); } });
		const decision = await Promise.race([hooks.requestApproval(part), abortWait]).catch((): 'skip' => 'skip');
		if (signal.aborted) {
			hooks.onToolPart({ ...part, status: 'cancelled', title: safeTitle(tool, args, 'rejected') });
			return { type: 'tool_result', toolUseId: c.id, content: 'Cancelled by the user.', isError: true };
		}
		if (decision === 'skip') {
			hooks.onToolPart({ ...part, status: 'rejected', title: safeTitle(tool, args, 'rejected') });
			return { type: 'tool_result', toolUseId: c.id, content: 'The user declined to run this. Do not retry the same action; ask what they would prefer or take a different approach.', isError: true };
		}
		if (decision === 'allowAlways' && command !== undefined) { p.settings.addSessionAllow(suggestAllowPrefix(command)); }
		part = { ...part, status: 'running', title: tool.title(args, 'running') };
	}
	hooks.onToolPart(part);

	const started = Date.now();
	let lastProgress = 0;
	const ctx: ToolContext = {
		...toolContext(p),
		onProgress: (output: string) => {
			const now = Date.now();
			if (now - lastProgress > 100) { lastProgress = now; hooks.onToolPart({ ...part, output }); }
		},
	};
	const editedPath = (c.name === 'edit_file' || c.name === 'write_file') && typeof args.path === 'string' ? args.path : undefined;
	if (p.mode === 'debug' && editedPath !== undefined && !tracking.baseline.has(editedPath)) {
		tracking.baseline.set(editedPath, (await markerHits(p, editedPath)).length);
	}
	let res: ToolResult;
	try {
		res = await tool.run(args, ctx);
	} catch (e) {
		res = { content: `Tool ${c.name} threw: ${e instanceof Error ? e.message : String(e)}`, isError: true };
	}
	const durationMs = Date.now() - started;
	if (!res.isError) {
		if (editedPath !== undefined) { tracking.edited.add(editedPath); }
		if (c.name === 'read_lints') { tracking.lintsRun = true; }
		if (c.name === 'todo_write') { tracking.todoWritten = true; }
	}
	if (signal.aborted && res.isError) {
		hooks.onToolPart({ ...part, status: 'cancelled', title: safeTitle(tool, args, 'cancelled', res), output: res.output ?? res.content, durationMs });
		return { type: 'tool_result', toolUseId: c.id, content: res.content, isError: true };
	}
	const status: ToolPart['status'] = res.isError ? 'error' : 'done';
	let content = capText(res.content, MAX_TOOL_RESULT_CHARS);
	let images = res.images;
	if (images?.length && !p.model.supportsImages) {
		content += '\n[Image omitted: the current model cannot view images.]';
		images = undefined;
	}
	// nudge the model out of loops
	const sig = `${c.name}:${JSON.stringify(args)}`;
	recent.push(sig);
	if (recent.length > 6) { recent.shift(); }
	if (recent.length >= 3 && recent.slice(-3).every(s => s === sig) && !c.name.startsWith('todo')) {
		content += '\n[Note: you have made this exact call 3 times in a row. Change your approach.]';
	}
	hooks.onToolPart({
		...part, status, title: safeTitle(tool, args, status, res), durationMs,
		output: capText(res.output ?? res.content, UI_OUTPUT_CHARS), edit: res.edit,
	});
	return { type: 'tool_result', toolUseId: c.id, content, isError: res.isError || undefined, images };
}

function toolContext(p: LoopParams): ToolContext {
	return { ...p.toolCtx, services: p.services, chatId: p.chatId, mode: p.mode, signal: p.signal };
}

/** Lines holding the Debug marker in one file, found with the grep tool (so the loop needs no file system of its own). */
async function markerHits(p: LoopParams, path: string): Promise<MarkerHit[]> {
	const grep = p.tools.byName.get('grep');
	if (!grep) { return []; }
	try {
		const r = await grep.run({ pattern: DEBUG_MARKER, path, output_mode: 'content' }, toolContext(p));
		if (r.isError) { return []; }
		const hits: MarkerHit[] = [];
		for (const line of r.content.split('\n')) {
			const m = /^(.+?):(\d+):/.exec(line);
			if (m) { hits.push({ path: m[1], line: Number(m[2]) }); }
		}
		return hits;
	} catch {
		return [];
	}
}

/**
 * Called when the model wants to end the turn. Returns a message that sends it back to work, or
 * undefined when the turn may end. Debug cannot end while marker lines it added are still there
 * (up to MAX_CLEANUP_REMINDERS times, then the user is told); other modes get their one-time reminders.
 */
async function endOfTurnReminder(p: LoopParams, t: TurnTracking, finalText: string): Promise<string | undefined> {
	if (p.signal.aborted) { return undefined; }
	if (p.mode === 'debug' && t.edited.size > 0) {
		const left: MarkerHit[] = [];
		for (const path of t.edited) {
			const hits = await markerHits(p, path);
			if (hits.length > (t.baseline.get(path) ?? 0)) { left.push(...hits.map(h => ({ path, line: h.line }))); }
		}
		if (left.length) {
			if (t.cleanupAttempts >= MAX_CLEANUP_REMINDERS) {
				p.hooks.onError(`Debug instrumentation (${DEBUG_MARKER}) is still in ${[...new Set(left.map(h => h.path))].join(', ')}. Search for ${DEBUG_MARKER} and remove those lines.`);
				return undefined;
			}
			t.cleanupAttempts++;
			return cleanupReminder(left, t.cleanupAttempts);
		}
	}
	const reminders = turnEndReminders({
		mode: p.mode, toolNames: new Set(p.tools.byName.keys()), edited: t.edited, lintsRun: t.lintsRun, todoWritten: t.todoWritten,
		todos: p.toolCtx.getTodos(), finalText, sent: t.sent,
	});
	if (!reminders.length) { return undefined; }
	for (const r of reminders) { t.sent.add(r.key); }
	return reminders.map(r => r.text).join('\n\n');
}
