/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Finds the agent CLIs. macOS GUI apps do not inherit the shell PATH, so we ask the user's login
 *  shell once (4s timeout) and also try the usual install locations. No vscode import.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CliAgentInfo } from '../services';
import type { CliAgentId } from './types';
import { fallbackOpenCodeModels, listOpenCodeModels } from './opencodeSetup';
import { COMMON_BIN_DIRS, defaultShell, executableNames, exists, parseJson, rec, runQuick, withPath } from './util';

export const BINARY_NAME: Record<CliAgentId, string> = { 'claude-code': 'claude', codex: 'codex', grok: 'grok', 'gemini-cli': 'gemini', opencode: 'opencode' };
export const AGENT_LABEL: Record<CliAgentId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok', 'gemini-cli': 'Gemini CLI', opencode: 'OpenCode' };
export const AGENT_IDS: CliAgentId[] = ['claude-code', 'codex', 'grok', 'gemini-cli', 'opencode'];

export interface DetectConfig {
	readonly enabled: boolean;
	readonly paths: Partial<Record<CliAgentId, string>>;
}

interface ShellInfo {
	readonly path: string[];
	readonly found: Partial<Record<CliAgentId, string>>;
}

let shellInfoPromise: Promise<ShellInfo> | undefined;

/** Runs the login shell once per process. A failed or timed out run is not remembered: the next call tries again. */
export function loginShellInfo(): Promise<ShellInfo> {
	if (!shellInfoPromise) {
		let failed = false;
		const p = (async (): Promise<ShellInfo> => {
			const info: { path: string[]; found: Partial<Record<CliAgentId, string>> } = { path: [], found: {} };
			if (process.platform === 'win32') {
				return info;
			}
			const shell = defaultShell();
			const script = `printf '__OC_PATH__%s\\n' "$PATH"; command -v ${AGENT_IDS.map(id => BINARY_NAME[id]).join(' ')}`;
			// on a timeout keep whatever arrived, but do not remember it
			const r = await runQuick(shell, ['-ilc', script], { timeoutMs: 4000, keepPartial: true, env: { ...process.env, TERM: process.env.TERM ?? 'dumb' } });
			if (!r || r.timedOut) {
				failed = true;
			}
			if (!r) {
				return info;
			}
			for (const raw of r.stdout.split('\n')) {
				const line = raw.replace(/\r$/, '');
				const i = line.indexOf('__OC_PATH__');
				if (i >= 0) {
					info.path = line.slice(i + '__OC_PATH__'.length).split(path.delimiter).filter(Boolean);
				} else if (line.startsWith('/')) {
					const base = path.basename(line);
					for (const id of AGENT_IDS) {
						if (BINARY_NAME[id] === base && !info.found[id]) {
							info.found[id] = line.trim();
						}
					}
				}
			}
			return info;
		})();
		shellInfoPromise = p;
		void p.then(() => {
			if (failed && shellInfoPromise === p) {
				shellInfoPromise = undefined;
			}
		});
	}
	return shellInfoPromise;
}

export function resetLoginShellCache(): void {
	shellInfoPromise = undefined;
}

export async function resolveBinary(id: CliAgentId, cfg: DetectConfig): Promise<string | undefined> {
	const override = cfg.paths[id]?.trim();
	if (override) {
		const p = override.startsWith('~') ? path.join(os.homedir(), override.slice(1)) : override;
		for (const cand of [p, ...(process.platform === 'win32' && !path.extname(p) ? executableNames(p) : [])]) {
			if (exists(cand)) {
				return cand;
			}
		}
	}
	const sh = await loginShellInfo();
	const fromShell = sh.found[id];
	if (fromShell && exists(fromShell)) {
		return fromShell;
	}
	const dirs = [...COMMON_BIN_DIRS(), ...sh.path, ...(process.env.PATH ?? '').split(path.delimiter)];
	for (const d of dirs) {
		if (!d) {
			continue;
		}
		for (const name of executableNames(BINARY_NAME[id])) {
			const p = path.join(d, name);
			if (exists(p)) {
				return p;
			}
		}
	}
	return undefined;
}

/** Environment for spawning a CLI: login-shell PATH first, then the usual dirs, then ours. */
export async function cliEnv(binary: string | undefined): Promise<NodeJS.ProcessEnv> {
	const sh = await loginShellInfo();
	const dirs = [binary ? path.dirname(binary) : '', ...sh.path, ...COMMON_BIN_DIRS(), ...(process.env.PATH ?? '').split(path.delimiter)];
	const seen = new Set<string>();
	const merged = dirs.filter(d => d && !seen.has(d) && !!seen.add(d));
	const env = withPath(process.env, merged.join(path.delimiter));
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}

export function parseVersion(text: string): string | undefined {
	const m = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(text);
	return m?.[0];
}

async function checkLogin(id: CliAgentId, binary: string, env: NodeJS.ProcessEnv): Promise<boolean | undefined> {
	const home = os.homedir();
	switch (id) {
		case 'claude-code': {
			if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) {
				return true;
			}
			const r = await runQuick(binary, ['auth', 'status'], { env, timeoutMs: 6000 });
			const j = r ? parseJson(r.stdout) : undefined;
			if (j && typeof j.loggedIn === 'boolean') {
				return j.loggedIn;
			}
			return fs.existsSync(path.join(home, '.claude', '.credentials.json')) ? true : undefined;
		}
		case 'codex': {
			if (env.OPENAI_API_KEY || env.CODEX_API_KEY) {
				return true;
			}
			const r = await runQuick(binary, ['login', 'status'], { env, timeoutMs: 6000 });
			if (r) {
				return r.code === 0;
			}
			return fs.existsSync(path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'auth.json')) ? true : undefined;
		}
		case 'grok':
			return (await grokStatus(binary, env)).loggedIn;
		case 'gemini-cli':
			if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_USE_VERTEXAI) {
				return true;
			}
			return fs.existsSync(path.join(home, '.gemini', 'oauth_creds.json')) ? true : undefined;
		case 'opencode':
			// The free Zen models need no account.
			return true;
	}
}

/** Codex models the user can pick, read from the CLI's local model cache (no network). */
export function readCodexModels(): { id: string; label: string }[] {
	const out: { id: string; label: string }[] = [];
	try {
		const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
		const j = parseJson(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
		for (const m of (Array.isArray(j?.models) ? j.models : []) as unknown[]) {
			const r = rec(m);
			if (r && typeof r.slug === 'string' && r.visibility === 'list') {
				out.push({ id: r.slug, label: typeof r.display_name === 'string' ? r.display_name : r.slug });
			}
		}
	} catch {
		/* no cache yet */
	}
	return out;
}

/** Turns `grok models` output into model choices: lines like `  * grok-4.7 (default)` and `  - grok-4.6`. */
export function parseGrokModels(stdout: string): { id: string; label: string }[] {
	const out: { id: string; label: string }[] = [];
	for (const line of stdout.split('\n')) {
		const m = /^\s*[*-]\s+(\S+)/.exec(line);
		if (m) {
			out.push({ id: m[1], label: m[1].replace(/^grok-/, '').replace(/-/g, ' ') });
		}
	}
	return out;
}

/** Grok models from the CLI's local cache, used when `grok models` cannot run. */
export function readGrokModels(): { id: string; label: string }[] {
	const out: { id: string; label: string }[] = [];
	try {
		const j = parseJson(fs.readFileSync(path.join(os.homedir(), '.grok', 'models_cache.json'), 'utf8'));
		for (const [id, v] of Object.entries(rec(j?.models) ?? {})) {
			if (rec(rec(v)?.info)?.hidden !== true) {
				out.push({ id, label: id.replace(/^grok-/, '').replace(/-/g, ' ') });
			}
		}
	} catch {
		/* no cache yet */
	}
	return out;
}

/** `grok models` prints the login state and the models this account can use (about 0.5s, no model turn). */
async function grokStatus(binary: string, env: NodeJS.ProcessEnv): Promise<{ loggedIn: boolean | undefined; models: { id: string; label: string }[] }> {
	const r = await runQuick(binary, ['models'], { env, timeoutMs: 8000 });
	const text = r ? r.stdout + '\n' + r.stderr : '';
	const models = parseGrokModels(r?.stdout ?? '');
	if (/logged in/i.test(text) && !/not logged in/i.test(text)) {
		return { loggedIn: true, models };
	}
	if (/not logged in|not signed in|log ?in|sign in/i.test(text)) {
		return { loggedIn: false, models };
	}
	if (env.XAI_API_KEY || env.GROK_API_KEY) {
		return { loggedIn: true, models };
	}
	return { loggedIn: fs.existsSync(path.join(os.homedir(), '.grok', 'auth.json')) ? true : undefined, models };
}

export function modelsFor(id: CliAgentId): { id: string; label: string }[] {
	switch (id) {
		case 'claude-code':
			return [
				{ id: 'default', label: 'Default' },
				{ id: 'opus', label: 'Opus' },
				{ id: 'sonnet', label: 'Sonnet' },
				{ id: 'haiku', label: 'Haiku' },
			];
		case 'codex':
			return [{ id: 'default', label: 'Default' }, ...readCodexModels()];
		case 'grok': {
			const found = readGrokModels();
			return [{ id: 'default', label: 'Default' }, ...(found.length ? found : [{ id: 'grok-4.7', label: '4.7' }])];
		}
		case 'gemini-cli':
			return [
				{ id: 'default', label: 'Default' },
				{ id: 'pro', label: 'Pro' },
				{ id: 'flash', label: 'Flash' },
			];
		case 'opencode':
			return fallbackOpenCodeModels();
	}
}

export async function detectAgent(id: CliAgentId, cfg: DetectConfig): Promise<CliAgentInfo> {
	const base = { id, label: AGENT_LABEL[id], models: modelsFor(id) };
	if (!cfg.enabled) {
		return base;
	}
	const binary = await resolveBinary(id, cfg);
	if (!binary) {
		return base;
	}
	const env = await cliEnv(binary);
	if (id === 'grok') {
		const [st, gver] = await Promise.all([grokStatus(binary, env), runQuick(binary, ['--version'], { env, timeoutMs: 6000 })]);
		const models = st.models.length ? [{ id: 'default', label: 'Default' }, ...st.models] : base.models;
		return { ...base, models, binaryPath: binary, version: gver ? parseVersion(gver.stdout + ' ' + gver.stderr) : undefined, loggedIn: st.loggedIn };
	}
	if (id === 'opencode') {
		const ver = await runQuick(binary, ['--version'], { env, timeoutMs: 6000 });
		const version = ver ? parseVersion(ver.stdout + ' ' + ver.stderr) : undefined;
		return { ...base, models: await listOpenCodeModels(binary, version, env), binaryPath: binary, version, loggedIn: true };
	}
	const [ver, loggedIn] = await Promise.all([runQuick(binary, ['--version'], { env, timeoutMs: 6000 }), checkLogin(id, binary, env)]);
	return { ...base, binaryPath: binary, version: ver ? parseVersion(ver.stdout + ' ' + ver.stderr) : undefined, loggedIn };
}

export async function detectAll(cfg: DetectConfig): Promise<CliAgentInfo[]> {
	return Promise.all(AGENT_IDS.map(id => detectAgent(id, cfg)));
}
