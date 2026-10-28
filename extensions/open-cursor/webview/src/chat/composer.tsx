/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  The composer: auto-growing input, @ mentions, / commands, context pills, mode and model pickers.
 *--------------------------------------------------------------------------------------------*/

import {
	useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
	type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactElement,
} from 'react';
import type { Chat, ChatMode, ContextItem, ContextKind, ModelOption, SlashCommandInfo, UiSettings } from '../../../src/shared/protocol';
import { Icon } from '../common/icons';
import { MOD, ModeMenu, ModelMenu } from './menus';
import { onHostMessage, post } from './host';
import { ContextPill } from './parts';
import { KIND_ICON, KIND_LABEL, MODE_META, MODE_ORDER, formatTokens, fuzzyScore, localId } from './util';

interface Category { readonly kind: ContextKind; readonly label: string; readonly hint: string }

const CATEGORIES: Category[] = [
	{ kind: 'file', label: 'Files', hint: 'Search the workspace' },
	{ kind: 'folder', label: 'Folders', hint: 'Add a whole directory' },
	{ kind: 'code', label: 'Code', hint: 'Symbols and line ranges' },
	{ kind: 'docs', label: 'Docs', hint: 'A documentation URL' },
	{ kind: 'git', label: 'Git', hint: 'Working tree or a commit' },
	{ kind: 'chat', label: 'Past chats', hint: 'Bring in an earlier chat' },
	{ kind: 'terminal', label: 'Terminal', hint: 'Last output or selection' },
	{ kind: 'lints', label: 'Lints', hint: 'Current problems' },
	{ kind: 'web', label: 'Web', hint: 'Let the agent search the web' },
	{ kind: 'rule', label: 'Rules', hint: 'Attach a rule file' },
];

interface MentionState {
	readonly start: number; // index of '@'
	readonly query: string;
	readonly kind?: ContextKind;
}

const BUILTIN_SLASH: (SlashCommandInfo & { builtin: true })[] = [
	{ name: 'new', description: 'Start a new chat', source: 'built in', builtin: true },
	{ name: 'history', description: 'Browse past chats', source: 'built in', builtin: true },
	{ name: 'settings', description: 'Open OpenCursor settings', source: 'built in', builtin: true },
];

let mentionSeq = 0;

function ContextRing({ usage }: { readonly usage: NonNullable<Chat['contextUsage']> }): ReactElement {
	const pct = Math.max(0, Math.min(1, usage.limit > 0 ? usage.used / usage.limit : 0));
	const r = 6;
	const c = 2 * Math.PI * r;
	const level = pct > 0.9 ? 'is-high' : pct > 0.7 ? 'is-mid' : '';
	return (
		<span className={'oc-ring ' + level} title={Math.round(pct * 100) + '% of context used (' + formatTokens(usage.used) + ' of ' + formatTokens(usage.limit) + ' tokens)'} role="img" aria-label={Math.round(pct * 100) + ' percent of context used'}>
			<svg width="16" height="16" viewBox="0 0 16 16">
				<circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
				<circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${(c * Math.max(pct, 0.02)).toFixed(2)} ${c.toFixed(2)}`} transform="rotate(-90 8 8)" />
			</svg>
		</span>
	);
}

export function Composer({ chat, models, settings, mode, modelId, text, contexts, activeFile, suggestDismissed, slash, hasUsableModel, focusNonce, onText, onContexts, onMode, onModel, onEditLast, onDismissSuggest, onOpenHistory, onNewChat, onConnect }: {
	readonly chat: Chat;
	readonly models: readonly ModelOption[];
	readonly settings: UiSettings;
	readonly mode: ChatMode;
	readonly modelId: string;
	readonly text: string;
	readonly contexts: readonly ContextItem[];
	readonly activeFile: ContextItem | null;
	readonly suggestDismissed: boolean;
	readonly slash: readonly SlashCommandInfo[];
	readonly hasUsableModel: boolean;
	readonly focusNonce: number;
	readonly onText: (t: string) => void;
	readonly onContexts: (items: ContextItem[]) => void;
	readonly onMode: (m: ChatMode) => void;
	readonly onModel: (id: string) => void;
	readonly onEditLast: () => boolean;
	readonly onDismissSuggest: (id: string) => void;
	readonly onOpenHistory: () => void;
	readonly onNewChat: () => void;
	/** Show every way to connect a model (the start screen panel). */
	readonly onConnect: () => void;
}): ReactElement {
	const ref = useRef<HTMLTextAreaElement>(null);
	const [caret, setCaret] = useState(0);
	const [mentionKind, setMentionKind] = useState<ContextKind | undefined>(undefined);
	const [items, setItems] = useState<ContextItem[]>([]);
	const [index, setIndex] = useState(0);
	const [dismissedAt, setDismissedAt] = useState<number | undefined>(undefined);
	const [dragging, setDragging] = useState(false);
	const reqId = useRef(0);
	const popupRef = useRef<HTMLDivElement>(null);
	const running = chat.status === 'running' || chat.status === 'awaiting-approval';

	// Auto grow.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) { return; }
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 220) + 'px';
	}, [text]);

	useEffect(() => {
		if (focusNonce > 0) {
			const el = ref.current;
			if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
		}
	}, [focusNonce]);

	// Focus when switching chats.
	useEffect(() => { ref.current?.focus({ preventScroll: true }); }, [chat.id]);

	// Trigger detection.
	const mention: MentionState | undefined = useMemo(() => {
		const before = text.slice(0, caret);
		const m = /(^|\s)@([^\s@]*)$/.exec(before);
		if (!m) { return undefined; }
		const start = before.length - m[2].length - 1;
		if (dismissedAt === start) { return undefined; }
		return { start, query: m[2], kind: mentionKind };
	}, [text, caret, mentionKind, dismissedAt]);

	const slashQuery = useMemo(() => {
		if (mention) { return undefined; }
		const m = /^\/([\w:.-]*)$/.exec(text);
		return m && caret === text.length && dismissedAt !== -2 ? m[1] : undefined;
	}, [text, caret, mention, dismissedAt]);

	useEffect(() => { if (!mention) { setMentionKind(undefined); } }, [mention]);

	// Mention search with a short debounce.
	useEffect(() => {
		if (!mention) { return; }
		const id = ++mentionSeq;
		reqId.current = id;
		const t = setTimeout(() => post({ type: 'searchMentions', requestId: id, query: mention.query, kind: mention.kind }), 50);
		return () => clearTimeout(t);
	}, [mention?.query, mention?.kind, !!mention]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => onHostMessage(m => {
		if (m.type === 'mentionResults' && m.requestId === reqId.current) {
			setItems(m.items);
			setIndex(0);
		}
	}), []);

	const showCategories = !!mention && !mention.kind && mention.query === '';
	type Row = { kind: 'cat'; cat: Category } | { kind: 'item'; item: ContextItem };
	const mentionRows: Row[] = useMemo(() => {
		if (!mention) { return []; }
		const rows: Row[] = [];
		if (showCategories) { for (const c of CATEGORIES) { rows.push({ kind: 'cat', cat: c }); } }
		for (const it of items.slice(0, showCategories ? 4 : 30)) { rows.push({ kind: 'item', item: it }); }
		return rows;
	}, [mention, showCategories, items]);

	const slashRows = useMemo(() => {
		if (slashQuery === undefined) { return []; }
		const all: (SlashCommandInfo & { builtin?: true })[] = [...slash, ...BUILTIN_SLASH.filter(b => !slash.some(s => s.name === b.name))];
		return all
			.map(c => ({ c, s: slashQuery ? fuzzyScore(slashQuery, c.name) : 0 }))
			.filter(x => x.s >= 0)
			.sort((a, b) => b.s - a.s)
			.map(x => x.c)
			.slice(0, 12);
	}, [slash, slashQuery]);

	const popupOpen = (mention && mentionRows.length > 0) || slashRows.length > 0;
	const rowCount = mention ? mentionRows.length : slashRows.length;
	useEffect(() => { setIndex(0); }, [mention?.query, mention?.kind, slashQuery]);
	useEffect(() => {
		popupRef.current?.querySelector('[data-hot="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [index, popupOpen]);

	const addContext = useCallback((item: ContextItem) => {
		if (contexts.some(c => c.id === item.id || (c.uri && c.uri === item.uri && c.label === item.label))) { return; }
		onContexts([...contexts, item]);
	}, [contexts, onContexts]);

	const replaceRange = (start: number, end: number, insert: string): void => {
		const next = text.slice(0, start) + insert + text.slice(end);
		onText(next);
		const pos = start + insert.length;
		requestAnimationFrame(() => {
			const el = ref.current;
			if (el) { el.focus(); el.setSelectionRange(pos, pos); setCaret(pos); }
		});
	};

	const pickMention = (row: Row): void => {
		if (!mention) { return; }
		const end = mention.start + 1 + mention.query.length;
		if (row.kind === 'cat') {
			setMentionKind(row.cat.kind);
			return;
		}
		addContext(row.item);
		const hasSpaceBefore = mention.start === 0 || /\s/.test(text[mention.start - 1] ?? ' ');
		replaceRange(hasSpaceBefore && mention.start > 0 ? mention.start - 1 : mention.start, end, '');
		setItems([]);
	};

	const pickSlash = (c: SlashCommandInfo & { builtin?: true }): void => {
		if (c.builtin) {
			onText('');
			if (c.name === 'new') { onNewChat(); }
			else if (c.name === 'history') { onOpenHistory(); }
			else if (c.name === 'settings') { post({ type: 'openSettings' }); }
			return;
		}
		replaceRange(0, text.length, '/' + c.name + ' ');
	};

	const submit = (): void => {
		const t = text.trim();
		if (!t && contexts.length === 0) { return; }
		if (running) {
			post({ type: 'queue', chatId: chat.id, text: t, context: [...contexts] });
		} else {
			post({ type: 'send', chatId: chat.id, text: t, context: [...contexts], mode, modelId });
		}
		onText('');
		onContexts([]);
	};

	const cycleMode = (dir: 1 | -1): void => {
		const i = MODE_ORDER.indexOf(mode);
		onMode(MODE_ORDER[(i + dir + MODE_ORDER.length) % MODE_ORDER.length]);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		const composing = e.nativeEvent.isComposing;
		if ((e.metaKey || e.ctrlKey) && e.key === '.') {
			e.preventDefault();
			cycleMode(e.shiftKey ? -1 : 1);
			return;
		}
		if (popupOpen && !composing) {
			if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => (i + 1) % rowCount); return; }
			if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => (i - 1 + rowCount) % rowCount); return; }
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				if (mention) { const r = mentionRows[index]; if (r) { pickMention(r); } }
				else { const c = slashRows[index]; if (c) { pickSlash(c); } }
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				if (mention) { setDismissedAt(mention.start); } else { setDismissedAt(-2); }
				return;
			}
			if (e.key === 'Backspace' && mention && mention.kind && mention.query === '') {
				setMentionKind(undefined);
			}
		}
		if (e.key === 'Enter' && !composing) {
			const send = settings.submitWithModEnter ? (e.metaKey || e.ctrlKey) : !e.shiftKey && !e.altKey;
			if (send) {
				e.preventDefault();
				submit();
				return;
			}
		}
		if (e.key === 'Escape' && running) {
			e.preventDefault();
			post({ type: 'stop', chatId: chat.id });
			return;
		}
		if (e.key === 'ArrowUp' && text === '' && !e.shiftKey && !e.metaKey && !e.altKey) {
			if (onEditLast()) { e.preventDefault(); }
			return;
		}
		if (e.key === 'Backspace' && ref.current && ref.current.selectionStart === 0 && ref.current.selectionEnd === 0 && contexts.length > 0 && text === '') {
			onContexts(contexts.slice(0, -1));
		}
	};

	const addImageFile = (file: File): void => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = String(reader.result);
			const name = file.name && file.name !== 'image.png' ? file.name : 'Pasted image';
			post({ type: 'pasteImage', dataUrl, name });
			onContexts([...contexts, { id: localId('img'), kind: 'image', label: name, content: dataUrl }]);
		};
		reader.readAsDataURL(file);
	};

	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
		const files = [...e.clipboardData.files].filter(f => f.type.startsWith('image/'));
		if (files.length) {
			e.preventDefault();
			files.forEach(addImageFile);
		}
	};

	const onDrop = (e: DragEvent<HTMLDivElement>): void => {
		setDragging(false);
		const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
		const uriList = e.dataTransfer.getData('text/uri-list');
		if (files.length) {
			e.preventDefault();
			files.forEach(addImageFile);
		} else if (uriList) {
			e.preventDefault();
			const added: ContextItem[] = [];
			for (const line of uriList.split(/\r?\n/)) {
				const u = line.trim();
				if (!u || u.startsWith('#')) { continue; }
				const label = decodeURIComponent(u.split('/').pop() ?? u);
				added.push({ id: 'drop:' + u, kind: /\/$/.test(u) ? 'folder' : 'file', label, uri: u });
			}
			if (added.length) { onContexts([...contexts, ...added.filter(a => !contexts.some(c => c.id === a.id))]); }
		}
	};

	const placeholder = running ? 'Queue a follow-up' : MODE_META[mode].placeholder;
	const suggest = activeFile && !suggestDismissed && !contexts.some(c => c.uri === activeFile.uri && c.kind === activeFile.kind) ? activeFile : null;
	const canSend = text.trim().length > 0 || contexts.length > 0;

	return (
		<div className="oc-composer-wrap">
			{!hasUsableModel ? (
				<div className="oc-notice">
					<span>No model is ready. Add an API key or sign in to an agent CLI.</span>
					<button type="button" className="oc-linkbtn" onClick={() => post({ type: 'openSettings', section: 'models' })}>Open settings</button>
				</div>
			) : null}
			<div
				className={'oc-composer is-' + mode + (dragging ? ' is-dragging' : '')}
				onDragOver={e => { if (e.dataTransfer.types.length) { e.preventDefault(); setDragging(true); } }}
				onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setDragging(false); } }}
				onDrop={onDrop}
			>
				{dragging ? <div className="oc-drop-hint" aria-hidden="true"><Icon name="plus" size={13} /> Drop to add as context</div> : null}
				{popupOpen ? (
					<div className="oc-popup" ref={popupRef} role="listbox" aria-label={mention ? 'Add context' : 'Commands'}>
						{mention ? (
							<>
								{mention.kind ? (
									<div className="oc-popup-head">
										<Icon name={KIND_ICON[mention.kind]} size={12} />
										<span>{KIND_LABEL[mention.kind]}</span>
										<button type="button" className="oc-linkbtn" onClick={() => setMentionKind(undefined)}>All</button>
									</div>
								) : null}
								{mentionRows.map((r, i) => r.kind === 'cat' ? (
									<div key={r.cat.kind} role="option" aria-selected={i === index} data-hot={i === index} className={'oc-popup-row' + (i === index ? ' is-hot' : '')} onMouseEnter={() => setIndex(i)} onMouseDown={e => { e.preventDefault(); pickMention(r); }}>
										<Icon name={KIND_ICON[r.cat.kind]} size={14} className="oc-popup-icon" />
										<span className="oc-popup-label">{r.cat.label}</span>
										<span className="oc-popup-detail">{r.cat.hint}</span>
										<Icon name="chevronRight" size={11} className="oc-popup-more" />
									</div>
								) : (
									<div key={r.item.id} role="option" aria-selected={i === index} data-hot={i === index} className={'oc-popup-row' + (i === index ? ' is-hot' : '')} onMouseEnter={() => setIndex(i)} onMouseDown={e => { e.preventDefault(); pickMention(r); }}>
										<Icon name={KIND_ICON[r.item.kind]} size={14} className="oc-popup-icon" />
										<span className="oc-popup-label">{r.item.label}</span>
										{r.item.detail ? <span className="oc-popup-detail is-rtl"><bdi>{r.item.detail}</bdi></span> : null}
									</div>
								))}
								{!showCategories && mentionRows.length === 0 ? <div className="oc-popup-empty">No matches</div> : null}
							</>
						) : (
							slashRows.map((c, i) => (
								<div key={c.name} role="option" aria-selected={i === index} data-hot={i === index} className={'oc-popup-row' + (i === index ? ' is-hot' : '')} onMouseEnter={() => setIndex(i)} onMouseDown={e => { e.preventDefault(); pickSlash(c); }}>
									<Icon name="slash" size={14} className="oc-popup-icon" />
									<span className="oc-popup-label">{c.name}</span>
									<span className="oc-popup-detail">{c.description}</span>
								</div>
							))
						)}
					</div>
				) : null}

				{contexts.length > 0 || suggest ? (
					<div className="oc-pills">
						{contexts.map(c => <ContextPill key={c.id} item={c} onRemove={() => onContexts(contexts.filter(x => x.id !== c.id))} />)}
						{suggest ? (
							<span className="oc-pill-suggest">
								<ContextPill item={suggest} suggested onClick={() => addContext(suggest)} />
								<button type="button" className="oc-pill-x is-suggest-x" aria-label="Dismiss suggestion" onClick={() => onDismissSuggest(suggest.id)}>
									<Icon name="x" size={10} />
								</button>
							</span>
						) : null}
					</div>
				) : null}

				<textarea
					ref={ref}
					className="oc-input"
					rows={1}
					value={text}
					placeholder={placeholder}
					aria-label="Message"
					spellCheck
					onChange={e => { onText(e.target.value); setCaret(e.target.selectionStart); setDismissedAt(undefined); }}
					onKeyDown={onKeyDown}
					onKeyUp={e => setCaret(e.currentTarget.selectionStart)}
					onClick={e => setCaret(e.currentTarget.selectionStart)}
					onSelect={e => setCaret(e.currentTarget.selectionStart)}
					onPaste={onPaste}
				/>

				<div className="oc-composer-bar">
					<ModeMenu mode={mode} onSelect={onMode} />
					<ModelMenu models={models} modelId={modelId} onSelect={onModel} onConnect={onConnect} />
					<span className="oc-spacer" />
					{chat.contextUsage ? <ContextRing usage={chat.contextUsage} /> : null}
					<button
						type="button"
						className="oc-iconbtn"
						title="Add context (@)"
						aria-label="Add context"
						onClick={() => {
							const el = ref.current;
							const pos = el?.selectionStart ?? text.length;
							const needsSpace = pos > 0 && !/\s/.test(text[pos - 1]);
							replaceRange(pos, pos, (needsSpace ? ' ' : '') + '@');
						}}
					>
						<Icon name="at" size={15} />
					</button>
					{running ? (
						<>
							{canSend ? (
								<button type="button" className="oc-send is-queue" title="Queue message (Enter)" aria-label="Queue message" onClick={submit}>
									<Icon name="arrowUp" size={14} />
								</button>
							) : null}
							<button type="button" className="oc-send is-stop" title="Stop (Esc)" aria-label="Stop" onClick={() => post({ type: 'stop', chatId: chat.id })}>
								<Icon name="stop" size={12} />
							</button>
						</>
					) : (
						<button
							type="button"
							className="oc-send"
							title={'Send (' + (settings.submitWithModEnter ? MOD + 'Enter' : 'Enter') + ')'}
							aria-label="Send"
							disabled={!canSend}
							onClick={submit}
						>
							<Icon name="arrowUp" size={14} />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
