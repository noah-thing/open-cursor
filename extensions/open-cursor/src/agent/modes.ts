/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  What each chat mode may do, and what must hold before a turn can end. Pure.
 *--------------------------------------------------------------------------------------------*/

import type { ChatMode, TodoItem } from '../shared/protocol';

/** Every temporary line Debug mode adds carries this literal, so it can be found and proven gone. */
export const DEBUG_MARKER = 'OC-DEBUG';

export function isReadOnlyMode(mode: ChatMode): boolean {
	return mode === 'ask' || mode === 'plan' || mode === 'help';
}

interface Parsed { segments: string[][] }

/**
 * Quote-aware split of a command line into segments of words. Returns an error string for anything
 * that could write or run something we cannot see: output redirection, command substitution,
 * subshells, here-docs, process substitution, env assignments.
 */
function parseCommand(cmd: string): Parsed | string {
	const segments: string[][] = [];
	let cur: string[] = [];
	let word = '';
	let has = false;
	let quote: '"' | '\'' | undefined;
	const endWord = (): void => { if (has) { cur.push(word); } word = ''; has = false; };
	const endSegment = (): void => { endWord(); if (cur.length) { segments.push(cur); } cur = []; };
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (quote === '\'') {
			if (c === '\'') { quote = undefined; } else { word += c; }
			continue;
		}
		if (c === '\\') { word += cmd[i + 1] ?? ''; has = true; i++; continue; }
		if (c === '`' || (c === '$' && cmd[i + 1] === '(')) { return 'command substitution'; }
		if (quote === '"') {
			if (c === '"') { quote = undefined; } else { word += c; }
			continue;
		}
		if (c === '\'' || c === '"') { quote = c; has = true; continue; }
		if (c === '>' || c === '<') {
			if (c === '>' && (cmd[i + 1] === '(')) { return 'process substitution'; }
			const m = c === '>' ? /^>(?:&\d+|\s*\/dev\/null(?![\w/.-]))/.exec(cmd.slice(i)) : null;
			if (!m) { return c === '>' ? 'output redirection' : 'input redirection or here-doc'; }
			// `2>&1`, `>/dev/null`, `&>/dev/null`: drop the fd digit or ampersand that was read as a word
			if (/^(?:\d+|&)$/.test(word)) { word = ''; has = false; }
			i += m[0].length - 1;
			continue;
		}
		if (c === '(' || c === ')') { return 'subshell'; }
		if (c === ';' || c === '|' || c === '&' || c === '\n') {
			// `&>` and `&>>` were handled as redirections above only when preceded by a word; a lone `&` backgrounds
			if (c === '&' && cmd[i + 1] === '>') { const m = /^&>\s*\/dev\/null(?![\w/.-])/.exec(cmd.slice(i)); if (m) { i += m[0].length - 1; continue; } return 'output redirection'; }
			endSegment();
			continue;
		}
		if (c === ' ' || c === '\t') { endWord(); continue; }
		word += c; has = true;
	}
	if (quote) { return 'unterminated quote'; }
	endSegment();
	return { segments };
}

const SIMPLE_READ_COMMANDS = new Set([
	'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'which', 'whoami', 'tree', 'grep', 'egrep', 'fgrep', 'rg', 'file', 'stat', 'du', 'df',
	'basename', 'dirname', 'realpath', 'readlink', 'cut', 'tr', 'nl', 'diff', 'cmp', 'jq', 'column', 'fold', 'uname', 'true', 'false', 'cd', 'type', 'id',
	'sort', 'date', 'hostname', 'nproc', 'md5sum', 'shasum', 'sha256sum',
]);

const GIT_READ_SUBCOMMANDS = new Set([
	'status', 'diff', 'log', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'blame', 'shortlog', 'describe', 'grep', 'cat-file', 'merge-base',
	'name-rev', 'diff-tree', 'diff-index', 'for-each-ref', 'count-objects', 'whatchanged', 'show-ref', 'check-ignore', 'blame',
]);

/** Flags that make an otherwise harmless command write a file or run a program. */
const DANGEROUS_FLAG = /^(?:--output(?:=.*)?|--ext-diff|--pre(?:=.*)?|--pre-glob(?:=.*)?|--hostname-bin(?:=.*)?|--open-files-in-pager(?:=.*)?|-O.*|--exec|--in-place)$/;

function flagIn(args: string[], flags: string[]): boolean {
	return args.some(a => flags.some(f => a === f || a.startsWith(f + '=')));
}

function onlyFlags(args: string[], allowed: string[]): boolean {
	return args.every(a => !a.startsWith('-') || allowed.some(f => a === f || a.startsWith(f + '=')));
}

function gitSegmentOk(args: string[]): string | undefined {
	// drop `-C <dir>` and `--no-pager`; any other global option (`-c k=v` can name a program) is refused
	let i = 0;
	while (i < args.length) {
		if (args[i] === '-C' && args[i + 1] !== undefined) { i += 2; } else if (args[i] === '--no-pager') { i++; } else { break; }
	}
	const sub = args[i];
	const rest = args.slice(i + 1);
	if (!sub) { return undefined; }
	if (sub.startsWith('-')) { return `git option ${sub}`; }
	if (rest.some(a => DANGEROUS_FLAG.test(a))) { return `git ${sub} with a flag that can write a file or run a program`; }
	if (GIT_READ_SUBCOMMANDS.has(sub)) { return undefined; }
	const listish = ['--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];
	switch (sub) {
		case 'branch':
			if (!onlyFlags(rest, ['-a', '-r', '-v', '-vv', '--all', '--remotes', '--verbose', '--show-current', '--sort', '--format', '--column', '--no-column', ...listish])) { return 'git branch that changes branches'; }
			if (rest.some(a => !a.startsWith('-')) && !flagIn(rest, listish)) { return 'git branch that creates a branch'; }
			return undefined;
		case 'tag':
			if (!onlyFlags(rest, ['-l', '-n', '-i', '--sort', '--format', '--column', '--no-column', ...listish])) { return 'git tag that changes tags'; }
			if (rest.some(a => !a.startsWith('-')) && !flagIn(rest, ['-l', ...listish])) { return 'git tag that creates a tag'; }
			return undefined;
		case 'remote':
			if (rest.length === 0 || (rest.length === 1 && (rest[0] === '-v' || rest[0] === '--verbose')) || rest[0] === 'get-url' || rest[0] === 'show') { return undefined; }
			return 'git remote that changes remotes';
		case 'config':
			return flagIn(rest, ['--get', '--get-all', '--list', '-l', '--get-regexp']) ? undefined : 'git config that writes';
		case 'stash':
			return rest[0] === 'list' || rest[0] === 'show' ? undefined : 'git stash that changes the stash';
		case 'worktree':
			return rest[0] === 'list' ? undefined : 'git worktree that changes worktrees';
		case 'reflog':
			return rest.length === 0 || rest[0] === 'show' || rest[0].startsWith('-') ? undefined : 'git reflog that rewrites the reflog';
		default:
			return `git ${sub}`;
	}
}

function segmentProblem(words: string[]): string | undefined {
	const [cmd, ...args] = words;
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) { return 'an environment assignment before the command'; }
	if (cmd === 'git') { return gitSegmentOk(args); }
	if (SIMPLE_READ_COMMANDS.has(cmd)) {
		if (args.some(a => DANGEROUS_FLAG.test(a))) { return `${cmd} with a flag that can write a file or run a program`; }
		if (cmd === 'sort' && args.some(a => /^-[a-zA-Z]*o/.test(a) && !a.startsWith('--'))) { return 'sort -o'; }
		if (cmd === 'tree' && args.some(a => /^-[a-zA-Z]*o/.test(a) && !a.startsWith('--'))) { return 'tree -o'; }
		if (cmd === 'date' && args.some(a => a === '-s' || a === '--set' || a.startsWith('--set='))) { return 'date -s'; }
		if (cmd === 'hostname' && args.length > 0) { return 'hostname with arguments'; }
		return undefined;
	}
	switch (cmd) {
		case 'find':
			return args.some(a => ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(a)) ? 'find with -exec/-delete/-fprint' : undefined;
		case 'sed': {
			// only the `sed -n '10,40p' file` idiom for reading a line range
			const flags = args.filter(a => a.startsWith('-'));
			const script = args.find(a => !a.startsWith('-'));
			if (!flags.includes('-n') || flags.some(f => f !== '-n' && f !== '-E') || !script || !/^(?:\d+|\$)(?:,(?:\d+|\$|\+\d+))?p$/.test(script)) { return 'sed other than `sed -n \'N,Mp\' file`'; }
			return undefined;
		}
		case 'npm':
			return ['ls', 'list', 'outdated', 'view', 'info', 'explain', 'why', '--version', '-v'].includes(args[0]) ? undefined : `npm ${args[0] ?? ''}`.trim();
		case 'pnpm':
			return ['ls', 'list', 'outdated', 'why', '--version', '-v'].includes(args[0]) ? undefined : `pnpm ${args[0] ?? ''}`.trim();
		case 'yarn':
			return ['list', 'why', 'info', '--version', '-v'].includes(args[0]) ? undefined : `yarn ${args[0] ?? ''}`.trim();
		case 'node': case 'python': case 'python3': case 'ruby': case 'java':
			return args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-version') ? undefined : `${cmd} running code`;
		case 'cargo':
			return ['tree', 'metadata', '--version', 'locate-project'].includes(args[0]) ? undefined : `cargo ${args[0] ?? ''}`.trim();
		case 'go':
			return (args[0] === 'list' || args[0] === 'version' || (args[0] === 'env' && !flagIn(args, ['-w', '-u']))) ? undefined : `go ${args[0] ?? ''}`.trim();
		default:
			return cmd;
	}
}

export type ReadOnlyCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Strict allowlist for the shell in Plan and Ask: inspection commands only. Anything that could
 * write, install, build, start a process or reach the network is refused, as is any construct
 * (redirects, substitutions, subshells) that hides what runs.
 */
export function isReadOnlyCommand(command: string): ReadOnlyCheck {
	const parsed = parseCommand(command);
	if (typeof parsed === 'string') { return { ok: false, reason: `it uses ${parsed}` }; }
	if (parsed.segments.length === 0) { return { ok: false, reason: 'it is empty' }; }
	for (const words of parsed.segments) {
		const problem = segmentProblem(words);
		if (problem) { return { ok: false, reason: `\`${problem}\` is not on the read-only list` }; }
	}
	return { ok: true };
}

export interface ToolLike { readonly name: string; readonly readOnly: boolean }

/** Why `tool` may not run in `mode`, or undefined when it may. The loop re-checks every call with this. */
export function toolBlockedReason(mode: ChatMode, tool: ToolLike, args: Record<string, unknown>): string | undefined {
	if (!isReadOnlyMode(mode)) { return undefined; }
	if (mode === 'help') { return tool.name === 'open_in_app' ? undefined : 'Help only explains the app and opens places in it; it has no workspace tools.'; }
	const label = mode === 'plan' ? 'Plan' : 'Ask';
	if (tool.name === 'run_terminal_cmd') {
		if (args.is_background === true) { return `${label} mode is read-only: background processes are not allowed.`; }
		const command = typeof args.command === 'string' ? args.command : '';
		const check = isReadOnlyCommand(command);
		return check.ok ? undefined : `${label} mode is read-only and only runs inspection commands, but ${check.reason}. Use read_file, grep, glob_file_search or list_dir, or tell the user to switch to Agent mode to run this.`;
	}
	if (mode === 'ask' && tool.name === 'todo_write') { return 'Ask mode does not keep a todo list.'; }
	if (!tool.readOnly) { return `${tool.name} changes the workspace and is not available in ${label} mode (read-only). Tell the user to switch to Agent mode for changes.`; }
	return undefined;
}

/** Marker hits as `path:line` (counted from 1). Pure text scan. */
export function findMarkerLines(text: string, marker = DEBUG_MARKER): number[] {
	const out: number[] = [];
	text.split('\n').forEach((l, i) => { if (l.includes(marker)) { out.push(i + 1); } });
	return out;
}

export interface TurnState {
	readonly mode: ChatMode;
	readonly toolNames: ReadonlySet<string>;
	/** Files successfully changed by edit_file / write_file this turn. */
	readonly edited: ReadonlySet<string>;
	readonly lintsRun: boolean;
	readonly todoWritten: boolean;
	readonly todos: readonly TodoItem[];
	readonly finalText: string;
	/** Reminders already sent this turn, by key. */
	readonly sent: ReadonlySet<string>;
}

export interface Reminder { readonly key: string; readonly text: string }

export function openTodos(todos: readonly TodoItem[]): TodoItem[] {
	return todos.filter(t => t.status === 'pending' || t.status === 'in_progress');
}

/**
 * Reminders that must be answered before the turn may end, other than Debug cleanup (which needs
 * file reads and lives in the loop). Each key fires at most once per turn.
 */
export function turnEndReminders(s: TurnState): Reminder[] {
	const out: Reminder[] = [];
	const once = (key: string, text: string): void => { if (!s.sent.has(key)) { out.push({ key, text }); } };
	if ((s.mode === 'agent' || s.mode === 'debug') && s.edited.size > 0) {
		if (!s.lintsRun && s.toolNames.has('read_lints')) {
			once('lints', `You changed ${[...s.edited].slice(0, 6).join(', ')}${s.edited.size > 6 ? ' and more' : ''} but did not run read_lints. Run read_lints on those files now (and the project's typecheck or test command if one exists and is quick), fix anything you broke, then finish.`);
		}
		const open = openTodos(s.todos);
		if (open.length) {
			once('todos', `Your todo list still has open items:\n${open.map(t => `- [${t.status}] ${t.content}`).join('\n')}\nFinish them, or mark each completed or cancelled with todo_write, before you give the final summary.`);
		}
	}
	if (s.mode === 'plan' && !s.todoWritten && s.toolNames.has('todo_write') && s.finalText.trim().length > 500 && openTodos(s.todos).length === 0) {
		once('plan-todos', 'Your plan has no todo list yet. Call todo_write now with merge false: one todo per numbered step of the plan, in order, all pending, so Build can follow them. Then reply with one short line, without repeating the plan.');
	}
	return out;
}

export interface MarkerHit { readonly path: string; readonly line: number }

/** The reminder sent when Debug mode tries to finish with instrumentation still in the code. */
export function cleanupReminder(hits: readonly MarkerHit[], attempt: number): string {
	const shown = hits.slice(0, 30).map(h => `- ${h.path}:${h.line}`).join('\n');
	const more = hits.length > 30 ? `\n(and ${hits.length - 30} more)` : '';
	return `You cannot finish yet: ${hits.length} temporary ${DEBUG_MARKER} line${hits.length === 1 ? ' is' : 's are'} still in the code you edited:\n${shown}${more}\nRemove every one (edit_file; delete any helper file you created only for debugging), then run grep for "${DEBUG_MARKER}" on each of those files to prove none remain, and re-run the reproduction once more to confirm the fix still holds.${attempt >= 2 ? ' This is the last reminder; the user will be told if instrumentation is left behind.' : ''} Do not repeat your earlier summary.`;
}

export function formatTodoState(todos: readonly TodoItem[], mode: ChatMode): string {
	const mark = (t: TodoItem): string => t.status === 'completed' ? 'x' : t.status === 'cancelled' ? '-' : t.status === 'in_progress' ? '~' : ' ';
	const lines = todos.map(t => `- [${mark(t)}] ${t.id}. ${t.content}`).join('\n');
	const how = mode === 'plan'
		? 'If the user is refining this plan, update it and the todo list (todo_write, merge false). If the request is unrelated, replace it.'
		: 'If the user is asking you to build or continue this work, follow it in order: start at the first open item, keep the list current with todo_write (merge true) and do not rewrite it from scratch. If the request is unrelated, ignore it or replace it.';
	return `<todo_state>\nOpen todo list for this chat ([x] done, [~] in progress, [ ] pending, [-] cancelled):\n${lines}\n${how}\n</todo_state>`;
}
