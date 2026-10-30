/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Process helpers shared by the CLI agent runners. No vscode import.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CliAgentId } from './types';
import { stripAnsi } from '../terminal/logic';

export const COMMON_BIN_DIRS = (): string[] => {
	const h = os.homedir();
	if (process.platform === 'win32') {
		const appData = process.env.APPDATA ?? path.join(h, 'AppData', 'Roaming');
		const local = process.env.LOCALAPPDATA ?? path.join(h, 'AppData', 'Local');
		return [
			path.join(h, '.local', 'bin'),
			path.join(h, '.claude', 'local'),
			path.join(appData, 'npm'),
			path.join(local, 'Programs', 'claude'),
			path.join(local, 'Microsoft', 'WinGet', 'Links'),
			path.join(h, 'scoop', 'shims'),
			path.join(h, '.bun', 'bin'),
			path.join(h, '.opencode', 'bin'),
			path.join(h, '.codex', 'packages', 'standalone', 'current', 'bin'),
			// CLIs OpenCursor installed with its private Node.js (npmSetup.ts), and that Node.js
			path.join(h, '.open-cursor', 'cli'),
			path.join(h, '.open-cursor', 'node'),
		];
	}
	return [
		path.join(h, '.local', 'bin'),
		path.join(h, '.claude', 'local'),
		'/opt/homebrew/bin',
		'/usr/local/bin',
		'/usr/bin',
		'/snap/bin',
		'/home/linuxbrew/.linuxbrew/bin',
		path.join(h, '.npm-global', 'bin'),
		path.join(h, '.bun', 'bin'),
		path.join(h, '.opencode', 'bin'),
		// Codex's own installer, and the copy the ChatGPT app ships for its Codex tab
		path.join(h, '.codex', 'packages', 'standalone', 'current', 'bin'),
		'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin',
		path.join(h, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin'),
		// CLIs OpenCursor installed with its private Node.js (npmSetup.ts), and that Node.js
		path.join(h, '.open-cursor', 'cli', 'bin'),
		path.join(h, '.open-cursor', 'node', 'bin'),
	];
};

/** The user's login shell, with a fallback that exists on this OS (zsh is not installed on most Linux distros). */
export function defaultShell(): string {
	if (process.env.SHELL) {
		return process.env.SHELL;
	}
	for (const s of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
		if (fs.existsSync(s)) {
			return s;
		}
	}
	return '/bin/sh';
}

/** Executable names to try in a directory: on Windows the bare name never exists, `claude.exe` or `codex.cmd` does. */
export function executableNames(name: string): string[] {
	return process.platform === 'win32' ? [name + '.exe', name + '.cmd', name + '.bat', name] : [name];
}

/** The PATH-like variable in an env object. Windows calls it `Path`, and a second `PATH` key would be ambiguous. */
export function withPath(env: NodeJS.ProcessEnv, value: string): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...env };
	for (const k of Object.keys(out)) {
		if (k.toUpperCase() === 'PATH') {
			delete out[k];
		}
	}
	out[process.platform === 'win32' ? 'Path' : 'PATH'] = value;
	return out;
}

interface SpawnPlan { file: string; args: string[]; shell: boolean }

/**
 * Node refuses to spawn .cmd/.bat files directly on Windows (CVE-2024-27980), and most npm-installed
 * CLIs are .cmd shims. A shim from npm just runs `node <script>`, so run that directly; anything else
 * goes through cmd.exe with every argument quoted.
 */
export function planSpawn(binary: string, args: string[]): SpawnPlan {
	if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(binary)) {
		return { file: binary, args, shell: false };
	}
	try {
		const text = fs.readFileSync(binary, 'utf8');
		const m = /"%dp0%\\([^"]+\.(?:c|m)?js)"/i.exec(text) ?? /"%~dp0\\([^"]+\.(?:c|m)?js)"/i.exec(text);
		if (m) {
			const dir = path.dirname(binary);
			const script = path.join(dir, m[1]);
			const localNode = path.join(dir, 'node.exe');
			if (fs.existsSync(script)) {
				return { file: fs.existsSync(localNode) ? localNode : 'node', args: [script, ...args], shell: false };
			}
		}
	} catch {
		/* fall through to cmd.exe */
	}
	const quote = (a: string): string => '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
	return { file: '"' + binary + '"', args: args.map(quote), shell: true };
}

/** Kills a process and everything it started. POSIX uses the process group; Windows needs taskkill /T. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (!pid) {
		return;
	}
	if (process.platform === 'win32') {
		try {
			spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill(signal));
		} catch {
			child.kill(signal);
		}
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		child.kill(signal);
	}
}

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
/** Every CLI turn still running, so a window reload or quit can end them instead of leaving them behind. */
const live = new Set<(now?: boolean) => void>();

export function killAllClis(): void {
	// timers never fire once the host is quitting, so there is no grace period here
	for (const k of [...live]) { k(true); }
	live.clear();
}

export function spawnCli(
	binary: string,
	args: string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string | 'keep-open' | 'none'; signal: AbortSignal; onLine: (line: string) => void },
): SpawnedCli {
	const plan = planSpawn(binary, args);
	const child = spawn(plan.file, plan.args, {
		cwd: opts.cwd,
		env: opts.env,
		detached: process.platform !== 'win32',
		shell: plan.shell,
		windowsHide: true,
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
	const send = (sig: NodeJS.Signals): void => {
		try {
			killTree(child, sig);
		} catch {
			/* already gone */
		}
	};
	const kill = (now = false): void => {
		const pid = child.pid;
		if (!pid || child.exitCode !== null) {
			return;
		}
		if (now) {
			send('SIGKILL');
			return;
		}
		if (killTimer) {
			return;
		}
		send('SIGTERM');
		killTimer = setTimeout(() => send('SIGKILL'), 3000);
		killTimer.unref();
	};
	const onAbort = (): void => kill();
	live.add(kill);
	child.once('exit', () => live.delete(kill));
	child.once('error', () => live.delete(kill));
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
				killTimer = undefined;
				// grandchildren that ignored SIGTERM outlive their parent; end the group once (ESRCH is fine)
				if (process.platform !== 'win32') {
					send('SIGKILL');
				}
			}
			opts.signal.removeEventListener('abort', onAbort);
			resolve({ code, signal, spawnError });
		});
	});
	return { child, stderr: () => err, exited, kill };
}

/**
 * Runs a short command and returns its output (or undefined on failure/timeout). Never throws.
 * Output is capped (4 MB unless `maxBytes`): the process is killed at the cap and the call fails.
 * With `keepPartial`, a timeout or the cap returns what was collected so far, with `timedOut` set on a timeout.
 */
export function runQuick(binary: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxBytes?: number; keepPartial?: boolean }): Promise<{ stdout: string; stderr: string; code: number | null; timedOut?: boolean } | undefined> {
	return new Promise(resolve => {
		let out = '';
		let err = '';
		let size = 0;
		let done = false;
		let child: ChildProcess;
		try {
			const plan = planSpawn(binary, args);
			child = spawn(plan.file, plan.args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', shell: plan.shell, windowsHide: true });
		} catch {
			resolve(undefined);
			return;
		}
		const finish = (code: number | null, ok: boolean, timedOut = false): void => {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			resolve(ok ? { stdout: out, stderr: err, code, ...(timedOut ? { timedOut } : {}) } : undefined);
		};
		const stop = (): void => {
			try {
				killTree(child, 'SIGKILL');
			} catch {
				/* gone */
			}
		};
		const timer = setTimeout(() => {
			stop();
			finish(null, !!opts.keepPartial, true);
		}, opts.timeoutMs);
		const cap = opts.maxBytes ?? 4 * 1024 * 1024;
		const take = (d: string, into: 'out' | 'err'): void => {
			if (done) {
				return;
			}
			size += Buffer.byteLength(d);
			if (size > cap) {
				stop();
				finish(null, !!opts.keepPartial);
				return;
			}
			if (into === 'out') { out += d; } else { err += d; }
		};
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (d: string) => take(d, 'out'));
		child.stderr?.on('data', (d: string) => take(d, 'err'));
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
export function friendlyError(agent: CliAgentId, text: string): string {
	// CLIs color their errors for a terminal; the codes would show as junk in the chat
	const raw = stripAnsi(text).trim();
	const login = { 'claude-code': '`claude login`', codex: '`codex login`', grok: '`grok login`', 'gemini-cli': '`gemini` (and sign in)', opencode: '`opencode auth login`' }[agent];
	const label = { 'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok', 'gemini-cli': 'Gemini CLI', opencode: 'OpenCode' }[agent];
	if (agent === 'gemini-cli' && /IneligibleTierError|no longer supported for Gemini Code Assist/i.test(raw)) {
		return 'Google no longer lets Gemini CLI sign in with a personal Google account. Use a Gemini API key instead: Settings > Models > Providers > Google Gemini (the key is free from Google AI Studio).';
	}
	if (/not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|401|oauth|sign in|log in|api key not valid|no credentials|auth(?:entication)? required/i.test(raw)) {
		return `${label} is not signed in. Run ${login} in a terminal, then try again.\n\n${tail(raw, 400)}`;
	}
	if (/rate limit|usage limit|quota|429|overloaded/i.test(raw)) {
		return `${label} hit a usage or rate limit.\n\n${tail(raw, 400)}`;
	}
	return tail(raw, 1200);
}
