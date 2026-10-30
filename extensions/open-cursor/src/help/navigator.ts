/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Carries out a Help action. Every branch opens or shows something; none of them writes a
 *  setting, a key or a file. Chat side actions go back to the chat through hooks.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ToolDef } from '../agent/tools/types';
import { actionLabel, helpTarget, HELP_TARGETS, stripAutoOpenArg, validateAction, type HelpAction } from './targets';

export interface HelpChatHooks {
	/** A new normal chat, with `text` typed into the box (not sent). */
	newChat(text?: string): Promise<void>;
	/** A new chat with the connect panel showing. */
	connect(): Promise<void>;
	pastChats(): void;
	/** Opens a prefilled GitHub issue for this Help chat. */
	reportIssue(title?: string): Promise<void>;
}

const VIEW_COMMAND: Record<string, string> = {
	explorer: 'workbench.view.explorer',
	search: 'workbench.view.search',
	'source-control': 'workbench.view.scm',
	run: 'workbench.view.debug',
	extensions: 'workbench.view.extensions',
	terminal: 'workbench.action.terminal.focus',
	problems: 'workbench.actions.view.problems',
	output: 'workbench.action.output.toggleOutput',
};

export class HelpNavigator {
	constructor(private readonly hooks: HelpChatHooks) { }

	/** Runs the action; resolves to the line shown to the user and the model. */
	async run(a: HelpAction): Promise<string> {
		const cmd = (id: string, ...args: unknown[]): Thenable<unknown> => vscode.commands.executeCommand(id, ...args);
		const label = actionLabel(a);
		switch (a.target) {
			case 'free-models': await cmd('openCursor.freeModels.open', a.arg === 'install' ? { install: true } : a.arg === 'local' ? { local: true } : undefined); break;
			case 'settings': await cmd('openCursor.settings.open', a.arg); break;
			case 'editor-settings': await cmd('workbench.action.openSettings', a.arg ?? ''); break;
			case 'shortcuts': await cmd('workbench.action.openGlobalKeybindings', a.arg ?? ''); break;
			case 'color-theme': await cmd('workbench.action.selectTheme'); break;
			case 'icon-theme': await cmd('workbench.action.selectIconTheme'); break;
			case 'command-palette': await cmd('workbench.action.quickOpen', '>' + (a.arg ?? '')); break;
			case 'extensions':
				if (a.arg) { await cmd('workbench.extensions.search', a.arg); } else { await cmd('workbench.view.extensions'); }
				break;
			case 'view': await cmd(VIEW_COMMAND[a.arg ?? ''] ?? 'workbench.view.explorer'); break;
			case 'mcp-config': await cmd(a.arg === 'workspace' ? 'openCursor.mcp.openWorkspaceConfig' : 'openCursor.mcp.openUserConfig'); break;
			case 'connect': await this.hooks.connect(); break;
			case 'new-chat': await this.hooks.newChat(a.arg); break;
			case 'past-chats': this.hooks.pastChats(); break;
			case 'import': await cmd('openCursor.import'); break;
			case 'open-folder': await cmd('workbench.action.files.openFolder'); break;
			case 'report-issue': await this.hooks.reportIssue(a.arg); break;
			case 'report-problem': await cmd('openCursor.reportProblem'); break;
		}
		return label;
	}

	/** The one tool a Help chat has. It only opens places that sit beside the chat. */
	/** `stillHere` is false once the user has left the Help chat that asked, so nothing opens over their work. */
	tool(stillHere: () => boolean = () => true): ToolDef<{ target?: string; argument?: string }> {
		const inPlace = HELP_TARGETS.filter(t => t.inPlace);
		return {
			readOnly: true,
			schema: {
				name: 'open_in_app',
				description: 'Open a page, settings section, picker or view in OpenCursor for the user, right now. It only opens things; the user makes any change.',
				parameters: {
					type: 'object',
					properties: {
						target: { type: 'string', enum: inPlace.map(t => t.id), description: 'Where to take the user.' },
						argument: { type: 'string', description: 'Section, view, or search text, as the target describes. Omit when the target takes none.' },
					},
					required: ['target'],
				},
			},
			run: async args => {
				const a = validateAction(args.target, args.argument);
				if (!a) { return { content: `Unknown target "${String(args.target)}". Use one of: ${inPlace.map(t => t.id).join(', ')}.`, isError: true }; }
				if (!stillHere()) { return { content: 'The user has left Help, so nothing was opened. Answer in text.', isError: true }; }
				if (!helpTarget(a.target)?.inPlace) { return { content: `${a.target} moves the chat away, so offer it as a link instead.`, isError: true }; }
				try {
					const label = await this.run(stripAutoOpenArg(a)); // the model may not start an install
					return { content: `Opened: ${label}. It is on screen now.`, output: label };
				} catch (e) {
					return { content: `Could not open it: ${e instanceof Error ? e.message : String(e)}`, isError: true };
				}
			},
			title: (args, status) => {
				const a = validateAction(args.target, args.argument);
				const label = a ? actionLabel(a) : 'the page';
				return status === 'done' ? `Opened ${label}` : `Opening ${label}`;
			},
		};
	}
}
