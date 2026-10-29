/*---------------------------------------------------------------------------------------------
 *  OpenCode runner. `opencode run --format json --standalone -m <provider/model>`, prompt on stdin.
 *  We run the real client, which is what makes its free Zen models usable without an account.
 *
 *  Permissions: OpenCode cannot pause a headless run for approval (an `ask` rule just hangs), so
 *  every rule is allow or deny and is passed as a per run config in OPENCODE_CONFIG_CONTENT. That
 *  config outranks the user's and the project's files, which are never modified.
 *    ask / plan : `"*": "deny"` plus read, glob, grep, list, webfetch, websearch. No shell, no edits.
 *    agent/debug: everything allowed except the shell, which only runs allowlisted commands
 *                 (autoRun allowlist), everything but the careful commands (auto) or nothing (ask);
 *                 `--auto` plus allow-all when "always".
 *  Events arrive whole (no token streaming): reasoning, text, and one `tool_use` per finished tool.
 *  Edits are found by diffing git status after each tool, like Codex and Grok.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cliPromptPrefix } from './modeArgs';
import { openCodeMajor } from './opencodeSetup';
import { commandAllowed } from './policy';
import { CAREFUL } from '../agent/approval';
import { TurnTracker } from './tracking';
import { MODE_READONLY, type RunOptions, type RunResult, type TurnHost } from './types';
import { arr, displayPath, friendlyError, num, oneLine, parseJson, rec, resolveInCwd, spawnCli, str, truncate } from './util';

const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch']);
const READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'list', 'webfetch', 'websearch'];

export function openCodeToolView(tool: string, input: Record<string, unknown> | undefined, phase: 'run' | 'done', cwd: string): { name: string; title: string; command?: { text: string; cwd?: string } } {
	const run = phase === 'run';
	const p = str(input?.path) ?? str(input?.filePath) ?? str(input?.file);
	const rel = p ? displayPath(cwd, resolveInCwd(cwd, p)) : undefined;
	switch (tool) {
		case 'shell':
		case 'bash': {
			const cmd = str(input?.command) ?? '';
			return { name: 'run_terminal_cmd', title: `${run ? 'Running' : 'Ran'} \`${oneLine(cmd, 70)}\``, command: { text: cmd, cwd } };
		}
		case 'read':
			return { name: 'read_file', title: `${run ? 'Reading' : 'Read'} ${rel ?? 'file'}` };
		case 'edit':
			return { name: 'edit_file', title: `${run ? 'Editing' : 'Edited'} ${rel ?? 'file'}` };
		case 'write':
			return { name: 'write_file', title: `${run ? 'Writing' : 'Wrote'} ${rel ?? 'file'}` };
		case 'patch':
		case 'apply_patch':
			return { name: 'edit_file', title: run ? 'Applying patch' : 'Applied patch' };
		case 'list':
			return { name: 'list_dir', title: `${run ? 'Listing' : 'Listed'} ${rel ?? 'directory'}` };
		case 'glob':
			return { name: 'glob', title: `${run ? 'Finding' : 'Found'} \`${oneLine(str(input?.pattern) ?? '', 50)}\`` };
		case 'grep':
			return { name: 'grep', title: `${run ? 'Searching' : 'Searched'} \`${oneLine(str(input?.pattern) ?? '', 50)}\`` };
		case 'webfetch':
			return { name: 'fetch_url', title: `${run ? 'Fetching' : 'Fetched'} ${oneLine(str(input?.url) ?? '', 70)}` };
		case 'websearch':
			return { name: 'web_search', title: `${run ? 'Searching the web for' : 'Searched the web for'} \`${oneLine(str(input?.query) ?? '', 60)}\`` };
		case 'todowrite':
			return { name: 'todo_write', title: run ? 'Updating todos' : 'Updated todos' };
		case 'task':
		case 'subagent':
			return { name: 'task', title: `${run ? 'Running' : 'Ran'} subagent${str(input?.description) ? ` \`${oneLine(str(input?.description) ?? '', 50)}\`` : ''}` };
		case 'skill':
			return { name: 'skill', title: `${run ? 'Loading' : 'Loaded'} skill${str(input?.name) ? ` ${str(input?.name)}` : ''}` };
		case 'execute':
			return { name: 'execute', title: run ? 'Running a script' : 'Ran a script' };
		default:
			return { name: tool, title: `${run ? 'Running' : 'Ran'} ${tool}` };
	}
}

export class OpenCodeParser {
	sessionId?: string;
	failure?: string;
	/** Commands the permission config refused. */
	readonly denied: string[] = [];
	private wroteText = false;
	private inputTokens = 0;
	private outputTokens = 0;
	private sawUsage = false;
	private rows = 0;

	constructor(
		private readonly cwd: string,
		private readonly host: TurnHost,
		private readonly tracker: TurnTracker,
	) {}

	async feed(ev: Record<string, unknown>): Promise<void> {
		this.sessionId = str(ev.sessionID) ?? this.sessionId;
		const part = rec(ev.part);
		switch (ev.type) {
			case 'reasoning': {
				const t = str(part?.text);
				if (t) {
					this.host.thinking(t + '\n\n');
				}
				return;
			}
			case 'text': {
				const t = str(part?.text);
				if (t) {
					this.host.text((this.wroteText ? '\n\n' : '') + t);
					this.wroteText = true;
				}
				return;
			}
			case 'tool_use':
				return this.onTool(part);
			case 'step_finish': {
				const tk = rec(part?.tokens);
				if (tk) {
					this.sawUsage = true;
					this.inputTokens += (num(tk.input) ?? 0) + (num(rec(tk.cache)?.read) ?? 0);
					this.outputTokens += (num(tk.output) ?? 0) + (num(tk.reasoning) ?? 0);
				}
				return;
			}
			case 'error': {
				const e = rec(ev.error);
				const msg = str(e?.message) ?? str(rec(e?.data)?.message) ?? str(ev.message);
				this.failure = msg ?? str(e?.type) ?? 'OpenCode reported an error.';
				return;
			}
		}
	}

	/** Totals over every step of the turn; call once after the stream ends. */
	finish(): void {
		if (this.sawUsage) {
			this.host.usage({ inputTokens: this.inputTokens, outputTokens: this.outputTokens });
		}
	}

	private async onTool(part: Record<string, unknown> | undefined): Promise<void> {
		const tool = str(part?.tool) ?? 'tool';
		const state = rec(part?.state);
		const input = rec(state?.input);
		const status = str(state?.status);
		if (status !== 'completed' && status !== 'error') {
			return;
		}
		const id = str(part?.id) ?? str(part?.partID) ?? `oc-${++this.rows}`;
		const start = num(rec(state?.time)?.start);
		const end = num(rec(state?.time)?.end);
		const durationMs = start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined;
		const meta = rec(rec(state?.metadata)?.metadata);
		const isShell = tool === 'shell' || tool === 'bash';
		const exit = num(meta?.exit);
		const errText = str(state?.error);
		const failed = status === 'error' || (isShell && exit !== undefined && exit !== 0);
		const editPaths = EDIT_TOOLS.has(tool) ? this.editPaths(input, meta) : [];

		if (isShell && errText && /^permission denied/i.test(errText)) {
			this.denied.push(str(input?.command) ?? '');
		}

		if (EDIT_TOOLS.has(tool) && !failed) {
			// The tracker reports the edit row with real +/- counts (and the Keep/Undo originals).
			await this.tracker.afterToolCall(editPaths);
			return;
		}

		const v = openCodeToolView(tool, input, 'done', this.cwd);
		const output = failed ? (errText ?? str(state?.output)) : str(state?.output);
		const showOutput = failed || isShell || tool === 'webfetch';
		const part_ = {
			type: 'tool' as const,
			id,
			name: v.name,
			args: input,
			status: failed ? ('error' as const) : ('done' as const),
			title: failed && isShell && exit !== undefined ? `Failed \`${oneLine(str(input?.command) ?? '', 70)}\` (exit ${exit})` : failed && !isShell ? `${v.title} failed` : v.title,
			output: showOutput && output ? truncate(output, 4000) : undefined,
			command: v.command,
			durationMs,
		};
		this.host.toolStart({ ...part_, status: 'running', title: openCodeToolView(tool, input, 'run', this.cwd).title, output: undefined, durationMs: undefined });
		this.host.toolUpdate(part_);
		if (!failed && isShell) {
			await this.tracker.afterToolCall();
		}
	}

	private editPaths(input: Record<string, unknown> | undefined, meta: Record<string, unknown> | undefined): string[] {
		const direct = str(input?.path) ?? str(input?.filePath);
		if (direct) {
			return [resolveInCwd(this.cwd, direct)];
		}
		const files = arr(meta?.files)
			.map(f => str(rec(f)?.file) ?? str(rec(f)?.path))
			.filter((f): f is string => !!f);
		return files.map(f => resolveInCwd(this.cwd, f));
	}
}

interface PermissionRule {
	[tool: string]: 'allow' | 'deny' | Record<string, 'allow' | 'deny'>;
}

/** The per run permission config (see the header). Never contains an `ask`, which would hang the run. */
export function openCodePermission(o: Pick<RunOptions, 'mode' | 'autoRun' | 'commandAllowlist'>): PermissionRule {
	if (MODE_READONLY(o.mode)) {
		const rule: PermissionRule = { '*': 'deny' };
		for (const t of READ_ONLY_TOOLS) {
			rule[t] = 'allow';
		}
		return rule;
	}
	if (o.autoRun === 'always') {
		return { '*': 'allow', question: 'deny' };
	}
	const bash: Record<string, 'allow' | 'deny'> = { '*': o.autoRun === 'auto' ? 'allow' : 'deny' };
	if (o.autoRun === 'auto') {
		// Auto: every command runs except the careful ones (delete, install, publish, network), which are refused
		for (const c of [...CAREFUL, 'sudo']) {
			bash[c] = 'deny';
			bash[`${c} *`] = 'deny';
		}
		// and nothing that names a path outside the project
		for (const p of ['* ../*', '* ..', '* ~/*', '* ~']) {
			bash[p] = 'deny';
		}
	}
	if (o.autoRun === 'allowlist') {
		// Same rule as policy.ts: plain commands only. OpenCode checks each chained segment itself.
		for (const entry of o.commandAllowlist.map(e => e.trim())) {
			if (commandAllowed(entry, [entry])) {
				bash[entry] = 'allow';
				bash[`${entry} *`] = 'allow';
			}
		}
	}
	// question would wait for an answer nobody can give; outside-workspace access and loops are refused, not asked about
	return { '*': 'allow', bash, question: 'deny', external_directory: 'deny', doom_loop: 'deny' };
}

/** Flags for the run. `--standalone` and `--auto` exist from OpenCode 2 on. */
export function openCodeArgs(o: Pick<RunOptions, 'mode' | 'autoRun' | 'model' | 'sessionId' | 'version' | 'extraArgs'>): string[] {
	const v2 = openCodeMajor(o.version) >= 2;
	const args = ['run', '--format', 'json', '--thinking'];
	if (v2) {
		args.push('--standalone');
	}
	if (o.model && o.model !== 'default') {
		args.push('-m', o.model);
	}
	if (o.sessionId) {
		args.push('--session', o.sessionId);
	}
	if (v2 && o.autoRun === 'always' && !MODE_READONLY(o.mode)) {
		args.push('--auto');
	}
	args.push(...o.extraArgs);
	return args;
}

/** Child environment: the per run permission config, and PWD, which OpenCode trusts over the real working directory. */
export function openCodeEnv(o: Pick<RunOptions, 'env' | 'cwd' | 'mode' | 'autoRun' | 'commandAllowlist'>): NodeJS.ProcessEnv {
	return { ...o.env, PWD: o.cwd, OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: openCodePermission(o) }), OPENCODE_DISABLE_AUTOUPDATE: '1' };
}

export async function runOpenCode(o: RunOptions): Promise<RunResult> {
	const args = openCodeArgs(o);
	let tmpDir: string | undefined;
	let prompt = cliPromptPrefix(o.mode) + o.prompt;
	if (o.images?.length) {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-opencode-'));
		for (const [i, img] of o.images.entries()) {
			const ext = img.mediaType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
			const p = path.join(tmpDir, `image-${i}.${ext}`);
			fs.writeFileSync(p, Buffer.from(img.data, 'base64'));
			args.push('--file', p);
		}
		// `--file` takes a list, so the prompt goes on stdin and must not be read as a file name
		prompt = `The user attached ${o.images.length} image file(s); look at them.\n\n${prompt}`;
	}

	const env = openCodeEnv(o);
	const tracker = await TurnTracker.create(o.cwd, o.env, o.host);
	const parser = new OpenCodeParser(o.cwd, o.host, tracker);
	let queue: Promise<void> = Promise.resolve();
	const proc = spawnCli(o.binary, args, {
		cwd: o.cwd,
		env,
		stdin: prompt,
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
	const sid = parser.sessionId ?? o.sessionId;
	if (o.signal.aborted) {
		return { sessionId: sid, stopReason: 'aborted' };
	}
	if (exit.spawnError) {
		return { stopReason: 'error', error: `Could not start OpenCode: ${exit.spawnError}` };
	}
	parser.finish();
	if (parser.failure) {
		return { sessionId: sid, stopReason: 'error', error: friendlyError('opencode', parser.failure) };
	}
	if (exit.code !== 0) {
		return { sessionId: sid, stopReason: 'error', error: friendlyError('opencode', proc.stderr() || `opencode exited with code ${exit.code}`) };
	}
	if (parser.denied.length) {
		o.host.text(
			MODE_READONLY(o.mode)
				? `\n\n> OpenCode tried to run \`${oneLine(parser.denied[0], 80)}\`, but ${o.mode} mode is read only. Switch to Agent mode to let it run commands.\n\n`
				: `\n\n> OpenCode tried to run \`${oneLine(parser.denied[0], 80)}\`, and OpenCode cannot stop to ask for approval. To let it run commands like this, click the shield next to the model name and choose Full access, or add the command to the allowlist in Settings, then send your message again.\n\n`,
		);
	}
	return { sessionId: sid, stopReason: 'done' };
}
