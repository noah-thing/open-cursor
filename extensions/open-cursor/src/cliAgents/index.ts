/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  "Bring your own CLI subscription": runs Claude Code, Codex, Grok, Gemini CLI or OpenCode headless in the
 *  workspace and translates their event streams into OpenCursor chat parts. Entry point for
 *  src/cliAgents. Everything except this file avoids vscode imports so it can be tested in plain node.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CliAgentInfo, CliTurnCallbacks, ICliAgents } from '../services';
import { runClaude } from './claude';
import { runCodex } from './codex';
import { AGENT_IDS, cliEnv, detectAll, resetLoginShellCache, type DetectConfig } from './detect';
import { runGemini } from './gemini';
import { runGrok } from './grok';
import { runOpenCode } from './opencode';
import { installOpenCodeCli, resetOpenCodeModelCache } from './opencodeSetup';
import { cliHint, installCommand } from '../shared/cliHints';
import type { CliAgentId, RunOptions, RunResult, TurnHost } from './types';
import { effectiveAutoRun } from './policy';

const REDETECT_MS = 5 * 60_000;
const RETRY_MISSING_MS = 30_000;

function readConfig(): DetectConfig & { extraArgs: Record<CliAgentId, string[]>; allowlist: string[]; denylist?: string[] } {
	const c = vscode.workspace.getConfiguration('openCursor');
	const paths = c.get<Record<string, string>>('cli.paths') ?? {};
	const list = (key: string): string[] => (c.get<unknown[]>(key) ?? []).filter((x): x is string => typeof x === 'string');
	return {
		enabled: c.get<boolean>('cli.enabled') ?? true,
		paths: { 'claude-code': paths['claude-code'] ?? paths.claude, codex: paths.codex, grok: paths.grok, 'gemini-cli': paths['gemini-cli'] ?? paths.gemini, opencode: paths.opencode },
		extraArgs: { 'claude-code': list('cli.claudeCode.extraArgs'), codex: list('cli.codex.extraArgs'), grok: list('cli.grok.extraArgs'), 'gemini-cli': list('cli.gemini.extraArgs'), opencode: list('cli.opencode.extraArgs') },
		allowlist: list('agent.commandAllowlist'),
		...(Array.isArray(c.get('agent.commandDenylist')) ? { denylist: list('agent.commandDenylist') } : {}),
	};
}

function adaptHost(cb: CliTurnCallbacks): TurnHost {
	return {
		text: d => cb.onText(d),
		thinking: d => cb.onThinking(d),
		toolStart: p => cb.onToolStart(p),
		toolUpdate: p => cb.onToolUpdate(p),
		requestApproval: p => cb.requestApproval(p),
		fileOriginal: (p, content) => cb.onFileOriginal(vscode.Uri.file(p), content),
		fileChanged: p => cb.onFileChanged(vscode.Uri.file(p)),
		usage: u => cb.onUsage(u),
		uri: p => vscode.Uri.file(p).toString(),
	};
}

/** Installs the OpenCode CLI for this user (no sudo, ~/.opencode/bin). Resolves once `opencode --version` works. */
export async function installOpenCode(): Promise<{ ok: boolean; message: string }> {
	const r = await installOpenCodeCli(await cliEnv(undefined));
	return { ok: r.ok, message: r.message };
}

export function createCliAgents(ctx: vscode.ExtensionContext): ICliAgents {
	// Gemini CLI never sees OpenCursor's stored keys, so the Google key saved in Settings goes to it as GEMINI_API_KEY
	const cliEnvWithKeys = async (binary: string | undefined, agent: CliAgentId): Promise<NodeJS.ProcessEnv> => {
		const env = await cliEnv(binary);
		if (agent === 'gemini-cli' && !env.GEMINI_API_KEY && !env.GOOGLE_API_KEY && !fs.existsSync(path.join(os.homedir(), '.gemini', 'oauth_creds.json'))) {
			try {
				const key = (await ctx.secrets.get('openCursor.key.google'))?.trim();
				if (key) {
					env.GEMINI_API_KEY = key;
				}
			} catch {
				/* no stored key */
			}
		}
		return env;
	};

	const emitter = new vscode.EventEmitter<void>();
	let infos: CliAgentInfo[] = [];
	let detectedAt = 0;
	let inflight: Promise<CliAgentInfo[]> | undefined;

	const same = (a: CliAgentInfo[], b: CliAgentInfo[]): boolean =>
		a.length === b.length && a.every((x, i) => x.binaryPath === b[i].binaryPath && x.version === b[i].version && x.loggedIn === b[i].loggedIn && x.models.length === b[i].models.length);

	const run = (): Promise<CliAgentInfo[]> => {
		inflight ??= detectAll(readConfig())
			.then(next => {
				const changed = !same(infos, next);
				infos = next;
				detectedAt = Date.now();
				if (changed) {
					emitter.fire();
				}
				return next;
			})
			.finally(() => {
				inflight = undefined;
			});
		return inflight;
	};

	ctx.subscriptions.push(
		emitter,
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('openCursor.cli')) {
				resetLoginShellCache();
				void run();
			}
		}),
	);

	return {
		onDidChange: emitter.event,

		async detect(): Promise<CliAgentInfo[]> {
			const age = Date.now() - detectedAt;
			const missing = infos.some(i => !i.binaryPath);
			if (infos.length === 0 || age > REDETECT_MS || (missing && age > RETRY_MISSING_MS)) {
				return run();
			}
			return infos;
		},

		async refresh(): Promise<CliAgentInfo[]> {
			// Keep the old infos so run() can tell whether anything changed.
			resetLoginShellCache();
			detectedAt = 0;
			inflight = undefined;
			return run();
		},

		async installOpenCode(): Promise<{ ok: boolean; message: string }> {
			const r = await installOpenCode();
			if (r.ok) {
				resetLoginShellCache();
				resetOpenCodeModelCache();
				await run().catch(() => undefined);
			}
			return r;
		},

		get(id: CliAgentInfo['id']): CliAgentInfo | undefined {
			return infos.find(i => i.id === id);
		},

		async runTurn(opts): Promise<RunResult> {
			const cfg = readConfig();
			if (!cfg.enabled) {
				return { stopReason: 'error', error: 'CLI agents are turned off (openCursor.cli.enabled).' };
			}
			if (!AGENT_IDS.includes(opts.agent)) {
				return { stopReason: 'error', error: `Unknown CLI agent: ${opts.agent}` };
			}
			let info = infos.find(i => i.id === opts.agent);
			if (!info) {
				info = (await run()).find(i => i.id === opts.agent);
			}
			if (!info?.binaryPath) {
				info = (await run()).find(i => i.id === opts.agent);
			}
			if (!info?.binaryPath) {
				if (opts.agent === 'opencode') {
					return { stopReason: 'error', error: `OpenCode is not installed yet. ${installCommand(cliHint('opencode'))} You can also set openCursor.cli.paths.` };
				}
				const hint = `Install it with \`${installCommand(cliHint(opts.agent))}\`, then sign in.`;
				return { stopReason: 'error', error: `${info?.label ?? opts.agent} was not found on this machine. ${hint} You can also set openCursor.cli.paths.` };
			}
			if (opts.signal.aborted) {
				return { stopReason: 'aborted', sessionId: opts.sessionId };
			}
			const runOpts: RunOptions = {
				binary: info.binaryPath,
				version: info.version,
				model: opts.model,
				mode: opts.mode,
				prompt: opts.prompt,
				images: opts.images,
				cwd: opts.cwd,
				sessionId: opts.sessionId,
				autoRun: effectiveAutoRun(opts.agent, opts.autoRun),
				effort: opts.effort,
				commandAllowlist: cfg.allowlist,
				commandDenylist: cfg.denylist,
				extraArgs: cfg.extraArgs[opts.agent],
				env: await cliEnvWithKeys(info.binaryPath, opts.agent),
				signal: opts.signal,
				host: adaptHost(opts.callbacks),
				permissionServerPath: path.join(ctx.extensionPath, 'dist', 'permissionServer.js'),
			};
			try {
				switch (opts.agent) {
					case 'claude-code':
						return await runClaude(runOpts);
					case 'codex':
						return await runCodex(runOpts);
					case 'grok':
						return await runGrok(runOpts);
					case 'gemini-cli':
						return await runGemini(runOpts);
					case 'opencode':
						return await runOpenCode(runOpts);
				}
			} catch (e) {
				if (opts.signal.aborted) {
					return { stopReason: 'aborted', sessionId: opts.sessionId };
				}
				return { stopReason: 'error', error: e instanceof Error ? e.message : String(e), sessionId: opts.sessionId };
			}
		},
	};
}
