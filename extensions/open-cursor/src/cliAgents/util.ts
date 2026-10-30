/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Process helpers shared by the CLI agent runners. No vscode import.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CliAgentId, TurnHost } from './types';
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
 * What an npm .cmd shim launches: a script for node, or a native .exe (Codex and others ship one).
 * The shim also mentions node.exe in its `IF EXIST` line, which is not the target.
 */
export function shimTarget(text: string): { kind: 'js' | 'exe'; rel: string } | undefined {
	const prefix = '"%~?dp0%?\\\\([^"]+';
	const js = new RegExp(prefix + '\\.(?:c|m)?js)"', 'i').exec(text);
	if (js) {
		return { kind: 'js', rel: js[1] };
	}
	for (const m of text.matchAll(new RegExp(prefix + '\\.exe)"', 'ig'))) {
		if (!/(^|[\\/])node\.exe$/i.test(m[1])) {
			return { kind: 'exe', rel: m[1] };
		}
	}
	return undefined;
}

/** cmd.exe ends a command at a newline, so line breaks inside an argument become spaces. */
export function cmdQuote(a: string): string {
	return '"' + a.replace(/\r?\n/g, ' ').replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

/**
 * Node refuses to spawn .cmd/.bat files directly on Windows (CVE-2024-27980), and most npm-installed
 * CLIs are .cmd shims. A shim from npm just runs `node <script>` or a native .exe, so run that directly;
 * anything else goes through cmd.exe with every argument quoted.
 */
export function planSpawn(binary: string, args: string[]): SpawnPlan {
	if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(binary)) {
		return { file: binary, args, shell: false };
	}
	try {
		const target = shimTarget(fs.readFileSync(binary, 'utf8'));
		if (target) {
			const dir = path.dirname(binary);
			const file = path.join(dir, target.rel);
			if (fs.existsSync(file)) {
				if (target.kind === 'exe') {
					return { file, args, shell: false };
				}
				const localNode = path.join(dir, 'node.exe');
				return { file: fs.existsSync(localNode) ? localNode : 'node', args: [file, ...args], shell: false };
			}
		}
	} catch {
		/* fall through to cmd.exe */
	}
	return { file: '"' + binary + '"', args: args.map(cmdQuote), shell: true };
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
	/** True when the idle watchdog (idleMs) ended the process. */
	readonly idled: () => boolean;
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
	opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string | 'keep-open' | 'none'; signal: AbortSignal; onLine: (line: string) => void; idleMs?: number },
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
	let idleTimer: NodeJS.Timeout | undefined;
	let idled = false;
	const poke = (): void => {
		if (!opts.idleMs) {
			return;
		}
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			idled = true;
			kill();
		}, opts.idleMs);
		idleTimer.unref();
	};
	child.stderr?.setEncoding('utf8');
	child.stderr?.on('data', (d: string) => {
		poke();
		err += d;
		if (err.length > 64_000) {
			err = err.slice(err.length - 32_000);
		}
	});
	const splitter = new LineSplitter(opts.onLine);
	child.stdout?.setEncoding('utf8');
	child.stdout?.on('data', (d: string) => {
		poke();
		splitter.push(d);
	});
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
			clearTimeout(idleTimer);
			spawnError = e.message;
			resolve({ code: null, signal: null, spawnError });
		});
		child.on('close', (code, signal) => {
			clearTimeout(idleTimer);
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
	poke();
	return { child, stderr: () => err, idled: () => idled, exited, kill };
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

/** True when the CLI says the session id we passed no longer exists (history cleared, a failed first turn). */
export function isStaleSessionError(text: string | undefined): boolean {
	return /no (?:saved )?(?:session|conversation)s?\b|(?:session|conversation) (?:was )?not found|not find (?:the |that )?(?:session|conversation)|could not (?:find|resume)[^\n]{0,40}(?:session|conversation)|could not resume|unknown session|no such session|session [0-9a-f-]{8,} (?:does not exist|is invalid)/i.test(stripAnsi(text ?? ''));
}

/** Wraps a host so a runner can tell whether the CLI produced anything the user would see. */
export function watchOutput(host: TurnHost): { host: TurnHost; produced: () => boolean } {
	let any = false;
	const mark = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => { any = true; return fn(...a); };
	return { produced: () => any, host: { ...host, text: mark(host.text), thinking: mark(host.thinking), toolStart: mark(host.toolStart) } };
}

/**
 * A CLI that exits 0 with no text and no result event but printed to stderr failed quietly.
 * Returns the message to show, or undefined when the turn was fine.
 */
export function silentFailure(agent: CliAgentId, produced: boolean, sawResult: boolean, stderr: string): string | undefined {
	const err = stderr.split('\n').filter(l => !/rmcp::transport|^Reading additional input/.test(l)).join('\n').trim();
	return !produced && !sawResult && err ? friendlyError(agent, err) : undefined;
}

const HTTP = (code: number): string => `(?:\\b(?:status\\w*|response)\\b[^\\n]{0,16}\\b${code}\\b|\\bhttp(?:/[\\d.]+)?[ :]+(?:error |status )?${code}\\b|\\b${code}\\b[^\\n]{0,24}\\b(?:unauthori[sz]ed|forbidden|too many|rate|authentication)\\b)`;
const NOT_SIGNED_IN = new RegExp(
	'not logged in|please run /login|invalid api key|api key not valid|no credentials|\\bsign in (?:to|with|again|required)\\b|please (?:sign|log) ?in|\\blog ?in (?:required|again)\\b|' +
	'authentication (?:failed|error|required|token)|auth(?:entication)? required|failed to authenticate|not authenticated|\\bunauthori[sz]ed\\b|invalid[_ ]grant|\\boauth token\\b|(?:token|session) (?:has )?expired|' + HTTP(401),
	'i',
);
const RATE_LIMITED = new RegExp(
	'rate[ -]?limit|usage limit|(?:exceeded|exhausted|reached|out of) (?:your |the |current )*quota|quota (?:exceeded|exhausted|reached)|resource_exhausted|too many requests|\\boverloaded\\b|' + HTTP(429),
	'i',
);

/** Short friendly hints for common failures. */
export function friendlyError(agent: CliAgentId, text: string): string {
	// CLIs color their errors for a terminal; the codes would show as junk in the chat
	const raw = stripAnsi(text).trim();
	const login = { 'claude-code': '`claude login`', codex: '`codex login`', grok: '`grok login`', 'gemini-cli': '`gemini` (and sign in)', opencode: '`opencode auth login`' }[agent];
	const label = { 'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok', 'gemini-cli': 'Gemini CLI', opencode: 'OpenCode' }[agent];
	if (agent === 'gemini-cli' && /IneligibleTierError|no longer supported for Gemini Code Assist/i.test(raw)) {
		return 'Google no longer lets Gemini CLI sign in with a personal Google account. Use a Gemini API key instead: save one under Settings > Models > Providers > Google Gemini (the key is free from Google AI Studio) and OpenCursor passes it to Gemini CLI, or set GEMINI_API_KEY in your environment.';
	}
	// OpenCode's free models need no account, so a sign in message would send the user down the wrong road
	if (agent !== 'opencode' && NOT_SIGNED_IN.test(raw)) {
		return `${label} is not signed in. Run ${login} in a terminal, then try again.\n\n${tail(raw, 400)}`;
	}
	if (RATE_LIMITED.test(raw)) {
		return `${label} hit a usage or rate limit.\n\n${tail(raw, 400)}`;
	}
	return tail(raw, 1200);
}
