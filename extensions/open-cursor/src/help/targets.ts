/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  The places Help can take the user. Every entry only opens or shows something; nothing here
 *  changes a setting, a file or the app. Pure, so the catalog and link parsing are unit tested.
 *--------------------------------------------------------------------------------------------*/

export interface HelpAction {
	readonly target: HelpTargetId;
	readonly arg?: string;
}

export type HelpTargetId =
	| 'free-models' | 'settings' | 'editor-settings' | 'shortcuts' | 'color-theme' | 'icon-theme'
	| 'command-palette' | 'extensions' | 'view' | 'mcp-config' | 'connect' | 'new-chat' | 'past-chats'
	| 'import' | 'open-folder' | 'report-issue' | 'report-problem';

export interface HelpTarget {
	readonly id: HelpTargetId;
	/** What the button says, before the argument is taken into account. */
	readonly label: string;
	/** One line for the model: what it opens and what the argument means. */
	readonly use: string;
	/** Allowed values for the argument, when it is a fixed list. */
	readonly args?: readonly string[];
	/**
	 * Opens beside the help chat (an editor tab, a picker, a side view), so Help may open it on its own.
	 * The others move the chat panel away from the conversation, so they only run when the user clicks.
	 */
	readonly inPlace: boolean;
}

export const SETTINGS_SECTIONS = ['general', 'models', 'subscriptions', 'tab', 'rules', 'commands', 'mcp', 'indexing'] as const;
const SECTION_LABEL: Record<string, string> = {
	general: 'General', models: 'Models', subscriptions: 'Subscriptions', tab: 'Tab', rules: 'Rules', commands: 'Commands', mcp: 'Tools and MCP', indexing: 'Indexing',
};

export const VIEWS = ['explorer', 'search', 'source-control', 'run', 'extensions', 'terminal', 'problems', 'output'] as const;
const VIEW_LABEL: Record<string, string> = {
	explorer: 'Explorer', search: 'Search', 'source-control': 'Source Control', run: 'Run and Debug', extensions: 'Extensions', terminal: 'Terminal', problems: 'Problems', output: 'Output',
};

export const HELP_TARGETS: readonly HelpTarget[] = [
	{ id: 'free-models', label: 'Free models', use: 'The Free models page: install OpenCode in one click, connect free API keys, use Free (auto).', inPlace: true },
	{ id: 'settings', label: 'OpenCursor settings', use: 'OpenCursor settings at a section.', args: SETTINGS_SECTIONS, inPlace: true },
	{ id: 'editor-settings', label: 'Editor settings', use: 'The editor\'s settings, filtered by the argument (a setting id like editor.fontSize or a few words like "font size").', inPlace: true },
	{ id: 'shortcuts', label: 'Keyboard shortcuts', use: 'The keyboard shortcuts editor, filtered by the argument (a command name or a key).', inPlace: true },
	{ id: 'color-theme', label: 'Color themes', use: 'The color theme picker. The user previews and picks one.', inPlace: true },
	{ id: 'icon-theme', label: 'File icon themes', use: 'The file icon theme picker.', inPlace: true },
	{ id: 'command-palette', label: 'Command palette', use: 'The command palette, prefilled with the argument so the matching commands are listed.', inPlace: true },
	{ id: 'extensions', label: 'Extensions', use: 'The Extensions view, searching for the argument.', inPlace: true },
	{ id: 'view', label: 'View', use: 'Shows a part of the window.', args: VIEWS, inPlace: true },
	{ id: 'mcp-config', label: 'MCP config', use: 'Opens mcp.json for the user to edit: "user" (every project) or "workspace" (this project).', args: ['user', 'workspace'], inPlace: true },
	{ id: 'connect', label: 'Connect a model', use: 'A new chat with the connect panel open (subscriptions, local models, API keys). Best for first time setup.', inPlace: false },
	{ id: 'new-chat', label: 'Start a chat', use: 'A new normal chat with the argument typed into the box, not sent. Use it to hand a coding task over to the agent.', inPlace: false },
	{ id: 'past-chats', label: 'Past chats', use: 'The list of earlier chats, with search.', inPlace: false },
	{ id: 'import', label: 'Import from Cursor or VS Code', use: 'Starts the import of settings, keybindings and extensions. It asks the user before doing anything.', inPlace: false },
	{ id: 'open-folder', label: 'Open a folder', use: 'The system dialog to open a project folder.', inPlace: false },
	{ id: 'report-problem', label: 'Report a problem', use: 'The Report a Problem form: the user describes what went wrong and sends it to the developer with a few app details. No account needed. Prefer this over GitHub.', inPlace: false },
	{ id: 'report-issue', label: 'Report on GitHub', use: 'A new GitHub issue in the browser, filled in with what the user wrote in this chat and the app details. The argument is a short issue title. The user reads it and submits it.', inPlace: false },
];

const BY_ID = new Map(HELP_TARGETS.map(t => [t.id, t]));

export function helpTarget(id: string): HelpTarget | undefined {
	return BY_ID.get(id as HelpTargetId);
}

/** Checks a model supplied action against the catalog; undefined when it names nothing we know. */
export function validateAction(target: unknown, arg?: unknown): HelpAction | undefined {
	if (typeof target !== 'string') { return undefined; }
	const t = helpTarget(target.trim().toLowerCase());
	if (!t) { return undefined; }
	let a = typeof arg === 'string' ? arg.trim().slice(0, 200) : undefined;
	if (t.args) {
		a = a?.toLowerCase().replace(/\s+/g, '-');
		if (t.id === 'settings' && a && !t.args.includes(a)) {
			// tolerate the visible names: "tools and mcp", "api keys"
			a = a === 'tools-and-mcp' || a === 'tools' ? 'mcp' : a === 'api-keys' || a === 'keys' ? 'models' : a;
		}
		if (a && !t.args.includes(a)) { a = undefined; }
		if (!a && t.id === 'view') { return undefined; }
	}
	return a ? { target: t.id, arg: a } : { target: t.id };
}

export const LINK_SCHEME = 'opencursor:';

/** `opencursor:settings/models`, `opencursor:editor-settings?font%20size` or `opencursor:color-theme`. */
export function parseHelpLink(href: string): HelpAction | undefined {
	const h = href.trim();
	if (!h.toLowerCase().startsWith(LINK_SCHEME)) { return undefined; }
	const rest = h.slice(LINK_SCHEME.length).replace(/^\/\//, '');
	const m = /^([a-z-]+)(?:[/?](.*))?$/i.exec(rest);
	if (!m) { return undefined; }
	let arg: string | undefined;
	if (m[2] !== undefined) {
		try { arg = decodeURIComponent(m[2].replace(/\+/g, ' ')); } catch { arg = m[2]; }
		arg = arg.replace(/^(q|query|section|arg)=/i, '');
	}
	return validateAction(m[1], arg);
}

export function formatHelpLink(a: HelpAction): string {
	return LINK_SCHEME + a.target + (a.arg ? '/' + encodeURIComponent(a.arg) : '');
}

/** Short past tense line for the tool row and the button. */
export function actionLabel(a: HelpAction): string {
	const t = helpTarget(a.target);
	if (!t) { return a.target; }
	switch (a.target) {
		case 'settings': return a.arg ? `Settings: ${SECTION_LABEL[a.arg] ?? a.arg}` : 'OpenCursor settings';
		case 'view': return VIEW_LABEL[a.arg ?? ''] ?? 'View';
		case 'editor-settings': return a.arg ? `Settings: ${a.arg}` : 'Editor settings';
		case 'shortcuts': return a.arg ? `Shortcuts: ${a.arg}` : 'Keyboard shortcuts';
		case 'extensions': return a.arg ? `Extensions: ${a.arg}` : 'Extensions';
		case 'command-palette': return a.arg ? `Commands: ${a.arg}` : 'Command palette';
		case 'mcp-config': return a.arg === 'workspace' ? 'Project MCP config' : 'MCP config';
		default: return t.label;
	}
}

/** Arguments that start an install: only a click on a link may carry them, never an automatic open. */
export function stripAutoOpenArg(a: HelpAction): HelpAction {
	return a.target === 'free-models' && a.arg === 'install' ? { target: a.target } : a;
}

/** The first link in a reply that may open on its own, for agents that answer in text only. */
export function firstInPlaceLink(text: string): HelpAction | undefined {
	const re = /\]\((opencursor:[^)\s]+)\)/gi;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const a = parseHelpLink(m[1]);
		if (a && helpTarget(a.target)?.inPlace) { return stripAutoOpenArg(a); }
	}
	return undefined;
}

/** The catalog as the model reads it. */
export function describeTargets(): string {
	return HELP_TARGETS.map(t => `- ${t.id}${t.args ? ` (argument: ${t.args.join(' | ')})` : ''}: ${t.use}`).join('\n');
}
