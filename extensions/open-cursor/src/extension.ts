/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Services } from './services';
import { createProviderRegistry } from './providers/registry';
import { createPendingEdits } from './edits/pendingEdits';
import { createCheckpoints } from './edits/checkpoints';
import { createMcpManager } from './mcp/manager';
import { createCodebaseIndex } from './indexing/index';
import { createContextService } from './context/service';
import { createCliAgents } from './cliAgents/index';
import { killAllClis } from './cliAgents/util';
import { createChatController } from './agent/chatController';
import { registerTab } from './tab/provider';
import { registerInlineEdit } from './inline/inlineEdit';
import { registerTerminalCmdK } from './terminal/cmdK';
import { registerCommitMessage } from './scm/commitMessage';
import { registerSettings } from './settings/panel';
import { registerImporter } from './migrate/importer';
import { FreeModelsPanel } from './connect/freePanel';
import { registerUpdater } from './update/updater';
import { registerInstallCount } from './stats/installCount';
import { ReportPanel, type ReportContext } from './report/reportPanel';
import { readEffort, setEffort } from './agent/env';
import type { Effort } from './shared/protocol';

export function activate(ctx: vscode.ExtensionContext): void {
	const registry = createProviderRegistry(ctx);
	const pendingEdits = createPendingEdits(ctx);
	const checkpoints = createCheckpoints(ctx, { onRestore: uris => pendingEdits.forget(uris) });
	const services: Services = {
		registry,
		pendingEdits,
		checkpoints,
		mcp: createMcpManager(ctx),
		index: createCodebaseIndex(ctx, registry),
		context: createContextService(ctx),
		cli: createCliAgents(ctx),
	};

	const chat = createChatController(ctx, services);
	registerInlineEdit(ctx, services);
	registerTab(ctx, services);
	registerTerminalCmdK(ctx, services);
	registerCommitMessage(ctx, services);
	registerSettings(ctx, services);
	registerImporter(ctx);
	registerUpdater(ctx);
	registerInstallCount(ctx);
	const report = new ReportPanel(ctx);
	ctx.subscriptions.push(report, vscode.commands.registerCommand('openCursor.reportProblem', (c?: ReportContext) => report.open(c ?? {})));
	ctx.subscriptions.push(vscode.commands.registerCommand('openCursor.setEffort', async () => {
		const cur = readEffort();
		const levels: { id: Effort; label: string; detail: string }[] = [
			{ id: 'auto', label: 'Auto', detail: 'High on API models; Claude Code and Codex keep their own default' },
			{ id: 'off', label: 'Off', detail: 'No thinking' },
			{ id: 'low', label: 'Low', detail: 'Short thinking, faster answers' },
			{ id: 'medium', label: 'Medium', detail: 'A middle amount of thinking' },
			{ id: 'high', label: 'High', detail: 'Long thinking for harder work' },
			{ id: 'max', label: 'Max', detail: 'The most the model allows' },
		];
		const pick = await vscode.window.showQuickPick(levels.map(l => ({ ...l, description: l.id === cur ? 'current' : undefined })), { title: 'Thinking effort', placeHolder: 'How hard models think before answering' });
		if (pick) { await setEffort(pick.id); }
	}));

	const free = new FreeModelsPanel(ctx, services, { activeModel: () => chat.activeModelId(), useModel: id => chat.useModel(id) });
	ctx.subscriptions.push(free,
		vscode.commands.registerCommand('openCursor.freeModels.open', (o?: { install?: boolean; local?: boolean }) => free.open(o)),
		vscode.commands.registerCommand('openCursor.localModels.open', () => free.open({ local: true })));
}

export function deactivate(): void {
	killAllClis();
}
