/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Finds the agent CLIs. macOS GUI apps do not inherit the shell PATH, so we ask the user's login
 *  shell once (4s timeout) and also try the usual install locations. No vscode import.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CliAgentInfo } from '../services';
import type { CliAgentId } from './types';
import { COMMON_BIN_DIRS, exists, parseJson, rec, runQuick } from './util';

export const BINARY_NAME: Record<CliAgentId, string> = { 'claude-code': 'claude', codex: 'codex', 'gemini-cli': 'gemini' };
export const AGENT_LABEL: Record<CliAgentId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI' };
export const AGENT_IDS: CliAgentId[] = ['claude-code', 'codex', 'gemini-cli'];

export interface DetectConfig {
	readonly enabled: boolean;
	readonly paths: Partial<Record<CliAgentId, string>>;
}

interface ShellInfo {
	readonly path: string[];
	readonly found: Partial<Record<CliAgentId, string>>;
}

let shellInfoPromise: Promise<ShellInfo> | undefined;

/** Runs the login shell once per process. */
export function loginShellInfo(): Promise<ShellInfo> {
	shellInfoPromise ??= (async (): Promise<ShellInfo> => {
		const info: { path: string[]; found: Partial<Record<CliAgentId, string>> } = { path: [], found: {} };
		if (process.platform === 'win32') {
			return info;
		}
		const shell = process.env.SHELL || '/bin/zsh';
		const script = `printf '__OC_PATH__%s\\n' "$PATH"; command -v ${AGENT_IDS.map(id => BINARY_NAME[id]).join(' ')}`;
		const r = await runQuick(shell, ['-ilc', script], { timeoutMs: 4000, env: { ...process.env, TERM: process.env.TERM ?? 'dumb' } });
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
	return shellInfoPromise;
}

export function resetLoginShellCache(): void {
	shellInfoPromise = undefined;
}

export async function resolveBinary(id: CliAgentId, cfg: DetectConfig): Promise<string | undefined> {
	const override = cfg.paths[id]?.trim();
	if (override) {
		const p = override.startsWith('~') ? path.join(os.homedir(), override.slice(1)) : override;
		if (exists(p)) {
			return p;
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
		const p = path.join(d, BINARY_NAME[id]);
		if (exists(p)) {
			return p;
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
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: merged.join(path.delimiter) };
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
		case 'gemini-cli':
			if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_USE_VERTEXAI) {
				return true;
			}
			return fs.existsSync(path.join(home, '.gemini', 'oauth_creds.json')) ? true : undefined;
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
		case 'gemini-cli':
			return [
				{ id: 'default', label: 'Default' },
				{ id: 'pro', label: 'Pro' },
				{ id: 'flash', label: 'Flash' },
			];
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
	const [ver, loggedIn] = await Promise.all([runQuick(binary, ['--version'], { env, timeoutMs: 6000 }), checkLogin(id, binary, env)]);
	return { ...base, binaryPath: binary, version: ver ? parseVersion(ver.stdout + ' ' + ver.stderr) : undefined, loggedIn };
}

export async function detectAll(cfg: DetectConfig): Promise<CliAgentInfo[]> {
	return Promise.all(AGENT_IDS.map(id => detectAgent(id, cfg)));
}
