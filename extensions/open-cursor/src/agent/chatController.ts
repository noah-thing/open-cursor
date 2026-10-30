/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Chat controller: owns chats, runs turns (native loop or CLI agent), talks to the webview.
 *--------------------------------------------------------------------------------------------*/

import { handoffBrief, isLimitError } from './handoff';
import { apiEffort } from './effort';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as nodePath from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import type { LLMContent, ModelInfo } from '../providers/types';
import { isAllowedExternalUrl } from '../shared/externalLink';
import type { Services } from '../services';
import type {
	AssistantMessage, ChatMode, ChatSummary, ContextItem, HostMessage, HostMessageExt, MessagePart, ModelOption, SlashCommandInfo, ToolPart, UserMessage, WebviewMessage, WebviewMessageExt,
} from '../shared/protocol';
import type { IContextServiceEx } from '../context/service';
import { toDisplayPath } from '../context/paths';
import type { CliAgentInfo } from '../services';
import { cliHint } from '../shared/cliHints';
import { cliEnv, loginShellInfo } from '../cliAgents/detect';
import { installWithPrivateNode } from '../cliAgents/npmSetup';
import { COMMON_BIN_DIRS, executableNames } from '../cliAgents/util';
import { ConnectService } from '../connect/connect';
import { FREE_AUTO_ID, isFreeModel } from '../providers/free';
import { HelpNavigator } from '../help/navigator';
import { issueUrl, modelKind } from '../help/issue';
import { buildHelpSystemPrompt } from '../help/prompt';
import { instantAnswer } from '../help/answers';
import { actionLabel, firstInPlaceLink, parseHelpLink } from '../help/targets';
import { suggestAllowPrefix } from './approval';
import { applyCodeToFile } from './applyCode';
import {
	buildEnv, editorSnapshot, parseDataUrl, readAutoRun, readDefaultMode, readLists, readMaxIterations, readUiSettings, referencedFiles, selectionItem, setAutoRun, readEffort, setEffort,
} from './env';
import { buildHistoryFromChat, truncateTranscript } from './history';
import { compactTranscript, runAgentLoop, type LoopHooks } from './loop';
import { buildEditorState, buildSystemPrompt, type PromptRule } from './prompts';
import { ChatStore, DEFAULT_TITLE, fallbackTitle, generateTitle, newId, type StoredChat } from './store';
import { estimateMessagesTokens, appendUserContent } from './tokens';
import { getToolSet, type ToolSet } from './tools';
import { disposeTerminalRunner, getTerminalRunner } from './tools/terminal';

type Decision = 'run' | 'skip' | 'allowAlways';

export interface IChatController extends vscode.Disposable {
	/** Send a prompt into the active chat (or a new one), used by editor commands. */
	submit(opts: { text: string; context?: ContextItem[]; mode?: ChatMode; newChat?: boolean }): Promise<void>;
	/** The model the active chat runs on. */
	activeModelId(): string;
	/** Put the active chat on this model, make it the default for new chats, and bring the chat forward. */
	useModel(modelId: string): Promise<void>;
}

interface Runtime {
	running: boolean;
	abort?: AbortController;
	approvals: Map<string, (d: Decision) => void>;
	idle: Promise<void>;
	resolveIdle?: () => void;
	postTimer?: ReturnType<typeof setTimeout>;
	stopped: boolean;
}

interface TurnState {
	readonly sc: StoredChat;
	readonly rt: Runtime;
	readonly parts: MessagePart[];
	msg: AssistantMessage;
	thinkingStart?: number;
	usage: { inputTokens: number; outputTokens: number };
	errored: boolean;
}

interface SendRequest {
	readonly text: string;
	/** What the model receives instead of `text` (expanded slash commands). */
	readonly promptText?: string;
	readonly context: ContextItem[];
	readonly mode?: ChatMode;
	readonly modelId?: string;
}

const POST_INTERVAL_MS = 33;
const BUILTIN_COMMANDS: { name: string; description: string }[] = [
	{ name: 'new', description: 'Start a new chat' },
	{ name: 'clear', description: 'Clear this chat' },
	{ name: 'summarize', description: 'Compress the conversation to free context' },
	{ name: 'plan', description: 'Switch to Plan mode' },
	{ name: 'ask', description: 'Switch to Ask mode' },
	{ name: 'agent', description: 'Switch to Agent mode' },
	{ name: 'debug', description: 'Switch to Debug mode' },
	{ name: 'model', description: 'Switch model: /model <name>' },
	{ name: 'rules', description: 'Open the rules folder' },
	{ name: 'help', description: 'Ask how to do something in OpenCursor' },
];

const CHAT_VISIBLE_KEY = 'openCursor.chat.visible';

/** The CLI agent that is the same company's subscription for an API provider. */
const SUBSCRIPTION_FOR: Record<string, string> = { anthropic: 'claude-code', openai: 'codex', xai: 'grok', google: 'gemini-cli' };
const SUBSCRIPTION_ORDER = ['claude-code', 'codex', 'grok', 'gemini-cli', 'opencode'];
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio']);
const PROVIDER_NAMES: Record<string, string> = {
	anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google Gemini', openrouter: 'OpenRouter', deepseek: 'DeepSeek', xai: 'xAI',
	mistral: 'Mistral', groq: 'Groq', ollama: 'Ollama', lmstudio: 'LM Studio', custom: 'The custom endpoint',
	nvidia: 'NVIDIA', zai: 'Z.ai', sambanova: 'SambaNova', free: 'Free (auto)',
};

export function createChatController(ctx: vscode.ExtensionContext, services: Services): IChatController {
	const controller = new ChatController(ctx, services);
	controller.register();
	return controller;
}

/** npm from the user's own Node.js (the private copy in ~/.open-cursor does not count: terminals cannot see it). */
async function hasSystemNpm(): Promise<boolean> {
	const own = nodePath.join(os.homedir(), '.open-cursor');
	const dirs = [...(await loginShellInfo()).path, ...COMMON_BIN_DIRS(), ...(process.env.PATH ?? '').split(nodePath.delimiter)];
	return dirs.some(d => !!d && !d.startsWith(own) && executableNames('npm').some(n => fs.existsSync(nodePath.join(d, n))));
}

/** `macOS 15.4 (arm64)`, `Windows 10.0.22631 (x64)`, `Ubuntu 24.04 LTS (x64)`: enough to reproduce a bug, nothing personal. */
function systemDescription(): string {
	const arch = process.arch;
	try {
		if (process.platform === 'darwin') { return `macOS ${cp.execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 2000 }).trim()} (${arch})`; }
		if (process.platform === 'linux') {
			const name = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(fs.readFileSync('/etc/os-release', 'utf8'))?.[1];
			if (name) { return `${name} (${arch})`; }
		}
	} catch {
		// fall through to the kernel version
	}
	return `${process.platform === 'win32' ? 'Windows' : process.platform} ${os.release()} (${arch})`;
}

class ChatController implements IChatController, vscode.WebviewViewProvider {
	private readonly store: ChatStore;
	private readonly ready: Promise<void>;
	private readonly runtimes = new Map<string, Runtime>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly sessionAllow = new Set<string>();
	private view: vscode.WebviewView | undefined;
	private webviewReady = false;
	private readonly outbox: HostMessage[] = [];
	private modelOptions: ModelOption[] = [];
	private viewResolved: (() => void) | undefined;
	private viewPromise: Promise<void> | undefined;
	private chatFocused = false;

	private readonly connect: ConnectService;
	private readonly help: HelpNavigator;
	/** The last chat that was not Help, so leaving Help goes back to it. */
	private lastWorkChatId: string | undefined;

	constructor(private readonly ctx: vscode.ExtensionContext, private readonly services: Services) {
		this.connect = new ConnectService(services, () => this.modelOptions, () => this.refreshModels());
		this.help = new HelpNavigator({
			newChat: async text => { await this.newChat(); this.post({ type: 'focusInput', text }); },
			connect: async () => { await this.newChat(); this.post({ type: 'showConnect' }); },
			pastChats: () => this.post({ type: 'showHistory' }),
			reportIssue: title => this.reportIssue(title),
		});
		const base = ctx.storageUri ?? ctx.globalStorageUri;
		this.store = new ChatStore(nodePath.join(base.fsPath, 'chats'));
		this.ready = this.store.init();
	}

	/** A GitHub issue prefilled from the Help chat on screen and the chat the user came from. */
	private async reportIssue(title?: string): Promise<void> {
		const help = this.store.activeChatId ? await this.store.get(this.store.activeChatId) : undefined;
		const work = this.lastWorkChatId ? await this.store.get(this.lastWorkChatId) : undefined;
		const userMessages = (help?.chat.mode === 'help' ? help.chat.messages : []).flatMap(m => (m.role === 'user' ? [m.text] : []));
		const mode = work?.chat.mode;
		const url = issueUrl({
			title: title ?? '',
			userMessages,
			version: String(this.ctx.extension.packageJSON.version ?? ''),
			system: systemDescription(),
			mode: mode ? mode[0].toUpperCase() + mode.slice(1) : undefined,
			model: modelKind(work?.chat.modelId),
		});
		await vscode.env.openExternal(vscode.Uri.parse(url, true));
	}

	private get contextEx(): Partial<IContextServiceEx> {
		return this.services.context as Partial<IContextServiceEx>;
	}

	register(): void {
		const d = this.disposables;
		d.push(vscode.window.registerWebviewViewProvider('openCursor.chat', this, { webviewOptions: { retainContextWhenHidden: true } }));
		d.push(this.services.pendingEdits.onDidChange(() => this.post({ type: 'pendingEdits', files: this.services.pendingEdits.getFiles() })));
		d.push(this.services.registry.onDidChangeModels(() => { void this.refreshModels(); }));
		d.push(this.services.cli.onDidChange(() => { void this.refreshModels(); void this.postAgents(); }));
		d.push(vscode.window.onDidChangeActiveTextEditor(() => this.postActiveEditor()));
		d.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('openCursor')) { this.post({ type: 'settings', settings: readUiSettings() }); }
		}));
		d.push(vscode.window.onDidChangeTextEditorSelection(e => {
			if (e.textEditor === vscode.window.activeTextEditor && e.kind !== undefined) { this.setChatFocused(false); }
		}));
		this.contextEx.setHooks?.({
			searchChats: q => this.searchChats(q),
			resolveChat: id => this.chatSummaryText(id),
		});
		this.registerCommands();
		void this.showOnStartup();
		d.push(vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, {
			provideCodeActions(doc, range, context) {
				const diags = context.diagnostics.filter(x => x.severity <= vscode.DiagnosticSeverity.Warning);
				if (!diags.length) { return []; }
				const action = new vscode.CodeAction('Fix with OpenCursor', vscode.CodeActionKind.QuickFix);
				action.diagnostics = diags;
				action.command = {
					command: 'openCursor.chat.fixWithAgent', title: 'Fix with OpenCursor',
					arguments: [doc.uri.toString(), diags.map(x => ({ line: x.range.start.line, character: x.range.start.character, message: x.message, source: x.source }))],
				};
				return [action];
			},
		}, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
		d.push({ dispose: () => this.dispose() });
		this.ctx.subscriptions.push(...d);
	}

	dispose(): void {
		this.disposed = true;
		for (const rt of this.runtimes.values()) {
			rt.abort?.abort();
			for (const resolve of rt.approvals.values()) { resolve('skip'); }
		}
		disposeTerminalRunner();
		this.agentWatch?.dispose();
		void this.store.flush();
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		this.webviewReady = false;
		const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview');
		view.webview.options = { enableScripts: true, localResourceRoots: [dist, vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] };
		view.webview.html = this.html(view.webview, dist);
		const sub: vscode.Disposable[] = [];
		sub.push(view.webview.onDidReceiveMessage((m: WebviewMessage) => { void this.onMessage(m).catch(err => console.error('[open-cursor] message failed', m?.type, err)); }));
		sub.push(view.onDidChangeVisibility(() => {
			this.setChatFocused(view.visible);
			void this.ctx.globalState.update(CHAT_VISIBLE_KEY, view.visible);
			if (view.visible) { this.post({ type: 'pendingEdits', files: this.services.pendingEdits.getFiles() }); }
		}));
		sub.push(view.onDidDispose(() => {
			sub.forEach(s => s.dispose());
			if (this.view === view) { this.view = undefined; this.webviewReady = false; this.setChatFocused(false); }
		}));
		this.setChatFocused(view.visible);
		this.viewResolved?.();
	}

	private html(webview: vscode.Webview, dist: vscode.Uri): string {
		const nonce = newId('n').replace(/[^a-z0-9]/gi, '');
		const js = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'chat.js'));
		const css = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'chat.css'));
		const csp = [
			'default-src \'none\'',
			`img-src ${webview.cspSource} data: blob:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`font-src ${webview.cspSource} data:`,
			`script-src 'nonce-${nonce}'`,
			'connect-src \'none\'',
		].join('; ');
		return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"><title>Chat</title></head><body><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
	}

	private post(msg: HostMessage | HostMessageExt): void {
		if (this.view && this.webviewReady) {
			void Promise.resolve(this.view.webview.postMessage(msg)).catch(() => undefined);
		} else if (msg.type === 'addContext' || msg.type === 'focusInput' || msg.type === 'showHistory') {
			this.outbox.push(msg);
			if (this.outbox.length > 20) { this.outbox.shift(); }
		}
	}

	private async postSlashCommands(): Promise<void> {
		const custom = await this.services.context.getSlashCommands();
		const commands: SlashCommandInfo[] = [
			...BUILTIN_COMMANDS.map(c => ({ ...c, source: 'built-in' })),
			...custom.map(c => ({ name: c.name, description: c.description, source: c.source })),
		];
		this.post({ type: 'slashCommands', commands });
	}

	private postActiveEditor(): void {
		const editor = vscode.window.activeTextEditor;
		const uri = editor?.document.uri;
		if (!uri || (uri.scheme !== 'file' && uri.scheme !== 'untitled' && uri.scheme !== 'vscode-remote')) {
			this.post({ type: 'activeEditor', item: null });
			return;
		}
		const rel = toDisplayPath(uri);
		this.post({ type: 'activeEditor', item: { id: `active:${uri.toString()}`, kind: 'file', label: nodePath.basename(uri.fsPath), detail: nodePath.dirname(rel) === '.' ? undefined : nodePath.dirname(rel), uri: uri.toString(), languageId: editor.document.languageId } });
	}

	private setChatFocused(v: boolean): void {
		if (this.chatFocused === v) { return; }
		this.chatFocused = v;
		void vscode.commands.executeCommand('setContext', 'openCursor.chatFocused', v);
	}

	/**
	 * The secondary sidebar is restored before this extension registers its provider, and the workbench then leaves
	 * the chat pane empty until the container is opened again. Open it once on launch (unless the user hid the chat
	 * last session) and hand focus back to the editor.
	 */
	private async showOnStartup(): Promise<void> {
		await new Promise(r => setTimeout(r, 1500));
		if (this.disposed) {
			return;
		}
		if (!this.view && this.ctx.globalState.get<boolean>(CHAT_VISIBLE_KEY) !== false) {
			const hadEditor = !!vscode.window.activeTextEditor;
			await vscode.commands.executeCommand('workbench.view.extension.openCursor');
			if (hadEditor) {
				await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
			}
		}
		// An empty window has nothing to edit yet, so the chat takes the whole window, like Cursor's agent view.
		for (let i = 0; i < 30 && !this.view && !this.disposed; i++) {
			await new Promise(r => setTimeout(r, 100));
		}
		if (this.view &&!vscode.workspace.workspaceFolders?.length && !vscode.window.visibleTextEditors.length) {
			await vscode.commands.executeCommand('workbench.action.maximizeAuxiliaryBar');
		}
	}

	private async reveal(): Promise<void> {
		if (!this.view) {
			this.viewPromise = new Promise<void>(res => { this.viewResolved = res; });
			await vscode.commands.executeCommand('workbench.view.extension.openCursor');
			await Promise.race([this.viewPromise, new Promise(r => setTimeout(r, 3000))]);
		}
		this.view?.show?.(false);
		this.setChatFocused(true);
	}

	private async onMessage(m: WebviewMessage | WebviewMessageExt): Promise<void> {
		await this.ready;
		switch (m.type) {
			case 'requestSlashCommands': return this.postSlashCommands();
			case 'requestActiveEditor': return this.postActiveEditor();
			case 'agentAction': return this.onAgentAction(m.id, m.action);
			case 'requestConnect': return this.postConnectState();
			case 'connectKey': {
				const r = await this.connect.setKey(m.provider, m.key);
				this.post({ type: 'connectResult', target: m.provider, ok: r.ok, message: r.message });
				return this.postConnectState();
			}
			case 'connectServer': {
				const r = await this.connect.connectServer(m.address);
				this.post({ type: 'connectResult', target: 'server', ok: r.ok, message: r.message });
				return this.postConnectState();
			}
			case 'resetServer': await this.connect.resetServer(m.id); return this.postConnectState();
			case 'localApp': return this.openLocalApp(m.id);
			case 'workbench': {
				const command = { openFolder: 'workbench.action.files.openFolder', openRecent: 'workbench.action.openRecent', cloneRepo: 'git.clone', showEditor: 'workbench.action.restoreAuxiliaryBar' }[m.action];
				await vscode.commands.executeCommand(command).then(undefined, e => console.warn('[open-cursor] workbench action failed', m.action, e));
				return;
			}
			case 'ready': return this.onReady();
			case 'send': return this.onSend(m.chatId, { text: m.text, context: m.context, mode: m.mode, modelId: m.modelId });
			case 'resend': return this.onResend(m.chatId, m.messageId, m.text, m.context, m.revert, m.modelId);
			case 'stop': return this.stop(m.chatId);
			case 'queue': return this.queueMessage(m.chatId, m.text, m.context);
			case 'unqueue': return this.unqueue(m.chatId, m.queuedId);
			case 'newChat': await this.newChat(); return;
			case 'openHelp': await this.openHelp(m.text); return;
			case 'leaveHelp': await this.leaveHelp(); return;
			case 'helpAction': {
				const a = parseHelpLink(m.href);
				if (a) { await this.help.run(a).catch(e => console.warn('[open-cursor] help action failed', m.href, e)); }
				return;
			}
			case 'openExternal':
				if (isAllowedExternalUrl(m.url)) { await vscode.env.openExternal(vscode.Uri.parse(m.url)); }
				return;
			case 'openChat': return this.openChat(m.chatId);
			case 'closeChatTab': return this.closeTab(m.chatId);
			case 'deleteChat': return this.deleteChat(m.chatId);
			case 'renameChat': return this.renameChat(m.chatId, m.title);
			case 'setMode': return this.setMode(m.chatId, m.mode);
			case 'setModel': return this.setModel(m.chatId, m.modelId);
			case 'continueOn': return this.continueOn(m.chatId, m.modelId);
			case 'approveTool': this.runtime(m.chatId).approvals.get(m.toolCallId)?.(m.decision); return;
			case 'restoreCheckpoint': return this.restoreCheckpoint(m.chatId, m.messageId);
			case 'searchMentions': {
				let items: ContextItem[] = [];
				try { items = await this.services.context.searchMentions(m.query, m.kind); } catch { /* empty results */ }
				if (m.query.startsWith('/') && !m.kind) {
					const q = m.query.slice(1).toLowerCase();
					const builtins = BUILTIN_COMMANDS.filter(c => c.name.startsWith(q)).map(c => ({ id: `command:${c.name}`, kind: 'rule' as const, label: '/' + c.name, detail: c.description, content: c.name }));
					items = [...builtins, ...items.filter(i => !builtins.some(b => b.id === i.id))];
				}
				this.post({ type: 'mentionResults', requestId: m.requestId, items });
				return;
			}
			case 'openFile': return this.openFile(m.uri, m.range);
			case 'openDiff': await this.services.pendingEdits.openDiff(vscode.Uri.parse(m.uri)); return;
			case 'acceptAll': await this.services.pendingEdits.acceptAll(); return;
			case 'rejectAll': await this.services.pendingEdits.rejectAll(); return;
			case 'acceptFile': await this.services.pendingEdits.acceptFile(vscode.Uri.parse(m.uri)); return;
			case 'rejectFile': await this.services.pendingEdits.rejectFile(vscode.Uri.parse(m.uri)); return;
			case 'openSettings': return this.openSettings(m.section);
			case 'setAutoRun': void setAutoRun(m.autoRun); return;
			case 'setEffort': void setEffort(m.effort); return;
			case 'copy': await vscode.env.clipboard.writeText(m.text); return;
			case 'insertCode': return this.insertCode(m.code);
			case 'applyCode': return this.applyCode(m.code, m.path);
			case 'runInTerminal': getTerminalRunner().runForUser(m.command); return;
			// The webview shows its own pill for pasted images; the data URL travels with `send`.
			case 'pasteImage': return;
		}
	}

	private async onReady(): Promise<void> {
		this.webviewReady = true;
		await this.refreshModels(false);
		const sc = await this.ensureActive();
		this.repairChat(sc);
		if (sc.chat.mode !== 'help') { this.lastWorkChatId = sc.chat.id; }
		void vscode.commands.executeCommand('setContext', 'openCursor.helpActive', sc.chat.mode === 'help');
		const openIds = this.store.openChatIds;
		this.post({
			type: 'init', chats: this.store.summaries(), openChatIds: openIds, activeChat: sc.chat, models: this.modelOptions,
			settings: readUiSettings(), pendingEdits: this.services.pendingEdits.getFiles(), workspaceName: vscode.workspace.name,
		});
		const queued = this.outbox.splice(0);
		for (const q of queued) { this.post(q); }
		void this.postAgents();
	}

	private async refreshModels(post = true): Promise<void> {
		try {
			const keyCache = new Map<string, Promise<boolean>>();
			const hasKey = (p: ModelInfo['provider']): Promise<boolean> => {
				let v = keyCache.get(p);
				if (!v) { v = this.services.registry.hasKey(p).catch(() => false); keyCache.set(p, v); }
				return v;
			};
			const options: ModelOption[] = await Promise.all(this.services.registry.getModels().map(async m => ({
				id: m.id, label: m.label, provider: m.provider, supportsImages: m.supportsImages, supportsThinking: m.supportsThinking, hasKey: await hasKey(m.provider), free: isFreeModel(m.id),
			})));
			let cliOptions: ModelOption[] = [];
			try {
				const agents = await this.services.cli.detect();
				cliOptions = agents.filter(a => a.binaryPath).flatMap(a => a.models.map(m => ({
					id: `cli:${a.id}/${m.id}`, label: `${a.label}: ${m.label}`, provider: 'cli', supportsImages: a.id !== 'gemini-cli', supportsThinking: false, hasKey: a.loggedIn !== false, free: m.free === true || undefined,
				})));
			} catch { /* CLI detection failed: native models only */ }
			this.modelOptions = [...options, ...cliOptions];
		} catch {
			// keep the previous list
		}
		if (post) { this.post({ type: 'models', models: this.modelOptions }); }
		this.repairEmptyChats();
	}

	private async postConnectState(): Promise<void> {
		const [local, providers] = await Promise.all([this.connect.localServers(), this.connect.apiProviders()]);
		this.post({ type: 'connectState', local, providers });
	}

	/** Starts Ollama if it is installed (in a terminal, so its output is visible), otherwise opens its download page. */
	private async openLocalApp(id: 'ollama' | 'lmstudio'): Promise<void> {
		const which = (bin: string): Promise<boolean> => new Promise(res => {
			const cmd = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
			cp.exec(cmd, { shell: process.platform === 'win32' ? undefined : process.env.SHELL || '/bin/sh' }, err => res(!err));
		});
		if (id === 'ollama' && await which('ollama')) {
			await vscode.commands.executeCommand('workbench.action.restoreAuxiliaryBar').then(undefined, () => undefined);
			const term = vscode.window.createTerminal({ name: 'Ollama' });
			term.show(true);
			term.sendText('ollama serve');
		} else if (id === 'lmstudio' && await which('lms')) {
			const term = vscode.window.createTerminal({ name: 'LM Studio' });
			term.sendText('lms server start');
			term.show(true);
		} else if (id === 'ollama') {
			// Not installed: the Free models page installs it, picks a model that fits and downloads it.
			await this.help.run({ target: 'free-models', arg: 'local' });
			return;
		} else {
			await vscode.env.openExternal(vscode.Uri.parse('https://lmstudio.ai'));
			return;
		}
		// Give the server a moment, then look again.
		setTimeout(() => { void this.refreshModels().then(() => this.postConnectState()); }, 2500);
	}

	private async postAgents(fresh = false): Promise<void> {
		let agents: CliAgentInfo[];
		try {
			agents = fresh ? await this.services.cli.refresh() : await this.services.cli.detect();
		} catch {
			return;
		}
		this.post({
			type: 'agents',
			agents: agents.map(a => ({
				id: a.id, label: a.label, installed: !!a.binaryPath, loggedIn: a.loggedIn,
				modelId: a.binaryPath ? `cli:${a.id}/${a.models.find(x => x.id === 'default')?.id ?? a.models[0]?.id ?? 'default'}` : undefined,
			})),
		});
	}

	/** Installing or signing in happens in a real terminal; we look again when it closes or the window gets focus back. */
	private async onAgentAction(id: string, action: 'install' | 'signIn' | 'refresh'): Promise<void> {
		// OpenCode installs in place, without a terminal: the Free models page does it and shows progress.
		if (id === 'opencode' && action === 'install') { await this.help.run({ target: 'free-models', arg: 'install' }); return; }
		if (action === 'refresh') {
			await this.postAgents(true);
			await this.refreshModels();
			return;
		}
		// Codex and Gemini CLI come from npm: without Node.js on this computer, install them with a private copy
		const npmPkg: Record<string, [string, string]> = { codex: ['@openai/codex', 'codex'], 'gemini-cli': ['@google/gemini-cli', 'gemini'] };
		if (action === 'install' && npmPkg[id] && !(await hasSystemNpm())) {
			const [pkg, bin] = npmPkg[id];
			const label = this.services.cli.get(id as CliAgentInfo['id'])?.label ?? id;
			const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing ${label}` }, async progress =>
				installWithPrivateNode(pkg, bin, await cliEnv(undefined), message => progress.report({ message })));
			if (r.ok) {
				await this.postAgents(true);
				await this.refreshModels();
				void vscode.window.showInformationMessage(`${label} is installed. Sign in to start using it.`);
			} else {
				void vscode.window.showErrorMessage(`${label} did not install: ${r.message}`);
			}
			return;
		}
		const hint = cliHint(id);
		const command = action === 'install' ? (process.platform === 'win32' ? hint.installWindows ?? hint.install : hint.install) : hint.loginCommand;
		if (!command) {
			void vscode.window.showInformationMessage(hint.login);
			return;
		}
		const label = this.services.cli.get(id as CliAgentInfo['id'])?.label ?? id;
		// The chat may fill the window; the terminal lives under the editor, so bring it back first.
		await vscode.commands.executeCommand('workbench.action.restoreAuxiliaryBar').then(undefined, () => undefined);
		const term = vscode.window.createTerminal({ name: (action === 'install' ? 'Install ' : 'Sign in to ') + label });
		term.show();
		term.sendText(command);
		this.watchAgent(id, term);
	}

	private agentWatch: vscode.Disposable | undefined;

	/** Looks again when the terminal closes or the window regains focus, until the agent is ready. One watcher at a time. */
	private watchAgent(id: string, term: vscode.Terminal): void {
		this.agentWatch?.dispose();
		let busy = false;
		const recheck = async (): Promise<void> => {
			if (busy) { return; }
			busy = true;
			try {
				await this.onAgentAction(id, 'refresh');
				const a = this.services.cli.get(id as CliAgentInfo['id']);
				if (a?.binaryPath && a.loggedIn !== false) { this.agentWatch?.dispose(); this.agentWatch = undefined; }
			} finally {
				busy = false;
			}
		};
		const subs = [
			vscode.window.onDidCloseTerminal(t => { if (t === term) { void recheck(); } }),
			vscode.window.onDidChangeWindowState(w => { if (w.focused) { void recheck(); } }),
		];
		this.agentWatch = { dispose: () => subs.forEach(x => x.dispose()) };
	}

	/** Another model that can take over after `current` hit a limit: not the same CLI or key, which share the limit. */
	private fallbackFor(current: string): ModelOption | undefined {
		const family = (id: string): string => (id.startsWith('cli:') ? id.slice(0, id.indexOf('/')) : id.slice(0, id.indexOf('/')));
		const ok = (m: ModelOption | undefined): m is ModelOption => !!m && m.hasKey && m.id !== current && family(m.id) !== family(current);
		const free = this.modelOptions.find(m => m.id === FREE_AUTO_ID);
		const candidates = [current !== FREE_AUTO_ID ? free : undefined, this.subscription(), this.modelOptions.find(m => m.id === this.defaultModelId()), ...this.modelOptions];
		return candidates.find(ok);
	}

	/** Continues the chat on another model after a limit: the earlier turns, edits and commands all carry over. */
	private async continueOn(chatId: string, modelId?: string): Promise<void> {
		const sc = await this.store.get(chatId);
		if (!sc || this.runtime(chatId).running) { return; }
		let target = modelId;
		if (!target) {
			const current = sc.chat.modelId;
			const items = this.modelOptions.filter(m => m.hasKey && m.id !== current).map(m => ({ label: m.label, description: m.free ? 'Free' : undefined, id: m.id }));
			if (!items.length) { await this.help.run({ target: 'free-models' }); return; }
			const pick = await vscode.window.showQuickPick(items, { title: 'Continue on another model', placeHolder: 'It gets the whole conversation and every change so far' });
			if (!pick) { return; }
			target = pick.id;
		}
		if (!this.usable(target)) { return; }
		await this.setModel(chatId, target);
		await this.onSend(chatId, { text: 'Continue where you left off.', context: [], mode: sc.chat.mode === 'help' ? undefined : sc.chat.mode, modelId: target });
	}

	private usable(id: string | undefined): boolean {
		return !!id && this.modelOptions.some(m => m.id === id && m.hasKey);
	}

	/** A signed-in subscription, preferring the one from `provider`'s company, then the order people most often have. */
	private subscription(provider?: string): ModelOption | undefined {
		const order = [...(provider && SUBSCRIPTION_FOR[provider] ? [SUBSCRIPTION_FOR[provider]] : []), ...SUBSCRIPTION_ORDER];
		for (const agent of order) {
			const ready = this.modelOptions.filter(m => m.hasKey && m.id.startsWith(`cli:${agent}/`));
			const pick = ready.find(m => m.id.endsWith('/default')) ?? ready[0];
			if (pick) { return pick; }
		}
		return undefined;
	}

	private defaultModelId(): string {
		// A CLI subscription (`cli:<agent>/<model>`) can be the default too; the registry only knows API models.
		const configured = vscode.workspace.getConfiguration('openCursor').get<string>('models.default');
		// The user's own default stands unless it is known not to run (listed, but without a key or sign-in).
		// A local model that has not been listed yet (Ollama still starting) keeps its place.
		const listed = configured ? this.modelOptions.find(m => m.id === configured) : undefined;
		if (configured && (!listed || listed.hasKey)) {
			return configured;
		}
		const api = this.services.registry.getDefaultModel('chat');
		if (api && this.usable(api.id) && !LOCAL_PROVIDERS.has(api.provider)) {
			return api.id;
		}
		// Nothing configured can run: a subscription the user is signed in to beats a small local model, and both beat
		// a model that needs a key they never added.
		return this.subscription()?.id ?? (api && this.usable(api.id) ? api.id : undefined) ?? this.modelOptions.find(m => m.hasKey)?.id ?? configured ?? api?.id ?? this.modelOptions[0]?.id ?? '';
	}

	/** Empty chats still pointing at a model that cannot run move to one that can, so the first message just works. */
	private repairEmptyChats(): void {
		for (const sc of this.store.loaded()) {
			if (this.repairChat(sc)) { this.postChatNow(sc); }
		}
	}

	private repairChat(sc: StoredChat): boolean {
		// Only a model known not to run moves; one missing from the list for a moment (a server reloading) stays.
		const known = this.modelOptions.find(m => m.id === sc.chat.modelId);
		if (sc.chat.messages.length > 0 || !known || known.hasKey) { return false; }
		const next = this.defaultModelId();
		if (!this.usable(next) || next === sc.chat.modelId) { return false; }
		sc.chat.modelId = next;
		this.store.markDirty(sc.chat.id);
		return true;
	}

	private runtime(chatId: string): Runtime {
		let rt = this.runtimes.get(chatId);
		if (!rt) {
			rt = { running: false, approvals: new Map(), idle: Promise.resolve(), stopped: false };
			this.runtimes.set(chatId, rt);
		}
		return rt;
	}

	private async ensureActive(): Promise<StoredChat> {
		const id = this.store.activeChatId;
		if (id) {
			const sc = await this.store.get(id);
			if (sc) {
				if (!this.store.openChatIds.includes(id)) { this.store.setOpen([...this.store.openChatIds, id], id); }
				return sc;
			}
		}
		for (const open of this.store.openChatIds) {
			const sc = await this.store.get(open);
			if (sc) { this.store.setOpen(this.store.openChatIds, open); return sc; }
		}
		return this.createChat();
	}

	private createChat(): StoredChat {
		const sc = this.store.create({ mode: readDefaultMode(), modelId: this.defaultModelId() });
		this.store.setOpen([...this.store.openChatIds, sc.chat.id], sc.chat.id);
		return sc;
	}

	private postChats(): void {
		this.post({ type: 'chats', chats: this.store.summaries(), openChatIds: this.store.openChatIds });
	}

	private async activate(sc: StoredChat): Promise<void> {
		this.repairChat(sc);
		const open = this.store.openChatIds.includes(sc.chat.id) ? this.store.openChatIds : [...this.store.openChatIds, sc.chat.id];
		this.store.setOpen(open, sc.chat.id);
		this.post({ type: 'chat', chat: sc.chat });
		this.postChats();
		this.post({ type: 'activeChat', chatId: sc.chat.id });
		if (sc.chat.mode !== 'help') { this.lastWorkChatId = sc.chat.id; }
		void vscode.commands.executeCommand('setContext', 'openCursor.helpActive', sc.chat.mode === 'help');
	}

	/** Back to the chat the user was in before Help, or a fresh one. */
	async leaveHelp(): Promise<void> {
		await this.ready;
		const back = this.lastWorkChatId ? await this.store.get(this.lastWorkChatId) : undefined;
		if (back && back.chat.mode !== 'help') { await this.activate(back); } else { await this.newChat(); }
		this.post({ type: 'focusInput' });
	}

	async newChat(): Promise<StoredChat> {
		await this.ready;
		// reuse an untouched active chat instead of piling up empty ones
		const cur = this.store.activeChatId ? await this.store.get(this.store.activeChatId) : undefined;
		if (cur && cur.chat.messages.length === 0 && cur.chat.status === 'idle' && cur.chat.mode !== 'help') {
			await this.activate(cur);
			return cur;
		}
		// ...or any other untouched chat left behind, so the list never fills with empty "New chat" rows
		for (const s of this.store.summaries().filter(x => x.title === DEFAULT_TITLE && x.status === 'idle')) {
			const empty = await this.store.get(s.id);
			if (empty && empty.chat.messages.length === 0 && empty.chat.mode !== 'help') {
				await this.activate(empty);
				return empty;
			}
		}
		const sc = this.createChat();
		await this.activate(sc);
		return sc;
	}

	/**
	 * The Help chat: the open one if there is one, else a fresh chat in Help mode. With `text` the
	 * question is asked straight away.
	 */
	async openHelp(text?: string): Promise<void> {
		await this.ready;
		let sc: StoredChat | undefined;
		for (const id of [...this.store.openChatIds].reverse()) {
			const c = await this.store.get(id);
			if (c?.chat.mode === 'help') { sc = c; break; }
		}
		if (!sc) {
			sc = this.store.create({ mode: 'help', modelId: this.defaultModelId() });
			this.store.setOpen([...this.store.openChatIds, sc.chat.id], sc.chat.id);
		}
		await this.activate(sc);
		if (text?.trim()) {
			await this.onSend(sc.chat.id, { text: text.trim(), context: [], mode: 'help', modelId: sc.chat.modelId || this.defaultModelId() });
		} else {
			this.post({ type: 'focusInput' });
		}
	}

	/** What Help is told about the user's setup, one line per kind of source. */
	private helpSetup(modelId: string): string {
		const ready = this.modelOptions.filter(m => m.hasKey);
		const current = this.modelOptions.find(m => m.id === modelId);
		const subs = [...new Set(ready.filter(m => m.provider === 'cli').map(m => m.label.split(':')[0].trim()))];
		const keys = [...new Set(ready.filter(m => m.provider !== 'cli' && !LOCAL_PROVIDERS.has(m.provider) && m.provider !== 'free').map(m => PROVIDER_NAMES[m.provider] ?? m.provider))];
		const local = [...new Set(ready.filter(m => LOCAL_PROVIDERS.has(m.provider)).map(m => PROVIDER_NAMES[m.provider] ?? m.provider))];
		return [
			`- This Help chat runs on: ${current?.label ?? modelId}`,
			`- Subscriptions ready: ${subs.join(', ') || 'none'}`,
			`- API keys added: ${keys.join(', ') || 'none'}`,
			`- Local servers with models: ${local.join(', ') || 'none'}`,
			`- Free models usable: ${ready.some(m => m.free || isFreeModel(m.id)) ? 'yes' : 'none yet'}`,
			`- Workspace: ${vscode.workspace.workspaceFolders?.length ? 'a folder is open' : 'no folder open'}`,
		].join('\n');
	}

	/**
	 * The common Help questions have hand written answers: shown at once, the page opened at once,
	 * and kept in the model's history so a follow up question still has the context.
	 */
	private async answerInstantly(turn: TurnState, userMsg: UserMessage, text: string): Promise<boolean> {
		const hit = instantAnswer(text);
		if (!hit) { return false; }
		if (hit.open) {
			const id = newId('t');
			const args = { target: hit.open.target, ...(hit.open.arg ? { argument: hit.open.arg } : {}) };
			this.upsertTool(turn, { type: 'tool', id, name: 'open_in_app', args, status: 'running', title: `Opening ${actionLabel(hit.open)}` });
			const ok = await this.help.run(hit.open).then(() => true, () => false);
			this.upsertTool(turn, { type: 'tool', id, name: 'open_in_app', args, status: ok ? 'done' : 'error', title: `${ok ? 'Opened' : 'Could not open'} ${actionLabel(hit.open)}` });
		}
		this.appendText(turn, hit.text);
		const sc = turn.sc;
		sc.transcript.push(
			{ turn: userMsg.id, msg: { role: 'user', content: [{ type: 'text', text }] } },
			{ turn: userMsg.id, msg: { role: 'assistant', content: [{ type: 'text', text: hit.text }] } },
		);
		this.touch(sc);
		return true;
	}

	/** Text only agents cannot call the tool, so the first link to a page in their answer opens on its own. */
	private async openFirstHelpLink(turn: TurnState): Promise<void> {
		if (turn.sc.chat.mode !== 'help' || turn.rt.abort?.signal.aborted || turn.errored || this.store.activeChatId !== turn.sc.chat.id) { return; }
		if (turn.parts.some(p => p.type === 'tool' && p.name === 'open_in_app')) { return; }
		const text = turn.parts.map(p => p.type === 'text' ? p.text : '').join('');
		const a = firstInPlaceLink(text);
		if (a) { await this.help.run(a).catch(() => undefined); }
	}

	/** An empty folder for Help turns on agent CLIs, so nothing they do can reach a project. */
	private helpDir(): string {
		const dir = nodePath.join(this.ctx.globalStorageUri.fsPath, 'help');
		try { fs.mkdirSync(dir, { recursive: true }); } catch { /* falls back to the path itself */ }
		return dir;
	}

	private async openChat(chatId: string): Promise<void> {
		const sc = await this.store.get(chatId);
		if (sc) { await this.activate(sc); }
	}

	private async closeTab(chatId: string): Promise<void> {
		const ids = this.store.openChatIds.filter(i => i !== chatId);
		if (this.store.activeChatId === chatId) {
			const idx = this.store.openChatIds.indexOf(chatId);
			const next = ids[Math.min(idx, ids.length - 1)];
			this.store.setOpen(ids, next);
			if (next) {
				const sc = await this.store.get(next);
				if (sc) { await this.activate(sc); return; }
			}
			await this.newChat();
			return;
		}
		this.store.setOpen(ids);
		this.postChats();
	}

	private async deleteChat(chatId: string): Promise<void> {
		const rt = this.runtimes.get(chatId);
		if (rt?.running) {
			const dying = await this.store.get(chatId);
			if (dying) { dying.chat.queued = []; }
			rt.abort?.abort();
			await rt.idle;
		}
		this.runtimes.delete(chatId);
		try { this.services.checkpoints.dispose(chatId); } catch { /* ignore */ }
		const wasActive = this.store.activeChatId === chatId;
		await this.store.delete(chatId);
		if (wasActive) {
			const sc = await this.ensureActive();
			await this.activate(sc);
		} else {
			this.postChats();
		}
	}

	private async renameChat(chatId: string, title: string): Promise<void> {
		const sc = await this.store.get(chatId);
		const t = title.trim();
		if (!sc || !t) { return; }
		sc.chat.title = t.slice(0, 120);
		sc.titleSource = 'user';
		this.touch(sc);
		this.postChats();
	}

	private async setMode(chatId: string, mode: ChatMode): Promise<void> {
		const sc = await this.store.get(chatId);
		// A Help chat stays Help and no other chat becomes one; Help is entered and left as its own chat.
		if (!sc || sc.chat.mode === 'help' || mode === 'help') { return; }
		sc.chat.mode = mode;
		this.touch(sc);
		this.postChatNow(sc);
	}

	activeModelId(): string {
		const id = this.store.activeChatId;
		const sc = id ? this.store.loaded().find(s => s.chat.id === id) : undefined;
		return sc?.chat.modelId ?? this.defaultModelId();
	}

	async useModel(modelId: string): Promise<void> {
		await vscode.workspace.getConfiguration('openCursor').update('models.default', modelId, vscode.ConfigurationTarget.Global);
		await this.refreshModels();
		const sc = await this.ensureActive();
		await this.setModel(sc.chat.id, modelId);
		await this.reveal();
	}

	private async setModel(chatId: string, modelId: string): Promise<void> {
		const sc = await this.store.get(chatId);
		if (!sc) { return; }
		sc.chat.modelId = modelId;
		this.touch(sc);
		this.postChatNow(sc);
	}

	private touch(sc: StoredChat): void {
		sc.chat.updatedAt = Date.now();
		this.store.markDirty(sc.chat.id);
	}

	private schedulePost(sc: StoredChat): void {
		const rt = this.runtime(sc.chat.id);
		if (rt.postTimer) { return; }
		rt.postTimer = setTimeout(() => {
			rt.postTimer = undefined;
			this.post({ type: 'chat', chat: sc.chat });
		}, POST_INTERVAL_MS);
	}

	private postChatNow(sc: StoredChat): void {
		const rt = this.runtime(sc.chat.id);
		if (rt.postTimer) { clearTimeout(rt.postTimer); rt.postTimer = undefined; }
		this.post({ type: 'chat', chat: sc.chat });
	}

	async submit(opts: { text: string; context?: ContextItem[]; mode?: ChatMode; newChat?: boolean }): Promise<void> {
		await this.ready;
		await this.reveal();
		const sc = opts.newChat ? await this.newChat() : await this.ensureActive();
		if (!opts.newChat) { await this.activate(sc); }
		await this.onSend(sc.chat.id, { text: opts.text, context: opts.context ?? [], mode: opts.mode ?? sc.chat.mode, modelId: sc.chat.modelId || this.defaultModelId() });
	}

	private async onSend(chatId: string, req: SendRequest): Promise<void> {
		const sc = await this.store.get(chatId);
		if (!sc) { return; }
		const text = req.text.trim();
		if (!text && req.context.length === 0) { return; }
		if (sc.chat.mode === 'help') {
			// Help answers from the manual only: file context never goes along, and the mode cannot change from here.
			req = { ...req, mode: 'help', context: [] };
		} else if (req.mode && req.mode !== 'help') { sc.chat.mode = req.mode; }
		if (req.modelId) { sc.chat.modelId = req.modelId; }

		const handled = await this.handleSlash(sc, text, req);
		if (handled === 'done') { return; }
		const effective = handled ?? req;

		const rt = this.runtime(chatId);
		if (rt.running) {
			sc.chat.queued = [...sc.chat.queued, { id: newId('q'), text: effective.text, context: effective.context }];
			this.touch(sc);
			this.postChatNow(sc);
			return;
		}
		await this.startTurn(sc, effective);
	}

	/** Returns 'done' when fully handled, a replacement request for custom commands, or undefined to send as is. */
	private async handleSlash(sc: StoredChat, text: string, req: SendRequest): Promise<'done' | SendRequest | undefined> {
		const m = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text);
		if (!m) { return undefined; }
		const name = m[1].toLowerCase();
		const args = (m[2] ?? '').trim();
		const rt = this.runtime(sc.chat.id);
		const setMode = async (mode: ChatMode): Promise<'done' | SendRequest> => {
			if (sc.chat.mode === 'help') {
				// From Help, a mode command starts a normal chat in that mode instead of turning Help into it.
				const n = await this.newChat();
				n.chat.mode = mode;
				this.touch(n);
				this.postChatNow(n);
				if (args) { await this.onSend(n.chat.id, { ...req, text: args, mode, context: [] }); }
				return 'done';
			}
			sc.chat.mode = mode;
			this.touch(sc);
			this.postChatNow(sc);
			return args ? { ...req, text: args, mode } : 'done';
		};
		switch (name) {
			case 'help': await this.openHelp(args); return 'done';
			case 'new': await this.newChat(); if (args) { const n = this.store.activeChatId; if (n) { await this.onSend(n, { ...req, text: args, mode: req.mode === 'help' ? undefined : req.mode }); } } return 'done';
			case 'clear': {
				if (rt.running) { return 'done'; }
				sc.chat.messages = [];
				sc.chat.todos = [];
				sc.chat.queued = [];
				sc.chat.contextUsage = undefined;
				sc.transcript = [];
				sc.cliSessionId = undefined;
				sc.cliSessionAgent = undefined;
				this.touch(sc);
				this.postChatNow(sc);
				return 'done';
			}
			case 'summarize': {
				if (rt.running) { return 'done'; }
				await this.summarizeChat(sc);
				return 'done';
			}
			case 'plan': return setMode('plan');
			case 'ask': return setMode('ask');
			case 'agent': return setMode('agent');
			case 'debug': return setMode('debug');
			case 'model': {
				const q = args.toLowerCase();
				const hit = q ? this.modelOptions.find(o => o.id.toLowerCase() === q) ?? this.modelOptions.find(o => o.label.toLowerCase() === q) ?? this.modelOptions.find(o => (o.label + ' ' + o.id).toLowerCase().includes(q)) : undefined;
				if (hit) {
					sc.chat.modelId = hit.id;
					this.touch(sc);
					this.postChatNow(sc);
				} else {
					void vscode.window.showWarningMessage(q ? `No model matches "${args}".` : 'Usage: /model <name>');
				}
				return 'done';
			}
			case 'rules':
				if (sc.chat.mode === 'help') { await this.help.run({ target: 'settings', arg: 'rules' }); return 'done'; }
				await this.openRulesFolder(); return 'done';
			default: {
				const cmd = await this.contextEx.findCommand?.(m[1]) ?? (await this.services.context.getSlashCommands()).find(c => c.name === m[1]);
				if (!cmd) { return undefined; }
				const body = cmd.content.includes('$ARGUMENTS') ? cmd.content.replace(/\$ARGUMENTS/g, args) : args ? `${cmd.content}\n\n${args}` : cmd.content;
				return { ...req, promptText: body };
			}
		}
	}

	private async openRulesFolder(): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!root) { void vscode.window.showInformationMessage('Open a folder to create project rules.'); return; }
		const dir = vscode.Uri.joinPath(root, '.open-cursor', 'rules');
		try { await vscode.workspace.fs.createDirectory(dir); } catch { /* ignore */ }
		try { await vscode.commands.executeCommand('revealInExplorer', dir); } catch { await vscode.commands.executeCommand('revealFileInOS', dir); }
	}

	private async queueMessage(chatId: string, text: string, context: ContextItem[]): Promise<void> {
		const sc = await this.store.get(chatId);
		if (!sc || (!text.trim() && !context.length)) { return; }
		const rt = this.runtime(chatId);
		if (!rt.running) { await this.onSend(chatId, { text, context }); return; }
		sc.chat.queued = [...sc.chat.queued, { id: newId('q'), text, context }];
		this.touch(sc);
		this.postChatNow(sc);
	}

	private async unqueue(chatId: string, queuedId: string): Promise<void> {
		const sc = await this.store.get(chatId);
		if (!sc) { return; }
		sc.chat.queued = sc.chat.queued.filter(q => q.id !== queuedId);
		this.touch(sc);
		this.postChatNow(sc);
	}

	private async stop(chatId: string): Promise<void> {
		const rt = this.runtimes.get(chatId);
		if (!rt?.running) { return; }
		rt.stopped = true;
		rt.abort?.abort();
		for (const resolve of rt.approvals.values()) { resolve('skip'); }
	}

	private async onResend(chatId: string, messageId: string, text: string, context: ContextItem[], revert: boolean, modelId?: string): Promise<void> {
		const sc = await this.store.get(chatId);
		if (!sc) { return; }
		const rt = this.runtime(chatId);
		if (rt.running) { sc.chat.queued = []; await this.stop(chatId); await rt.idle; }
		const idx = sc.chat.messages.findIndex(m => m.id === messageId && m.role === 'user');
		if (idx === -1) { return; }
		const target = sc.chat.messages[idx] as UserMessage;
		if (revert && target.checkpointId) {
			try { await this.services.checkpoints.restore(chatId, target.checkpointId); } catch (e) { void vscode.window.showWarningMessage(`Could not restore files: ${e instanceof Error ? e.message : String(e)}`); return; }
		}
		this.truncateFrom(sc, idx);
		sc.chat.queued = [];
		await this.startTurn(sc, { text, context, modelId });
	}

	private async restoreCheckpoint(chatId: string, messageId: string): Promise<void> {
		const sc = await this.store.get(chatId);
		if (!sc) { return; }
		const rt = this.runtime(chatId);
		if (rt.running) { sc.chat.queued = []; await this.stop(chatId); await rt.idle; }
		const idx = sc.chat.messages.findIndex(m => m.id === messageId && m.role === 'user');
		if (idx === -1) { return; }
		const target = sc.chat.messages[idx] as UserMessage;
		if (target.checkpointId) {
			try {
				await this.services.checkpoints.restore(chatId, target.checkpointId);
			} catch (e) {
				void vscode.window.showWarningMessage(`Could not restore files: ${e instanceof Error ? e.message : String(e)}`);
				return;
			}
		}
		this.truncateFrom(sc, idx);
		this.postChatNow(sc);
		this.post({ type: 'focusInput', text: target.text });
	}

	/** Remove the message at `idx` and everything after it, keeping the model transcript in step. */
	private truncateFrom(sc: StoredChat, idx: number): void {
		const target = sc.chat.messages[idx];
		const cut = truncateTranscript(sc.transcript, target.id);
		sc.chat.messages = sc.chat.messages.slice(0, idx);
		sc.transcript = cut ?? buildHistoryFromChat(sc.chat.messages);
		sc.chat.status = 'idle';
		sc.chat.todos = [];
		this.touch(sc);
	}

	private async startTurn(sc: StoredChat, req: SendRequest): Promise<void> {
		const chatId = sc.chat.id;
		const rt = this.runtime(chatId);
		rt.running = true;
		rt.stopped = false;
		rt.abort = new AbortController();
		rt.idle = new Promise<void>(res => { rt.resolveIdle = res; });

		const mode = req.mode ?? sc.chat.mode;
		let modelId = req.modelId ?? sc.chat.modelId;
		// An API model without a key, from a company whose subscription the user is signed in to, runs on that subscription.
		const picked = this.modelOptions.find(m => m.id === modelId);
		const sameCompany = picked && !picked.hasKey && picked.provider !== 'cli' ? this.subscription(picked.provider) : undefined;
		if (sameCompany?.id.startsWith(`cli:${SUBSCRIPTION_FOR[picked!.provider]}/`)) {
			modelId = sameCompany.id;
		}
		let blocked = picked && !picked.hasKey && modelId === picked.id ? picked : undefined;
		// The model list is a snapshot; look again before refusing (a key added a moment ago, a fresh sign-in).
		if (blocked && (blocked.provider === 'cli'
			? (await this.services.cli.refresh().catch(() => [])).some(a => blocked!.id.startsWith(`cli:${a.id}/`) && a.binaryPath && a.loggedIn !== false)
			: await this.services.registry.hasKey(blocked.provider as ModelInfo['provider']).catch(() => false))) {
			blocked = undefined;
			void this.refreshModels();
		}
		sc.chat.mode = mode;
		sc.chat.modelId = modelId;
		sc.chat.status = 'running';

		const isFirst = sc.chat.messages.length === 0;
		const userId = newId('m');
		let checkpointId: string | undefined;
		try { checkpointId = this.services.checkpoints.begin(chatId, userId); } catch { /* checkpoints unavailable */ }
		const userMsg: UserMessage = { id: userId, role: 'user', text: req.text, context: req.context, createdAt: Date.now(), checkpointId };
		const parts: MessagePart[] = [];
		const assistant: AssistantMessage = { id: newId('a'), role: 'assistant', parts, createdAt: Date.now(), modelId, done: false };
		sc.chat.messages.push(userMsg, assistant);
		if (isFirst && sc.titleSource === 'default') {
			sc.chat.title = fallbackTitle(req.text);
			sc.titleSource = 'auto';
		}
		this.touch(sc);
		this.postChatNow(sc);
		this.postChats();

		const turn: TurnState = { sc, rt, parts, msg: assistant, usage: { inputTokens: 0, outputTokens: 0 }, errored: false };
		try {
			if (blocked) {
				const isCli = blocked.provider === 'cli';
				const alt = this.subscription();
				const who = isCli ? blocked.label.split(':')[0] : PROVIDER_NAMES[blocked.provider] ?? blocked.provider;
				const agentId = isCli ? blocked.id.slice(4, blocked.id.indexOf('/')) : '';
				const message = blocked.provider === 'free'
					? 'Free (auto) needs at least one free key. Connecting one takes about a minute on the Free models page.'
					: isCli
					? `${who} is not signed in on this computer.` + (alt && !alt.id.startsWith(`cli:${agentId}/`) ? ` You are signed in to ${alt.label.split(':')[0]}.` : '')
					: `${who} needs an API key, and none is added.` + (alt ? ` You are signed in to ${alt.label.split(':')[0]}, which needs no key.` : ' Add a key, or connect a subscription you already have.');
				turn.parts.push({
					type: 'error', message,
					switchTo: alt && !alt.id.startsWith(`cli:${agentId}/`) ? { id: alt.id, label: alt.label } : undefined,
					fix: isCli ? { kind: 'signIn', agentId, label: who } : blocked.provider === 'free' ? { kind: 'freeModels' } : { kind: 'addKey' },
				});
				turn.errored = true;
				this.postChatNow(sc);
			} else if (mode === 'help' && await this.answerInstantly(turn, userMsg, req.text)) {
				// answered from the hand written answers, no model needed
			} else if (modelId.startsWith('cli:')) {
				await this.runCliTurn(turn, userMsg, req);
			} else {
				await this.runNativeTurn(turn, userMsg, req, checkpointId);
			}
			await this.openFirstHelpLink(turn);
		} catch (e) {
			if (!rt.abort?.signal.aborted) {
				this.addError(turn, `Something went wrong: ${e instanceof Error ? e.message : String(e)}`, 'retry');
			}
		} finally {
			await this.finishTurn(turn, isFirst, req.text);
		}
	}

	private async finishTurn(turn: TurnState, isFirst: boolean, userText: string): Promise<void> {
		const { sc, rt } = turn;
		for (const resolve of rt.approvals.values()) { resolve('skip'); }
		rt.approvals.clear();
		// any tool row still in flight is not going to finish
		for (let i = 0; i < turn.parts.length; i++) {
			const p = turn.parts[i];
			if (p.type === 'tool' && (p.status === 'running' || p.status === 'streaming' || p.status === 'awaiting-approval')) {
				turn.parts[i] = { ...p, status: 'cancelled' };
			} else if (p.type === 'thinking' && !p.done) {
				turn.parts[i] = { ...p, done: true, durationMs: turn.thinkingStart ? Date.now() - turn.thinkingStart : p.durationMs };
			}
		}
		this.syncMsg(turn, true);
		sc.chat.status = turn.errored ? 'error' : 'idle';
		this.touch(sc);
		if (rt.postTimer) { clearTimeout(rt.postTimer); rt.postTimer = undefined; }
		this.postChatNow(sc);
		this.postChats();
		void this.store.flush();
		rt.running = false;
		rt.abort = undefined;
		rt.resolveIdle?.();

		if (isFirst && !turn.errored && sc.titleSource === 'auto') {
			void this.generateChatTitle(sc, userText).catch(() => undefined);
		}
		// queued messages go out in order
		const next = rt.stopped ? undefined : sc.chat.queued[0];
		if (next && !this.disposed) {
			sc.chat.queued = sc.chat.queued.slice(1);
			this.touch(sc);
			this.postChatNow(sc);
			void this.onSend(sc.chat.id, { text: next.text, context: next.context }).catch(() => undefined);
		}
	}

	private disposed = false;

	private async generateChatTitle(sc: StoredChat, userText: string): Promise<void> {
		const assistantText = sc.chat.messages.map(m => m.role === 'assistant' ? m.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n') : '').join('\n').trim();
		const model = this.services.registry.getDefaultModel('inline') ?? this.services.registry.getDefaultModel('chat');
		const title = await generateTitle(this.services.registry, model, userText, assistantText, AbortSignal.timeout(15000));
		if (title && sc.titleSource === 'auto' && sc.chat.title !== title) {
			sc.chat.title = title;
			this.touch(sc);
			this.postChats();
			this.postChatNow(sc);
		}
	}

	// MessagePart fields are readonly, so these replace elements

	private syncMsg(turn: TurnState, done = false): void {
		const i = turn.sc.chat.messages.findIndex(m => m.id === turn.msg.id);
		turn.msg = { ...turn.msg, done: done || turn.msg.done, usage: turn.usage.outputTokens || turn.usage.inputTokens ? { ...turn.usage } : turn.msg.usage };
		if (i !== -1) { turn.sc.chat.messages[i] = turn.msg; }
	}

	private appendText(turn: TurnState, delta: string): void {
		this.closeThinking(turn);
		const last = turn.parts[turn.parts.length - 1];
		if (last?.type === 'text') { turn.parts[turn.parts.length - 1] = { type: 'text', text: last.text + delta }; }
		else { turn.parts.push({ type: 'text', text: delta }); }
		this.schedulePost(turn.sc);
	}

	private appendThinking(turn: TurnState, delta: string): void {
		const last = turn.parts[turn.parts.length - 1];
		if (last?.type === 'thinking' && !last.done) {
			turn.parts[turn.parts.length - 1] = { ...last, text: last.text + delta };
		} else {
			turn.thinkingStart = Date.now();
			turn.parts.push({ type: 'thinking', text: delta, done: false });
		}
		this.schedulePost(turn.sc);
	}

	private closeThinking(turn: TurnState): void {
		const i = turn.parts.length - 1;
		const last = turn.parts[i];
		if (last?.type === 'thinking' && !last.done) {
			turn.parts[i] = { ...last, done: true, durationMs: turn.thinkingStart ? Date.now() - turn.thinkingStart : undefined };
			this.schedulePost(turn.sc);
		}
	}

	private upsertTool(turn: TurnState, part: ToolPart): void {
		this.closeThinking(turn);
		const i = turn.parts.findIndex(p => p.type === 'tool' && p.id === part.id);
		if (i === -1) { turn.parts.push(part); } else { turn.parts[i] = part; }
		const ready = part.status === 'awaiting-approval';
		const wasWaiting = turn.sc.chat.status === 'awaiting-approval';
		if (ready) { turn.sc.chat.status = 'awaiting-approval'; }
		else if (wasWaiting && !turn.parts.some(p => p.type === 'tool' && p.status === 'awaiting-approval')) { turn.sc.chat.status = 'running'; }
		if (ready || wasWaiting) { this.postChats(); }
		if (part.status === 'done' || part.status === 'error' || ready) { this.postChatNow(turn.sc); } else { this.schedulePost(turn.sc); }
	}

	private addError(turn: TurnState, message: string, action?: 'openSettings' | 'retry'): void {
		this.closeThinking(turn);
		if (isLimitError(message)) {
			// A limit is not the end of the work: offer the next model, which gets the whole conversation.
			const next = this.fallbackFor(turn.sc.chat.modelId);
			turn.parts.push({ type: 'error', message, action: 'retry', limit: true, ...(next ? { switchTo: { id: next.id, label: next.label } } : { fix: { kind: 'freeModels' } }) });
			turn.errored = true;
			this.postChatNow(turn.sc);
			return;
		}
		turn.parts.push({ type: 'error', message, action });
		turn.errored = true;
		this.postChatNow(turn.sc);
	}

	private requestApproval(turn: TurnState, part: ToolPart): Promise<Decision> {
		return new Promise<Decision>(resolve => {
			turn.rt.approvals.set(part.id, d => {
				turn.rt.approvals.delete(part.id);
				if (d === 'allowAlways' && part.command) { this.sessionAllow.add(suggestAllowPrefix(part.command.text)); }
				resolve(d);
			});
		});
	}

	private async buildUserContent(req: SendRequest, snapshotEditor: boolean): Promise<{ content: LLMContent[]; resolvedTexts: string[] }> {
		const textItems = req.context.filter(c => c.kind !== 'image');
		const images = req.context.filter(c => c.kind === 'image');
		const resolved = await Promise.all(textItems.map(async item => {
			const t = await this.services.context.resolve(item).catch(() => '');
			return t;
		}));
		const content: LLMContent[] = [];
		const ctxText = resolved.filter(Boolean).join('\n\n');
		const editor = snapshotEditor ? buildEditorState(editorSnapshot()) : '';
		const head = [editor, ctxText ? `<attached_context>\n${ctxText}\n</attached_context>` : ''].filter(Boolean).join('\n');
		const body = req.promptText ?? req.text;
		content.push({ type: 'text', text: head ? `${head}\n\n<user_query>\n${body}\n</user_query>` : body });
		for (const img of images) {
			const parsed = img.content ? parseDataUrl(img.content) : undefined;
			if (parsed) { content.push({ type: 'image', mediaType: parsed.mediaType, data: parsed.data }); }
		}
		return { content, resolvedTexts: resolved };
	}

	private async runNativeTurn(turn: TurnState, userMsg: UserMessage, req: SendRequest, checkpointId: string | undefined): Promise<void> {
		const { sc, rt } = turn;
		const signal = rt.abort!.signal;
		const registry = this.services.registry;
		const model = registry.getModel(sc.chat.modelId) ?? registry.getDefaultModel('chat');
		if (!model) {
			this.addError(turn, 'No model is available. Add an API key or a local model in settings.', 'openSettings');
			return;
		}
		if (model.id !== sc.chat.modelId) { sc.chat.modelId = model.id; }
		const mode = sc.chat.mode;

		const files = referencedFiles(req.context);
		const rules = mode === 'help' ? [] : await this.services.context.getRules(files).catch(() => []);
		const inline: PromptRule[] = rules.filter(r => !r.agentRequested).map(r => ({ name: r.name, source: r.source, content: r.content }));
		const agentRules = rules.filter(r => r.agentRequested).map(r => ({ name: r.name, description: r.description ?? '' }));
		let toolSet: ToolSet = model.supportsTools ? getToolSet(mode, this.services) : { byName: new Map(), schemas: [] };
		let system: string;
		if (mode === 'help') {
			const tool = this.help.tool(() => this.store.activeChatId === sc.chat.id);
			toolSet = model.supportsTools ? { byName: new Map([[tool.schema.name, tool]]), schemas: [tool.schema] } : { byName: new Map(), schemas: [] };
			const env = buildEnv([], []);
			system = buildHelpSystemPrompt({ os: env.os, date: env.date, setup: this.helpSetup(model.id) }, toolSet.schemas.length > 0);
		} else {
			system = buildSystemPrompt(mode, buildEnv(inline, toolSet.byName.has('fetch_rules') ? agentRules : []));
		}

		const { content } = await this.buildUserContent(req, true);
		if (signal.aborted) { return; }

		// model history: stored transcript, or rebuilt from the UI for chats created before one existed
		// and rebuilt as well when turns ran on a command line agent since, so this model sees them too
		const earlier = sc.chat.messages.slice(0, -2);
		const covered = new Set(sc.transcript.map(e => e.turn));
		const missedCli = earlier.some((m, i) => m.role === 'user' && !covered.has(m.id) && earlier[i + 1]?.role === 'assistant' && (earlier[i + 1] as AssistantMessage).modelId?.startsWith('cli:'));
		if (earlier.length && (sc.transcript.length === 0 || missedCli)) {
			sc.transcript = buildHistoryFromChat(earlier);
		}
		const msgs = sc.transcript.map(e => e.msg);
		const lastTurn = sc.transcript[sc.transcript.length - 1];
		appendUserContent(msgs, content);
		if (lastTurn && lastTurn.msg.role === 'user') {
			sc.transcript[sc.transcript.length - 1] = { turn: lastTurn.turn, msg: msgs[msgs.length - 1] };
		} else {
			sc.transcript.push({ turn: userMsg.id, msg: msgs[msgs.length - 1] });
		}
		this.touch(sc);

		const hooks: LoopHooks = {
			onText: d => this.appendText(turn, d),
			onThinking: d => this.appendThinking(turn, d),
			onThinkingDone: () => this.closeThinking(turn),
			onToolPart: p => this.upsertTool(turn, p),
			requestApproval: p => this.requestApproval(turn, p),
			onUsage: u => {
				turn.usage = { inputTokens: u.inputTokens || turn.usage.inputTokens, outputTokens: turn.usage.outputTokens + u.outputTokens };
				this.syncMsg(turn);
			},
			onContextUsage: (used, limit) => { sc.chat.contextUsage = { used, limit }; this.schedulePost(sc); },
			onTranscript: () => this.touch(sc),
			onError: (message, action) => this.addError(turn, message, action),
		};

		const reason = await runAgentLoop({
			services: this.services, chatId: sc.chat.id, mode, model, system, transcript: sc.transcript, turn: userMsg.id, tools: toolSet,
			toolCtx: {
				checkpointId,
				confirmOutsideWorkspace: (p, action) => this.confirmOutside(p, action, signal),
				getTodos: () => sc.chat.todos,
				setTodos: todos => { sc.chat.todos = todos; this.touch(sc); this.postChatNow(sc); },
				getAgentRules: async () => (await this.services.context.getRules(files).catch(() => [])).filter(r => r.agentRequested).map(r => ({ name: r.name, description: r.description, content: r.content })),
			},
			settings: {
				maxIterations: readMaxIterations(),
				// Help looks things up in the manual it was handed; thinking only adds seconds.
				thinking: mode === 'help' ? false : apiEffort(readEffort()) !== undefined,
				effort: apiEffort(readEffort()),
				getPolicy: () => ({ autoRun: readAutoRun(), ...readLists(), sessionAllow: this.sessionAllow }),
				addSessionAllow: prefix => { this.sessionAllow.add(prefix); },
			},
			hooks, signal,
		});
		if (reason === 'error') { turn.errored = true; }
		sc.chat.contextUsage = { used: estimateMessagesTokens(sc.transcript.map(e => e.msg)), limit: model.contextWindow || 128000 };
	}

	private async confirmOutside(absPath: string, action: string, signal: AbortSignal): Promise<boolean> {
		if (signal.aborted) { return false; }
		const choice = await vscode.window.showWarningMessage(`OpenCursor wants to access a path outside the workspace.`, { modal: true, detail: `${action}: ${absPath}` }, 'Allow');
		return choice === 'Allow' && !signal.aborted;
	}

	private async summarizeChat(sc: StoredChat): Promise<void> {
		const registry = this.services.registry;
		const model = registry.getModel(sc.chat.modelId) ?? registry.getDefaultModel('chat');
		const rt = this.runtime(sc.chat.id);
		if (!model || sc.chat.modelId.startsWith('cli:')) { void vscode.window.showInformationMessage('Summarize needs a native model.'); return; }
		if (sc.transcript.length === 0 && sc.chat.messages.length) { sc.transcript = buildHistoryFromChat(sc.chat.messages); }
		const before = estimateMessagesTokens(sc.transcript.map(e => e.msg));
		rt.running = true;
		rt.abort = new AbortController();
		rt.idle = new Promise<void>(res => { rt.resolveIdle = res; });
		sc.chat.status = 'running';
		this.postChats();
		const parts: MessagePart[] = [{ type: 'tool', id: newId('t'), name: 'summarize', status: 'running', title: 'Summarizing conversation' }];
		const msg: AssistantMessage = { id: newId('a'), role: 'assistant', parts, createdAt: Date.now(), modelId: model.id, done: false };
		sc.chat.messages.push(msg);
		this.postChatNow(sc);
		let ok = false;
		try {
			ok = await compactTranscript(registry, model, sc.transcript, rt.abort.signal, 1);
		} catch { ok = false; }
		const after = estimateMessagesTokens(sc.transcript.map(e => e.msg));
		const tool = parts[0] as ToolPart;
		parts[0] = { ...tool, status: ok ? 'done' : 'error', title: ok ? `Summarized conversation · ${Math.round(before / 1000)}k to ${Math.round(after / 1000)}k tokens` : 'Nothing to summarize yet' };
		const i = sc.chat.messages.findIndex(m => m.id === msg.id);
		if (i !== -1) { sc.chat.messages[i] = { ...msg, done: true }; }
		sc.chat.contextUsage = { used: after, limit: model.contextWindow || 128000 };
		sc.chat.status = 'idle';
		rt.running = false;
		rt.abort = undefined;
		rt.resolveIdle?.();
		this.touch(sc);
		this.postChatNow(sc);
		this.postChats();
	}

	private async runCliTurn(turn: TurnState, userMsg: UserMessage, req: SendRequest): Promise<void> {
		const { sc, rt } = turn;
		const signal = rt.abort!.signal;
		const rest = sc.chat.modelId.slice(4);
		const slash = rest.indexOf('/');
		const agent = (slash === -1 ? rest : rest.slice(0, slash)) as CliAgentInfo['id'];
		const model = slash === -1 ? 'default' : rest.slice(slash + 1);
		const info = this.services.cli.get(agent);
		if (!info?.binaryPath) {
			this.addError(turn, `${info?.label ?? agent} is not installed or was not found on PATH.`, 'openSettings');
			return;
		}
		const help = sc.chat.mode === 'help';
		const cwd = help ? this.helpDir() : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const files = referencedFiles(req.context);
		const rules = help ? [] : await this.services.context.getRules(files).catch(() => []);
		const { content, resolvedTexts } = await this.buildUserContent(req, false);
		const ruleText = rules.filter(r => !r.agentRequested && !/^(AGENTS|CLAUDE)\.md$/.test(r.name)).map(r => `Rule ${r.name}:\n${r.content}`).join('\n\n');
		const first = content.find(c => c.type === 'text');
		// The CLI's own session remembers its turns. Anything it has not seen (the whole chat when it starts
		// fresh, or turns that ran on other models since) is handed over in writing, so nothing is lost.
		const resume = sc.cliSessionAgent === agent && sc.cliSessionCwd === cwd ? sc.cliSessionId : undefined;
		const earlier = sc.chat.messages.slice(0, -2);
		let brief = '';
		if (!help && earlier.length) {
			if (!resume) {
				brief = handoffBrief(earlier, { todos: sc.chat.todos });
			} else if (sc.cliSessionUpTo) {
				const seen = earlier.findIndex(m => m.id === sc.cliSessionUpTo);
				if (seen !== -1 && seen < earlier.length - 1) { brief = handoffBrief(earlier.slice(seen + 1), { since: true }); }
			}
		}
		const prompt = [ruleText ? `<project_rules>\n${ruleText}\n</project_rules>` : '', brief, first && first.type === 'text' ? first.text : (req.promptText ?? req.text)].filter(Boolean).join('\n\n');
		void resolvedTexts;
		const images = content.filter((c): c is Extract<LLMContent, { type: 'image' }> => c.type === 'image').map(c => ({ mediaType: c.mediaType, data: c.data }));

		// Edit capture. A CLI writes to disk itself. We remember the original (onFileOriginal) and on the first change hand
		// the captured original to applyContent as the session's original, so the review diffs original -> new without
		// ever writing the original back to disk while the agent is running.
		const originals = new Map<string, string | undefined>();
		const reviewed = new Set<string>();
		let chain: Promise<void> = Promise.resolve();
		const checkpointId = userMsg.checkpointId;
		const edits = this.services.pendingEdits;
		const handleChanged = async (uri: vscode.Uri): Promise<void> => {
			const key = uri.toString();
			let after: string | undefined;
			try { after = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { after = undefined; }
			const hasOriginal = originals.has(key);
			const before = originals.get(key);
			if (after === undefined) {
				// deleted by the CLI: deleteFile needs the file to exist, so this one case restores it first (the review then owns the deletion)
				if (hasOriginal && before !== undefined && !reviewed.has(key)) {
					reviewed.add(key);
					await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(before));
					await edits.deleteFile(uri, sc.chat.id);
				}
				return;
			}
			let override: string | null | undefined;
			if (!reviewed.has(key)) {
				reviewed.add(key);
				if (hasOriginal) {
					if (before === after) { reviewed.delete(key); return; }
					override = before ?? null;
				}
			}
			await edits.applyContent(uri, after, 'agent', sc.chat.id, override);
		};

		const result = await this.services.cli.runTurn({
			agent, model, mode: sc.chat.mode, prompt, images: images.length ? images : undefined, cwd,
			sessionId: resume,
			autoRun: readAutoRun(), effort: readEffort(), signal,
			callbacks: {
				onText: d => this.appendText(turn, d),
				onThinking: d => this.appendThinking(turn, d),
				onToolStart: p => this.upsertTool(turn, p),
				onToolUpdate: p => this.upsertTool(turn, p),
				requestApproval: p => { this.upsertTool(turn, { ...p, status: 'awaiting-approval' }); return this.requestApproval(turn, p); },
				onFileOriginal: (uri, before) => {
					const key = uri.toString();
					if (!originals.has(key)) { originals.set(key, before); }
					if (checkpointId) { try { this.services.checkpoints.capture(checkpointId, uri, before); } catch { /* ignore */ } }
				},
				onFileChanged: uri => { chain = chain.then(() => handleChanged(uri)).catch(() => undefined); },
				onUsage: u => { turn.usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens }; this.syncMsg(turn); },
			},
		});
		await chain;
		if (result.sessionId) { sc.cliSessionId = result.sessionId; sc.cliSessionAgent = agent; sc.cliSessionCwd = cwd; sc.cliSessionUpTo = turn.msg.id; }
		// OpenCode's free models share one quota. When it runs out before anything was produced, the same
		// message carries on with the free keys the user connected, instead of stopping the work.
		const answered = turn.parts.some(p => p.type === 'text' || p.type === 'tool');
		if (result.stopReason === 'error' && agent === 'opencode' && !answered && /\brate[ -]?limit|\b429\b|quota|usage limit|too many requests/i.test(result.error ?? '') && this.usable(FREE_AUTO_ID)) {
			sc.chat.modelId = FREE_AUTO_ID;
			this.appendText(turn, '_OpenCode\'s free quota is used up for now, so this continues on Free (auto)._\n\n');
			await this.runNativeTurn(turn, userMsg, req, userMsg.checkpointId);
			return;
		}
		if (result.stopReason === 'error') { this.addError(turn, result.error ?? 'The CLI agent failed.', 'retry'); }
	}

	private async openFile(uri: string, range?: { startLine: number; endLine: number }): Promise<void> {
		try {
			const u = vscode.Uri.parse(uri);
			const sel = range ? new vscode.Range(Math.max(0, range.startLine - 1), 0, Math.max(0, range.endLine - 1), 0) : undefined;
			await vscode.window.showTextDocument(u, { selection: sel, preview: false });
		} catch (e) {
			void vscode.window.showWarningMessage(`Could not open file: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async openSettings(section?: string): Promise<void> {
		const cmds = await vscode.commands.getCommands(true);
		for (const c of ['openCursor.settings.open', 'openCursor.openSettings']) {
			if (cmds.includes(c)) { await vscode.commands.executeCommand(c, section); return; }
		}
		await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:open-cursor.open-cursor${section ? ' ' + section : ''}`);
	}

	private async insertCode(code: string): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) { void vscode.window.showInformationMessage('Open a file to insert code.'); return; }
		await editor.edit(b => b.replace(editor.selection, code));
	}

	private async applyCode(code: string, path?: string): Promise<void> {
		const ac = new AbortController();
		try {
			const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Applying code', cancellable: true }, (_p, token) => {
				token.onCancellationRequested(() => ac.abort());
				return applyCodeToFile(this.services, code, path, ac.signal);
			});
			if (!r.ok) { void vscode.window.showWarningMessage(r.message); }
		} catch (e) {
			void vscode.window.showWarningMessage(`Apply failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private searchChats(q: string): ContextItem[] {
		const needle = q.toLowerCase();
		return this.store.summaries()
			.filter((c: ChatSummary) => c.id !== this.store.activeChatId && c.title !== DEFAULT_TITLE && (!needle || c.title.toLowerCase().includes(needle)))
			.slice(0, 15)
			.map(c => ({ id: `chat:${c.id}`, kind: 'chat' as const, label: c.title, detail: new Date(c.updatedAt).toLocaleDateString() }));
	}

	private async chatSummaryText(chatId: string): Promise<string | undefined> {
		const sc = await this.store.get(chatId);
		if (!sc) { return undefined; }
		const lines: string[] = [];
		for (const m of sc.chat.messages) {
			if (m.role === 'user') { lines.push(`User: ${m.text}`); }
			else {
				const text = m.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n').trim();
				const edits = m.parts.filter((p): p is ToolPart => p.type === 'tool' && !!p.edit).map(p => p.edit!.path);
				if (text) { lines.push(`Assistant: ${text.length > 1500 ? text.slice(0, 1500) + '…' : text}`); }
				if (edits.length) { lines.push(`(edited: ${[...new Set(edits)].join(', ')})`); }
			}
		}
		const joined = lines.join('\n\n');
		return joined.length > 12000 ? joined.slice(0, 6000) + '\n[...]\n' + joined.slice(-6000) : joined;
	}

	private async addContextToChat(items: ContextItem[], opts: { newChat?: boolean } = {}): Promise<void> {
		await this.ready;
		await this.reveal();
		if (opts.newChat) { await this.newChat(); } else {
			const sc = await this.ensureActive();
			// Files and selections are for working chats; from Help they start one.
			if (sc.chat.mode === 'help') { await this.newChat(); } else { await this.activate(sc); }
		}
		for (const item of items) { this.post({ type: 'addContext', item }); }
		this.post({ type: 'focusInput' });
	}

	private registerCommands(): void {
		const reg = (id: string, fn: (...args: any[]) => unknown): void => {
			this.ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...args: any[]) => {
				try { return await fn(...args); } catch (e) { console.error(`[open-cursor] ${id} failed`, e); }
			}));
		};
		const editorSelection = (): ContextItem | undefined => {
			const ed = vscode.window.activeTextEditor;
			return ed ? selectionItem(ed) : undefined;
		};

		reg('openCursor.chat.open', async () => {
			const sel = editorSelection();
			await this.addContextToChat(sel ? [sel] : []);
		});
		reg('openCursor.help.open', async (text?: unknown) => {
			await this.ready;
			await this.reveal();
			await this.openHelp(typeof text === 'string' ? text : undefined);
		});
		reg('openCursor.help.leave', async () => {
			await this.reveal();
			await this.leaveHelp();
		});
		reg('openCursor.chat.newChat', async () => {
			await this.ready;
			await this.reveal();
			await this.newChat();
			this.post({ type: 'focusInput' });
		});
		// From the menu bar panel: a new chat that starts on the task straight away.
		reg('openCursor.chat.startTask', async (text?: unknown, mode?: unknown) => {
			if (typeof text !== 'string' || !text.trim()) { await vscode.commands.executeCommand('openCursor.chat.newChat'); return; }
			const m = typeof mode === 'string' && ['agent', 'plan', 'debug', 'ask'].includes(mode) ? mode as ChatMode : undefined;
			await this.submit({ text, newChat: true, mode: m });
		});
		reg('openCursor.chat.addSelectionToNewChat', async () => {
			const sel = editorSelection();
			await this.addContextToChat(sel ? [sel] : [], { newChat: true });
		});
		reg('openCursor.chat.toggle', () => vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar'));
		reg('openCursor.chat.history', async () => {
			await this.reveal();
			this.post({ type: 'showHistory' });
		});
		reg('openCursor.chat.stop', async () => {
			if (this.store.activeChatId) { await this.stop(this.store.activeChatId); }
		});
		reg('openCursor.chat.openSettings', () => this.openSettings());
		reg('openCursor.chat.addFileToChat', async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
			const uris = selected?.length ? selected : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
			const items: ContextItem[] = [];
			for (const u of uris) {
				let isDir = false;
				try { isDir = !!((await vscode.workspace.fs.stat(u)).type & vscode.FileType.Directory); } catch { /* treat as file */ }
				const rel = toDisplayPath(u);
				const base = nodePath.posix.basename(rel);
				const dir = nodePath.posix.dirname(rel);
				items.push({ id: `${isDir ? 'folder' : 'file'}:${u.toString()}`, kind: isDir ? 'folder' : 'file', label: isDir ? base + '/' : base, detail: dir === '.' ? undefined : dir, uri: u.toString() });
			}
			if (items.length) { await this.addContextToChat(items); }
		});
		reg('openCursor.chat.addTerminalSelection', async () => {
			let text = '';
			if (vscode.window.activeTerminal) {
				const prev = await vscode.env.clipboard.readText();
				await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
				const copied = await vscode.env.clipboard.readText();
				text = copied !== prev ? copied : '';
				await vscode.env.clipboard.writeText(prev);
			}
			if (!text) { text = this.contextEx.getLastTerminalOutput?.() ?? ''; }
			if (!text.trim()) { void vscode.window.showInformationMessage('Select text in the terminal first.'); return; }
			const first = text.split('\n').find(l => l.trim())?.trim().slice(0, 40) ?? 'output';
			await this.addContextToChat([{ id: newId('term'), kind: 'terminal', label: `Terminal: ${first}`, content: text.slice(-20000) }]);
		});
		reg('openCursor.chat.fixWithAgent', async (uriStr?: string, diags?: { line: number; character: number; message: string; source?: string }[]) => {
			const ed = vscode.window.activeTextEditor;
			let uri = uriStr ? vscode.Uri.parse(uriStr) : ed?.document.uri;
			let problems = diags ?? [];
			if (!problems.length && ed) {
				const here = vscode.languages.getDiagnostics(ed.document.uri).filter(d => d.range.contains(ed.selection.active) || d.range.start.line === ed.selection.active.line);
				problems = here.map(d => ({ line: d.range.start.line, character: d.range.start.character, message: d.message, source: d.source }));
			}
			if (!uri || !problems.length) { void vscode.window.showInformationMessage('No problem found at the cursor.'); return; }
			uri = uri as vscode.Uri;
			const rel = toDisplayPath(uri);
			const list = problems.map(p => `- ${rel}:${p.line + 1}:${p.character + 1} ${p.message}${p.source ? ` [${p.source}]` : ''}`).join('\n');
			const base = nodePath.posix.basename(rel);
			await this.submit({
				text: `Fix ${problems.length > 1 ? 'these problems' : 'this problem'}:\n${list}`,
				context: [{ id: `file:${uri.toString()}`, kind: 'file', label: base, detail: rel, uri: uri.toString() }],
				mode: 'agent',
			});
		});
		reg('openCursor.chat.explainSelection', async () => {
			const sel = editorSelection();
			if (!sel) { void vscode.window.showInformationMessage('Select some code to explain.'); return; }
			await this.submit({ text: 'Explain this code: what it does, how it works, and anything surprising.', context: [sel], mode: 'ask', newChat: true });
		});
	}
}
