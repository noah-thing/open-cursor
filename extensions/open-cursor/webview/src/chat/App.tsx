/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { memo, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactElement } from 'react';
import type { Chat, ChatMode, ContextItem } from '../../../src/shared/protocol';
import { Icon } from '../common/icons';
import { Composer } from './composer';
import { EmptyState, Header, History } from './header';
import { onHostMessage, post, saveUiState } from './host';
import { AssistantBlock, UserBubble } from './messages';
import { QueueTray, ReviewBar, TodoTray } from './trays';
import { initialState, lastAssistant, reducer, type State } from './store';

const scrollPositions: Record<string, number> = {};

const BOTTOM_SLACK = 48;

const MessageList = memo(function MessageList({ chat, showThinking, editingId, setEditingId, scrollTo }: {
	readonly chat: Chat;
	readonly showThinking: boolean;
	readonly editingId: string | undefined;
	readonly setEditingId: (id: string | undefined) => void;
	readonly scrollTo: string | undefined;
}): ReactElement {
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [showJump, setShowJump] = useState(false);
	const running = chat.status === 'running' || chat.status === 'awaiting-approval';
	const messageCount = chat.messages.length;
	const lastIsUser = messageCount > 0 && chat.messages[messageCount - 1].role === 'user';

	const toBottom = useCallback(() => {
		const el = scroller.current;
		if (el) { el.scrollTop = el.scrollHeight; }
	}, []);

	// Restore position when the chat changes.
	useLayoutEffect(() => {
		const saved = scrollPositions[chat.id];
		const el = scroller.current;
		if (!el) { return; }
		if (saved === undefined || saved < 0) {
			stick.current = true;
			toBottom();
		} else {
			el.scrollTop = saved;
			stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
		}
		setShowJump(!stick.current);
	}, [chat.id, toBottom]);

	// A new user message always jumps to the end.
	useLayoutEffect(() => {
		if (lastIsUser) {
			stick.current = true;
			toBottom();
			setShowJump(false);
		}
	}, [lastIsUser, messageCount, toBottom]);

	useLayoutEffect(() => {
		if (stick.current) { toBottom(); }
	}, [chat, toBottom]);

	useEffect(() => {
		const c = content.current;
		if (!c || typeof ResizeObserver === 'undefined') { return; }
		const ro = new ResizeObserver(() => { if (stick.current) { toBottom(); } });
		ro.observe(c);
		return () => ro.disconnect();
	}, [toBottom]);

	useEffect(() => {
		if (!scrollTo) { return; }
		const el = scroller.current?.querySelector('[data-mid="' + scrollTo + '"]');
		el?.scrollIntoView({ block: 'center' });
	}, [scrollTo]);

	const onScroll = (): void => {
		const el = scroller.current;
		if (!el) { return; }
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
		stick.current = atBottom;
		scrollPositions[chat.id] = atBottom ? -1 : el.scrollTop;
		setShowJump(prev => (prev === !atBottom ? prev : !atBottom));
		persist();
	};

	const retry = useCallback(() => {
		for (let i = chat.messages.length - 1; i >= 0; i--) {
			const m = chat.messages[i];
			if (m.role === 'user') {
				post({ type: 'resend', chatId: chat.id, messageId: m.id, text: m.text, context: m.context, revert: false });
				return;
			}
		}
	}, [chat]);

	const last = lastAssistant(chat);
	const showBuild = chat.mode === 'plan' && chat.status === 'idle' && !!last && last.done && chat.messages[chat.messages.length - 1] === last && last.parts.some(p => p.type === 'text' && p.text.trim().length > 0);

	return (
		<div className="oc-scroll-wrap">
			<div className="oc-scroll" ref={scroller} onScroll={onScroll}>
				<div className="oc-messages" ref={content}>
					{chat.messages.map(m => (
						<div key={m.id} className={'oc-msg is-' + m.role} data-mid={m.id}>
							{m.role === 'user' ? (
								<UserBubble message={m} chatId={chat.id} running={running} editing={editingId === m.id} onEditChange={e => setEditingId(e ? m.id : undefined)} />
							) : (
								<AssistantBlock message={m} chatId={chat.id} showThinking={showThinking} onRetry={retry} />
							)}
						</div>
					))}
					{showBuild ? (
						<div className="oc-build">
							<div className="oc-build-text">Plan ready. Build it with the agent?</div>
							<button
								type="button"
								className="oc-btn is-primary"
								onClick={() => {
									post({ type: 'setMode', chatId: chat.id, mode: 'agent' });
									post({ type: 'send', chatId: chat.id, text: 'Implement the plan above.', context: [], mode: 'agent', modelId: chat.modelId });
								}}
							>
								<Icon name="play" size={11} /> Build
							</button>
						</div>
					) : null}
				</div>
			</div>
			{showJump ? (
				<button type="button" className="oc-jump" aria-label="Scroll to latest" onClick={() => { stick.current = true; toBottom(); setShowJump(false); }}>
					<Icon name="arrowUp" size={13} style={{ transform: 'rotate(180deg)' }} />
				</button>
			) : null}
		</div>
	);
});

let persistState: () => void = () => undefined;
function persist(): void { persistState(); }

export function App(): ReactElement {
	const [state, dispatch] = useReducer(reducer, undefined, initialState);
	const [editingId, setEditingId] = useState<string | undefined>(undefined);
	const stateRef = useRef<State>(state);
	stateRef.current = state;

	useEffect(() => {
		persistState = () => saveUiState({ drafts: stateRef.current.drafts, scroll: scrollPositions });
		const off = onHostMessage(m => dispatch({ kind: 'host', m }));
		post({ type: 'ready' });
		post({ type: 'requestSlashCommands' });
		post({ type: 'requestActiveEditor' });
		return off;
	}, []);

	useEffect(() => { saveUiState({ drafts: state.drafts, scroll: scrollPositions }); }, [state.drafts]);

	// Esc stops the agent even when the input does not have focus.
	useEffect(() => {
		const h = (e: KeyboardEvent): void => {
			if (e.key !== 'Escape' || e.defaultPrevented) { return; }
			const s = stateRef.current;
			const chat = s.activeId ? s.chats[s.activeId] : undefined;
			if (chat && (chat.status === 'running' || chat.status === 'awaiting-approval') && s.view === 'chat') { post({ type: 'stop', chatId: chat.id }); }
		};
		window.addEventListener('keydown', h);
		return () => window.removeEventListener('keydown', h);
	}, []);

	useEffect(() => { setEditingId(undefined); }, [state.activeId]);

	const chat = state.activeId ? state.chats[state.activeId] : undefined;

	const onEditLast = useCallback((): boolean => {
		const s = stateRef.current;
		const c = s.activeId ? s.chats[s.activeId] : undefined;
		if (!c || c.status === 'running') { return false; }
		for (let i = c.messages.length - 1; i >= 0; i--) {
			const m = c.messages[i];
			if (m.role === 'user') { setEditingId(m.id); return true; }
		}
		return false;
	}, []);

	if (!state.ready || !chat) {
		return (
			<div className="oc-app">
				<Header summaries={state.summaries} openIds={state.openIds} activeId={state.activeId} view={state.view} onView={v => dispatch({ kind: 'view', view: v })} />
				<div className="oc-loading"><span className="is-shimmer">Loading</span></div>
			</div>
		);
	}

	const o = state.overrides[chat.id];
	const mode: ChatMode = o?.mode ?? chat.mode;
	const modelId = o?.modelId ?? chat.modelId;
	const setMode = (m: ChatMode): void => {
		dispatch({ kind: 'override', chatId: chat.id, o: { mode: m } });
		post({ type: 'setMode', chatId: chat.id, mode: m });
	};
	const setModel = (id: string): void => {
		dispatch({ kind: 'override', chatId: chat.id, o: { modelId: id } });
		post({ type: 'setModel', chatId: chat.id, modelId: id });
	};
	const pickChat = (id: string): void => {
		post({ type: 'openChat', chatId: id });
		dispatch({ kind: 'view', view: 'chat' });
	};
	const contexts: ContextItem[] = state.contexts[chat.id] ?? [];
	const incomplete = chat.messages.length === 0;
	const recent = state.summaries.filter(s => s.id !== chat.id && s.updatedAt > 0).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);
	const effectiveChat: Chat = chat.mode === mode ? chat : { ...chat, mode };

	return (
		<div className="oc-app" style={{ ['--oc-font-size' as string]: state.settings.fontSize ? state.settings.fontSize + 'px' : undefined }}>
			<Header summaries={state.summaries} openIds={state.openIds} activeId={state.activeId} view={state.view} onView={v => dispatch({ kind: 'view', view: v })} />
			{state.view === 'history' ? (
				<History summaries={state.summaries} activeId={state.activeId} onPick={pickChat} />
			) : (
				<>
					{incomplete ? (
						<EmptyState chat={effectiveChat} recent={recent} workspaceName={state.workspaceName} onPick={pickChat} submitWithModEnter={state.settings.submitWithModEnter} />
					) : (
						<MessageList chat={chat} showThinking={state.settings.showThinking} editingId={editingId} setEditingId={setEditingId} scrollTo={editingId} />
					)}
					<div className="oc-dock">
						{chat.todos.length > 0 ? <TodoTray todos={chat.todos} /> : null}
						{chat.queued.length > 0 ? <QueueTray chat={chat} /> : null}
						{state.pendingEdits.length > 0 ? <ReviewBar files={state.pendingEdits} /> : null}
						<Composer
							chat={effectiveChat}
							models={state.models}
							settings={state.settings}
							mode={mode}
							modelId={modelId}
							text={state.drafts[chat.id] ?? ''}
							contexts={contexts}
							activeFile={state.activeFile}
							suggestDismissed={!!state.activeFile && state.dismissedSuggest[chat.id] === state.activeFile.id}
							slash={state.slash}
							hasUsableModel={state.models.length === 0 || state.models.some(m => m.hasKey)}
							focusNonce={state.focusNonce}
							onText={t => dispatch({ kind: 'draft', chatId: chat.id, text: t })}
							onContexts={items => dispatch({ kind: 'contexts', chatId: chat.id, items })}
							onMode={setMode}
							onModel={setModel}
							onEditLast={onEditLast}
							onDismissSuggest={id => dispatch({ kind: 'dismissSuggest', chatId: chat.id, id })}
							onOpenHistory={() => dispatch({ kind: 'view', view: 'history' })}
							onNewChat={() => post({ type: 'newChat' })}
						/>
					</div>
				</>
			)}
		</div>
	);
}
