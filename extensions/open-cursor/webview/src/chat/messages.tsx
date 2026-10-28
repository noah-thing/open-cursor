/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { AssistantMessage, MessagePart, ToolPart, UserMessage } from '../../../src/shared/protocol';
import { Icon } from '../common/icons';
import { Markdown } from './markdown';
import { post } from './host';
import { ContextPill, ErrorCard, ExploreGroup, Thinking, ToolPartView, isExploreTool } from './parts';
import { basename } from './util';

type Node =
	| { kind: 'part'; part: MessagePart; key: string }
	| { kind: 'explore'; tools: ToolPart[]; key: string };

function buildNodes(parts: readonly MessagePart[]): Node[] {
	const out: Node[] = [];
	let run: ToolPart[] = [];
	const flush = (): void => {
		if (run.length >= 2) {
			out.push({ kind: 'explore', tools: run, key: 'x' + run[0].id });
		} else if (run.length === 1) {
			out.push({ kind: 'part', part: run[0], key: run[0].id });
		}
		run = [];
	};
	parts.forEach((p, i) => {
		if (p.type === 'tool' && isExploreTool(p)) {
			run.push(p);
			return;
		}
		flush();
		out.push({ kind: 'part', part: p, key: p.type === 'tool' ? p.id : p.type + i });
	});
	flush();
	return out;
}

export function useNow(on: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!on) { return; }
		setNow(Date.now());
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [on]);
	return now;
}

function phase(message: AssistantMessage): { label: string; waiting: boolean } {
	const last = message.parts[message.parts.length - 1];
	if (!last) { return { label: 'Thinking', waiting: false }; }
	// A live thinking row already says so; the status line speaks for the run as a whole.
	if (last.type === 'thinking' && !last.done) { return { label: message.parts.length > 1 ? 'Working' : 'Reasoning', waiting: false }; }
	if (last.type === 'text') { return { label: 'Writing', waiting: false }; }
	if (last.type === 'tool') {
		if (last.status === 'awaiting-approval') { return { label: 'Waiting for your approval', waiting: true }; }
		if (last.status === 'running' || last.status === 'streaming') {
			if (last.edit) { return { label: 'Editing ' + basename(last.edit.path), waiting: false }; }
			if (last.command || last.name === 'run_terminal_cmd') { return { label: 'Running a command', waiting: false }; }
			if (isExploreTool(last)) { return { label: 'Exploring', waiting: false }; }
			return { label: 'Working', waiting: false };
		}
	}
	return { label: 'Deciding the next step', waiting: false };
}

/**
 * The run's status line: what is happening now, for how long, and one mark per step taken. Marks
 * arrive as steps start, the live one carries a sweep of light, failures stay red in the record.
 */
const WorkingLine = memo(function WorkingLine({ message }: { readonly message: AssistantMessage }): ReactElement {
	const now = useNow(true);
	const { label, waiting } = phase(message);
	const steps = message.parts.filter((p): p is ToolPart => p.type === 'tool');
	const secs = Math.max(0, Math.round((now - message.createdAt) / 1000));
	return (
		<div className={'oc-working' + (waiting ? ' is-waiting' : '')}>
			<span key={label} className={'oc-working-label' + (waiting ? '' : ' is-shimmer')} aria-live="polite">{label}</span>
			{steps.length ? (
				<span className="oc-trace" aria-hidden="true">
					{steps.slice(-32).map(t => <i key={t.id} className={'is-' + t.status} />)}
				</span>
			) : null}
			<span className="oc-working-time" aria-hidden="true">{secs >= 60 ? Math.floor(secs / 60) + 'm ' + (secs % 60) + 's' : secs + 's'}</span>
		</div>
	);
});

function RunSummary({ message }: { readonly message: AssistantMessage }): ReactElement | null {
	const steps = message.parts.filter((p): p is ToolPart => p.type === 'tool');
	if (steps.length < 2) { return null; }
	const files = new Set(steps.filter(t => t.edit && t.status === 'done').map(t => t.edit!.path)).size;
	const bits = [steps.length + ' steps'];
	if (files) { bits.push(files + (files === 1 ? ' file changed' : ' files changed')); }
	return <span className="oc-run-summary">{bits.join(', ')}</span>;
}

export const AssistantBlock = memo(function AssistantBlock({ message, chatId, showThinking, onRetry }: {
	readonly message: AssistantMessage;
	readonly chatId: string;
	readonly showThinking: boolean;
	readonly onRetry: (modelId?: string) => void;
}): ReactElement {
	const nodes = useMemo(() => buildNodes(message.parts), [message.parts]);
	const fullText = useMemo(() => message.parts.filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text').map(p => p.text).join('\n\n'), [message.parts]);
	const [copied, setCopied] = useState(false);
	return (
		<div className={'oc-assistant' + (message.done ? '' : ' is-running')} data-done={message.done}>
			{nodes.map(n => {
				if (n.kind === 'explore') { return <ExploreGroup key={n.key} tools={n.tools} chatId={chatId} />; }
				const p = n.part;
				switch (p.type) {
					case 'text':
						return p.text.trim() ? <Markdown key={n.key} text={p.text} /> : null;
					case 'thinking':
						return <Thinking key={n.key} part={p} show={showThinking} />;
					case 'tool':
						return <ToolPartView key={n.key} part={p} chatId={chatId} />;
					case 'error':
						return (
							<ErrorCard
								key={n.key}
								message={p.message}
								action={p.action}
								switchTo={p.switchTo}
								fix={p.fix}
								onRetry={() => onRetry()}
								onSwitch={id => onRetry(id)}
							/>
						);
				}
			})}
			{message.done ? null : <WorkingLine message={message} />}
			{message.done && fullText ? (
				<div className="oc-assistant-foot">
					<RunSummary message={message} />
					<button
						type="button"
						className="oc-iconbtn"
						title="Copy response"
						aria-label="Copy response"
						onClick={() => {
							post({ type: 'copy', text: fullText });
							setCopied(true);
							setTimeout(() => setCopied(false), 1200);
						}}
					>
						<Icon name={copied ? 'check' : 'copy'} size={14} />
					</button>
				</div>
			) : null}
		</div>
	);
});

function useAutosize(ref: React.RefObject<HTMLTextAreaElement | null>, value: string): void {
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) { return; }
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 260) + 'px';
	}, [ref, value]);
}

export const UserBubble = memo(function UserBubble({ message, chatId, running, editing, onEditChange }: {
	readonly message: UserMessage;
	readonly chatId: string;
	readonly running: boolean;
	readonly editing: boolean;
	readonly onEditChange: (editing: boolean) => void;
}): ReactElement {
	const [text, setText] = useState(message.text);
	const [revert, setRevert] = useState(true);
	const [confirming, setConfirming] = useState(false);
	const ref = useRef<HTMLTextAreaElement>(null);
	useAutosize(ref, text);
	useEffect(() => {
		if (editing) {
			setText(message.text);
			const el = ref.current;
			if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
		}
	}, [editing, message.text]);

	const submit = (): void => {
		const t = text.trim();
		if (!t) { return; }
		post({ type: 'resend', chatId, messageId: message.id, text: t, context: message.context, revert: revert && !!message.checkpointId });
		onEditChange(false);
	};
	const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (e.key === 'Escape') { e.preventDefault(); onEditChange(false); }
		else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
	};

	if (editing) {
		return (
			<div className="oc-user is-editing">
				<div className="oc-edit-banner">Editing message</div>
				<div className="oc-bubble">
					{message.context.length ? (
						<div className="oc-pills">{message.context.map(c => <ContextPill key={c.id} item={c} />)}</div>
					) : null}
					<textarea ref={ref} className="oc-edit-input" value={text} rows={1} onChange={e => setText(e.target.value)} onKeyDown={onKey} aria-label="Edit message" />
					<div className="oc-edit-actions">
						{message.checkpointId ? (
							<label className="oc-check">
								<input type="checkbox" checked={revert} onChange={e => setRevert(e.target.checked)} />
								<span>Revert files</span>
							</label>
						) : null}
						<span className="oc-spacer" />
						<button type="button" className="oc-btn" onClick={() => onEditChange(false)}>Cancel</button>
						<button type="button" className="oc-btn is-primary" onClick={submit} disabled={!text.trim()}>Resubmit</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="oc-user">
			<div
				className="oc-bubble is-clickable"
				role="button"
				tabIndex={0}
				onClick={e => {
					if ((e.target as HTMLElement).closest('button,a,textarea')) { return; }
					if (window.getSelection()?.toString()) { return; }
					onEditChange(true);
				}}
				onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) { onEditChange(true); } }}
				title="Click to edit and resubmit"
			>
				{message.context.length ? (
					<div className="oc-pills">{message.context.map(c => <ContextPill key={c.id} item={c} />)}</div>
				) : null}
				<div className="oc-user-text">{message.text}</div>
				{message.checkpointId && !confirming ? (
					<div className="oc-bubble-actions">
						<button
							type="button"
							className="oc-iconbtn"
							title={running ? 'Stop the agent to restore' : 'Restore checkpoint'}
							aria-label="Restore checkpoint"
							disabled={running}
							onClick={() => setConfirming(true)}
						>
							<Icon name="restore" size={14} />
						</button>
					</div>
				) : null}
			</div>
			{confirming ? (
				<div className="oc-confirm" role="alertdialog" aria-label="Restore checkpoint">
					<div className="oc-confirm-title">Revert files to this message?</div>
					<div className="oc-confirm-body">Changes the agent made after this message are undone. Later messages stay in the chat.</div>
					<div className="oc-confirm-actions">
						<button type="button" className="oc-btn" onClick={() => setConfirming(false)}>Cancel</button>
						<button
							type="button"
							className="oc-btn is-primary"
							onClick={() => {
								post({ type: 'restoreCheckpoint', chatId, messageId: message.id });
								setConfirming(false);
							}}
						>
							Revert files
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
});
