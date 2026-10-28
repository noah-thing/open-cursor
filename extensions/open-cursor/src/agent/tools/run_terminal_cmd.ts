/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Approval happens in the agent loop before run() is called.
 *--------------------------------------------------------------------------------------------*/

import { primaryRoot, resolvePath } from '../../context/paths';
import { tailLines } from '../tokens';
import { getTerminalRunner } from './terminal';
import { bool, clip, str, type ToolDef } from './types';
import { msg } from './fsutil';

interface Args { command?: string; is_background?: boolean; cwd?: string }

const DEFAULT_TIMEOUT_MS = 120_000;

export const runTerminalCmd: ToolDef<Args> = {
	readOnly: false,
	schema: {
		name: 'run_terminal_cmd',
		description: 'Run a shell command in the OpenCursor terminal and return its output (last ~200 lines) and exit code. The shell session persists between calls, so `cd` and exported variables carry over, and the initial directory is the workspace root. Commands time out after 120s: start servers and watchers with is_background true. Never run interactive commands that wait for input; pass non-interactive flags (e.g. --yes). Do not use it to read or edit files when a dedicated tool exists.',
		parameters: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The command line to execute.' },
				is_background: { type: 'boolean', description: 'Start and return immediately (dev servers, watchers).' },
				cwd: { type: 'string', description: 'Directory to run in (default: current shell directory, initially the workspace root).' },
			},
			required: ['command'],
		},
	},
	async run(args, ctx) {
		const command = str(args.command)?.trim();
		if (!command) { return { content: 'Missing required argument: command', isError: true }; }
		const root = primaryRoot();
		const cwdUri = args.cwd ? resolvePath(args.cwd).uri : root;
		if (!cwdUri || cwdUri.scheme !== 'file') { return { content: 'Running commands needs a local workspace folder.', isError: true }; }
		const runner = getTerminalRunner();
		try {
			if (bool(args.is_background)) {
				const r = await runner.startBackground(command, cwdUri.fsPath, ctx.signal);
				const tail = r.initialOutput.trim() ? `\nInitial output:\n${tailLines(r.initialOutput, 40, 4000)}` : '';
				return { content: `Started in the background in terminal "${r.terminalName}". It keeps running; the user can see it in the terminal panel.${tail}`, output: tail.trim() || 'started' };
			}
			const r = await runner.run({
				command, cwd: cwdUri.fsPath, cwdExplicit: !!args.cwd, timeoutMs: DEFAULT_TIMEOUT_MS, signal: ctx.signal,
				onOutput: text => ctx.onProgress?.(text),
			});
			const out = tailLines(r.output.trim(), 200).trim();
			if (r.aborted) { return { content: `Command cancelled by the user.${out ? `\nOutput so far:\n${out}` : ''}`, isError: true, output: out }; }
			if (r.timedOut) {
				return { content: `Command timed out after ${DEFAULT_TIMEOUT_MS / 1000}s and was interrupted. If it is a long running process, rerun with is_background true.${out ? `\nOutput so far:\n${out}` : ''}`, isError: true, output: out };
			}
			const code = r.exitCode;
			const status = code === undefined ? 'exit code unknown' : `exit code ${code}`;
			return { content: `${out || '(no output)'}\n[${status}]`, isError: code !== undefined && code !== 0 ? true : undefined, output: out || '(no output)' };
		} catch (e) {
			return { content: `Failed to run command: ${msg(e)}`, isError: true };
		}
	},
	title(args, status, r) {
		const c = clip(args.command ?? '', 60);
		if (status === 'done') { return `Ran \`${c}\``; }
		if (status === 'rejected') { return `Skipped \`${c}\``; }
		if (status === 'error') { return `Ran \`${c}\`${r?.content.includes('exit code') ? ' · failed' : ''}`; }
		return status === 'awaiting-approval' ? `Run \`${c}\`?` : `Running \`${c}\``;
	},
};
