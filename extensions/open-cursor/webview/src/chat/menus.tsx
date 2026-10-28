/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Small popover menus: mode picker, model picker.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react';
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

export function Popover({ children, className, direction = 'up', align = 'start' }: {
	readonly children: ReactNode;
	readonly className?: string;
	readonly direction?: 'up' | 'down';
	readonly align?: 'start' | 'end';
}): ReactElement {
	return <div className={'oc-popover is-' + direction + ' is-' + align + (className ? ' ' + className : '')} role="menu">{children}</div>;
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
				<Popover className="oc-mode-menu">
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

function groupKey(m: ModelOption): string {
	if (m.id.startsWith('cli:')) { return 'cli:' + m.provider; }
	return m.provider;
}

function groupName(key: string): string {
	if (key.startsWith('cli:')) {
		const p = key.slice(4);
		const names: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI' };
		return (names[p] ?? providerLabel(p)) + ' (subscription)';
	}
	return providerLabel(key);
}

export function ModelMenu({ models, modelId, onSelect }: {
	readonly models: readonly ModelOption[];
	readonly modelId: string;
	readonly onSelect: (id: string) => void;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [index, setIndex] = useState(0);
	const ref = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	useDismiss(ref, open, () => { setOpen(false); setQuery(''); });

	const current = models.find(m => m.id === modelId);
	const flat = useMemo(() => {
		const q = query.trim();
		const scored = models
			.map(m => ({ m, s: q ? Math.max(fuzzyScore(q, m.label), fuzzyScore(q, m.id) - 5, fuzzyScore(q, providerLabel(m.provider)) - 10) : 0 }))
			.filter(x => x.s >= 0);
		const groups = new Map<string, { m: ModelOption; s: number }[]>();
		for (const x of scored) {
			const k = groupKey(x.m);
			const list = groups.get(k) ?? [];
			list.push(x);
			groups.set(k, list);
		}
		const ordered = [...groups.entries()].sort((a, b) => {
			const ak = a[1].some(x => x.m.hasKey) ? 0 : 1;
			const bk = b[1].some(x => x.m.hasKey) ? 0 : 1;
			return ak - bk;
		});
		return ordered.map(([key, items]) => ({ key, name: groupName(key), items: q ? [...items].sort((a, b) => b.s - a.s).map(x => x.m) : items.map(x => x.m) }));
	}, [models, query]);
	const rows = useMemo(() => flat.flatMap(g => g.items), [flat]);

	useEffect(() => { setIndex(0); }, [query, open]);
	useEffect(() => {
		listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [index]);

	const pick = (m: ModelOption): void => {
		if (!m.hasKey) { return; }
		onSelect(m.id);
		setOpen(false);
		setQuery('');
	};
	const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(rows.length - 1, i + 1)); }
		else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)); }
		else if (e.key === 'Enter') { e.preventDefault(); const m = rows[index]; if (m) { pick(m); } }
	};

	let rowIndex = -1;
	const label = current?.label ?? (modelId ? modelId.split('/').pop() : 'Choose model');
	return (
		<div className="oc-menu-wrap" ref={ref}>
			<button type="button" className="oc-chip oc-model-chip" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open} title={current ? current.label + ' (' + providerLabel(current.provider) + ')' : 'Choose a model'}>
				<span className="oc-chip-text">{label}</span>
				<Icon name="chevronDown" size={10} className="oc-chip-chev" />
			</button>
			{open ? (
				<Popover className="oc-model-menu">
					<div className="oc-menu-search">
						<Icon name="search" size={13} />
						<input autoFocus value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKey} placeholder="Search models" aria-label="Search models" spellCheck={false} />
					</div>
					<div className="oc-menu-list" ref={listRef} role="listbox">
						{flat.length === 0 ? <div className="oc-menu-empty">No models match</div> : null}
						{flat.map(g => (
							<div key={g.key} className="oc-menu-group">
								<div className="oc-menu-group-label">{g.name}</div>
								{g.items.map(m => {
									rowIndex += 1;
									const idx = rowIndex;
									return (
										<div
											key={m.id}
											role="option"
											aria-selected={m.id === modelId}
											aria-disabled={!m.hasKey}
											data-active={idx === index}
											className={'oc-menu-item' + (m.id === modelId ? ' is-active' : '') + (!m.hasKey ? ' is-dim' : '') + (idx === index ? ' is-hot' : '')}
											onMouseEnter={() => setIndex(idx)}
											onClick={() => pick(m)}
										>
											<span className="oc-menu-main"><span className="oc-menu-label">{m.label}</span></span>
											{m.supportsThinking ? <span className="oc-tag" title="Supports extended thinking">think</span> : null}
											{m.supportsImages ? <Icon name="image" size={12} className="oc-menu-sub" /> : null}
											{!m.hasKey ? (
												<button
													type="button"
													className="oc-linkbtn"
													onClick={e => { e.stopPropagation(); post({ type: 'openSettings', section: 'models' }); setOpen(false); }}
												>
													{m.id.startsWith('cli:') ? 'Set up' : 'Add key'}
												</button>
											) : m.id === modelId ? <Icon name="check" size={13} className="oc-menu-check" /> : null}
										</div>
									);
								})}
							</div>
						))}
					</div>
					<button type="button" className="oc-menu-footer" onClick={() => { post({ type: 'openSettings', section: 'models' }); setOpen(false); }}>
						<Icon name="gear" size={13} />
						<span>Manage models</span>
					</button>
				</Popover>
			) : null}
		</div>
	);
}
