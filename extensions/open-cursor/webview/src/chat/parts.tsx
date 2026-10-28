/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Pieces of an assistant turn: thinking, tool rows, edit rows, approval and error cards.
 *--------------------------------------------------------------------------------------------*/

import { memo, useState, type ReactElement, type ReactNode } from 'react';
import type { ContextItem, MessagePart, ToolPart } from '../../../src/shared/protocol';
import { Icon, Spinner, type IconName } from '../common/icons';
import { Markdown } from './markdown';
import { post } from './host';
import { HelpJumpRow } from './help';
import { KIND_ICON, basename, dirname, formatDuration } from './util';

export function ContextPill({ item, onRemove, suggested, onClick }: {
	readonly item: ContextItem;
	readonly onRemove?: () => void;
	readonly suggested?: boolean;
	readonly onClick?: () => void;
}): ReactElement {
	const isImage = item.kind === 'image' && !!item.content && item.content.startsWith('data:');
	const open = (): void => {
		if (onClick) { onClick(); return; }
		if (item.uri) { post({ type: 'openFile', uri: item.uri, range: item.range }); }
	};
	return (
		<span
			className={'oc-pill' + (suggested ? ' is-suggested' : '') + (isImage ? ' has-thumb' : '')}
			title={item.detail ? item.label + '  ' + item.detail : item.label}
		>
			<button type="button" className="oc-pill-main" onClick={open} tabIndex={item.uri || onClick ? 0 : -1}>
				{isImage ? <img className="oc-pill-thumb" src={item.content} alt="" /> : <Icon name={KIND_ICON[item.kind]} size={12} />}
				<span className="oc-pill-label">{item.label}</span>
			</button>
			{onRemove ? (
				<button type="button" className="oc-pill-x" aria-label={'Remove ' + item.label} onClick={onRemove}>
					<Icon name="x" size={10} />
				</button>
			) : null}
		</span>
	);
}

function InlineCode({ text }: { readonly text: string }): ReactElement {
	const bits = text.split(/(`[^`]+`)/g);
	return (
		<>
			{bits.map((b, i) => (b.startsWith('`') && b.endsWith('`') && b.length > 2 ? <code key={i}>{b.slice(1, -1)}</code> : <span key={i}>{b}</span>))}
		</>
	);
}

function Chevron({ open }: { readonly open: boolean }): ReactElement {
	return <Icon name="chevronRight" size={12} className={'oc-chev' + (open ? ' is-open' : '')} />;
}

/** The sentence being thought right now, without markdown marks. */
function lastLine(text: string): { text: string; n: number } {
	const lines = text.replace(/[*_`#>]/g, '').split(/\n+/).map(l => l.trim()).filter(Boolean);
	const last = lines[lines.length - 1] ?? '';
	const sentences = last.split(/(?<=[.!?])\s+/);
	const line = sentences[sentences.length - 1].length > 12 ? sentences[sentences.length - 1] : last;
	// `n` counts sentences so far: the line slides in once per new sentence, not once per streamed word.
	return { text: line.length > 110 ? '…' + line.slice(-110) : line, n: lines.length * 1000 + sentences.length };
}

export const Thinking = memo(function Thinking({ part, show }: { readonly part: Extract<MessagePart, { type: 'thinking' }>; readonly show: boolean }): ReactElement {
	const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined);
	const canOpen = show && part.text.trim().length > 0;
	const open = canOpen && (userOpen ?? false);
	const secs = formatDuration(part.durationMs);
	// While it thinks, the newest line of thought drifts past under the title, so the wait reads as work.
	const live = !part.done && show && !open ? lastLine(part.text) : undefined;
	return (
		<div className={'oc-thinking' + (part.done ? '' : ' is-live')}>
			<button type="button" className="oc-row-head" disabled={!canOpen} onClick={() => setUserOpen(!open)} aria-expanded={open}>
				<Icon name="brain" size={14} className="oc-row-icon" />
				<span className={'oc-row-title' + (part.done ? '' : ' is-shimmer')}>
					{part.done ? (secs ? 'Thought for ' + secs : 'Thought') : 'Thinking'}
				</span>
				{canOpen ? <Chevron open={open} /> : null}
			</button>
			{live?.text ? <div className="oc-think-live"><span key={live.n}>{live.text}</span></div> : null}
			{open ? (
				<div className="oc-thinking-body">
					<Markdown text={part.text} />
				</div>
			) : null}
		</div>
	);
});

export function toolIcon(name: string): IconName {
	if (name === 'read_file') { return 'file'; }
	if (name === 'list_dir') { return 'folder'; }
	if (name === 'glob_file_search' || name === 'grep' || name === 'codebase_search') { return 'search'; }
	if (name === 'edit_file' || name === 'write_file') { return 'pencil'; }
	if (name === 'delete_file') { return 'trash'; }
	if (name === 'run_terminal_cmd') { return 'terminal'; }
	if (name === 'read_lints') { return 'warning'; }
	if (name === 'todo_write') { return 'todos'; }
	if (name === 'fetch_url' || name === 'web_search') { return 'globe'; }
	if (name.startsWith('mcp_')) { return 'plug'; }
	return 'tool';
}

const EXPLORE = new Set(['read_file', 'list_dir', 'glob_file_search', 'grep', 'codebase_search', 'read_lints', 'fetch_url', 'web_search']);

export function isExploreTool(p: MessagePart): boolean {
	return p.type === 'tool' && EXPLORE.has(p.name) && !p.command;
}

function isActive(status: ToolPart['status']): boolean {
	return status === 'streaming' || status === 'running';
}

function StatusTail({ part }: { readonly part: ToolPart }): ReactElement | null {
	switch (part.status) {
		case 'streaming':
		case 'running':
			return <Spinner size={12} />;
		case 'error':
			return <span className="oc-tail is-error">Failed</span>;
		case 'rejected':
			return <span className="oc-tail">Skipped</span>;
		case 'cancelled':
			return <span className="oc-tail">Stopped</span>;
		case 'awaiting-approval':
			return <span className="oc-tail is-wait">Waiting</span>;
		default: {
			const d = formatDuration(part.durationMs);
			return d && part.durationMs! > 1500 ? <span className="oc-tail">{d}</span> : null;
		}
	}
}

function splitTitle(title: string): { verb: string; rest: string } {
	const i = title.indexOf(' ');
	return i < 0 ? { verb: title, rest: '' } : { verb: title.slice(0, i), rest: title.slice(i + 1) };
}

const EditRow = memo(function EditRow({ part }: { readonly part: ToolPart }): ReactElement {
	const e = part.edit!;
	const dir = dirname(e.path);
	const active = isActive(part.status);
	const dead = part.status === 'rejected' || part.status === 'cancelled' || part.status === 'error';
	return (
		<div className={'oc-tool is-edit' + (dead ? ' is-dead' : '')} data-status={part.status}>
			<button type="button" className="oc-row-head" onClick={() => post({ type: 'openDiff', uri: e.uri })} title={'Open diff for ' + e.path}>
				<Icon name={e.deleted ? 'trash' : e.isNew ? 'plus' : 'pencil'} size={14} className="oc-row-icon" />
				<span className={'oc-edit-name' + (active ? ' is-shimmer' : '')}>{basename(e.path)}</span>
				{dir ? <span className="oc-edit-dir">{dir}</span> : null}
				<span className="oc-spacer" />
				{e.isNew ? <span className="oc-badge">New</span> : null}
				{e.deleted ? <span className="oc-badge">Deleted</span> : null}
				{e.added > 0 ? <span key={'a' + e.added} className="oc-added oc-tick">+{e.added}</span> : null}
				{e.removed > 0 ? <span key={'r' + e.removed} className="oc-removed oc-tick">&minus;{e.removed}</span> : null}
				<StatusTail part={part} />
			</button>
		</div>
	);
});

const ToolRow = memo(function ToolRow({ part }: { readonly part: ToolPart }): ReactElement {
	const hasBody = !!part.output && part.output.trim().length > 0;
	const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined);
	const autoOpen = part.status === 'running' && hasBody;
	const open = hasBody && (userOpen ?? autoOpen);
	const { verb, rest } = splitTitle(part.title);
	const active = isActive(part.status);
	const dead = part.status === 'rejected' || part.status === 'cancelled';
	return (
		<div className={'oc-tool' + (dead ? ' is-dead' : '') + (part.status === 'error' ? ' is-err' : '')} data-status={part.status}>
			<button type="button" className="oc-row-head" disabled={!hasBody} onClick={() => setUserOpen(!open)} aria-expanded={open}>
				<Icon name={toolIcon(part.name)} size={14} className="oc-row-icon" />
				<span className={'oc-row-title' + (active ? ' is-shimmer' : '')}>
					<span className="oc-verb">{verb}</span>
					{rest ? <span className="oc-rest"> <InlineCode text={rest} /></span> : null}
				</span>
				<span className="oc-spacer" />
				<StatusTail part={part} />
				{hasBody ? <Chevron open={open} /> : null}
			</button>
			{open ? <pre className="oc-tool-out">{part.output!.length > 6000 ? part.output!.slice(-6000) : part.output}</pre> : null}
		</div>
	);
});

const ApprovalCard = memo(function ApprovalCard({ part, chatId }: { readonly part: ToolPart; readonly chatId: string }): ReactElement {
	const cmd = part.command;
	const decide = (decision: 'run' | 'skip' | 'allowAlways'): void => post({ type: 'approveTool', chatId, toolCallId: part.id, decision });
	return (
		<div className="oc-approval" role="group" aria-label="Command awaiting approval">
			<div className="oc-approval-head">
				<Icon name={cmd ? 'terminal' : toolIcon(part.name)} size={14} className="oc-row-icon" />
				<span className="oc-approval-title">{cmd ? 'Run command' : part.title}</span>
				<span className="oc-spacer" />
				<span className="oc-tail is-wait">Waiting for approval</span>
			</div>
			{cmd ? (
				<pre className="oc-approval-cmd"><span className="oc-prompt">$ </span>{cmd.text}</pre>
			) : null}
			{cmd?.cwd ? <div className="oc-approval-cwd">in {cmd.cwd}{cmd.background ? ' (background)' : ''}</div> : null}
			<div className="oc-approval-actions">
				<button type="button" className="oc-btn is-primary" onClick={() => decide('run')}>Run</button>
				<button type="button" className="oc-btn" onClick={() => decide('skip')}>Skip</button>
				<span className="oc-spacer" />
				<button type="button" className="oc-linkbtn" onClick={() => decide('allowAlways')} title="Always allow commands like this one">
					Allow always
				</button>
			</div>
		</div>
	);
});

export const ErrorCard = memo(function ErrorCard({ message, action, switchTo, fix, onRetry, onSwitch }: {
	readonly message: string;
	readonly action?: 'openSettings' | 'retry';
	readonly switchTo?: { readonly id: string; readonly label: string };
	readonly fix?: Extract<MessagePart, { type: 'error' }>['fix'];
	readonly onRetry?: () => void;
	readonly onSwitch?: (id: string) => void;
}): ReactElement {
	const [switched, setSwitched] = useState(false);
	return (
		<div className="oc-error" role="alert">
			<Icon name="warning" size={14} className="oc-error-icon" />
			<div className="oc-error-main">
				<div className="oc-error-text">{message}</div>
				{action || switchTo || fix ? (
					<div className="oc-error-actions">
						{switchTo && onSwitch ? (
							<button type="button" className="oc-btn is-primary" disabled={switched} onClick={() => { setSwitched(true); onSwitch(switchTo.id); }}>
								Use {switchTo.label} and retry
							</button>
						) : null}
						{fix?.kind === 'signIn' ? (
							<button type="button" className="oc-btn" onClick={() => post({ type: 'agentAction', id: fix.agentId, action: 'signIn' })}>Sign in to {fix.label}</button>
						) : fix?.kind === 'addKey' ? (
							<button type="button" className="oc-btn" onClick={() => post({ type: 'openSettings', section: 'models' })}>Add an API key</button>
						) : action === 'retry' ? (
							<button type="button" className="oc-btn" onClick={onRetry}>Try again</button>
						) : action === 'openSettings' ? (
							<button type="button" className="oc-btn" onClick={() => post({ type: 'openSettings', section: 'models' })}>Open settings</button>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	);
});

export const ToolPartView = memo(function ToolPartView({ part, chatId }: { readonly part: ToolPart; readonly chatId: string }): ReactElement {
	if (part.status === 'awaiting-approval') { return <ApprovalCard part={part} chatId={chatId} />; }
	if (part.edit) { return <EditRow part={part} />; }
	if (part.name === 'open_in_app') { return <HelpJumpRow part={part} />; }
	return <ToolRow part={part} />;
});

function exploreSummary(tools: readonly ToolPart[]): string {
	let reads = 0;
	let searches = 0;
	let lists = 0;
	let other = 0;
	for (const t of tools) {
		if (t.name === 'read_file') { reads++; }
		else if (t.name === 'grep' || t.name === 'codebase_search' || t.name === 'glob_file_search') { searches++; }
		else if (t.name === 'list_dir') { lists++; }
		else { other++; }
	}
	const bits: string[] = [];
	if (reads) { bits.push(reads + (reads === 1 ? ' file' : ' files')); }
	if (searches) { bits.push(searches + (searches === 1 ? ' search' : ' searches')); }
	if (lists) { bits.push(lists + (lists === 1 ? ' folder' : ' folders')); }
	if (other) { bits.push(other + (other === 1 ? ' lookup' : ' lookups')); }
	return bits.join(', ');
}

export const ExploreGroup = memo(function ExploreGroup({ tools, chatId }: { readonly tools: readonly ToolPart[]; readonly chatId: string }): ReactElement {
	const running = tools.some(t => isActive(t.status));
	const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined);
	const open = userOpen ?? running;
	return (
		<div className="oc-group">
			<button type="button" className="oc-row-head" onClick={() => setUserOpen(!open)} aria-expanded={open}>
				<Icon name="search" size={14} className="oc-row-icon" />
				<span className={'oc-row-title' + (running ? ' is-shimmer' : '')}>
					<span className="oc-verb">{running ? 'Exploring' : 'Explored'}</span>
					<span className="oc-rest"> {exploreSummary(tools)}</span>
				</span>
				<span className="oc-spacer" />
				<Chevron open={open} />
			</button>
			{open ? (
				<div className="oc-group-body">
					{tools.map(t => <ToolPartView key={t.id} part={t} chatId={chatId} />)}
				</div>
			) : null}
		</div>
	);
});

export function Section({ children }: { readonly children: ReactNode }): ReactElement {
	return <div className="oc-section">{children}</div>;
}
