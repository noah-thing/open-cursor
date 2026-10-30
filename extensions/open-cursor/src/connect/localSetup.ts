/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Running a model on this computer: looks at the hardware, installs and starts Ollama, and
 *  downloads a model through Ollama's own API. No account and nothing leaves the computer
 *  except the downloads themselves, which come from ollama.com.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseNvidiaSmi, type Hardware } from './localModels';

export type OllamaState = 'missing' | 'stopped' | 'running';

export function ollamaBase(): string {
	const v = vscode.workspace.getConfiguration('openCursor').get<string>('providers.ollama.baseUrl', '').trim();
	return (v || 'http://localhost:11434').replace(/\/+$/, '');
}

/** True when the configured Ollama address points at another machine, which this editor must not install or start anything for. */
export function ollamaRemote(): boolean {
	try {
		const h = new URL(ollamaBase()).hostname.toLowerCase().replace(/^\[|\]$/g, '');
		return !(h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\./.test(h));
	} catch {
		return false;
	}
}

/** Where a remote Ollama is expected, for messages. */
export function ollamaHost(): string {
	try { return new URL(ollamaBase()).host; } catch { return ollamaBase(); }
}

function run(file: string, args: string[], timeout = 10 * 60_000): Promise<{ code: number; out: string }> {
	return new Promise(resolve => {
		cp.execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
			resolve({ code, out: `${stdout}${stderr}`.trim() });
		});
	});
}

export async function detectHardware(): Promise<Hardware> {
	let gpu: Hardware['gpu'];
	if (process.platform === 'win32' || process.platform === 'linux') {
		const r = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 4000);
		if (r.code === 0) { gpu = parseNvidiaSmi(r.out); }
	}
	let diskFreeGB: number | undefined;
	try {
		const s = await fs.promises.statfs(os.homedir());
		diskFreeGB = (s.bavail * s.bsize) / 1e9;
	} catch {
		// unknown: the page does not warn about disk
	}
	const cpu = (os.cpus()[0]?.model ?? '').replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').replace(/\s+/g, ' ').trim();
	return { platform: process.platform, arch: process.arch, cpu, memGB: os.totalmem() / 1024 ** 3, ...(gpu ? { gpu } : {}), ...(diskFreeGB !== undefined ? { diskFreeGB } : {}) };
}

/** Where an installed Ollama lives, if anywhere. */
export function findOllama(): string | undefined {
	const home = os.homedir();
	const candidates = process.platform === 'darwin'
		? ['/Applications/Ollama.app', path.join(home, 'Applications', 'Ollama.app')]
		: process.platform === 'win32'
			? [path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama app.exe')]
			: [];
	for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
		candidates.push(path.join(dir, process.platform === 'win32' ? 'ollama.exe' : 'ollama'));
	}
	// apps started from the Dock do not get the shell's PATH, so look where package managers put it
	if (process.platform === 'darwin') { candidates.push('/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', path.join(home, '.homebrew', 'bin', 'ollama')); }
	if (process.platform === 'linux') { candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama'); }
	return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
}

/** A hard deadline on top of the abort signal: behind some proxies the editor's fetch ignores aborts. */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise(resolve => {
		const t = setTimeout(() => resolve(fallback), ms);
		p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
	});
}

export function ollamaRunning(): Promise<boolean> {
	// any other server on the port also answers 200; only Ollama sends {"version": "..."}
	const probe = async (): Promise<boolean> => {
		const r = await fetch(ollamaBase() + '/api/version', { signal: AbortSignal.timeout(1500) });
		if (!r.ok) { return false; }
		const j = await r.json() as { version?: unknown } | null;
		return !!j && typeof j.version === 'string';
	};
	return within(probe(), 2000, false);
}

export async function ollamaState(): Promise<OllamaState> {
	if (await ollamaRunning()) {
		// the install is done; the next one may open a terminal again
		linuxTerminal = undefined;
		return 'running';
	}
	return findOllama() ? 'stopped' : 'missing';
}

export function installedTags(): Promise<string[]> {
	const get = async (): Promise<string[]> => {
		const r = await fetch(ollamaBase() + '/api/tags', { signal: AbortSignal.timeout(2500) });
		const j = await r.json() as { models?: { name?: string }[] };
		return (j.models ?? []).map(m => m.name ?? '').filter(Boolean);
	};
	return within(get(), 3000, []);
}

async function waitRunning(ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await ollamaRunning()) { return true; }
		await new Promise(r => setTimeout(r, 1000));
	}
	return false;
}

/** Starts the installed Ollama in the background and waits for its server. */
export async function startOllama(): Promise<boolean> {
	if (await ollamaRunning()) { return true; }
	// the configured server is on another machine: starting a local one would not help
	if (ollamaRemote()) { return false; }
	const found = findOllama();
	if (!found) { return false; }
	const detach = (cmd: string, args: string[]): void => {
		// a failed spawn must not become an uncaught exception; waitRunning reports it
		cp.spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => undefined).unref();
	};
	if (process.platform === 'darwin') {
		if (found.endsWith('.app')) { detach('open', ['-g', found]); } else { detach(found, ['serve']); }
	} else if (process.platform === 'win32') {
		const app = found.endsWith('ollama app.exe') ? found : path.join(path.dirname(found), 'ollama app.exe');
		if (fs.existsSync(app)) { detach(app, []); } else { detach(found, ['serve']); }
	} else {
		detach(found, ['serve']);
	}
	return waitRunning(30_000);
}

async function download(url: string, file: string, report: (pct: number) => void, signal: AbortSignal): Promise<void> {
	const r = await fetch(url, { headers: { 'User-Agent': 'OpenCursor' }, signal });
	if (!r.ok || !r.body) { throw new Error(`the download answered ${r.status}`); }
	const total = Number(r.headers.get('content-length')) || 0;
	const out = fs.createWriteStream(file);
	// a full disk surfaces as a stream error; without a listener the drain wait would hang forever
	let failure: Error | undefined;
	const broke = new Promise<never>((_, rej) => out.once('error', e => { failure = e; rej(e); }));
	broke.catch(() => undefined);
	try {
		const reader = r.body.getReader();
		let got = 0;
		for (;;) {
			if (failure) { throw failure; }
			const { done, value } = await reader.read();
			if (done) { break; }
			got += value.length;
			if (!out.write(value)) { await Promise.race([new Promise<void>(res => out.once('drain', () => res())), broke]); }
			if (total) { report(got / total); }
		}
		await Promise.race([new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res()))), broke]);
	} finally {
		out.destroy();
	}
}

function writable(dir: string): boolean {
	try {
		fs.accessSync(dir, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Installs Ollama from ollama.com and starts it. macOS and Windows install without a password;
 * Linux needs one, so its official script runs in a terminal where the person can type it.
 * Resolves to 'terminal' when the person has to finish in that terminal.
 */
let linuxTerminal: vscode.Terminal | undefined;

/** Called when the page closes: the next install click starts fresh. */
export function forgetInstallTerminal(): void {
	linuxTerminal = undefined;
}

export async function installOllama(report: (message: string) => void, signal: AbortSignal): Promise<'running' | 'terminal'> {
	if (ollamaRemote()) { throw new Error(`the Ollama server at ${ollamaHost()} is not reachable`); }
	if (process.platform === 'linux') {
		// repeated clicks must not open more terminals and run the script again while the first is still going
		if (linuxTerminal && linuxTerminal.exitStatus === undefined) {
			linuxTerminal.show(false);
			return 'terminal';
		}
		const term = linuxTerminal = vscode.window.createTerminal({ name: 'Install Ollama' });
		term.show(false);
		term.sendText('curl -fsSL https://ollama.com/install.sh | sh');
		return 'terminal';
	}
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'opencursor-ollama-'));
	try {
		if (process.platform === 'darwin') {
			const zip = path.join(work, 'Ollama-darwin.zip');
			await download('https://ollama.com/download/Ollama-darwin.zip', zip, p => report(`Downloading Ollama, ${Math.round(p * 100)}%`), signal);
			report('Installing Ollama');
			const unpack = await run('ditto', ['-x', '-k', zip, work]);
			if (unpack.code !== 0 || !fs.existsSync(path.join(work, 'Ollama.app'))) { throw new Error(`could not unpack Ollama (${unpack.out})`); }
			const dest = writable('/Applications') ? '/Applications' : path.join(os.homedir(), 'Applications');
			fs.mkdirSync(dest, { recursive: true });
			const target = path.join(dest, 'Ollama.app');
			fs.rmSync(target, { recursive: true, force: true });
			const move = await run('ditto', [path.join(work, 'Ollama.app'), target]);
			if (move.code !== 0) { throw new Error(`could not copy Ollama to ${dest} (${move.out})`); }
		} else if (process.platform === 'win32') {
			const exe = path.join(work, 'OllamaSetup.exe');
			await download('https://ollama.com/download/OllamaSetup.exe', exe, p => report(`Downloading Ollama, ${Math.round(p * 100)}%`), signal);
			report('Installing Ollama');
			const r = await run(exe, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
			if (r.code !== 0) { throw new Error(`the Ollama installer stopped (${r.code})`); }
		} else {
			throw new Error('this system is not supported yet');
		}
	} finally {
		// the Windows installer can still hold its file for a moment; a leftover temp file is harmless
		try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
	}
	report('Starting Ollama');
	if (!(await startOllama())) { throw new Error('Ollama is installed but did not start. Open it once from your apps.'); }
	return 'running';
}

/** Downloads a model with Ollama's pull API; `report` gets 0..1 when Ollama knows the size. */
export async function pullModel(tag: string, report: (pct: number | undefined, status: string) => void, signal: AbortSignal): Promise<void> {
	const r = await fetch(ollamaBase() + '/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: tag, stream: true }), signal });
	if (!r.ok || !r.body) { throw new Error(`Ollama answered ${r.status}`); }
	const reader = r.body.getReader();
	const dec = new TextDecoder();
	let buf = '';
	let succeeded = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) { break; }
		buf += dec.decode(value, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) { continue; }
			let ev: { status?: string; total?: number; completed?: number; error?: string };
			try { ev = JSON.parse(line); } catch { continue; }
			if (ev.error) { throw new Error(/file does not exist|not found/i.test(ev.error) ? `${tag} is not in Ollama's library` : ev.error); }
			if (ev.status === 'success') { succeeded = true; }
			const pct = ev.total && ev.completed !== undefined ? ev.completed / ev.total : undefined;
			report(pct, ev.status ?? '');
		}
	}
	// the last line may arrive without a newline
	try { if ((JSON.parse(buf.trim()) as { status?: string }).status === 'success') { succeeded = true; } } catch { /* not JSON */ }
	// a dropped connection ends the stream quietly; only Ollama's own success event proves the model is there
	if (!succeeded) { throw new Error('Ollama stopped before the download finished'); }
}
