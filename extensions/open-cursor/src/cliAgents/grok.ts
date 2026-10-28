/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Grok CLI runner. `grok -p <prompt> --output-format streaming-json`. Headless mode cannot ask us
 *  for approvals: a shell command that is not read only or allow-listed is refused and the CLI
 *  ends the turn ("cancelled"). So agent mode runs with `acceptEdits` inside `--sandbox workspace`
 *  (the kernel only lets it write the workspace and temp dirs), ask/plan with `plan` inside
 *  `--sandbox read-only`. Only autoRun === 'always' uses `bypassPermissions` without a sandbox.
 *  Allow-listed commands are passed as `--allow Bash(...)` rules. Edits are found by diffing git
 *  status. Event shapes: text / thought deltas, tool_call + tool_call_update, usage, end.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commandAllowed } from './policy';
import { cliPromptPrefix } from './modeArgs';
import { MODE_READONLY, type RunOptions, type RunResult, type TurnHost } from './types';
import { TurnTracker } from './tracking';
import { arr, displayPath, friendlyError, num, oneLine, parseJson, rec, resolveInCwd, spawnCli, str, truncate } from './util';

const EDIT_TOOLS = new Set(['search_replace', 'write', 'edit_notebook', 'delete_file']);
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

function pathArg(p: Record<string, unknown> | undefined): string | undefined {
	return str(p?.file_path) ?? str(p?.target_file) ?? str(p?.path) ?? str(p?.target_directory) ?? str(p?.directory);
}

export function grokToolView(tool: string, params: Record<string, unknown> | undefined, phase: 'run' | 'done', cwd: string): { name: string; title: string; command?: { text: string; cwd?: string } } {
	const run = phase === 'run';
	const p = pathArg(params);
	const rel = p ? displayPath(cwd, resolveInCwd(cwd, p)) : undefined;
	switch (tool) {
		case 'run_terminal_command': {
			const cmd = str(params?.command) ?? '';
			return { name: 'run_terminal_cmd', title: `${run ? 'Running' : 'Ran'} \`${oneLine(cmd, 70)}\``, command: { text: cmd, cwd } };
		}
		case 'read_file':
			return { name: 'read_file', title: `${run ? 'Reading' : 'Read'} ${rel ?? 'file'}` };
		case 'search_replace':
			return { name: 'edit_file', title: `${run ? 'Editing' : 'Edited'} ${rel ?? 'file'}` };
		case 'write':
			return { name: 'write_file', title: `${run ? 'Writing' : 'Wrote'} ${rel ?? 'file'}` };
		case 'list_dir':
			return { name: 'list_dir', title: `${run ? 'Listing' : 'Listed'} ${rel ?? 'directory'}` };
		case 'grep':
			return { name: 'grep', title: `${run ? 'Searching' : 'Searched'} \`${oneLine(str(params?.pattern) ?? '', 50)}\`` };
		case 'web_fetch':
			return { name: 'fetch_url', title: `${run ? 'Fetching' : 'Fetched'} ${oneLine(str(params?.url) ?? '', 70)}` };
		case 'web_search':
			return { name: 'web_search', title: `${run ? 'Searching the web for' : 'Searched the web for'} \`${oneLine(str(params?.query) ?? '', 60)}\`` };
		case 'todo_write':
			return { name: 'todo_write', title: run ? 'Updating todos' : 'Updated todos' };
		case 'spawn_subagent':
			return { name: 'task', title: `${run ? 'Running' : 'Ran'} subagent${str(params?.description) ? ` \`${oneLine(str(params?.description) ?? '', 50)}\`` : ''}` };
		default:
			return { name: tool, title: `${run ? 'Running' : 'Ran'} ${tool}` };
	}
}

/** Grok keeps its plan in a markdown file under ~/.grok/sessions. */
function isPlanFile(p: string): boolean {
	return /[\\/]\.grok[\\/]sessions[\\/].*plan\.md$/.test(p);
}

interface ToolState {
	tool: string;
	params?: Record<string, unknown>;
	startedAt: number;
	output?: string;
	diffPath?: string;
}

export class GrokParser {
	sessionId?: string;
	sawEnd = false;
	failure?: string;
	/** Set when the CLI refused a command because headless mode cannot ask for approval. */
	blockedCommand?: string;
	private wroteText = false;
	private afterTool = false;
	private readonly tools = new Map<string, ToolState>();

	constructor(
		private readonly cwd: string,
		private readonly host: TurnHost,
		private readonly tracker: TurnTracker,
	) {}

	async feed(ev: Record<string, unknown>): Promise<void> {
		switch (ev.type) {
			case 'thought':
				if (typeof ev.data === 'string') {
					this.host.thinking(ev.data);
				}
				return;
			case 'text':
				if (typeof ev.data === 'string') {
					// Keep prose before and after a tool call from running together.
					this.host.text((this.afterTool && this.wroteText ? '\n\n' : '') + ev.data);
					this.wroteText = true;
					this.afterTool = false;
				}
				return;
			case 'tool_call': {
				const id = str(ev.toolCallId) ?? `tool-${this.tools.size}`;
				const tool = str(ev.toolName) ?? str(ev.title) ?? 'tool';
				if (tool === 'exit_plan_mode' || tool === 'enter_plan_mode') {
					return;
				}
				const params = rec(ev.rawInput);
				this.tools.set(id, { tool, params, startedAt: Date.now() });
				const p = pathArg(params);
				if (p && isPlanFile(p)) {
					this.host.toolStart({ type: 'tool', id, name: 'create_plan', status: 'running', title: 'Writing plan' });
					return;
				}
				const v = grokToolView(tool, params, 'run', this.cwd);
				this.host.toolStart({ type: 'tool', id, name: v.name, args: params, status: 'running', title: v.title, command: v.command });
				this.afterTool = true;
				return;
			}
			case 'tool_call_update':
				return this.onUpdate(ev);
			case 'end': {
				this.sawEnd = true;
				this.sessionId = str(ev.sessionId) ?? this.sessionId;
				const u = rec(ev.usage);
				if (u) {
					const input = (num(u.input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0);
					this.host.usage({ inputTokens: input, outputTokens: num(u.output_tokens) ?? 0 });
				}
				const reason = str(ev.stopReason);
				if (reason === 'cancelled' && this.blockedCommand) {
					this.host.text(
						`\n\n> Grok was stopped because it tried to run \`${oneLine(this.blockedCommand, 80)}\`, which needs your approval, and Grok CLI cannot ask for it here. Add the command to the agent command allowlist, or set auto-run to run everything, then send your message again to continue.\n\n`,
					);
				} else if (reason === 'error' || reason === 'refusal') {
					this.failure = str(ev.error) ?? str(ev.message) ?? `Grok stopped: ${reason}.`;
				}
				return;
			}
			case 'error': {
				const msg = str(ev.message) ?? str(ev.data) ?? str(rec(ev.error)?.message);
				if (msg) {
					this.failure = msg;
				}
				return;
			}
		}
	}

	private async onUpdate(ev: Record<string, unknown>): Promise<void> {
		const id = str(ev.toolCallId) ?? '';
		const st = this.tools.get(id);
		if (!st) {
			return;
		}
		// Collect the newest text output and any diff path; the final update repeats them.
		for (const c of arr(ev.content).map(rec)) {
			if (c?.type === 'content') {
				const t = str(rec(c.content)?.text);
				if (t) {
					st.output = stripAnsi(t);
				}
			} else if (c?.type === 'diff') {
				st.diffPath = str(c.path) ?? st.diffPath;
			}
		}
		const status = str(ev.status);
		if (status !== 'completed' && status !== 'failed') {
			return;
		}
		this.tools.delete(id);
		const raw = rec(ev.rawOutput);
		const exit = num(raw?.exit_code);
		const failed = status === 'failed' || (st.tool === 'run_terminal_command' && exit !== undefined && exit !== 0);
		const editPath = st.diffPath ?? pathArg(st.params);
		if (editPath && isPlanFile(editPath)) {
			if (!failed) {
				const plan = str(st.params?.new_string) ?? str(st.params?.content);
				if (plan) {
					this.host.text((this.wroteText ? '\n\n' : '') + plan);
					this.wroteText = true;
				}
			}
			this.host.toolUpdate({ type: 'tool', id, name: 'create_plan', status: failed ? 'error' : 'done', title: failed ? 'Plan failed' : 'Wrote plan', durationMs: Date.now() - st.startedAt });
			return;
		}
		if (failed && st.tool === 'run_terminal_command' && /cancelled/i.test(st.output ?? '')) {
			this.blockedCommand = str(st.params?.command) ?? '';
		}
		const v = grokToolView(st.tool, st.params, 'done', this.cwd);
		const showOutput = failed || st.tool === 'run_terminal_command' || st.tool === 'web_fetch';
		this.host.toolUpdate({
			type: 'tool',
			id,
			name: v.name,
			args: st.params,
			status: failed ? 'error' : 'done',
			title: failed && st.tool === 'run_terminal_command' && exit !== undefined ? `Failed \`${oneLine(str(st.params?.command) ?? '', 70)}\` (exit ${exit})` : v.title,
			output: showOutput && st.output ? truncate(st.output, 4000) : undefined,
			command: v.command,
			durationMs: Date.now() - st.startedAt,
		});
		if (!failed && (EDIT_TOOLS.has(st.tool) || st.tool === 'run_terminal_command')) {
			await this.tracker.afterToolCall(editPath && EDIT_TOOLS.has(st.tool) ? [resolveInCwd(this.cwd, editPath)] : undefined);
		}
	}
}

/** Permission and sandbox flags for a turn (see the header comment). */
export function grokPermissionArgs(o: Pick<RunOptions, 'mode' | 'autoRun' | 'commandAllowlist'>): string[] {
	if (MODE_READONLY(o.mode)) {
		return ['--permission-mode', 'plan', '--sandbox', 'read-only'];
	}
	if (o.autoRun === 'always') {
		return ['--permission-mode', 'bypassPermissions'];
	}
	const args = ['--permission-mode', 'acceptEdits', '--sandbox', 'workspace'];
	if (o.autoRun === 'allowlist') {
		// Same rule as policy.ts: plain commands only, never a chain. Grok checks each chained segment itself.
		for (const entry of o.commandAllowlist.map(e => e.trim())) {
			if (commandAllowed(entry, [entry])) {
				args.push('--allow', `Bash(${entry})`, '--allow', `Bash(${entry} *)`);
			}
		}
	}
	return args;
}

export async function runGrok(o: RunOptions): Promise<RunResult> {
	const args: string[] = ['--output-format', 'streaming-json', '--cwd', o.cwd, ...grokPermissionArgs(o)];
	if (o.model && o.model !== 'default') {
		args.push('-m', o.model);
	}
	const sessionId = o.sessionId ?? crypto.randomUUID();
	args.push(o.sessionId ? '-r' : '-s', sessionId);
	args.push(...o.extraArgs);

	// Images: written to a private temp dir and referenced by path in the prompt.
	let tmpDir: string | undefined;
	let prompt = cliPromptPrefix(o.mode) + o.prompt;
	if (o.images?.length) {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-grok-'));
		const files = o.images.map((img, i) => {
			const ext = img.mediaType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
			const p = path.join(tmpDir!, `image-${i}.${ext}`);
			fs.writeFileSync(p, Buffer.from(img.data, 'base64'));
			return p;
		});
		prompt = `The user attached image files; look at them with read_file:\n${files.join('\n')}\n\n${prompt}`;
	}
	if (prompt.length > 100_000) {
		tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'oc-grok-'));
		const pf = path.join(tmpDir, 'prompt.txt');
		fs.writeFileSync(pf, prompt);
		args.push('--prompt-file', pf);
	} else {
		args.push('-p', prompt);
	}

	const tracker = await TurnTracker.create(o.cwd, o.env, o.host);
	const parser = new GrokParser(o.cwd, o.host, tracker);
	let queue: Promise<void> = Promise.resolve();
	const proc = spawnCli(o.binary, args, {
		cwd: o.cwd,
		env: o.env,
		stdin: 'none',
		signal: o.signal,
		onLine: line => {
			o.rawLog?.(line);
			const ev = parseJson(line);
			if (ev) {
				queue = queue.then(() => parser.feed(ev)).catch(() => undefined);
			}
		},
	});
	const exit = await proc.exited;
	await queue;
	await tracker.afterToolCall().catch(() => undefined);
	if (tmpDir) {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
	const sid = parser.sessionId ?? sessionId;
	if (o.signal.aborted) {
		return { sessionId: sid, stopReason: 'aborted' };
	}
	if (exit.spawnError) {
		return { stopReason: 'error', error: `Could not start Grok: ${exit.spawnError}` };
	}
	if (parser.failure) {
		return { sessionId: sid, stopReason: 'error', error: friendlyError('grok', parser.failure) };
	}
	if (!parser.sawEnd && exit.code !== 0) {
		return { sessionId: sid, stopReason: 'error', error: friendlyError('grok', proc.stderr() || `grok exited with code ${exit.code}`) };
	}
	return { sessionId: sid, stopReason: 'done' };
}
