/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Small popover menus: mode picker, model picker, command permissions.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react';
import type { ChatMode, Effort, ModelOption, UiSettings } from '../../../src/shared/protocol';
import { Icon } from '../common/icons';
import { post } from './host';
import { MODE_META, MODE_ORDER, fuzzyScore, providerLabel } from './util';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = IS_MAC ? '⌘' : 'Ctrl+';

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
	const [shift, setShift] = useState(0);
	// Keep the menu inside the panel sideways too: a narrow chat would otherwise cut its right edge off.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) { return; }
		const r = el.getBoundingClientRect();
		const over = r.right - (window.innerWidth - 8);
		const under = 8 - r.left;
		setShift(over > 0 ? -Math.min(over, Math.max(0, r.left - 8)) : under > 0 ? under : 0);
	}, []);
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
			style={placed || shift ? { maxHeight: placed?.max, translate: shift ? `${shift}px 0` : undefined } : undefined}
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

type AutoRun = UiSettings['autoRun'];

const PERMISSIONS: readonly { readonly id: AutoRun; readonly label: string; readonly short: string; readonly hint: string }[] = [
	{ id: 'ask', label: 'Ask every time', short: 'Ask', hint: 'Every command waits for you' },
	{ id: 'allowlist', label: 'Allowlist', short: 'Allowlist', hint: 'Commands on your allowlist run, the rest ask' },
	{ id: 'auto', label: 'Auto', short: 'Auto', hint: 'Safe commands run; it asks before deleting, installing or going online' },
	{ id: 'always', label: 'Full access', short: 'Full access', hint: 'Every command and tool runs without asking' },
];

/** When the agent may run a command without asking. One setting for every chat; file edits never ask. */
/** What a subscription CLI does with the levels below Full access, where it cannot pause for the user. */
function cliPermissionNote(modelId: string, autoRun: AutoRun): string | undefined {
	if (autoRun === 'always' || !modelId.startsWith('cli:')) { return undefined; }
	const agent = modelId.slice(4, modelId.indexOf('/'));
	if (agent === 'claude-code') { return undefined; }
	if (agent === 'codex') { return autoRun === 'ask' ? 'Codex cannot stop to ask, so in Ask it runs no commands.' : 'Codex cannot stop to ask, so its commands run in a sandbox that can only change this project and cannot go online. Deleted files show up for review.'; }
	const name = AGENT_NAMES[agent] ?? 'This CLI';
	if (autoRun === 'allowlist') { return `${name} cannot stop to ask, so here Allowlist works like Auto: it runs commands, but deleting, installing or going online is refused.`; }
	return `${name} cannot stop to ask, so a command that needs your approval is refused instead.`;
}

export function PermissionMenu({ autoRun, modelId }: { readonly autoRun: AutoRun; readonly modelId: string }): ReactElement {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useDismiss(ref, open, () => setOpen(false));
	const cur = PERMISSIONS.find(p => p.id === autoRun) ?? PERMISSIONS[1];
	const note = cliPermissionNote(modelId, autoRun);
	return (
		<div className="oc-menu-wrap" ref={ref}>
			<button type="button" className={'oc-chip oc-perm-chip is-' + cur.id} onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} title={'Commands: ' + cur.label}>
				<Icon name={cur.id === 'always' ? 'bolt' : cur.id === 'ask' ? 'shield' : 'shieldCheck'} size={13} />
				<span className="oc-perm-label">{cur.short}</span>
			</button>
			{open ? (
				<Popover className="oc-perm-menu" align="end" fit>
					<div className="oc-menu-section-title">Running commands</div>
					{PERMISSIONS.map(p => (
						<button
							key={p.id}
							type="button"
							role="menuitemradio"
							aria-checked={p.id === autoRun}
							className={'oc-menu-item is-' + p.id + (p.id === autoRun ? ' is-active' : '')}
							onClick={() => { post({ type: 'setAutoRun', autoRun: p.id }); setOpen(false); }}
						>
							<span className="oc-menu-main">
								<span className="oc-menu-label">{p.label}</span>
								<span className="oc-menu-hint">{p.hint}</span>
							</span>
							{p.id === autoRun ? <Icon name="check" size={13} className="oc-menu-check" /> : null}
						</button>
					))}
					<div className="oc-menu-foot">
						{note ? <span className="oc-perm-note">{note}</span> : null}
						File edits never ask; you keep or undo them. The denylist always asks.{' '}
						<button type="button" className="oc-linkbtn" onClick={() => { post({ type: 'openSettings', section: 'general' }); setOpen(false); }}>Edit lists</button>
					</div>
				</Popover>
			) : null}
		</div>
	);
}

const EFFORTS: readonly { readonly id: Effort; readonly label: string; readonly hint: string }[] = [
	{ id: 'auto', label: 'Auto', hint: 'High on API models; CLIs keep their own default' },
	{ id: 'off', label: 'Off', hint: 'Answers straight away, no thinking' },
	{ id: 'low', label: 'Low', hint: 'Short thinking, faster answers' },
	{ id: 'medium', label: 'Medium', hint: 'A middle amount of thinking' },
	{ id: 'high', label: 'High', hint: 'Long thinking for harder work' },
	{ id: 'max', label: 'Max', hint: 'The most the model allows' },
];

/** CLIs that take a level from us; the others choose their own. */
const EFFORT_AGENTS = new Set(['claude-code', 'codex', 'opencode']);

/** Shown only for a model that can think, or a CLI that takes a level. One setting for every chat. */
export function EffortMenu({ effort, model }: { readonly effort: Effort; readonly model: ModelOption | undefined }): ReactElement | null {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useDismiss(ref, open, () => setOpen(false));
	const agent = model ? agentOf(model) : undefined;
	if (!model || (agent ? !EFFORT_AGENTS.has(agent) : !model.supportsThinking)) { return null; }
	// a CLI cannot switch thinking off; its lowest level is Low
	const options = agent ? EFFORTS.filter(e => e.id !== 'off') : EFFORTS;
	const cur = options.find(e => e.id === effort) ?? (agent && effort === 'off' ? options.find(e => e.id === 'low')! : options[0]);
	return (
		<div className="oc-menu-wrap" ref={ref}>
			<button type="button" className={'oc-chip oc-effort-chip is-' + cur.id} onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} title={'Thinking effort: ' + cur.label}>
				<Icon name="gauge" size={13} />
				<span className="oc-perm-label">{cur.label}</span>
			</button>
			{open ? (
				<Popover className="oc-perm-menu" align="end" fit>
					<div className="oc-menu-section-title">Thinking effort</div>
					{options.map(e => (
						<button
							key={e.id}
							type="button"
							role="menuitemradio"
							aria-checked={e.id === cur.id}
							className={'oc-menu-item' + (e.id === cur.id ? ' is-active' : '')}
							onClick={() => { post({ type: 'setEffort', effort: e.id }); setOpen(false); }}
						>
							<span className="oc-menu-main">
								<span className="oc-menu-label">{e.label}</span>
								<span className="oc-menu-hint">{e.hint}</span>
							</span>
							{e.id === cur.id ? <Icon name="check" size={13} className="oc-menu-check" /> : null}
						</button>
					))}
					<div className="oc-menu-foot">More effort gives better answers on hard problems and takes longer. It applies to every chat.</div>
				</Popover>
			) : null}
		</div>
	);
}

const AGENT_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok', 'gemini-cli': 'Gemini CLI', opencode: 'OpenCode' };
const LOCAL = new Set(['ollama', 'lmstudio']);

function agentOf(m: ModelOption): string | undefined {
	return m.id.startsWith('cli:') ? m.id.slice(4, m.id.indexOf('/')) : undefined;
}

type Row =
	| { readonly kind: 'model'; readonly m: ModelOption }
	| { readonly kind: 'connect'; readonly key: string; readonly label: string; readonly subscription: boolean }
	/** OpenCode is not installed yet: one row that leads to the Free models page, where it installs in one click. */
	| { readonly kind: 'get-free'; readonly key: string; readonly label: string; readonly detail: string };

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
	const free = ready.filter(m => m.free);
	const paid = ready.filter(m => !m.free);
	const subs = paid.filter(m => agentOf(m));
	const local = paid.filter(m => !agentOf(m) && LOCAL.has(m.provider));
	const api = paid.filter(m => !agentOf(m) && !LOCAL.has(m.provider));
	const out: Section[] = [];
	// Free first: Free (auto), then OpenCode's no-account models, then free models on keys the user added.
	const freeKey = (m: ModelOption): string => m.provider === 'free' ? 'auto' : agentOf(m) ?? m.provider;
	const freeOrder = (k: string): number => k === 'auto' ? 0 : k === 'opencode' ? 1 : 2;
	const freeGroups = byGroup([...free].sort((a, b) => freeOrder(freeKey(a)) - freeOrder(freeKey(b))), freeKey, k => k === 'auto' ? '' : AGENT_NAMES[k] ?? providerLabel(k));
	const hasOpenCode = models.some(m => agentOf(m) === 'opencode');
	if (!hasOpenCode && (!q || fuzzyScore(q, 'opencode free') >= 0)) {
		freeGroups.push({ key: 'get-opencode', rows: [{ kind: 'get-free', key: 'get-opencode', label: 'OpenCode', detail: 'Free models, no account' }] });
	}
	// A model on this computer, offered until one is running in Ollama.
	const hasLocal = models.some(m => m.provider === 'ollama' && m.hasKey);
	if (!hasLocal && (!q || fuzzyScore(q, 'local ollama offline computer') >= 0)) {
		freeGroups.push({ key: 'get-local', rows: [{ kind: 'get-free', key: 'get-local', label: 'On this computer', detail: 'Private, works offline' }] });
	}
	if (freeGroups.length) { out.push({ title: 'Free', groups: freeGroups }); }
	if (subs.length) { out.push({ title: 'Your subscriptions', groups: byGroup(subs, m => agentOf(m)!, k => AGENT_NAMES[k] ?? k) }); }
	if (local.length) { out.push({ title: 'Local models', groups: byGroup(local, m => m.provider, providerLabel) }); }
	if (api.length) { out.push({ title: 'API keys', groups: byGroup(api, m => m.provider, providerLabel) }); }
	const missing = new Map<string, Row>();
	// Free (auto) is not a provider to sign up for; the Free section and its Get row cover it.
	for (const m of hits.filter(x => !x.hasKey && x.provider !== 'free')) {
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
		} else if (r.kind === 'get-free') {
			post({ type: 'helpAction', href: r.key === 'get-local' ? 'opencursor:free-models/local' : 'opencursor:free-models/install' });
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
											if (r.kind === 'get-free') {
												return (
													<div key={r.key} role="option" aria-selected={false} data-active={hot} className={'oc-menu-item is-connect' + (hot ? ' is-hot' : '')} onMouseEnter={() => setIndex(idx)} onClick={() => choose(r)}>
														<Icon name="sparkle" size={13} className="oc-menu-icon oc-holo-icon" />
														<span className="oc-menu-main"><span className="oc-menu-label">{r.label}</span><span className="oc-menu-hint">{r.detail}</span></span>
														<span className="oc-menu-cta oc-holo">Get</span>
													</div>
												);
											}
											const m = r.m;
											return (
												<div key={m.id} role="option" aria-selected={m.id === modelId} data-active={hot} className={'oc-menu-item' + (m.id === modelId ? ' is-active' : '') + (hot ? ' is-hot' : '')} onMouseEnter={() => setIndex(idx)} onClick={() => choose(r)}>
													<span className="oc-menu-main"><span className="oc-menu-label">{agentOf(m) ? m.label.slice(m.label.indexOf(':') + 1).trim() : m.label}</span></span>
													{m.free ? <span className="oc-tag is-free" title="Costs nothing">Free</span> : null}
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
					<div className="oc-menu-footer-row">
						<button type="button" className="oc-menu-footer" onClick={() => { onConnect(); close(); }}>
							<Icon name="gear" size={13} />
							<span>Connect models</span>
						</button>
						<button type="button" className="oc-menu-footer is-free" onClick={() => { post({ type: 'helpAction', href: 'opencursor:free-models' }); close(); }}>
							<Icon name="sparkle" size={13} className="oc-holo-icon" />
							<span className="oc-holo">Get free models</span>
						</button>
					</div>
				</Popover>
			) : null}
		</div>
	);
}
