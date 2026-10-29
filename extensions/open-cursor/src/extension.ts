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

	const free = new FreeModelsPanel(ctx, services, { activeModel: () => chat.activeModelId(), useModel: id => chat.useModel(id) });
	ctx.subscriptions.push(free, vscode.commands.registerCommand('openCursor.freeModels.open', (o?: { install?: boolean }) => free.open(o)));
}

export function deactivate(): void {
	killAllClis();
}
