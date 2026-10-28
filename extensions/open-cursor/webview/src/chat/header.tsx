/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Header (chat tabs + actions), history view and the empty state.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { Chat, ChatSummary } from '../../../src/shared/protocol';
import { Icon, Spinner } from '../common/icons';
import { MOD, Popover, useDismiss } from './menus';
import { post } from './host';
import { MODE_META, groupHistory, fuzzyScore, relativeTime } from './util';

export function Header({ summaries, openIds, activeId, view, onView }: {
	readonly summaries: readonly ChatSummary[];
	readonly openIds: readonly string[];
	readonly activeId: string | undefined;
	readonly view: 'chat' | 'history';
	readonly onView: (v: 'chat' | 'history') => void;
}): ReactElement {
	const byId = useMemo(() => new Map(summaries.map(s => [s.id, s])), [summaries]);
	const tabs = openIds.map(id => byId.get(id)).filter((s): s is ChatSummary => !!s);
	const [moreOpen, setMoreOpen] = useState(false);
	const moreRef = useRef<HTMLDivElement>(null);
	const activeTab = useRef<HTMLDivElement>(null);
	useDismiss(moreRef, moreOpen, () => setMoreOpen(false));
	useEffect(() => { activeTab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [activeId, tabs.length]);
	const active = activeId ? byId.get(activeId) : undefined;

	return (
		<header className="oc-header">
			<div className="oc-tabs" role="tablist" aria-label="Chats">
				{tabs.map(t => {
					const isActive = t.id === activeId && view === 'chat';
					const busy = t.status === 'running' || t.status === 'awaiting-approval';
					return (
						<div
							key={t.id}
							ref={isActive ? activeTab : undefined}
							className={'oc-tab' + (isActive ? ' is-active' : '')}
							role="tab"
							aria-selected={isActive}
							tabIndex={0}
							title={t.title}
							onClick={() => { post({ type: 'openChat', chatId: t.id }); onView('chat'); }}
							onAuxClick={e => { if (e.button === 1) { post({ type: 'closeChatTab', chatId: t.id }); } }}
							onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); post({ type: 'openChat', chatId: t.id }); onView('chat'); } }}
						>
							{busy ? <Spinner size={11} /> : t.status === 'error' ? <span className="oc-dot is-error" /> : null}
							<span className="oc-tab-label">{t.title || 'New chat'}</span>
							{openIds.length > 1 ? (
								<button type="button" className="oc-tab-x" aria-label={'Close ' + t.title} onClick={e => { e.stopPropagation(); post({ type: 'closeChatTab', chatId: t.id }); }}>
									<Icon name="x" size={10} />
								</button>
							) : null}
						</div>
					);
				})}
			</div>
			<div className="oc-header-actions">
				<button type="button" className="oc-iconbtn" title={'New chat (' + MOD + 'T)'} aria-label="New chat" onClick={() => { post({ type: 'newChat' }); onView('chat'); }}>
					<Icon name="plus" size={15} />
				</button>
				<button type="button" className={'oc-iconbtn' + (view === 'history' ? ' is-on' : '')} title="Past chats" aria-label="Past chats" aria-pressed={view === 'history'} onClick={() => onView(view === 'history' ? 'chat' : 'history')}>
					<Icon name="history" size={15} />
				</button>
				<button type="button" className="oc-iconbtn" title="Open Cursor settings" aria-label="Settings" onClick={() => post({ type: 'openSettings' })}>
					<Icon name="gear" size={15} />
				</button>
				<div className="oc-menu-wrap" ref={moreRef}>
					<button type="button" className="oc-iconbtn" title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen(o => !o)}>
						<Icon name="more" size={15} />
					</button>
					{moreOpen ? (
						<Popover direction="down" align="end" className="oc-more-menu">
							<button type="button" className="oc-menu-item" onClick={() => { post({ type: 'newChat' }); onView('chat'); setMoreOpen(false); }}>
								<Icon name="plus" size={14} className="oc-menu-icon" /><span className="oc-menu-main"><span className="oc-menu-label">New chat</span></span>
							</button>
							<button type="button" className="oc-menu-item" disabled={!active} onClick={() => { if (active) { onView('history'); } setMoreOpen(false); }}>
								<Icon name="history" size={14} className="oc-menu-icon" /><span className="oc-menu-main"><span className="oc-menu-label">Past chats</span></span>
							</button>
							<button type="button" className="oc-menu-item" disabled={!active} onClick={() => { if (active) { post({ type: 'closeChatTab', chatId: active.id }); } setMoreOpen(false); }}>
								<Icon name="x" size={14} className="oc-menu-icon" /><span className="oc-menu-main"><span className="oc-menu-label">Close this tab</span></span>
							</button>
							<button type="button" className="oc-menu-item" disabled={!active} onClick={() => { if (active) { post({ type: 'deleteChat', chatId: active.id }); } setMoreOpen(false); }}>
								<Icon name="trash" size={14} className="oc-menu-icon" /><span className="oc-menu-main"><span className="oc-menu-label">Delete this chat</span></span>
							</button>
							<div className="oc-menu-sep" />
							<button type="button" className="oc-menu-item" onClick={() => { post({ type: 'openSettings', section: 'rules' }); setMoreOpen(false); }}>
								<Icon name="rule" size={14} className="oc-menu-icon" /><span className="oc-menu-main"><span className="oc-menu-label">Rules</span></span>
							</button>
							<button type="button" className="oc-menu-item" onClick={() => { post({ type: 'openSettings', section: 'mcp' }); setMoreOpen(false); }}>
								<Icon name="plug" size={14} className="oc-menu-icon" /><span className="oc-menu-main"><span className="oc-menu-label">Tools and MCP</span></span>
							</button>
						</Popover>
					) : null}
				</div>
			</div>
		</header>
	);
}

function HistoryItem({ chat, active, onPick }: { readonly chat: ChatSummary; readonly active: boolean; readonly onPick: () => void }): ReactElement {
	const [renaming, setRenaming] = useState(false);
	const [title, setTitle] = useState(chat.title);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => { if (renaming) { inputRef.current?.select(); } }, [renaming]);
	useEffect(() => {
		if (!confirmDelete) { return; }
		const t = setTimeout(() => setConfirmDelete(false), 3000);
		return () => clearTimeout(t);
	}, [confirmDelete]);
	const commit = (): void => {
		const t = title.trim();
		if (t && t !== chat.title) { post({ type: 'renameChat', chatId: chat.id, title: t }); }
		setRenaming(false);
	};
	const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === 'Enter') { commit(); }
		else if (e.key === 'Escape') { setTitle(chat.title); setRenaming(false); }
	};
	const busy = chat.status === 'running' || chat.status === 'awaiting-approval';
	return (
		<li className={'oc-hist-item' + (active ? ' is-active' : '')}>
			{renaming ? (
				<div className="oc-hist-main">
					<Icon name={MODE_META[chat.mode].icon} size={14} className="oc-row-icon" />
					<input ref={inputRef} className="oc-hist-rename" value={title} onChange={e => setTitle(e.target.value)} onBlur={commit} onKeyDown={onKey} aria-label="Chat title" autoFocus />
				</div>
			) : (
				<button type="button" className="oc-hist-main" onClick={onPick}>
					{busy ? <Spinner size={13} /> : <Icon name={MODE_META[chat.mode].icon} size={14} className="oc-row-icon" />}
					<span className="oc-hist-title">{chat.title || 'New chat'}</span>
					<span className="oc-hist-time">{relativeTime(chat.updatedAt)}</span>
				</button>
			)}
			{!renaming ? (
				<span className="oc-hist-actions">
					<button type="button" className="oc-iconbtn" title="Rename" aria-label={'Rename ' + chat.title} onClick={() => { setTitle(chat.title); setRenaming(true); }}>
						<Icon name="pencil" size={13} />
					</button>
					<button
						type="button"
						className={'oc-iconbtn' + (confirmDelete ? ' is-danger' : '')}
						title={confirmDelete ? 'Click again to delete' : 'Delete'}
						aria-label={'Delete ' + chat.title}
						onClick={() => { if (confirmDelete) { post({ type: 'deleteChat', chatId: chat.id }); } else { setConfirmDelete(true); } }}
					>
						<Icon name="trash" size={13} />
					</button>
				</span>
			) : null}
		</li>
	);
}

export function History({ summaries, activeId, onPick }: {
	readonly summaries: readonly ChatSummary[];
	readonly activeId: string | undefined;
	readonly onPick: (id: string) => void;
}): ReactElement {
	const [query, setQuery] = useState('');
	const filtered = useMemo(() => {
		const q = query.trim();
		if (!q) { return summaries; }
		return summaries.filter(c => fuzzyScore(q, c.title) >= 0);
	}, [summaries, query]);
	const groups = useMemo(() => groupHistory(filtered), [filtered]);
	return (
		<div className="oc-history">
			<div className="oc-hist-search">
				<Icon name="search" size={13} />
				<input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" spellCheck={false} />
				{query ? <button type="button" className="oc-iconbtn" aria-label="Clear search" onClick={() => setQuery('')}><Icon name="x" size={12} /></button> : null}
			</div>
			<div className="oc-hist-scroll">
				{groups.length === 0 ? <div className="oc-hist-empty">{query ? 'No chats match' : 'No chats yet'}</div> : null}
				{groups.map(g => (
					<section key={g.label} className="oc-hist-group">
						<h3 className="oc-hist-label">{g.label}</h3>
						<ul>
							{g.items.map(c => <HistoryItem key={c.id} chat={c} active={c.id === activeId} onPick={() => onPick(c.id)} />)}
						</ul>
					</section>
				))}
			</div>
		</div>
	);
}

export function EmptyState({ chat, recent, workspaceName, onPick, submitWithModEnter, hasUsableModel }: {
	readonly hasUsableModel: boolean;
	readonly chat: Chat;
	readonly recent: readonly ChatSummary[];
	readonly workspaceName: string | undefined;
	readonly onPick: (id: string) => void;
	readonly submitWithModEnter: boolean;
}): ReactElement {
	const hints: { keys: string[]; label: string }[] = [
		{ keys: ['@'], label: 'Add files, code, docs or git as context' },
		{ keys: ['/'], label: 'Run a command' },
		{ keys: [MOD + '.'], label: 'Switch between ' + Object.values(MODE_META).map(m => m.label).join(', ') },
		{ keys: [submitWithModEnter ? MOD + 'Enter' : 'Enter'], label: 'Send. ' + (submitWithModEnter ? 'Enter' : 'Shift+Enter') + ' for a new line' },
		{ keys: ['Esc'], label: 'Stop the agent' },
	];
	return (
		<div className="oc-empty">
			<div className="oc-empty-top">
				<div className="oc-empty-mark" aria-hidden="true">
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
						<path d="M12 2.75l8.25 4.75v9L12 21.25 3.75 16.5v-9z" />
						<path d="M12 2.75v9.5m0 0l8.25-4.75M12 12.25L3.75 7.5" opacity="0.55" />
					</svg>
				</div>
				<div className="oc-empty-title">{workspaceName ? workspaceName : 'New chat'}</div>
				<div className="oc-empty-sub">{MODE_META[chat.mode].hint}</div>
			</div>
			{!hasUsableModel ? (
				<div className="oc-setup">
					<div className="oc-empty-label">Connect a model</div>
					<button type="button" className="oc-setup-item" onClick={() => post({ type: 'openSettings', section: 'subscriptions' })}>
						<span className="oc-setup-title">Use a subscription you already have</span>
						<span className="oc-setup-sub">Claude Code, Codex or Gemini CLI, signed in on this machine</span>
					</button>
					<button type="button" className="oc-setup-item" onClick={() => post({ type: 'openSettings', section: 'models' })}>
						<span className="oc-setup-title">Add an API key</span>
						<span className="oc-setup-sub">Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek and more</span>
					</button>
					<button type="button" className="oc-setup-item" onClick={() => post({ type: 'openSettings', section: 'models' })}>
						<span className="oc-setup-title">Run a model locally</span>
						<span className="oc-setup-sub">Start Ollama or LM Studio and it shows up here, free and offline</span>
					</button>
				</div>
			) : null}
			<ul className="oc-hints">
				{hints.map(h => (
					<li key={h.label}>
						<span className="oc-kbd-group">{h.keys.map(k => <kbd key={k}>{k}</kbd>)}</span>
						<span>{h.label}</span>
					</li>
				))}
			</ul>
			{recent.length ? (
				<div className="oc-empty-recent">
					<div className="oc-empty-label">Recent</div>
					<ul>
						{recent.map(c => (
							<li key={c.id}>
								<button type="button" className="oc-recent-item" onClick={() => onPick(c.id)}>
									<Icon name={MODE_META[c.mode].icon} size={13} className="oc-row-icon" />
									<span className="oc-hist-title">{c.title || 'New chat'}</span>
									<span className="oc-hist-time">{relativeTime(c.updatedAt)}</span>
								</button>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</div>
	);
}
