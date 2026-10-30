/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { memo, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactElement } from 'react';
import type { Chat, ChatMode, ContextItem, HostMessageExt } from '../../../src/shared/protocol';
import { flushSync } from 'react-dom';
import { Icon } from '../common/icons';
import { Loader } from '../common/loader';
import { Composer } from './composer';
import { Header, History } from './header';
import { HelpBar, HelpBottom, HelpTop } from './help';
import { ConnectBlock, HomeBottom, HomeTop, buildStarters } from './home';
import { onHostMessage, post, saveUiState } from './host';
import { CodeActions } from './markdown';
import { AssistantBlock, UserBubble } from './messages';
import { QueueTray, ReviewBar, TodoTray } from './trays';
import { initialState, lastAssistant, reducer, type State } from './store';
import { retryTarget } from './util';

const scrollPositions: Record<string, number> = {};

// Small on purpose: a larger slack kept following the stream after the user had scrolled up a little.
const BOTTOM_SLACK = 8;

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
	const seen = useRef<{ chatId: string; ids: Set<string> } | undefined>(undefined);
	if (seen.current?.chatId !== chat.id) {
		seen.current = { chatId: chat.id, ids: new Set(chat.messages.filter(m => m.role === 'user' || (m as { done?: boolean }).done).map(m => m.id)) };
	}
	const [showJump, setShowJump] = useState(false);
	const running = chat.status === 'running' || chat.status === 'awaiting-approval';
	const messageCount = chat.messages.length;
	const lastIsUser = messageCount > 0 && chat.messages[messageCount - 1].role === 'user';

	const toBottom = useCallback(() => {
		const el = scroller.current;
		if (el) { el.scrollTop = el.scrollHeight; }
	}, []);

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

	// Wheel up or a touch drag is the user taking over, before any scroll event can say so.
	// The button state is refreshed next frame, since no scroll event follows when the view cannot move.
	const unstick = useCallback((): void => {
		stick.current = false;
		requestAnimationFrame(() => onScrollRef.current());
	}, []);
	const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>): void => {
		// scrolling inside a code block is not leaving the bottom of the chat
		if ((e.target as Element | null)?.closest?.('pre')) { return; }
		if (e.deltaY < 0) {
			stick.current = false;
			requestAnimationFrame(() => onScrollRef.current());
		}
	}, []);

	const onScrollRef = useRef<() => void>(() => undefined);
	const onScroll = (): void => {
		const el = scroller.current;
		if (!el) { return; }
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
		stick.current = atBottom;
		scrollPositions[chat.id] = atBottom ? -1 : el.scrollTop;
		setShowJump(prev => (prev === !atBottom ? prev : !atBottom));
		persist();
	};
	onScrollRef.current = onScroll;

	// Read through a ref so retry keeps one identity and streamed tokens do not re-render every AssistantBlock.
	const chatRef = useRef(chat);
	chatRef.current = chat;
	const retry = useCallback((assistantId: string, modelId?: string) => {
		const c = chatRef.current;
		// the message that owns this error's turn, and only while it is the last turn
		const m = retryTarget(c.messages, assistantId);
		if (m) { post({ type: 'resend', chatId: c.id, messageId: m.id, text: m.text, context: m.context, revert: false, modelId }); }
	}, []);
	const built = useRef(false);

	const last = lastAssistant(chat);
	useEffect(() => { built.current = false; }, [chat.mode, chat.messages.length]);
	const showBuild = chat.mode === 'plan' && chat.status === 'idle' && !!last && last.done && chat.messages[chat.messages.length - 1] === last && last.parts.some(p => p.type === 'text' && p.text.trim().length > 0);

	return (
		<CodeActions.Provider value={chat.mode !== 'help'}>
		<div className="oc-scroll-wrap">
			<div className="oc-scroll" ref={scroller} onScroll={onScroll} onWheel={onWheel} onTouchMove={unstick}>
				<div className="oc-messages" ref={content}>
					{chat.messages.map(m => (
						<div key={m.id} className={'oc-msg is-' + m.role + (seen.current!.ids.has(m.id) ? ' is-history' : '')} data-mid={m.id}>
							{m.role === 'user' ? (
								<UserBubble message={m} chatId={chat.id} running={running} editing={editingId === m.id} onEditChange={setEditingId} />
							) : (
								<AssistantBlock message={m} chatId={chat.id} showThinking={showThinking} current={m === chat.messages[chat.messages.length - 1]} onRetry={retry} />
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
									if (built.current) { return; }
									built.current = true;
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
		</CodeActions.Provider>
	);
});

let persistState: () => void = () => undefined;
function persist(): void { persistState(); }

/** Wide enough for the chat list beside the conversation, as when the chat fills the window. */
const WIDE = '(min-width: 880px)';

function useWide(): boolean {
	const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
	useEffect(() => {
		const q = window.matchMedia(WIDE);
		const h = (): void => setWide(q.matches);
		q.addEventListener('change', h);
		return () => q.removeEventListener('change', h);
	}, []);
	return wide;
}

const GLIDE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

interface Ghost { readonly el: HTMLElement; readonly top: number; readonly left: number; readonly width: number; readonly below: boolean }

/**
 * Moves between the start screen and a conversation without a cut. The composer is one node in both
 * layouts, so after React lays out the new one it is played back from where it was (FLIP). The start
 * screen pieces are already detached by then; they are put back where they stood and faded out.
 */
function useStageMotion(home: boolean, staged: boolean): { stageRef: React.RefObject<HTMLDivElement | null>; dockRef: React.RefObject<HTMLDivElement | null> } {
	const stageRef = useRef<HTMLDivElement>(null);
	const dockRef = useRef<HTMLDivElement>(null);
	const last = useRef<{ home: boolean; dockTop: number; ghosts: Ghost[] } | undefined>(undefined);
	const capture = useCallback((isHome: boolean): void => {
		const stage = stageRef.current;
		const dock = dockRef.current;
		if (!stage || !dock) { last.current = undefined; return; }
		const box = stage.getBoundingClientRect();
		const dockRect = dock.getBoundingClientRect();
		const ghosts: Ghost[] = isHome
			? [...stage.querySelectorAll<HTMLElement>(':scope > .oc-home-top:not(.oc-leaving), :scope > .oc-home-bottom:not(.oc-leaving)')].map(el => {
				const r = el.getBoundingClientRect();
				return { el, top: r.top - box.top, left: r.left - box.left, width: r.width, below: r.top > dockRect.top };
			})
			: [];
		last.current = { home: isHome, dockTop: dockRect.top, ghosts };
	}, []);
	// Scrolling the start screen or resizing the panel moves things without a render; keep the snapshot true.
	// Subscribed once per stage mount, not per render; the dock is watched too since it moves when the composer grows.
	useEffect(() => {
		const stage = stageRef.current;
		if (!stage) { return; }
		const again = (): void => capture(stage.classList.contains('is-home'));
		stage.addEventListener('scroll', again, { passive: true });
		const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(again);
		ro?.observe(stage);
		if (dockRef.current) { ro?.observe(dockRef.current); }
		// the dock also moves when the start screen blocks above or below it change size
		for (const el of stage.querySelectorAll(':scope > .oc-home-top, :scope > .oc-home-bottom')) { ro?.observe(el); }
		return () => { stage.removeEventListener('scroll', again); ro?.disconnect(); };
	}, [staged, capture]);
	useLayoutEffect(() => {
		const stage = stageRef.current;
		const dock = dockRef.current;
		if (!stage || !dock) { last.current = undefined; return; }
		const dockRect = dock.getBoundingClientRect();
		const prev = last.current;
		if (prev && prev.home !== home && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			const dy = prev.dockTop - dockRect.top;
			if (Math.abs(dy) > 2) {
				dock.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: home ? 300 : 460, easing: GLIDE });
			}
			for (const g of home ? [] : prev.ghosts) {
				const el = g.el;
				el.classList.add('oc-leaving');
				el.style.cssText = `position:absolute;top:${g.top}px;left:${g.left}px;width:${g.width}px;margin:0;pointer-events:none;`;
				stage.appendChild(el);
				el.animate(
					[{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: `translateY(${g.below ? 14 : -8}px) scale(0.985)`, filter: 'blur(3px)' }],
					{ duration: 220, easing: EASE_OUT, fill: 'forwards' },
				).onfinish = () => el.remove();
			}
		}
		capture(home);
	}, [home, staged, capture]);
	return { stageRef, dockRef };
}

function crossesHelp(s: State, nextId: string): boolean {
	const cur = s.activeId ? s.chats[s.activeId] : undefined;
	const next = s.chats[nextId];
	return !!cur && !!next && cur.id !== next.id && (cur.mode === 'help') !== (next.mode === 'help');
}

export function App(): ReactElement {
	const [state, dispatch] = useReducer(reducer, undefined, initialState);
	const [editingId, setEditingId] = useState<string | undefined>(undefined);
	const stateRef = useRef<State>(state);
	stateRef.current = state;

	useEffect(() => {
		persistState = () => saveUiState({ drafts: stateRef.current.drafts, scroll: scrollPositions, connectHidden: stateRef.current.connectHidden });
		// While a transition is swapping chats, later messages wait their turn, so a draft or a pill meant
		// for the new chat never lands on the old one.
		let pending: Promise<void> | undefined;
		const apply = (m: HostMessageExt): void => {
			// Into and out of Help the whole panel dissolves into the other look instead of cutting.
			if (m.type === 'activeChat' && crossesHelp(stateRef.current, m.chatId)) {
				const doc = document as Document & { startViewTransition?: (cb: () => void) => { updateCallbackDone: Promise<void> } };
				if (doc.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
					try {
						const vt = doc.startViewTransition(() => flushSync(() => dispatch({ kind: 'host', m })));
						const done = vt.updateCallbackDone.catch(() => dispatch({ kind: 'host', m }));
						pending = done.then(() => { if (pending === done) { pending = undefined; } });
						return;
					} catch { /* no transition: plain switch below */ }
				}
			}
			dispatch({ kind: 'host', m });
		};
		const off = onHostMessage(m => {
			if (pending) { const p = pending.then(() => apply(m)); pending = p; return; }
			apply(m);
		});
		post({ type: 'ready' });
		post({ type: 'requestSlashCommands' });
		post({ type: 'requestActiveEditor' });
		return off;
	}, []);

	useEffect(() => { saveUiState({ drafts: state.drafts, scroll: scrollPositions, connectHidden: state.connectHidden }); }, [state.drafts, state.connectHidden]);

	// Esc stops the agent even when the input does not have focus.
	useEffect(() => {
		const h = (e: KeyboardEvent): void => {
			// Esc during an IME composition cancels the composition, not the agent.
			if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) { return; }
			const s = stateRef.current;
			const chat = s.activeId ? s.chats[s.activeId] : undefined;
			// Esc in another field (the chat list search, a rename, an edit box) belongs to that field
			const t = e.target as HTMLElement | null;
			const otherField = !!t && (t.tagName === 'INPUT' || (t.tagName === 'TEXTAREA' && !t.closest('.oc-composer')));
			if (otherField && chat && (chat.status === 'running' || chat.status === 'awaiting-approval')) { return; }
			if (chat && (chat.status === 'running' || chat.status === 'awaiting-approval') && s.view === 'chat') { post({ type: 'stop', chatId: chat.id }); return; }
			// Esc is also the way out of Help, once nothing else (a menu, a running answer, a rename) wanted it.
			if (chat?.mode === 'help' && s.view === 'chat' && !e.isComposing && !otherField) { e.preventDefault(); post({ type: 'leaveHelp' }); }
		};
		window.addEventListener('keydown', h);
		return () => window.removeEventListener('keydown', h);
	}, []);

	useEffect(() => { setEditingId(undefined); }, [state.activeId]);

	// The host turns the keybinding context on only while this panel really has focus.
	useEffect(() => {
		const send = (focused: boolean): void => post({ type: 'chatFocus', focused });
		const on = (): void => send(true);
		const off = (): void => send(false);
		window.addEventListener('focus', on);
		window.addEventListener('blur', off);
		if (document.hasFocus()) { on(); }
		return () => { window.removeEventListener('focus', on); window.removeEventListener('blur', off); };
	}, []);

	const shown = useRef<Chat | undefined>(undefined);
	const chat = (state.activeId ? state.chats[state.activeId] : undefined) ?? (state.ready ? shown.current : undefined);
	shown.current = chat;
	const wide = useWide();
	const isHome = !!chat && chat.messages.length === 0;
	const { stageRef, dockRef } = useStageMotion(isHome, state.ready && !!chat && state.view !== 'history');
	// Coming back to the start screen, the connect panel waits until the composer has glided into
	// place; building it mid-glide is what made the first New chat stutter.
	const [connectReady, setConnectReady] = useState(true);
	const wasHome = useRef(isHome);
	useLayoutEffect(() => {
		const entering = isHome && !wasHome.current;
		wasHome.current = isHome;
		if (!entering) { return; }
		setConnectReady(false);
		const t = setTimeout(() => setConnectReady(true), 360);
		return () => clearTimeout(t);
	}, [isHome]);

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
				<Loader />
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
	const home = chat.messages.length === 0;
	// Untouched chats are not worth listing; the open one still shows so you can see where you are.
	const listed = state.summaries.filter(s => s.id === state.activeId || s.title !== 'New chat');
	const recent = listed.filter(s => s.id !== chat.id && s.updatedAt > 0).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);
	const effectiveChat: Chat = chat.mode === mode ? chat : { ...chat, mode };
	const hasModel = state.models.some(m => m.hasKey);
	const help = mode === 'help' && state.view === 'chat';
	const starters = buildStarters({
		hasFolder: !!state.workspaceName,
		hasModel,
		recent: recent[0],
		onPick: pickChat,
		onMode: (m, text) => {
			setMode(m);
			dispatch({ kind: 'host', m: { type: 'focusInput', text } });
		},
	});

	return (
		<div className={'oc-app' + (wide ? ' is-wide' : '') + (help ? ' is-help' : '')} style={{ ['--oc-font-size' as string]: state.settings.fontSize ? state.settings.fontSize + 'px' : undefined }}>
			{wide ? null : <Header summaries={state.summaries} openIds={state.openIds} activeId={state.activeId} view={state.view} onView={v => dispatch({ kind: 'view', view: v })} />}
			<div className="oc-body">
			{wide ? (
				<aside className="oc-rail" aria-label="Chats">
					<button type="button" className="oc-rail-new" onClick={() => { post({ type: 'newChat' }); dispatch({ kind: 'view', view: 'chat' }); }}>
						<Icon name="plus" size={14} /> New chat
					</button>
					<History summaries={listed} activeId={state.activeId} onPick={pickChat} autoFocus={false} />
					<footer className="oc-rail-foot">
						<button type="button" className="oc-rail-link" onClick={() => post({ type: 'workbench', action: 'showEditor' })} title="Bring back the editor and files">
							<Icon name="code" size={14} /> Show editor
						</button>
						<button type="button" className="oc-iconbtn" title="OpenCursor settings" aria-label="Settings" onClick={() => post({ type: 'openSettings' })}>
							<Icon name="gear" size={15} />
						</button>
					</footer>
				</aside>
			) : null}
			{state.view === 'history' && !wide ? (
				<History summaries={listed} activeId={state.activeId} onPick={pickChat} />
			) : (
				<div className={'oc-stage' + (home ? ' is-home' : '')} ref={stageRef}>
					{help ? <HelpBar /> : null}
					{home && help ? <HelpTop /> : home ? (
						<HomeTop workspaceName={state.workspaceName} />
					) : (
						<MessageList chat={chat} showThinking={state.settings.showThinking} editingId={editingId} setEditingId={setEditingId} scrollTo={editingId} />
					)}
					<div className="oc-dock" ref={dockRef}>
						{chat.todos.length > 0 ? <TodoTray todos={chat.todos} /> : null}
						{chat.queued.length > 0 ? <QueueTray chat={chat} /> : null}
						{(() => { const mine = state.pendingEdits.filter(f => !f.chatId || f.chatId === chat.id); return mine.length > 0 ? <ReviewBar files={mine} chatId={chat.id} /> : null; })()}
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
							onConnect={() => {
								dispatch({ kind: 'connectHidden', hidden: false });
								if (!home) { post({ type: 'newChat' }); }
							}}
						/>
					</div>
					{home && help ? (
						<HelpBottom hasModel={hasModel} onAsk={q => post({ type: 'send', chatId: chat.id, text: q, context: [], mode: 'help', modelId })} />
					) : home ? (
						<HomeBottom
							starters={starters}
							recent={recent.slice(1)}
							onPick={pickChat}
							connect={connectReady && (!hasModel || !state.connectHidden) ? (
								<ConnectBlock
									agents={state.agents}
									local={state.local}
									trusted={state.trusted}
									providers={state.providers}
									results={state.connectResults}
									modelId={modelId}
									needed={!hasModel}
									onUse={setModel}
									onHide={() => dispatch({ kind: 'connectHidden', hidden: true })}
								/>
							) : null}
						/>
					) : null}
				</div>
			)}
			</div>
		</div>
	);
}
