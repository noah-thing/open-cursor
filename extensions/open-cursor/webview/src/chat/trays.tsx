/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Trays stacked above the composer: to-dos, queued messages, pending edit review.
 *--------------------------------------------------------------------------------------------*/

import { memo, useEffect, useState, type ReactElement } from 'react';
import type { Chat, PendingFileEdit, TodoItem } from '../../../src/shared/protocol';
import { Icon } from '../common/icons';
import { post } from './host';
import { basename, dirname } from './util';

function TodoIcon({ status }: { readonly status: TodoItem['status'] }): ReactElement {
	if (status === 'completed') {
		return (
			<svg className="oc-todo-icon is-done" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
				<circle cx="8" cy="8" r="6" fill="currentColor" opacity="0.18" />
				<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
				<path d="M5.5 8.2l1.8 1.8 3.2-3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		);
	}
	if (status === 'in_progress') {
		return (
			<svg className="oc-todo-icon is-active" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
				<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
				<path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" />
			</svg>
		);
	}
	if (status === 'cancelled') {
		return (
			<svg className="oc-todo-icon is-cancelled" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
				<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
				<path d="M5.5 8h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			</svg>
		);
	}
	return (
		<svg className="oc-todo-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
		</svg>
	);
}

export const TodoTray = memo(function TodoTray({ todos }: { readonly todos: readonly TodoItem[] }): ReactElement {
	const done = todos.filter(t => t.status === 'completed').length;
	const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined);
	const open = userOpen ?? done < todos.length;
	const setOpen = (fn: (o: boolean) => boolean): void => setUserOpen(fn(open));
	const current = todos.find(t => t.status === 'in_progress');
	return (
		<div className="oc-tray oc-todos">
			<button type="button" className="oc-tray-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
				<Icon name="chevronRight" size={12} className={'oc-chev' + (open ? ' is-open' : '')} />
				<span className="oc-tray-title">To-dos</span>
				<span className="oc-count">{done > 0 ? done + ' of ' + todos.length + ' done' : todos.length}</span>
				{!open && current ? <span className="oc-tray-current">{current.content}</span> : null}
			</button>
			{open ? (
				<ul className="oc-todo-list">
					{todos.map(t => (
						<li key={t.id} className={'oc-todo is-' + t.status}>
							<TodoIcon status={t.status} />
							<span className="oc-todo-text">{t.content}</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
});

export const QueueTray = memo(function QueueTray({ chat }: { readonly chat: Chat }): ReactElement {
	// Queued messages that nothing is sending (after an error, a stop or a reload) are shown as unsent.
	// The short wait keeps the label from flickering in the moment between one queued message and the next.
	const idle = chat.status === 'idle' || chat.status === 'error';
	const [unsent, setUnsent] = useState(false);
	useEffect(() => {
		if (!idle) { setUnsent(false); return; }
		const t = setTimeout(() => setUnsent(true), 700);
		return () => clearTimeout(t);
	}, [idle, chat.queued.length]);
	return (
		<div className="oc-tray oc-queue">
			<div className="oc-tray-head is-static">
				<span className="oc-tray-title">{unsent ? 'Not sent' : 'Queued'}</span>
				<span className="oc-count">{chat.queued.length}</span>
				{unsent ? (
					<>
						<span className="oc-spacer" />
						<button type="button" className="oc-btn is-sm" onClick={() => post({ type: 'sendQueued', chatId: chat.id })}>Send now</button>
					</>
				) : null}
			</div>
			<ul className="oc-queue-list">
				{chat.queued.map(q => (
					<li key={q.id} className="oc-queue-item">
						<Icon name="arrowUp" size={12} className="oc-row-icon" />
						<span className="oc-queue-text" title={q.text}>{q.text}</span>
						{q.context.length ? <span className="oc-tag">{q.context.length} ctx</span> : null}
						<button type="button" className="oc-iconbtn oc-queue-x" aria-label="Remove queued message" title="Remove" onClick={() => post({ type: 'unqueue', chatId: chat.id, queuedId: q.id })}>
							<Icon name="x" size={12} />
						</button>
					</li>
				))}
			</ul>
		</div>
	);
});

function FileRow({ f }: { readonly f: PendingFileEdit }): ReactElement {
	const dir = dirname(f.path);
	return (
		<li className="oc-review-file">
			<button type="button" className="oc-review-open" onClick={() => post({ type: 'openDiff', uri: f.uri })} title={'Open diff for ' + f.path}>
				<Icon name={f.deleted ? 'trash' : f.isNew ? 'plus' : 'file'} size={13} className="oc-row-icon" />
				<span className="oc-edit-name">{basename(f.path)}</span>
				{dir ? <span className="oc-edit-dir">{dir}</span> : null}
				<span className="oc-spacer" />
				{f.added > 0 ? <span className="oc-added">+{f.added}</span> : null}
				{f.removed > 0 ? <span className="oc-removed">&minus;{f.removed}</span> : null}
			</button>
			<span className="oc-review-file-actions">
				<button type="button" className="oc-iconbtn" title="Undo this file" aria-label={'Undo ' + f.path} onClick={() => post({ type: 'rejectFile', uri: f.uri })}>
					<Icon name="undo" size={13} />
				</button>
				<button type="button" className="oc-iconbtn is-keep" title="Keep this file" aria-label={'Keep ' + f.path} onClick={() => post({ type: 'acceptFile', uri: f.uri })}>
					<Icon name="check" size={13} />
				</button>
			</span>
		</li>
	);
}

export const ReviewBar = memo(function ReviewBar({ files, chatId }: { readonly files: readonly PendingFileEdit[]; readonly chatId: string }): ReactElement {
	const [open, setOpen] = useState(false);
	const added = files.reduce((n, f) => n + f.added, 0);
	const removed = files.reduce((n, f) => n + f.removed, 0);
	return (
		<div className="oc-tray oc-review">
			<div className="oc-review-head">
				<button type="button" className="oc-tray-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
					<Icon name="chevronRight" size={12} className={'oc-chev' + (open ? ' is-open' : '')} />
					<span className="oc-tray-title">{files.length} {files.length === 1 ? 'file' : 'files'}</span>
					<span className="oc-added">+{added}</span>
					<span className="oc-removed">&minus;{removed}</span>
				</button>
				<span className="oc-review-actions">
					<button type="button" className="oc-btn is-ghost" onClick={() => post({ type: 'rejectAll', chatId })} title="Undo all pending changes">Undo all</button>
					<button type="button" className="oc-btn is-primary is-sm" onClick={() => post({ type: 'acceptAll', chatId })} title="Keep all pending changes">Keep all</button>
				</span>
			</div>
			{open ? <ul className="oc-review-list">{files.map(f => <FileRow key={f.uri} f={f} />)}</ul> : null}
		</div>
	);
});
