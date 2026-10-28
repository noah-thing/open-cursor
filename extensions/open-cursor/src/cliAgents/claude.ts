/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Claude Code runner. `claude -p --output-format stream-json --input-format stream-json`, one
 *  process per turn, `--resume <session>` for later turns. Tool permissions are routed to us
 *  through `--permission-prompt-tool mcp__oc__approve` (see permissionServer.ts). No vscode import.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { diffLines } from 'diff';
import type { ToolPart } from '../shared/protocol';
import { ApprovalBroker, type ApprovalDecision, type ApprovalRequest } from './approvalBroker';
import { GitTracker } from './fileTracker';
import { isDenied, DEFAULT_DENYLIST } from '../agent/approval';
import { isReadOnlyCommand } from '../agent/modes';
import { claudeModeArgs } from './modeArgs';
import { commandAllowed } from './policy';
import { MODE_READONLY, type RunOptions, type RunResult, type TurnHost } from './types';
import { arr, countLines, displayPath, friendlyError, num, oneLine, parseJson, readTextFile, rec, resolveInCwd, spawnCli, str, truncate } from './util';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SAFE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'TodoWrite', 'Task', 'Agent', 'ToolSearch', 'WebFetch', 'WebSearch', 'BashOutput', 'KillShell', 'TaskOutput', 'TaskStop', 'Skill', 'SlashCommand']);

/** Claude Code tool name -> the tool names the chat UI already knows (icons, grouping). */
const UI_NAME: Record<string, string> = {
	Read: 'read_file',
	Edit: 'edit_file',
	MultiEdit: 'edit_file',
	NotebookEdit: 'edit_file',
	Write: 'write_file',
	Bash: 'run_terminal_cmd',
	Grep: 'grep',
	Glob: 'glob_file_search',
	LS: 'list_dir',
	WebFetch: 'fetch_url',
	WebSearch: 'web_search',
	TodoWrite: 'todo_write',
};

export function filePathOf(input: Record<string, unknown>): string | undefined {
	return str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
}

export interface ToolView {
	name: string;
	title: string;
	command?: ToolPart['command'];
}

/** Human title for a Claude Code tool call. `phase` picks tense. */
export function claudeToolView(rawName: string, input: Record<string, unknown>, phase: 'run' | 'done', cwd: string): ToolView {
	const name = UI_NAME[rawName] ?? rawName;
	const p = filePathOf(input);
	const rel = p ? displayPath(cwd, resolveInCwd(cwd, p)) : undefined;
	const run = phase === 'run';
	switch (rawName) {
		case 'Read': {
			const off = num(input.offset);
			const lim = num(input.limit);
			const range = off !== undefined || lim !== undefined ? ` L${(off ?? 0) + 1}-${(off ?? 0) + (lim ?? 2000)}` : '';
			return { name, title: `${run ? 'Reading' : 'Read'} ${rel ?? 'file'}${range}` };
		}
		case 'Edit':
		case 'MultiEdit':
		case 'NotebookEdit':
			return { name, title: `${run ? 'Editing' : 'Edited'} ${rel ?? 'file'}` };
		case 'Write':
			return { name, title: `${run ? 'Writing' : 'Wrote'} ${rel ?? 'file'}` };
		case 'Bash': {
			const cmd = str(input.command) ?? '';
			if (!cmd) {
				return { name, title: run ? 'Running command' : 'Ran command' };
			}
			return { name, title: `${run ? 'Running' : 'Ran'} \`${oneLine(cmd, 70)}\``, command: { text: cmd, background: input.run_in_background === true } };
		}
		case 'Grep':
			return { name, title: `${run ? 'Searching' : 'Searched'} \`${oneLine(str(input.pattern) ?? '', 50)}\`` };
		case 'Glob':
			return { name, title: `${run ? 'Finding' : 'Found'} files \`${oneLine(str(input.pattern) ?? '', 50)}\`` };
		case 'LS':
			return { name, title: `${run ? 'Listing' : 'Listed'} ${rel ?? 'directory'}` };
		case 'WebFetch':
			return { name, title: `${run ? 'Fetching' : 'Fetched'} ${oneLine(str(input.url) ?? '', 70)}` };
		case 'WebSearch':
			return { name, title: `${run ? 'Searching the web for' : 'Searched the web for'} \`${oneLine(str(input.query) ?? '', 60)}\`` };
		case 'TodoWrite':
			return { name, title: run ? 'Updating todos' : 'Updated todos' };
		case 'Task':
		case 'Agent':
			return { name: 'subagent', title: `Subagent: ${oneLine(str(input.description) ?? str(input.subagent_type) ?? 'task', 60)}` };
		case 'ExitPlanMode':
			return { name: 'plan', title: 'Presented plan' };
		default: {
			const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(rawName);
			if (m) {
				return { name: `mcp_${m[1]}_${m[2]}`, title: `${m[1]} · ${m[2]}` };
			}
			return { name: rawName, title: `${run ? 'Running' : 'Ran'} ${rawName}` };
		}
	}
}

/** Lines added and removed going from `before` to `after`, the way a diff view counts them. */
function lineDelta(before: string, after: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const part of diffLines(before, after)) {
		if (part.added) { added += part.count ?? countLines(part.value); }
		else if (part.removed) { removed += part.count ?? countLines(part.value); }
	}
	return { added, removed };
}

/** Added/removed line counts straight from the tool input (the edit is not on disk yet when we see it). */
export function editStats(rawName: string, input: Record<string, unknown>, original: string | undefined): { added: number; removed: number } {
	switch (rawName) {
		case 'Edit':
			return lineDelta(str(input.old_string) ?? '', str(input.new_string) ?? '');
		case 'MultiEdit': {
			let added = 0;
			let removed = 0;
			for (const e of arr(input.edits)) {
				const r = rec(e);
				const d = lineDelta(str(r?.old_string) ?? '', str(r?.new_string) ?? '');
				added += d.added;
				removed += d.removed;
			}
			return { added, removed };
		}
		case 'Write':
			return original ? lineDelta(original, str(input.content) ?? '') : { added: countLines(str(input.content) ?? ''), removed: 0 };
		case 'NotebookEdit':
			return { added: countLines(str(input.new_source) ?? ''), removed: 0 };
		default:
			return { added: 0, removed: 0 };
	}
}

interface ToolState {
	rawName: string;
	input: Record<string, unknown>;
	startedAt: number;
	emitted: boolean;
}

export interface ClaudeResult {
	sessionId?: string;
	isError: boolean;
	message?: string;
	sawResult: boolean;
}

/** Turns Claude Code's stream-json events into host callbacks. Pure, replayable in tests. */
export class ClaudeParser {
	readonly result: ClaudeResult = { isError: false, sawResult: false };
	private readonly tools = new Map<string, ToolState>();
	private readonly blocks = new Map<number, { type: string; id?: string }>();
	private readonly streamedText = new Set<string>();
	private currentMessageId = '';

	constructor(
		private readonly cwd: string,
		private readonly host: TurnHost,
		/** Original content captured by the approval flow, if any ('unknown' when we never saw the file). */
		private readonly originalOf: (abs: string) => string | undefined | 'unknown' = () => 'unknown',
	) {}

	feed(ev: Record<string, unknown>): void {
		switch (ev.type) {
			case 'system':
				if (ev.subtype === 'init') {
					this.result.sessionId = str(ev.session_id) ?? this.result.sessionId;
				}
				return;
			case 'stream_event':
				this.onStream(rec(ev.event), ev.parent_tool_use_id != null);
				return;
			case 'assistant':
				this.onAssistant(rec(ev.message), ev.parent_tool_use_id != null);
				return;
			case 'user':
				this.onUser(rec(ev.message));
				return;
			case 'result':
				this.onResult(ev);
				return;
		}
	}

	private onStream(e: Record<string, unknown> | undefined, sub: boolean): void {
		if (!e) {
			return;
		}
		switch (e.type) {
			case 'message_start': {
				this.currentMessageId = str(rec(e.message)?.id) ?? '';
				this.blocks.clear();
				return;
			}
			case 'content_block_start': {
				const cb = rec(e.content_block);
				const index = num(e.index) ?? 0;
				const type = str(cb?.type) ?? '';
				this.blocks.set(index, { type, id: str(cb?.id) });
				if (type === 'tool_use' && cb) {
					this.startTool(str(cb.id) ?? `tool-${index}`, str(cb.name) ?? 'tool', rec(cb.input) ?? {});
				}
				return;
			}
			case 'content_block_delta': {
				const d = rec(e.delta);
				if (!d || sub) {
					return;
				}
				if (d.type === 'text_delta' && typeof d.text === 'string') {
					this.streamedText.add(this.currentMessageId);
					this.host.text(d.text);
				} else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
					this.host.thinking(d.thinking);
				}
				return;
			}
		}
	}

	private startTool(id: string, rawName: string, input: Record<string, unknown>): void {
		if (this.tools.has(id)) {
			return;
		}
		this.tools.set(id, { rawName, input, startedAt: Date.now(), emitted: true });
		const v = claudeToolView(rawName, input, 'run', this.cwd);
		this.host.toolStart({ type: 'tool', id, name: v.name, args: input, status: 'running', title: v.title, command: v.command });
	}

	private onAssistant(m: Record<string, unknown> | undefined, sub: boolean): void {
		if (!m) {
			return;
		}
		const mid = str(m.id) ?? '';
		for (const b of arr(m.content)) {
			const block = rec(b);
			if (!block) {
				continue;
			}
			if (block.type === 'tool_use') {
				const id = str(block.id) ?? '';
				const rawName = str(block.name) ?? 'tool';
				const input = rec(block.input) ?? {};
				const known = this.tools.get(id);
				if (!known) {
					this.startTool(id, rawName, input);
				} else {
					known.input = input;
					known.rawName = rawName;
					const v = claudeToolView(rawName, input, 'run', this.cwd);
					this.host.toolUpdate({ type: 'tool', id, name: v.name, args: input, status: 'running', title: v.title, command: v.command });
				}
			} else if (block.type === 'text' && !sub && !this.streamedText.has(mid) && typeof block.text === 'string') {
				this.host.text(block.text);
			}
		}
	}

	private onUser(m: Record<string, unknown> | undefined): void {
		if (!m || !Array.isArray(m.content)) {
			return;
		}
		for (const b of m.content) {
			const block = rec(b);
			if (!block || block.type !== 'tool_result') {
				continue;
			}
			const id = str(block.tool_use_id) ?? '';
			const st = this.tools.get(id);
			if (!st) {
				continue;
			}
			const isError = block.is_error === true;
			const text = toolResultText(block.content);
			const v = claudeToolView(st.rawName, st.input, 'done', this.cwd);
			const durationMs = Date.now() - st.startedAt;
			let title = v.title;
			let output: string | undefined;
			let edit: ToolPart['edit'];
			if (isError) {
				output = truncate(text, 2000);
			} else if (st.rawName === 'Bash') {
				output = text ? truncate(text, 4000) : undefined;
			} else if (st.rawName === 'Grep' || st.rawName === 'Glob') {
				const n = text.split('\n').filter(l => l.trim() && !/^No (files|matches)/i.test(l)).length;
				title += ` · ${n} ${n === 1 ? 'result' : 'results'}`;
				output = text ? truncate(text, 2000) : undefined;
			} else if (st.rawName === 'WebFetch' || st.rawName === 'WebSearch' || st.rawName === 'TodoWrite' || st.rawName.startsWith('mcp__')) {
				output = text ? truncate(text, 2000) : undefined;
			}
			if (!isError && EDIT_TOOLS.has(st.rawName)) {
				const p = filePathOf(st.input);
				if (p) {
					const abs = resolveInCwd(this.cwd, p);
					const original = this.originalOf(abs);
					const stats = editStats(st.rawName, st.input, original === 'unknown' ? undefined : original);
					edit = { uri: this.host.uri(abs), path: displayPath(this.cwd, abs), added: stats.added, removed: stats.removed, isNew: original === undefined && st.rawName === 'Write' ? true : undefined };
					this.host.fileChanged(abs);
				}
			}
			this.host.toolUpdate({
				type: 'tool',
				id,
				name: v.name,
				args: st.input,
				status: isError ? 'error' : 'done',
				title,
				output,
				command: v.command,
				edit,
				durationMs,
			});
			this.tools.delete(id);
		}
	}

	private onResult(ev: Record<string, unknown>): void {
		this.result.sawResult = true;
		this.result.sessionId = str(ev.session_id) ?? this.result.sessionId;
		const u = rec(ev.usage);
		if (u) {
			const input = (num(u.input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0);
			this.host.usage({ inputTokens: input, outputTokens: num(u.output_tokens) ?? 0 });
		}
		const subtype = str(ev.subtype) ?? 'success';
		if (ev.is_error === true || subtype !== 'success') {
			this.result.isError = true;
			const errs = arr(ev.errors).filter((x): x is string => typeof x === 'string');
			this.result.message = str(ev.result) ?? (errs.length ? errs.join('\n') : subtype === 'error_max_turns' ? 'Claude Code stopped: maximum turns reached.' : `Claude Code failed (${subtype}).`);
		}
	}
}

function toolResultText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	return arr(content)
		.map(c => (rec(c) && rec(c)!.type === 'text' ? str(rec(c)!.text) ?? '' : ''))
		.filter(Boolean)
		.join('\n');
}


export async function runClaude(o: RunOptions): Promise<RunResult> {
	const host = o.host;
	const originals = new Map<string, string | undefined>();
	const alwaysTools = new Set<string>();
	const readonly = MODE_READONLY(o.mode);
	const useServer = !!o.permissionServerPath && fs.existsSync(o.permissionServerPath);

	const handle = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
		const { toolName, input } = req;
		if (toolName === 'ExitPlanMode') {
			const plan = str(input.plan);
			if (plan) {
				host.text(plan);
			}
			return { behavior: 'deny', message: 'The plan was shown to the user in OpenCursor. Stop here and wait for their reply.', interrupt: true };
		}
		if (toolName === 'AskUserQuestion') {
			return { behavior: 'deny', message: 'Interactive questions are not available in OpenCursor. Ask your question as plain text in your reply and stop.' };
		}
		if (readonly && (EDIT_TOOLS.has(toolName) || (toolName === 'Bash' && !isReadOnlyCommand(str(input.command) ?? '').ok))) {
			return { behavior: 'deny', message: `${o.mode === 'plan' ? 'Plan' : 'Ask'} mode in OpenCursor is read only: ${toolName} is not allowed. Use read-only tools and inspection commands, or tell the user to switch to Agent mode.` };
		}
		if (EDIT_TOOLS.has(toolName)) {
			const p = filePathOf(input);
			if (p) {
				const abs = resolveInCwd(o.cwd, p);
				const rel = path.relative(o.cwd, abs);
				if (o.autoRun !== 'always' && (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))) {
					const v = claudeToolView(toolName, input, 'run', o.cwd);
					const outside: ToolPart = { type: 'tool', id: req.toolUseId ?? `approval-${Date.now()}`, name: v.name, args: input, status: 'awaiting-approval', title: v.title, command: v.command };
					if ((await host.requestApproval(outside)) === 'skip') {
						return { behavior: 'deny', message: 'The user declined editing a file outside the workspace in OpenCursor.' };
					}
				}
				if (!originals.has(abs)) {
					const text = readTextFile(abs);
					if (text !== 'skip') {
						originals.set(abs, text);
						host.fileOriginal(abs, text);
					}
				}
			}
			return { behavior: 'allow', updatedInput: input };
		}
		if (SAFE_TOOLS.has(toolName) || o.autoRun === 'always') {
			return { behavior: 'allow', updatedInput: input };
		}
		const isBash = toolName === 'Bash';
		const command = isBash ? str(input.command) ?? '' : undefined;
		// "allow always" remembers the exact normalised command, never a prefix; the denylist always wins
		const denied = isBash && isDenied(command ?? '', DEFAULT_DENYLIST);
		const key = isBash ? 'Bash:' + (command ?? '').replace(/\s+/g, ' ').trim() : toolName;
		if (!denied && (alwaysTools.has(key) || (isBash && o.autoRun === 'allowlist' && commandAllowed(command ?? '', o.commandAllowlist)))) {
			return { behavior: 'allow', updatedInput: input };
		}
		const v = claudeToolView(toolName, input, 'run', o.cwd);
		const part: ToolPart = { type: 'tool', id: req.toolUseId ?? `approval-${Date.now()}`, name: v.name, args: input, status: 'awaiting-approval', title: v.title, command: v.command };
		const answer = await host.requestApproval(part);
		if (answer === 'skip') {
			return { behavior: 'deny', message: 'The user declined this action in OpenCursor.' };
		}
		if (answer === 'allowAlways' && !denied) {
			alwaysTools.add(key);
		}
		return { behavior: 'allow', updatedInput: input };
	};

	let broker: ApprovalBroker | undefined;
	let tracker: GitTracker | undefined;
	const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages'];
	if (o.model && o.model !== 'default') {
		args.push('--model', o.model);
	}
	if (o.sessionId) {
		args.push('--resume', o.sessionId);
	}
	args.push(...claudeModeArgs(o));
	if (useServer) {
		try {
			broker = await ApprovalBroker.start(handle);
		} catch {
			broker = undefined;
		}
	}
	if (broker && o.permissionServerPath) {
		const mcp = {
			mcpServers: {
				oc: {
					command: process.execPath,
					args: [o.permissionServerPath],
					env: { ELECTRON_RUN_AS_NODE: '1', OC_PERM_SOCKET: broker.socketPath, OC_PERM_TOKEN: broker.token },
				},
			},
		};
		args.push('--mcp-config', JSON.stringify(mcp), '--permission-prompt-tool', 'mcp__oc__approve');
	} else {
		// No approval channel (server not bundled): let edits through and track them by git status instead.
		if (!readonly) {
			args.splice(args.indexOf('--permission-mode'), 2, '--permission-mode', o.autoRun === 'always' ? 'bypassPermissions' : 'acceptEdits');
		}
		tracker = await GitTracker.create(o.cwd, o.env);
	}
	args.push(...o.extraArgs);

	const parser = new ClaudeParser(o.cwd, host, abs => (originals.has(abs) ? originals.get(abs) : 'unknown'));
	let stdinEnded = false;
	const proc = spawnCli(o.binary, args, {
		cwd: o.cwd,
		env: o.env,
		stdin: 'keep-open',
		signal: o.signal,
		onLine: line => {
			o.rawLog?.(line);
			const ev = parseJson(line);
			if (!ev) {
				return;
			}
			parser.feed(ev);
			if (ev.type === 'result' && !stdinEnded) {
				stdinEnded = true;
				proc.child.stdin?.end();
			}
			if (tracker && ev.type === 'user') {
				void tracker.scan().then(files => {
					for (const f of files) {
						if (f.first) {
							host.fileOriginal(f.absPath, f.original);
						}
						host.fileChanged(f.absPath);
					}
				});
			}
		},
	});

	const content: unknown[] = [];
	for (const img of o.images ?? []) {
		content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
	}
	content.push({ type: 'text', text: o.prompt });
	proc.child.stdin?.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');

	const exit = await proc.exited;
	broker?.close();
	if (tracker) {
		await tracker.scan().catch(() => []);
	}
	if (o.signal.aborted) {
		return { sessionId: parser.result.sessionId ?? o.sessionId, stopReason: 'aborted' };
	}
	if (exit.spawnError) {
		return { stopReason: 'error', error: `Could not start Claude Code: ${exit.spawnError}` };
	}
	const sessionId = parser.result.sessionId ?? o.sessionId;
	if (parser.result.isError) {
		return { sessionId, stopReason: 'error', error: friendlyError('claude-code', parser.result.message ?? proc.stderr()) };
	}
	if (!parser.result.sawResult && exit.code !== 0) {
		return { sessionId, stopReason: 'error', error: friendlyError('claude-code', proc.stderr() || `claude exited with code ${exit.code}`) };
	}
	return { sessionId, stopReason: 'done' };
}
