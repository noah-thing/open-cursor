/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  "Bring your own CLI subscription": runs Claude Code, Codex, Grok or Gemini CLI headless in the
 *  workspace and translates their event streams into Open Cursor chat parts. Entry point for
 *  src/cliAgents. Everything except this file is vscode-free so it can be tested in plain node.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import type { CliAgentInfo, CliTurnCallbacks, ICliAgents } from '../services';
import { runClaude } from './claude';
import { runCodex } from './codex';
import { AGENT_IDS, cliEnv, detectAll, resetLoginShellCache, type DetectConfig } from './detect';
import { runGemini } from './gemini';
import { runGrok } from './grok';
import { cliHint } from '../shared/cliHints';
import type { CliAgentId, RunOptions, RunResult, TurnHost } from './types';

const REDETECT_MS = 5 * 60_000;
const RETRY_MISSING_MS = 30_000;

function readConfig(): DetectConfig & { extraArgs: Record<CliAgentId, string[]>; allowlist: string[] } {
	const c = vscode.workspace.getConfiguration('openCursor');
	const paths = c.get<Record<string, string>>('cli.paths') ?? {};
	const list = (key: string): string[] => (c.get<unknown[]>(key) ?? []).filter((x): x is string => typeof x === 'string');
	return {
		enabled: c.get<boolean>('cli.enabled') ?? true,
		paths: { 'claude-code': paths['claude-code'] ?? paths.claude, codex: paths.codex, grok: paths.grok, 'gemini-cli': paths['gemini-cli'] ?? paths.gemini },
		extraArgs: { 'claude-code': list('cli.claudeCode.extraArgs'), codex: list('cli.codex.extraArgs'), grok: list('cli.grok.extraArgs'), 'gemini-cli': list('cli.gemini.extraArgs') },
		allowlist: list('agent.commandAllowlist'),
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

export function createCliAgents(ctx: vscode.ExtensionContext): ICliAgents {
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
				const hint = `Install it with \`${cliHint(opts.agent).install}\`, then sign in.`;
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
				autoRun: opts.autoRun,
				commandAllowlist: cfg.allowlist,
				extraArgs: cfg.extraArgs[opts.agent],
				env: await cliEnv(info.binaryPath),
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
