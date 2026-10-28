/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { AssistantMessage, MessagePart, ToolPart, UserMessage } from '../../../src/shared/protocol';
import { Icon } from '../common/icons';
import { Markdown } from './markdown';
import { post } from './host';
import { ContextPill, ErrorCard, ExploreGroup, Thinking, ToolPartView, isExploreTool } from './parts';

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

export const AssistantBlock = memo(function AssistantBlock({ message, chatId, showThinking, onRetry }: {
	readonly message: AssistantMessage;
	readonly chatId: string;
	readonly showThinking: boolean;
	readonly onRetry: () => void;
}): ReactElement {
	const nodes = useMemo(() => buildNodes(message.parts), [message.parts]);
	const last = message.parts[message.parts.length - 1];
	const busyTail =
		!message.done &&
		(!last || (last.type === 'tool' && last.status !== 'running' && last.status !== 'streaming' && last.status !== 'awaiting-approval') || (last.type === 'thinking' && last.done));
	const fullText = useMemo(() => message.parts.filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text').map(p => p.text).join('\n\n'), [message.parts]);
	const [copied, setCopied] = useState(false);
	return (
		<div className="oc-assistant" data-done={message.done}>
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
						return <ErrorCard key={n.key} message={p.message} action={p.action} onRetry={onRetry} />;
				}
			})}
			{busyTail ? (
				<div className="oc-working" aria-live="polite">
					<span className="is-shimmer">{message.parts.length === 0 ? 'Thinking' : 'Working'}</span>
				</div>
			) : null}
			{message.done && fullText ? (
				<div className="oc-assistant-foot">
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
