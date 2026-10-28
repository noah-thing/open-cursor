/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Gemini CLI runner. `gemini -p <prompt> --output-format stream-json`. Headless mode cannot ask
 *  us for approvals, so agent mode runs with `--approval-mode auto_edit` (edits auto-approved,
 *  shell commands denied by the CLI) and ask/plan with `plan` (read only). autoRun === 'always'
 *  uses `yolo`. Edits are found by diffing git status. Event shapes follow the documented
 *  stream-json schema (init / message / tool_use / tool_result / error / result).
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MODE_READONLY, type RunOptions, type RunResult, type TurnHost } from './types';
import { TurnTracker } from './tracking';
import { displayPath, friendlyError, num, oneLine, parseJson, rec, resolveInCwd, runQuick, spawnCli, str, truncate } from './util';

const EDIT_TOOLS = new Set(['write_file', 'replace', 'edit', 'apply_patch']);

function pathArg(p: Record<string, unknown> | undefined): string | undefined {
	return str(p?.file_path) ?? str(p?.absolute_path) ?? str(p?.path) ?? str(p?.dir_path);
}

export function geminiToolView(tool: string, params: Record<string, unknown> | undefined, phase: 'run' | 'done', cwd: string): { name: string; title: string; command?: { text: string; cwd?: string } } {
	const run = phase === 'run';
	const p = pathArg(params);
	const rel = p ? displayPath(cwd, resolveInCwd(cwd, p)) : undefined;
	switch (tool) {
		case 'run_shell_command': {
			const cmd = str(params?.command) ?? '';
			return { name: 'run_terminal_cmd', title: `${run ? 'Running' : 'Ran'} \`${oneLine(cmd, 70)}\``, command: { text: cmd, cwd } };
		}
		case 'read_file':
			return { name: 'read_file', title: `${run ? 'Reading' : 'Read'} ${rel ?? 'file'}` };
		case 'read_many_files':
			return { name: 'read_file', title: `${run ? 'Reading' : 'Read'} files` };
		case 'write_file':
			return { name: 'write_file', title: `${run ? 'Writing' : 'Wrote'} ${rel ?? 'file'}` };
		case 'replace':
		case 'edit':
			return { name: 'edit_file', title: `${run ? 'Editing' : 'Edited'} ${rel ?? 'file'}` };
		case 'list_directory':
			return { name: 'list_dir', title: `${run ? 'Listing' : 'Listed'} ${rel ?? 'directory'}` };
		case 'glob':
			return { name: 'glob_file_search', title: `${run ? 'Finding' : 'Found'} files \`${oneLine(str(params?.pattern) ?? '', 50)}\`` };
		case 'search_file_content':
		case 'grep_search':
		case 'grep':
			return { name: 'grep', title: `${run ? 'Searching' : 'Searched'} \`${oneLine(str(params?.pattern) ?? str(params?.query) ?? '', 50)}\`` };
		case 'web_fetch':
			return { name: 'fetch_url', title: `${run ? 'Fetching' : 'Fetched'} ${oneLine(str(params?.prompt) ?? str(params?.url) ?? '', 70)}` };
		case 'google_web_search':
			return { name: 'web_search', title: `${run ? 'Searching the web for' : 'Searched the web for'} \`${oneLine(str(params?.query) ?? '', 60)}\`` };
		case 'write_todos':
			return { name: 'todo_write', title: run ? 'Updating todos' : 'Updated todos' };
		default:
			return { name: tool, title: `${run ? 'Running' : 'Ran'} ${tool}` };
	}
}

export class GeminiParser {
	sessionId?: string;
	sawResult = false;
	failure?: string;
	private lastError?: string;
	private readonly tools = new Map<string, { tool: string; params?: Record<string, unknown>; startedAt: number }>();

	constructor(
		private readonly cwd: string,
		private readonly host: TurnHost,
		private readonly tracker: TurnTracker,
	) {}

	async feed(ev: Record<string, unknown>): Promise<void> {
		switch (ev.type) {
			case 'init':
				this.sessionId = str(ev.session_id) ?? this.sessionId;
				return;
			case 'message':
				if (ev.role === 'assistant' && typeof ev.content === 'string') {
					this.host.text(ev.content);
				}
				return;
			case 'thought':
				if (typeof ev.content === 'string') {
					this.host.thinking(ev.content);
				}
				return;
			case 'tool_use': {
				const id = str(ev.tool_id) ?? `tool-${this.tools.size}`;
				const tool = str(ev.tool_name) ?? 'tool';
				const params = rec(ev.parameters);
				this.tools.set(id, { tool, params, startedAt: Date.now() });
				const v = geminiToolView(tool, params, 'run', this.cwd);
				this.host.toolStart({ type: 'tool', id, name: v.name, args: params, status: 'running', title: v.title, command: v.command });
				return;
			}
			case 'tool_result': {
				const id = str(ev.tool_id) ?? '';
				const st = this.tools.get(id);
				if (!st) {
					return;
				}
				const failed = ev.status === 'error' || !!rec(ev.error);
				const v = geminiToolView(st.tool, st.params, 'done', this.cwd);
				const out = str(ev.output) ?? str(rec(ev.error)?.message);
				this.host.toolUpdate({
					type: 'tool',
					id,
					name: v.name,
					args: st.params,
					status: failed ? 'error' : 'done',
					title: v.title,
					output: out && (failed || st.tool === 'run_shell_command' || st.tool === 'web_fetch') ? truncate(out, 3000) : undefined,
					command: v.command,
					durationMs: Date.now() - st.startedAt,
				});
				this.tools.delete(id);
				if (!failed && (EDIT_TOOLS.has(st.tool) || st.tool === 'run_shell_command')) {
					const p = pathArg(st.params);
					await this.tracker.afterToolCall(p && EDIT_TOOLS.has(st.tool) ? [resolveInCwd(this.cwd, p)] : undefined);
				}
				return;
			}
			case 'error': {
				const msg = str(ev.message);
				if (msg) {
					this.lastError = msg;
					if (ev.severity === 'error') {
						this.failure = msg;
					}
				}
				return;
			}
			case 'result': {
				this.sawResult = true;
				const stats = rec(ev.stats);
				if (stats) {
					const out = num(stats.output_tokens) ?? 0;
					const total = num(stats.total_tokens);
					const input = num(stats.input_tokens) ?? (total !== undefined ? Math.max(0, total - out) : 0);
					this.host.usage({ inputTokens: input, outputTokens: out });
				}
				if (ev.status !== undefined && ev.status !== 'success') {
					this.failure = str(rec(ev.error)?.message) ?? this.lastError ?? 'Gemini CLI reported an error.';
				}
				return;
			}
		}
	}
}

/** Finds the CLI's own session index for a session UUID (resume needs an index or "latest"). */
async function findSessionIndex(o: RunOptions, id: string): Promise<string | undefined> {
	const r = await runQuick(o.binary, ['--list-sessions', '--skip-trust'], { cwd: o.cwd, env: o.env, timeoutMs: 10_000 });
	if (!r) {
		return undefined;
	}
	for (const line of (r.stdout + '\n' + r.stderr).split('\n')) {
		const m = /^\s*(\d+)\..*\[([0-9a-f-]{36})\]\s*$/.exec(line);
		if (m && m[2] === id) {
			return m[1];
		}
	}
	return undefined;
}

const PLAN_PREFIX = 'Open Cursor note: this turn is read only. Investigate the code and answer or propose a concrete plan; do not modify any file.\n\n';

export async function runGemini(o: RunOptions): Promise<RunResult> {
	const readonly = MODE_READONLY(o.mode);
	const args: string[] = ['--output-format', 'stream-json', '--skip-trust'];
	args.push('--approval-mode', readonly ? 'plan' : o.autoRun === 'always' ? 'yolo' : 'auto_edit');
	if (o.model && o.model !== 'default') {
		args.push('-m', o.model);
	}
	let sessionId = o.sessionId;
	if (sessionId) {
		const idx = await findSessionIndex(o, sessionId);
		if (idx) {
			args.push('--resume', idx);
		} else {
			sessionId = undefined; // the CLI no longer has it; start over
		}
	}
	if (!sessionId) {
		sessionId = crypto.randomUUID();
		args.push('--session-id', sessionId);
	}
	args.push(...o.extraArgs);

	// Images: the CLI reads `@path` references in the prompt.
	let tmpDir: string | undefined;
	let prompt = (readonly ? PLAN_PREFIX : '') + o.prompt;
	if (o.images?.length) {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gemini-'));
		const refs = o.images.map((img, i) => {
			const ext = img.mediaType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
			const p = path.join(tmpDir!, `image-${i}.${ext}`);
			fs.writeFileSync(p, Buffer.from(img.data, 'base64'));
			return '@' + p;
		});
		prompt = refs.join(' ') + '\n' + prompt;
	}
	// Long prompts go through stdin (the CLI appends -p to stdin input).
	const viaStdin = prompt.length > 100_000;
	args.push('-p', viaStdin ? 'Follow the request above.' : prompt);

	const tracker = await TurnTracker.create(o.cwd, o.env, o.host);
	const parser = new GeminiParser(o.cwd, o.host, tracker);
	let queue: Promise<void> = Promise.resolve();
	const proc = spawnCli(o.binary, args, {
		cwd: o.cwd,
		env: o.env,
		stdin: viaStdin ? prompt : 'none',
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
		return { stopReason: 'error', error: `Could not start Gemini CLI: ${exit.spawnError}` };
	}
	if (parser.failure) {
		return { sessionId: sid, stopReason: 'error', error: friendlyError('gemini-cli', parser.failure) };
	}
	if (!parser.sawResult && exit.code !== 0) {
		return { sessionId: sid, stopReason: 'error', error: friendlyError('gemini-cli', proc.stderr() || `gemini exited with code ${exit.code}`) };
	}
	return { sessionId: sid, stopReason: 'done' };
}
