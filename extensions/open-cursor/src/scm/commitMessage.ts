/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Sparkle button in the SCM input box: writes a commit message from the staged diff.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Services } from '../services';
import { collectText, pickInlineModel } from '../inline/oneshot';
import { COMMIT_SYSTEM, buildCommitPrompt, cleanCommitMessage } from './logic';

interface GitRepo {
	readonly rootUri: vscode.Uri;
	readonly inputBox: { value: string };
	readonly state: { readonly indexChanges: readonly unknown[]; readonly workingTreeChanges: readonly { uri: vscode.Uri; status: number }[]; readonly untrackedChanges?: readonly { uri: vscode.Uri }[] };
	diff(cached?: boolean): Promise<string>;
	log(options?: { maxEntries?: number }): Promise<{ message: string }[]>;
}
interface GitApi { readonly repositories: GitRepo[] }

export function registerCommitMessage(ctx: vscode.ExtensionContext, services: Services): void {
	let running: AbortController | undefined;

	function gitApi(): GitApi | undefined {
		const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
		if (!ext?.isActive) { return undefined; }
		try { return ext.exports.getAPI(1); } catch { return undefined; }
	}

	function pickRepo(api: GitApi, arg: unknown): GitRepo | undefined {
		const root = (arg as { rootUri?: vscode.Uri } | undefined)?.rootUri;
		if (root) {
			const hit = api.repositories.find(r => r.rootUri.toString() === root.toString());
			if (hit) { return hit; }
		}
		const active = vscode.window.activeTextEditor?.document.uri;
		if (active) {
			const hit = api.repositories.filter(r => active.fsPath.startsWith(r.rootUri.fsPath)).sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
			if (hit) { return hit; }
		}
		return api.repositories[0];
	}

	async function generate(arg?: unknown): Promise<void> {
		if (running) { running.abort(); return; } // second click cancels
		const ext = vscode.extensions.getExtension('vscode.git');
		if (ext && !ext.isActive) { await ext.activate(); }
		const api = gitApi();
		const repo = api && pickRepo(api, arg);
		if (!repo) { void vscode.window.showWarningMessage('Open Cursor: no git repository found.'); return; }
		const model = pickInlineModel(services);
		if (!model) { void vscode.window.showErrorMessage('Open Cursor: no model available. Add an API key or start a local model.'); return; }

		const ac = new AbortController();
		running = ac;
		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: 'Writing commit message…' }, async () => {
				let diff = repo.state.indexChanges.length > 0 ? await repo.diff(true) : '';
				if (!diff.trim()) { diff = await repo.diff(false); }
				const untracked = (repo.state.untrackedChanges ?? []).map(c => vscode.workspace.asRelativePath(c.uri, false));
				if (!diff.trim() && untracked.length === 0) { void vscode.window.showInformationMessage('Open Cursor: no changes to describe.'); return; }
				const recent = (await repo.log({ maxEntries: 8 }).catch(() => [])).map(c => c.message.split('\n')[0]);
				let rules: { name: string; content: string }[] = [];
				try { rules = (await services.context.getRules([])).map(r => ({ name: r.name, content: r.content })); } catch { /* optional */ }
				const prompt = buildCommitPrompt(diff, recent, rules, repo.state.indexChanges.length > 0 ? [] : untracked);
				const text = await collectText(services, model, COMMIT_SYSTEM, prompt, ac.signal, {
					maxTokens: 400, temperature: 0.2,
					onText: soFar => { repo.inputBox.value = cleanCommitMessage(soFar); },
				});
				const msg = cleanCommitMessage(text);
				if (msg) { repo.inputBox.value = msg; }
			});
		} catch (err) {
			if (!ac.signal.aborted) { void vscode.window.showErrorMessage(`Open Cursor: ${err instanceof Error ? err.message : String(err)}`); }
		} finally {
			if (running === ac) { running = undefined; }
		}
	}

	ctx.subscriptions.push(vscode.commands.registerCommand('openCursor.scm.generateCommitMessage', generate));
}
