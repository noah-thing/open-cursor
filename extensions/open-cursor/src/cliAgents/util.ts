/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Process helpers shared by the CLI agent runners. No vscode import.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const COMMON_BIN_DIRS = (): string[] => {
	const h = os.homedir();
	return [
		path.join(h, '.local', 'bin'),
		path.join(h, '.claude', 'local'),
		'/opt/homebrew/bin',
		'/usr/local/bin',
		path.join(h, '.npm-global', 'bin'),
		path.join(h, '.bun', 'bin'),
	];
};

export function exists(p: string): boolean {
	try {
		fs.accessSync(p, fs.constants.X_OK);
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

export function tail(text: string, max = 800): string {
	const t = text.trim();
	return t.length > max ? '...' + t.slice(t.length - max) : t;
}

export function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + '\n... (truncated)' : text;
}

export function oneLine(text: string, max = 80): string {
	const t = text.replace(/\s+/g, ' ').trim();
	return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Splits a byte stream into lines, tolerant of chunk boundaries and CRLF. */
export class LineSplitter {
	private buf = '';
	constructor(private readonly onLine: (line: string) => void) {}
	push(chunk: string): void {
		this.buf += chunk;
		let i: number;
		while ((i = this.buf.indexOf('\n')) >= 0) {
			const line = this.buf.slice(0, i).replace(/\r$/, '');
			this.buf = this.buf.slice(i + 1);
			if (line.trim()) {
				this.onLine(line);
			}
		}
	}
	end(): void {
		if (this.buf.trim()) {
			this.onLine(this.buf.trim());
		}
		this.buf = '';
	}
}

export function parseJson(line: string): Record<string, unknown> | undefined {
	try {
		const v: unknown = JSON.parse(line);
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function str(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}
export function num(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
export function rec(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
export function arr(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

export interface SpawnedCli {
	readonly child: ChildProcess;
	readonly stderr: () => string;
	/** Resolves when the process has exited and all stdout lines were delivered. */
	readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: string }>;
	kill(): void;
}

/**
 * Spawns detached (own process group) so abort can take down the CLI together with every
 * shell and tool it started. stdout is delivered line by line.
 */
export function spawnCli(
	binary: string,
	args: string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string | 'keep-open' | 'none'; signal: AbortSignal; onLine: (line: string) => void },
): SpawnedCli {
	const child = spawn(binary, args, {
		cwd: opts.cwd,
		env: opts.env,
		detached: process.platform !== 'win32',
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let err = '';
	child.stderr?.setEncoding('utf8');
	child.stderr?.on('data', (d: string) => {
		err += d;
		if (err.length > 64_000) {
			err = err.slice(err.length - 32_000);
		}
	});
	const splitter = new LineSplitter(opts.onLine);
	child.stdout?.setEncoding('utf8');
	child.stdout?.on('data', (d: string) => splitter.push(d));
	child.stdin?.on('error', () => undefined);
	if (typeof opts.stdin === 'string' && opts.stdin !== 'keep-open' && opts.stdin !== 'none') {
		child.stdin?.end(opts.stdin);
	} else if (opts.stdin === 'none' || opts.stdin === undefined) {
		child.stdin?.end();
	}

	let killTimer: NodeJS.Timeout | undefined;
	const kill = (): void => {
		const pid = child.pid;
		if (!pid || child.exitCode !== null) {
			return;
		}
		const send = (sig: NodeJS.Signals): void => {
			try {
				if (process.platform === 'win32') {
					child.kill(sig);
				} else {
					process.kill(-pid, sig);
				}
			} catch {
				try {
					child.kill(sig);
				} catch {
					/* already gone */
				}
			}
		};
		send('SIGTERM');
		killTimer = setTimeout(() => send('SIGKILL'), 3000);
		killTimer.unref();
	};
	const onAbort = (): void => kill();
	if (opts.signal.aborted) {
		kill();
	} else {
		opts.signal.addEventListener('abort', onAbort, { once: true });
	}

	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: string }>(resolve => {
		let spawnError: string | undefined;
		child.on('error', e => {
			spawnError = e.message;
			resolve({ code: null, signal: null, spawnError });
		});
		child.on('close', (code, signal) => {
			splitter.end();
			if (killTimer) {
				clearTimeout(killTimer);
			}
			opts.signal.removeEventListener('abort', onAbort);
			resolve({ code, signal, spawnError });
		});
	});
	return { child, stderr: () => err, exited, kill };
}

/** Runs a short command and returns stdout (or undefined on failure/timeout). Never throws. */
export function runQuick(binary: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ stdout: string; stderr: string; code: number | null } | undefined> {
	return new Promise(resolve => {
		let out = '';
		let err = '';
		let done = false;
		let child: ChildProcess;
		try {
			child = spawn(binary, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
		} catch {
			resolve(undefined);
			return;
		}
		const finish = (code: number | null, ok: boolean): void => {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			resolve(ok ? { stdout: out, stderr: err, code } : undefined);
		};
		const timer = setTimeout(() => {
			try {
				if (child.pid && process.platform !== 'win32') {
					process.kill(-child.pid, 'SIGKILL');
				} else {
					child.kill('SIGKILL');
				}
			} catch {
				/* gone */
			}
			finish(null, false);
		}, opts.timeoutMs);
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (d: string) => (out += d));
		child.stderr?.on('data', (d: string) => (err += d));
		child.on('error', () => finish(null, false));
		child.on('close', code => finish(code, true));
	});
}

export function resolveInCwd(cwd: string, p: string): string {
	return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

export function displayPath(cwd: string, abs: string): string {
	const rel = path.relative(cwd, abs);
	return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
}

export function countLines(text: string): number {
	return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Unicode-safe read for review purposes: returns undefined for missing, binary or huge files. */
export function readTextFile(p: string, maxBytes = 2_000_000): string | undefined | 'skip' {
	try {
		const st = fs.statSync(p);
		if (!st.isFile()) {
			return 'skip';
		}
		if (st.size > maxBytes) {
			return 'skip';
		}
		const buf = fs.readFileSync(p);
		if (buf.subarray(0, 8000).includes(0)) {
			return 'skip';
		}
		return buf.toString('utf8');
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'skip';
	}
}

/** Short friendly hints for common failures. */
export function friendlyError(agent: 'claude-code' | 'codex' | 'gemini-cli', raw: string): string {
	const login = agent === 'claude-code' ? '`claude login`' : agent === 'codex' ? '`codex login`' : '`gemini` (and sign in)';
	const label = agent === 'claude-code' ? 'Claude Code' : agent === 'codex' ? 'Codex' : 'Gemini CLI';
	if (/not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|401|oauth|sign in|log in|api key not valid|no credentials|auth(?:entication)? required/i.test(raw)) {
		return `${label} is not signed in. Run ${login} in a terminal, then try again.\n\n${tail(raw, 400)}`;
	}
	if (/rate limit|usage limit|quota|429|overloaded/i.test(raw)) {
		return `${label} hit a usage or rate limit.\n\n${tail(raw, 400)}`;
	}
	return tail(raw, 1200);
}
