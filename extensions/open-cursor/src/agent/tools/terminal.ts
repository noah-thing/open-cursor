/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Command runner: a reusable "Open Cursor" VS Code terminal using shell integration, with a
 *  child_process fallback when shell integration is not available.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { stripAnsi } from '../../context/html';
import { tailLines } from '../tokens';

export interface RunOptions {
	readonly command: string;
	readonly cwd: string;
	/** True when the user gave an explicit cwd (otherwise the shell keeps its own session cwd). */
	readonly cwdExplicit: boolean;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
	onOutput?(textSoFar: string): void;
}

export interface RunResult {
	output: string;
	exitCode?: number;
	timedOut: boolean;
	aborted: boolean;
	via: 'terminal' | 'process';
}

const TERMINAL_NAME = 'Open Cursor';
const SI_WAIT_MS = 3000;
const ENV = { PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', CI: '1' };

function quote(p: string): string {
	return process.platform === 'win32' ? `"${p}"` : `'${p.replace(/'/g, `'\\''`)}'`;
}

function waitForShellIntegration(terminal: vscode.Terminal, ms: number): Promise<vscode.TerminalShellIntegration | undefined> {
	if (terminal.shellIntegration) { return Promise.resolve(terminal.shellIntegration); }
	return new Promise(resolve => {
		const timer = setTimeout(() => { sub.dispose(); resolve(terminal.shellIntegration); }, ms);
		const sub = vscode.window.onDidChangeTerminalShellIntegration(e => {
			if (e.terminal === terminal) {
				clearTimeout(timer);
				sub.dispose();
				resolve(e.shellIntegration);
			}
		});
	});
}

export class TerminalRunner implements vscode.Disposable {
	private terminal: vscode.Terminal | undefined;
	private chain: Promise<unknown> = Promise.resolve();
	private readonly disposables: vscode.Disposable[] = [];
	/** Remember a failed shell integration wait so later runs do not pay 3s each time. */
	private integrationBroken = false;

	constructor() {
		this.disposables.push(vscode.window.onDidCloseTerminal(t => {
			if (t === this.terminal) { this.terminal = undefined; }
		}));
	}

	/** Foreground commands are serialised: one shell, one command at a time. */
	run(opts: RunOptions): Promise<RunResult> {
		const next = this.chain.then(() => this.runNow(opts), () => this.runNow(opts));
		this.chain = next.catch(() => undefined);
		return next;
	}

	private async runNow(opts: RunOptions): Promise<RunResult> {
		if (opts.signal.aborted) { return { output: '', timedOut: false, aborted: true, via: 'process' }; }
		if (!this.integrationBroken && opts.cwd) {
			try {
				const t = this.getTerminal(opts.cwd);
				const si = await waitForShellIntegration(t, this.terminal === t && t.shellIntegration ? 0 : SI_WAIT_MS);
				if (si) {
					return await this.runWithIntegration(t, si, opts);
				}
				this.integrationBroken = true;
				t.dispose();
				this.terminal = undefined;
			} catch {
				this.integrationBroken = true;
			}
		}
		return this.runWithProcess(opts);
	}

	private getTerminal(cwd: string): vscode.Terminal {
		if (!this.terminal || this.terminal.exitStatus !== undefined) {
			this.terminal = vscode.window.createTerminal({ name: TERMINAL_NAME, cwd, env: ENV, isTransient: true, iconPath: new vscode.ThemeIcon('sparkle') });
			this.terminal.show(true);
		}
		return this.terminal;
	}

	private async runWithIntegration(terminal: vscode.Terminal, si: vscode.TerminalShellIntegration, opts: RunOptions): Promise<RunResult> {
		let line = opts.command;
		const current = si.cwd?.fsPath;
		if (opts.cwdExplicit && current !== opts.cwd) {
			line = `cd ${quote(opts.cwd)} && ${opts.command}`;
		}
		const exec = si.executeCommand(line);
		let output = '';
		const exited = new Promise<number | undefined>(resolve => {
			const sub = vscode.window.onDidEndTerminalShellExecution(e => {
				if (e.execution === exec) { sub.dispose(); resolve(e.exitCode); }
			});
			const closed = vscode.window.onDidCloseTerminal(t => {
				if (t === terminal) { closed.dispose(); sub.dispose(); resolve(undefined); }
			});
		});
		const reader = (async () => {
			try {
				for await (const chunk of exec.read()) {
					output += chunk;
					opts.onOutput?.(tailLines(stripAnsi(output), 60, 6000));
				}
			} catch {
				// terminal disposed
			}
		})();
		const finished = Promise.all([reader, exited]).then(([, code]) => ({ kind: 'done' as const, code }));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<{ kind: 'timeout' }>(res => { timer = setTimeout(() => res({ kind: 'timeout' }), opts.timeoutMs); });
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<{ kind: 'abort' }>(res => { onAbort = () => res({ kind: 'abort' }); opts.signal.addEventListener('abort', onAbort, { once: true }); });
		const outcome = await Promise.race([finished, timeout, aborted]);
		clearTimeout(timer);
		if (onAbort) { opts.signal.removeEventListener('abort', onAbort); }
		if (outcome.kind !== 'done') {
			terminal.sendText('\u0003', false);
			// give the shell a moment to report the interrupted command
			await Promise.race([finished, new Promise(r => setTimeout(r, 1500))]);
			return { output: stripAnsi(output), timedOut: outcome.kind === 'timeout', aborted: outcome.kind === 'abort', exitCode: undefined, via: 'terminal' };
		}
		return { output: stripAnsi(output), exitCode: outcome.code, timedOut: false, aborted: false, via: 'terminal' };
	}

	private runWithProcess(opts: RunOptions): Promise<RunResult> {
		return new Promise(resolve => {
			const win = process.platform === 'win32';
			const shell = process.env.SHELL || '/bin/sh';
			const child = win
				? spawn(opts.command, { cwd: opts.cwd, shell: true, env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'] })
				: spawn(shell, ['-l', '-c', opts.command], { cwd: opts.cwd, env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
			let output = '';
			let timedOut = false;
			let aborted = false;
			let settled = false;
			const kill = () => {
				try {
					if (!win && child.pid) { process.kill(-child.pid, 'SIGTERM'); } else { child.kill('SIGTERM'); }
					setTimeout(() => { try { if (!win && child.pid) { process.kill(-child.pid, 'SIGKILL'); } else { child.kill('SIGKILL'); } } catch { /* gone */ } }, 2000).unref();
				} catch { /* already exited */ }
			};
			const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
			const onAbort = () => { aborted = true; kill(); };
			opts.signal.addEventListener('abort', onAbort, { once: true });
			const onData = (d: Buffer) => {
				output += d.toString('utf8');
				if (output.length > 400000) { output = output.slice(-200000); }
				opts.onOutput?.(tailLines(stripAnsi(output), 60, 6000));
			};
			child.stdout?.on('data', onData);
			child.stderr?.on('data', onData);
			const finish = (code: number | null) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				opts.signal.removeEventListener('abort', onAbort);
				resolve({ output: stripAnsi(output), exitCode: code ?? undefined, timedOut, aborted, via: 'process' });
			};
			child.on('error', err => { output += `\n${err.message}`; finish(-1); });
			child.on('close', code => finish(code));
		});
	}

	/** Start a long running command in its own visible terminal and return after a short look at its output. */
	async startBackground(command: string, cwd: string, signal: AbortSignal): Promise<{ terminalName: string; initialOutput: string }> {
		const name = `Open Cursor: ${command.replace(/\s+/g, ' ').slice(0, 30)}`;
		const t = vscode.window.createTerminal({ name, cwd, env: ENV, iconPath: new vscode.ThemeIcon('sparkle') });
		t.show(true);
		const si = await waitForShellIntegration(t, SI_WAIT_MS);
		if (!si) {
			t.sendText(command, true);
			return { terminalName: name, initialOutput: '' };
		}
		const exec = si.executeCommand(command);
		let out = '';
		const sample = (async () => {
			try { for await (const c of exec.read()) { out += c; } } catch { /* closed */ }
		})();
		await Promise.race([sample, new Promise(r => setTimeout(r, 2500)), new Promise<void>(r => signal.addEventListener('abort', () => r(), { once: true }))]);
		return { terminalName: name, initialOutput: stripAnsi(out) };
	}

	/** Show a command the user asked to run (webview "run in terminal"). */
	runForUser(command: string): void {
		const t = this.terminal && this.terminal.exitStatus === undefined ? this.terminal : this.getTerminal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());
		t.show();
		t.sendText(command, true);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.terminal?.dispose();
	}
}

let shared: TerminalRunner | undefined;
export function getTerminalRunner(): TerminalRunner {
	shared ??= new TerminalRunner();
	return shared;
}
export function disposeTerminalRunner(): void {
	shared?.dispose();
	shared = undefined;
}
