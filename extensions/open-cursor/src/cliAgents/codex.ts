/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Codex runner. `codex exec --json`, resume via `codex exec resume <thread>`. `codex exec` cannot
 *  route approvals to a client, so safety comes from the sandbox: workspace-write for agent mode,
 *  read-only for ask/plan, approval policy "never" (blocked actions fail instead of hanging). Only
 *  autoRun === 'always' lifts the sandbox. File edits are found by diffing git status.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codexModeArgs } from './modeArgs';
import type { RunOptions, RunResult, TurnHost } from './types';
import { TurnTracker } from './tracking';
import { arr, friendlyError, num, oneLine, parseJson, rec, resolveInCwd, spawnCli, str, truncate } from './util';

/** `/bin/zsh -lc "echo hi"` -> `echo hi` */
export function unwrapShell(cmd: string): string {
	const m = /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+-[a-z]*c\s+(["'])([\s\S]*)\1\s*$/.exec(cmd.trim());
	if (!m) {
		return cmd;
	}
	return m[1] === '"' ? m[2].replace(/\\(["\\$`])/g, '$1') : m[2];
}

export class CodexParser {
	sessionId?: string;
	sawTurnCompleted = false;
	failure?: string;
	private lastError?: string;
	private wroteText = false;

	constructor(
		private readonly cwd: string,
		private readonly host: TurnHost,
		private readonly tracker: TurnTracker,
	) {}

	async feed(ev: Record<string, unknown>): Promise<void> {
		switch (ev.type) {
			case 'thread.started':
				this.sessionId = str(ev.thread_id) ?? this.sessionId;
				return;
			case 'item.started':
				return this.onItem(rec(ev.item), 'started');
			case 'item.updated':
				return this.onItem(rec(ev.item), 'updated');
			case 'item.completed':
				return this.onItem(rec(ev.item), 'completed');
			case 'turn.completed': {
				this.sawTurnCompleted = true;
				const u = rec(ev.usage);
				if (u) {
					this.host.usage({ inputTokens: num(u.input_tokens) ?? 0, outputTokens: (num(u.output_tokens) ?? 0) });
				}
				return;
			}
			case 'turn.failed':
				this.failure = str(rec(ev.error)?.message) ?? this.lastError ?? 'Codex turn failed.';
				return;
			case 'error':
				this.lastError = str(ev.message) ?? this.lastError;
				return;
		}
	}

	private async onItem(item: Record<string, unknown> | undefined, phase: 'started' | 'updated' | 'completed'): Promise<void> {
		if (!item) {
			return;
		}
		const id = str(item.id) ?? '';
		switch (item.type) {
			case 'agent_message':
				if (phase === 'completed' && typeof item.text === 'string') {
					this.host.text((this.wroteText ? '\n\n' : '') + item.text);
					this.wroteText = true;
				}
				return;
			case 'reasoning':
				if (phase === 'completed' && typeof item.text === 'string') {
					this.host.thinking(item.text + '\n\n');
				}
				return;
			case 'command_execution': {
				const cmd = unwrapShell(str(item.command) ?? '');
				if (phase === 'started') {
					this.host.toolStart({ type: 'tool', id, name: 'run_terminal_cmd', args: { command: cmd }, status: 'running', title: `Running \`${oneLine(cmd, 70)}\``, command: { text: cmd, cwd: this.cwd } });
				} else if (phase === 'completed') {
					const code = num(item.exit_code);
					const failed = item.status === 'failed' || (code !== undefined && code !== 0);
					const out = str(item.aggregated_output);
					this.host.toolUpdate({
						type: 'tool',
						id,
						name: 'run_terminal_cmd',
						args: { command: cmd },
						status: failed ? 'error' : 'done',
						title: `${failed ? 'Failed' : 'Ran'} \`${oneLine(cmd, 70)}\`${failed && code !== undefined ? ` (exit ${code})` : ''}`,
						output: out ? truncate(out, 4000) : undefined,
						command: { text: cmd, cwd: this.cwd },
					});
					await this.tracker.afterToolCall();
				}
				return;
			}
			case 'file_change': {
				if (phase === 'completed') {
					const changes = arr(item.changes).map(rec).filter((c): c is Record<string, unknown> => !!c);
					const paths = changes.map(c => resolveInCwd(this.cwd, str(c.path) ?? '')).filter(p => p !== this.cwd);
					await this.tracker.afterToolCall(item.status === 'failed' ? [] : paths);
				}
				return;
			}
			case 'mcp_tool_call': {
				const server = str(item.server) ?? 'mcp';
				const tool = str(item.tool) ?? 'tool';
				const title = `${server} \u00b7 ${tool}`;
				if (phase === 'started') {
					this.host.toolStart({ type: 'tool', id, name: `mcp_${server}_${tool}`, args: rec(item.arguments), status: 'running', title });
				} else if (phase === 'completed') {
					const err = rec(item.error);
					const failed = item.status === 'failed' || !!err;
					const result = rec(item.result);
					const text = arr(result?.content)
						.map(c => str(rec(c)?.text) ?? '')
						.filter(Boolean)
						.join('\n');
					this.host.toolUpdate({ type: 'tool', id, name: `mcp_${server}_${tool}`, args: rec(item.arguments), status: failed ? 'error' : 'done', title, output: truncate(str(err?.message) ?? text, 2000) || undefined });
				}
				return;
			}
			case 'web_search':
				if (phase === 'completed') {
					this.host.toolStart({ type: 'tool', id: id || `ws-${Date.now()}`, name: 'web_search', status: 'done', title: `Searched the web for \`${oneLine(str(item.query) ?? '', 60)}\`` });
				}
				return;
			case 'error':
				if (phase === 'completed') {
					this.lastError = str(item.message) ?? this.lastError;
				}
				return;
		}
	}
}

export async function runCodex(o: RunOptions): Promise<RunResult> {
	const args: string[] = ['exec'];
	if (o.sessionId) {
		args.push('resume');
	}
	args.push('--json', '--skip-git-repo-check');
	if (!o.sessionId) {
		args.push('-C', o.cwd);
	}
	args.push(...codexModeArgs(o));
	if (o.model && o.model !== 'default') {
		args.push('-m', o.model);
	}
	args.push(...o.extraArgs);

	// Images are passed as files; write them to a private temp dir.
	let tmpDir: string | undefined;
	const imagePaths: string[] = [];
	if (o.images?.length) {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-codex-'));
		o.images.forEach((img, i) => {
			const ext = img.mediaType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
			const p = path.join(tmpDir!, `image-${i}.${ext}`);
			fs.writeFileSync(p, Buffer.from(img.data, 'base64'));
			imagePaths.push(p);
		});
	}
	if (o.sessionId) {
		args.push(o.sessionId);
	}
	for (const p of imagePaths) {
		args.push('--image=' + p);
	}
	args.push('-'); // prompt from stdin

	const tracker = await TurnTracker.create(o.cwd, o.env, o.host);
	const parser = new CodexParser(o.cwd, o.host, tracker);
	let queue: Promise<void> = Promise.resolve();
	const proc = spawnCli(o.binary, args, {
		cwd: o.cwd,
		env: o.env,
		stdin: o.prompt, // the mode guidance rides in developer_instructions
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
	const sessionId = parser.sessionId ?? o.sessionId;
	if (o.signal.aborted) {
		return { sessionId, stopReason: 'aborted' };
	}
	if (exit.spawnError) {
		return { stopReason: 'error', error: `Could not start Codex: ${exit.spawnError}` };
	}
	if (parser.failure) {
		return { sessionId, stopReason: 'error', error: friendlyError('codex', parser.failure) };
	}
	if (!parser.sawTurnCompleted && exit.code !== 0) {
		const err = proc.stderr().split('\n').filter(l => !/rmcp::transport|^Reading additional input/.test(l)).join('\n');
		return { sessionId, stopReason: 'error', error: friendlyError('codex', err || `codex exited with code ${exit.code}`) };
	}
	return { sessionId, stopReason: 'done' };
}
