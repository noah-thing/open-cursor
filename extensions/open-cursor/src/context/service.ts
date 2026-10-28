/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  IContextService implementation: rules, slash commands, @-mentions.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { ContextItem } from '../shared/protocol';
import type { IContextService } from '../services';
import { stripAnsi } from './html';
import { FileIndex, Mentions, type ContextHooks } from './mentions';
import { RulesStore, type RuleEntry } from './rules';

export type { ContextHooks } from './mentions';

/** The service plus the extra surface the chat controller and agent tools use. */
export interface IContextServiceEx extends IContextService, vscode.Disposable {
	readonly onDidChangeRules: vscode.Event<void>;
	/** Every discovered rule, including manual ones (for @rule and fetch_rules). */
	getAllRules(): Promise<RuleEntry[]>;
	/** Controller provides past-chat search and summaries for @Past chats. */
	setHooks(hooks: ContextHooks): void;
	/** Last captured terminal command output (ANSI stripped), if any. */
	getLastTerminalOutput(): string | undefined;
	/** Raw slash command match (custom commands only). */
	findCommand(name: string): Promise<{ name: string; content: string } | undefined>;
}

const MAX_TERMINAL_CHARS = 12000;

export function createContextService(ctx: vscode.ExtensionContext): IContextServiceEx {
	const rules = new RulesStore();
	const files = new FileIndex();
	let hooks: ContextHooks = {};
	let lastOutput: string | undefined;
	const disposables: vscode.Disposable[] = [rules, files];

	// Capture output of every shell integrated execution so @Terminal has something to attach.
	try {
		disposables.push(vscode.window.onDidStartTerminalShellExecution(async e => {
			let buf = '';
			try {
				for await (const chunk of e.execution.read()) {
					buf += chunk;
					if (buf.length > MAX_TERMINAL_CHARS * 2) {
						buf = buf.slice(-MAX_TERMINAL_CHARS);
					}
				}
			} catch {
				// terminal closed mid read
			}
			const text = stripAnsi(buf).trim();
			if (text) {
				const cmd = e.execution.commandLine.value;
				lastOutput = `$ ${cmd}\n${text.slice(-MAX_TERMINAL_CHARS)}`;
			}
		}));
	} catch {
		// shell integration API unavailable
	}

	const mentions = new Mentions(files, rules, () => lastOutput, () => hooks);
	ctx.subscriptions.push(...disposables);

	return {
		onDidChangeRules: rules.onDidChange,
		async getRules(filePaths) {
			const selected = await rules.select(filePaths);
			return selected.map(r => ({
				name: r.name,
				source: r.source,
				content: r.content,
				description: r.description,
				agentRequested: r.kind === 'agent' ? true : undefined,
			}));
		},
		getAllRules: () => rules.getAll(),
		async getSlashCommands() {
			return (await rules.getCommands()).map(c => ({ name: c.name, description: c.description, source: c.source, content: c.content }));
		},
		async findCommand(name) {
			const c = (await rules.getCommands()).find(x => x.name === name);
			return c ? { name: c.name, content: c.content } : undefined;
		},
		searchMentions: (query: string, kind?: ContextItem['kind']) => mentions.search(query, kind),
		resolve: (item: ContextItem) => mentions.resolve(item),
		setHooks(h) { hooks = h; },
		getLastTerminalOutput: () => lastOutput,
		dispose() { disposables.forEach(d => d.dispose()); },
	};
}
