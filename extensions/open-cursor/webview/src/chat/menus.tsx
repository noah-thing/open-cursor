/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Small popover menus: mode picker, model picker.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react';
import type { ChatMode, ModelOption } from '../../../src/shared/protocol';
import { Icon } from '../common/icons';
import { post } from './host';
import { MODE_META, MODE_ORDER, fuzzyScore, providerLabel } from './util';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? '⌘' : 'Ctrl+';

/** Closes on outside pointer down or Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
	useEffect(() => {
		if (!open) { return; }
		const down = (e: MouseEvent): void => {
			if (ref.current && !ref.current.contains(e.target as Node)) { onClose(); }
		};
		const key = (e: globalThis.KeyboardEvent): void => {
			if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
		};
		document.addEventListener('mousedown', down, true);
		document.addEventListener('keydown', key, true);
		return () => {
			document.removeEventListener('mousedown', down, true);
			document.removeEventListener('keydown', key, true);
		};
	}, [ref, open, onClose]);
}

/**
 * A menu anchored to its trigger. With `fit`, it opens toward whichever side has room and never runs
 * past the panel edge: the composer can sit in the middle of the start screen or at the very bottom.
 */
export function Popover({ children, className, direction = 'up', align = 'start', fit = false }: {
	readonly children: ReactNode;
	readonly className?: string;
	readonly direction?: 'up' | 'down';
	readonly align?: 'start' | 'end';
	readonly fit?: boolean;
}): ReactElement {
	const ref = useRef<HTMLDivElement>(null);
	const [placed, setPlaced] = useState<{ dir: 'up' | 'down'; max: number } | undefined>(undefined);
	useLayoutEffect(() => {
		const el = ref.current;
		const anchor = el?.parentElement;
		if (!fit || !el || !anchor) { return; }
		const r = anchor.getBoundingClientRect();
		const box = (anchor.closest('.oc-stage') ?? document.documentElement).getBoundingClientRect();
		const above = r.top - Math.max(0, box.top) - 10;
		const below = Math.min(window.innerHeight, box.bottom) - r.bottom - 10;
		const cap = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
		const want = Math.min(el.scrollHeight, cap);
		const dir = want <= above || above >= below ? 'up' : 'down';
		setPlaced({ dir, max: Math.max(140, Math.min(cap, dir === 'up' ? above : below)) });
	}, [fit]);
	const dir = placed?.dir ?? direction;
	return (
		<div
			ref={ref}
			className={'oc-popover is-' + dir + ' is-' + align + (className ? ' ' + className : '')}
			style={placed ? { maxHeight: placed.max } : undefined}
			role="menu"
		>
			{children}
		</div>
	);
}

export function ModeMenu({ mode, onSelect }: { readonly mode: ChatMode; readonly onSelect: (m: ChatMode) => void }): ReactElement {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useDismiss(ref, open, () => setOpen(false));
	const meta = MODE_META[mode];
	return (
		<div className="oc-menu-wrap" ref={ref}>
			<button type="button" className={'oc-chip oc-mode-chip is-' + mode} onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} title={'Mode: ' + meta.label + '  (' + MOD + '. to switch)'}>
				<Icon name={meta.icon} size={13} />
				<span>{meta.label}</span>
				<Icon name="chevronDown" size={10} className="oc-chip-chev" />
			</button>
			{open ? (
				<Popover className="oc-mode-menu" fit>
					{MODE_ORDER.map(m => {
						const mm = MODE_META[m];
						return (
							<button
								key={m}
								type="button"
								role="menuitemradio"
								aria-checked={m === mode}
								className={'oc-menu-item is-' + m + (m === mode ? ' is-active' : '')}
								onClick={() => { onSelect(m); setOpen(false); }}
							>
								<Icon name={mm.icon} size={14} className="oc-menu-icon" />
								<span className="oc-menu-main">
									<span className="oc-menu-label">{mm.label}</span>
									<span className="oc-menu-hint">{mm.hint}</span>
								</span>
								{m === mode ? <Icon name="check" size={13} className="oc-menu-check" /> : null}
							</button>
						);
					})}
					<div className="oc-menu-foot">{MOD}. cycles modes</div>
				</Popover>
			) : null}
		</div>
	);
}

const AGENT_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok', 'gemini-cli': 'Gemini CLI' };
const LOCAL = new Set(['ollama', 'lmstudio']);

function agentOf(m: ModelOption): string | undefined {
	return m.id.startsWith('cli:') ? m.id.slice(4, m.id.indexOf('/')) : undefined;
}

type Row =
	| { readonly kind: 'model'; readonly m: ModelOption }
	| { readonly kind: 'connect'; readonly key: string; readonly label: string; readonly subscription: boolean };

interface Section { readonly title: string; readonly groups: { readonly key: string; readonly name?: string; readonly rows: Row[] }[] }

/** Subscriptions first, then local models, then API keys; whatever is not connected collapses to one row per provider. */
function buildSections(models: readonly ModelOption[], query: string): Section[] {
	const q = query.trim();
	const score = (m: ModelOption): number => q ? Math.max(fuzzyScore(q, m.label), fuzzyScore(q, m.id) - 5, fuzzyScore(q, providerLabel(m.provider)) - 10) : 0;
	const hits = models.map(m => ({ m, s: score(m) })).filter(x => x.s >= 0).sort((a, b) => q ? b.s - a.s : 0).map(x => x.m);
	const byGroup = (list: ModelOption[], keyOf: (m: ModelOption) => string, nameOf: (k: string) => string): Section['groups'] => {
		const map = new Map<string, Row[]>();
		for (const m of list) {
			const k = keyOf(m);
			map.set(k, [...(map.get(k) ?? []), { kind: 'model', m }]);
		}
		return [...map.entries()].map(([key, rows]) => ({ key, name: nameOf(key), rows }));
	};
	const ready = hits.filter(m => m.hasKey);
	const subs = ready.filter(m => agentOf(m));
	const local = ready.filter(m => !agentOf(m) && LOCAL.has(m.provider));
	const api = ready.filter(m => !agentOf(m) && !LOCAL.has(m.provider));
	const out: Section[] = [];
	if (subs.length) { out.push({ title: 'Your subscriptions', groups: byGroup(subs, m => agentOf(m)!, k => AGENT_NAMES[k] ?? k) }); }
	if (local.length) { out.push({ title: 'Local models', groups: byGroup(local, m => m.provider, providerLabel) }); }
	if (api.length) { out.push({ title: 'API keys', groups: byGroup(api, m => m.provider, providerLabel) }); }
	const missing = new Map<string, Row>();
	for (const m of hits.filter(x => !x.hasKey)) {
		const agent = agentOf(m);
		const key = agent ? 'cli:' + agent : m.provider;
		if (!missing.has(key)) {
			missing.set(key, { kind: 'connect', key, label: agent ? (AGENT_NAMES[agent] ?? agent) : providerLabel(m.provider) + ' API', subscription: !!agent });
		}
	}
	if (missing.size) { out.push({ title: 'Not connected', groups: [{ key: 'missing', rows: [...missing.values()] }] }); }
	return out;
}

export function ModelMenu({ models, modelId, onSelect, onConnect }: {
	readonly models: readonly ModelOption[];
	readonly modelId: string;
	readonly onSelect: (id: string) => void;
	readonly onConnect: () => void;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [index, setIndex] = useState(0);
	const ref = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const byKey = useRef(false);
	useDismiss(ref, open, () => { setOpen(false); setQuery(''); });

	const current = models.find(m => m.id === modelId);
	const sections = useMemo(() => buildSections(models, query), [models, query]);
	const rows = useMemo(() => sections.flatMap(s => s.groups.flatMap(g => g.rows)), [sections]);

	useEffect(() => { setIndex(0); }, [query, open]);
	useEffect(() => {
		if (!byKey.current) { return; }
		byKey.current = false;
		listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [index]);

	const close = (): void => { setOpen(false); setQuery(''); };
	const choose = (r: Row): void => {
		if (r.kind === 'connect') {
			post({ type: 'openSettings', section: r.subscription ? 'subscriptions' : 'models' });
		} else {
			onSelect(r.m.id);
		}
		close();
	};
	const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === 'ArrowDown') { e.preventDefault(); byKey.current = true; setIndex(i => Math.min(rows.length - 1, i + 1)); }
		else if (e.key === 'ArrowUp') { e.preventDefault(); byKey.current = true; setIndex(i => Math.max(0, i - 1)); }
		else if (e.key === 'Enter') { e.preventDefault(); const r = rows[index]; if (r) { choose(r); } }
	};

	let rowIndex = -1;
	const agent = current ? agentOf(current) : undefined;
	const label = current?.label ?? (modelId ? modelId.split('/').pop() : 'Choose model');
	return (
		<div className="oc-menu-wrap" ref={ref}>
			<button type="button" className={'oc-chip oc-model-chip' + (current && !current.hasKey ? ' is-unready' : '')} onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open} title={current ? current.label + (agent ? ' (your subscription)' : ' (' + providerLabel(current.provider) + ')') : 'Choose a model'}>
				{current && !current.hasKey ? <Icon name="warning" size={11} /> : null}
				<span className="oc-chip-text">{label}</span>
				<Icon name="chevronDown" size={10} className="oc-chip-chev" />
			</button>
			{open ? (
				<Popover className="oc-model-menu" fit>
					<div className="oc-menu-search">
						<Icon name="search" size={13} />
						<input autoFocus value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKey} placeholder="Search models" aria-label="Search models" spellCheck={false} />
					</div>
					<div className="oc-menu-list" ref={listRef} role="listbox">
						{rows.length === 0 ? <div className="oc-menu-empty">No models match</div> : null}
						{sections.map(sec => (
							<section key={sec.title} className="oc-menu-section">
								<div className="oc-menu-section-title">{sec.title}</div>
								{sec.groups.map(g => (
									<div key={g.key} className="oc-menu-group">
										{g.name ? <div className="oc-menu-group-label">{g.name}</div> : null}
										{g.rows.map(r => {
											rowIndex += 1;
											const idx = rowIndex;
											const hot = idx === index;
											if (r.kind === 'connect') {
												return (
													<div key={r.key} role="option" aria-selected={false} data-active={hot} className={'oc-menu-item is-connect' + (hot ? ' is-hot' : '')} onMouseEnter={() => setIndex(idx)} onClick={() => choose(r)}>
														<Icon name={r.subscription ? 'user' : 'key'} size={13} className="oc-menu-icon" />
														<span className="oc-menu-main"><span className="oc-menu-label">{r.label}</span></span>
														<span className="oc-menu-cta">{r.subscription ? 'Sign in' : 'Add key'}</span>
													</div>
												);
											}
											const m = r.m;
											return (
												<div key={m.id} role="option" aria-selected={m.id === modelId} data-active={hot} className={'oc-menu-item' + (m.id === modelId ? ' is-active' : '') + (hot ? ' is-hot' : '')} onMouseEnter={() => setIndex(idx)} onClick={() => choose(r)}>
													<span className="oc-menu-main"><span className="oc-menu-label">{agentOf(m) ? m.label.slice(m.label.indexOf(':') + 1).trim() : m.label}</span></span>
													{m.supportsThinking ? <span className="oc-tag" title="Supports extended thinking">think</span> : null}
													{m.supportsImages ? <Icon name="image" size={12} className="oc-menu-sub" /> : null}
													{m.id === modelId ? <Icon name="check" size={13} className="oc-menu-check" /> : null}
												</div>
											);
										})}
									</div>
								))}
							</section>
						))}
					</div>
					<button type="button" className="oc-menu-footer" onClick={() => { onConnect(); close(); }}>
						<Icon name="gear" size={13} />
						<span>Connect models and subscriptions</span>
					</button>
				</Popover>
			) : null}
		</div>
	);
}
