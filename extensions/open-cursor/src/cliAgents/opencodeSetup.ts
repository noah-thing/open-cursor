/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  OpenCode setup: which models to offer (and which are free) and the no-sudo install. The free
 *  "Zen" models only work inside the OpenCode client, so we always run the real `opencode` CLI.
 *  No vscode import.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { arr, exists, executableNames, rec, runQuick, str, tail } from './util';

export interface OpenCodeModel {
	readonly id: string;
	readonly label: string;
	/** Free inside the OpenCode client, no account needed. */
	readonly free?: true;
}

/** Zen models known at build time; shown when the CLI is missing or its list cannot be read. */
export const OPENCODE_FALLBACK_MODELS: readonly string[] = [
	'opencode/big-pickle',
	'opencode/deepseek-v4.1-flash-free',
	'opencode/glm-5.3-flash-free',
	'opencode/nemotron-3-ultra-free',
	'opencode/mimo-v2.6-flash-free',
];

const WORD_CASE: Record<string, string> = { deepseek: 'DeepSeek', glm: 'GLM', mimo: 'MiMo', vl: 'VL', gpt: 'GPT', qwen: 'Qwen' };

/** `deepseek-v4.1-flash-free` -> `DeepSeek V4.1 Flash`. */
export function openCodeModelLabel(modelId: string): string {
	const name = modelId.slice(modelId.indexOf('/') + 1).replace(/-free$/, '');
	return name
		.split('-')
		.filter(Boolean)
		.map(w => {
			if (WORD_CASE[w]) {
				return WORD_CASE[w];
			}
			if (/\d/.test(w)) {
				return w.toUpperCase();
			}
			return w[0].toUpperCase() + w.slice(1);
		})
		.join(' ');
}

export function isOpenCodeFree(modelId: string): boolean {
	return modelId.startsWith('opencode/') && (modelId.endsWith('-free') || modelId === 'opencode/big-pickle');
}

/** Lines like `opencode/big-pickle`. The CLI prints them on stderr when not attached to a terminal, so callers pass both streams. */
export function parseOpenCodeModelList(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (/^[\w.-]+\/[^\s]+$/.test(line)) {
			out.push(line);
		}
	}
	return out;
}

/** Provider ids from `opencode auth list --format json` (OpenAI -> `openai`). Environment keys count as signed in. */
export function parseOpenCodeAuth(stdout: string): { id: string; name: string }[] {
	let j: unknown;
	try {
		j = JSON.parse(stdout);
	} catch {
		return [];
	}
	const out: { id: string; name: string }[] = [];
	for (const e of arr(j)) {
		const r = rec(e);
		const id = str(r?.id);
		if (id) {
			out.push({ id, name: str(r?.name) ?? id });
		}
	}
	return out;
}

/**
 * Free models first, then models of providers the user is signed in to. Everything else the CLI
 * lists (it knows every provider) is hidden because it would fail without a key.
 */
export function buildOpenCodeModels(all: readonly string[], providers: readonly { id: string; name: string }[]): OpenCodeModel[] {
	const free: OpenCodeModel[] = [];
	const rest: OpenCodeModel[] = [];
	const names = new Map(providers.map(p => [p.id, p.name]));
	for (const id of all) {
		if (isOpenCodeFree(id)) {
			free.push({ id, label: openCodeModelLabel(id), free: true });
			continue;
		}
		const provider = id.slice(0, id.indexOf('/'));
		if (names.has(provider)) {
			rest.push({ id, label: `${names.get(provider)}: ${id.slice(provider.length + 1)}` });
		}
	}
	// big-pickle first (the sturdiest all rounder), then alphabetical
	free.sort((a, b) => (a.id === 'opencode/big-pickle' ? -1 : b.id === 'opencode/big-pickle' ? 1 : a.id.localeCompare(b.id)));
	return [...free, ...rest];
}

export function fallbackOpenCodeModels(): OpenCodeModel[] {
	return buildOpenCodeModels(OPENCODE_FALLBACK_MODELS, []);
}

/** OpenCode 2 runs a background server unless told otherwise; `--standalone` keeps every call self contained. 0 when the version is unknown. */
export function openCodeMajor(version: string | undefined): number {
	const m = /^(\d+)\./.exec(version ?? '');
	// unknown version (the probe timed out): 0, so only flags that both versions accept are passed
	return m ? Number(m[1]) : 0;
}

let modelCache: { key: string; at: number; models: OpenCodeModel[] } | undefined;
const MODEL_CACHE_MS = 60_000;

/** Models to offer for an installed OpenCode. Falls back to the built in free list when the CLI cannot be queried. */
export async function listOpenCodeModels(binary: string, version: string | undefined, env: NodeJS.ProcessEnv): Promise<OpenCodeModel[]> {
	const key = `${binary}@${version ?? ''}`;
	if (modelCache && modelCache.key === key && Date.now() - modelCache.at < MODEL_CACHE_MS) {
		return modelCache.models;
	}
	const standalone = openCodeMajor(version) >= 2 ? ['--standalone'] : [];
	const [m, a] = await Promise.all([
		runQuick(binary, ['models', ...standalone], { env, timeoutMs: 15_000 }),
		runQuick(binary, ['auth', 'list', '--format', 'json', ...standalone], { env, timeoutMs: 15_000 }),
	]);
	const all = m ? parseOpenCodeModelList(m.stdout + '\n' + m.stderr) : [];
	if (!all.length) {
		return fallbackOpenCodeModels();
	}
	const models = buildOpenCodeModels(all, a ? parseOpenCodeAuth(a.stdout) : []);
	const result = models.length ? models : fallbackOpenCodeModels();
	modelCache = { key, at: Date.now(), models: result };
	return result;
}

export function resetOpenCodeModelCache(): void {
	modelCache = undefined;
}

/* ---------------------------------------------------------------- install */

export interface OpenCodeInstallResult {
	ok: boolean;
	message: string;
	binaryPath?: string;
}

export interface OpenCodeInstallOptions {
	/** Home directory to install under; tests point this at a scratch dir. */
	home?: string;
	/** Force the registry download (used on Windows, and by tests). */
	viaRegistry?: boolean;
	/** `darwin-arm64`, `windows-x64`, ... Defaults to this machine. */
	target?: string;
}

export const OPENCODE_INSTALL_CMD = 'curl -fsSL https://opencode.ai/v2/install | bash';

function platformTarget(): string {
	const os_ = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
	return `${os_}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
}

async function versionOf(bin: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const r = await runQuick(bin, ['--version'], { env, timeoutMs: 15_000 });
	const m = r && r.code === 0 ? /\d+\.\d+\.\d+/.exec(r.stdout + r.stderr) : null;
	return m?.[0];
}

function installedBinary(home: string): string | undefined {
	for (const n of executableNames('opencode')) {
		const p = path.join(home, '.opencode', 'bin', n);
		if (exists(p)) {
			return p;
		}
	}
	return undefined;
}

/**
 * The official v2 installer does exactly this: download `@opencode/cli-<target>` from the npm
 * registry and unpack the binary into ~/.opencode/bin. There is no PowerShell installer for v2,
 * so Windows uses this directly. Needs `tar`, which Windows 10+ ships.
 */
async function installViaRegistry(home: string, target: string, env: NodeJS.ProcessEnv): Promise<OpenCodeInstallResult> {
	const get = async (url: string): Promise<Response> => {
		const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
		if (!r.ok) {
			throw new Error(`${url} answered ${r.status}`);
		}
		return r;
	};
	const meta = rec(await (await get('https://opencode.ai/update/api/latest/cli/npm')).json());
	const version = str(meta?.version);
	const scope = (str(rec(meta?.metadata)?.package) ?? '@opencode/cli').replace(/\/cli$/, '');
	if (!version) {
		return { ok: false, message: 'Could not read the latest OpenCode version from opencode.ai.' };
	}
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-opencode-'));
	try {
		const win = target.startsWith('windows');
		const candidates = target.endsWith('-baseline') || !target.endsWith('x64') ? [target] : [target, `${target}-baseline`];
		let lastError = '';
		for (const t of candidates) {
			const file = path.join(tmp, `${t}.tgz`);
			try {
				const res = await get(`https://registry.npmjs.org/${scope}/cli-${t}/-/cli-${t}-${version}.tgz`);
				fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
			} catch (e) {
				lastError = e instanceof Error ? e.message : String(e);
				continue;
			}
			// Relative names: a GNU tar earlier on PATH (Git for Windows) would read `C:` as a remote host.
			const x = await runQuick('tar', ['-xzf', path.basename(file)], { env, cwd: tmp, timeoutMs: 120_000 });
			if (!x || x.code !== 0) {
				lastError = `tar failed: ${tail(x?.stderr ?? 'not available', 200)}`;
				continue;
			}
			const dir = path.join(home, '.opencode', 'bin');
			fs.mkdirSync(dir, { recursive: true });
			const dest = path.join(dir, win ? 'opencode.exe' : 'opencode');
			fs.copyFileSync(path.join(tmp, 'package', 'bin', win ? 'opencode.exe' : 'opencode'), dest);
			fs.chmodSync(dest, 0o755);
			if (await versionOf(dest, env)) {
				return { ok: true, message: `Installed OpenCode ${version} to ${dest}.`, binaryPath: dest };
			}
			lastError = 'the downloaded binary did not start';
		}
		return { ok: false, message: `OpenCode could not be installed: ${lastError}` };
	} catch (e) {
		return { ok: false, message: `OpenCode could not be installed: ${e instanceof Error ? e.message : String(e)}` };
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * Installs OpenCode 2 for the current user: the official installer on macOS and Linux, the same
 * registry download on Windows. Lands in ~/.opencode/bin, never needs sudo, does not touch shell
 * profiles. Resolves once `opencode --version` works.
 */
export async function installOpenCodeCli(env: NodeJS.ProcessEnv, opts: OpenCodeInstallOptions = {}): Promise<OpenCodeInstallResult> {
	const home = opts.home ?? os.homedir();
	const childEnv: NodeJS.ProcessEnv = { ...env, HOME: home, USERPROFILE: home };
	const existing = installedBinary(home);
	if (existing && (await versionOf(existing, childEnv))) {
		return { ok: true, message: `OpenCode is already installed at ${existing}.`, binaryPath: existing };
	}
	if (opts.viaRegistry || process.platform === 'win32') {
		return installViaRegistry(home, opts.target ?? platformTarget(), childEnv);
	}
	const r = await runQuick('bash', ['-c', OPENCODE_INSTALL_CMD.replace('| bash', '| bash -s -- --no-modify-path')], { env: childEnv, timeoutMs: 300_000 });
	const bin = installedBinary(home);
	if (bin && (await versionOf(bin, childEnv))) {
		return { ok: true, message: `Installed OpenCode to ${bin}.`, binaryPath: bin };
	}
	// curl or bash missing, offline installer host, ...: the registry route needs neither
	const fallback = await installViaRegistry(home, opts.target ?? platformTarget(), childEnv);
	if (fallback.ok) {
		return fallback;
	}
	return { ok: false, message: `OpenCode could not be installed. ${tail((r?.stderr || r?.stdout || '') + '\n' + fallback.message, 500)}\nYou can install it yourself with: ${OPENCODE_INSTALL_CMD}` };
}
