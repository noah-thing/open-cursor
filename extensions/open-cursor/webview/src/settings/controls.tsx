/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Form controls for the settings page.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { Icon } from '../common/icons';

export function Page({ title, lead, children }: { readonly title: string; readonly lead?: string; readonly children: ReactNode }): ReactElement {
	return (
		<div className="st-page">
			<h1 className="st-h1">{title}</h1>
			{lead ? <p className="st-lead">{lead}</p> : null}
			{children}
		</div>
	);
}

export function Group({ title, hint, actions, children }: { readonly title?: string; readonly hint?: string; readonly actions?: ReactNode; readonly children: ReactNode }): ReactElement {
	return (
		<section className="st-group">
			{title ? (
				<header className="st-group-head">
					<div>
						<h2 className="st-h2">{title}</h2>
						{hint ? <p className="st-hint">{hint}</p> : null}
					</div>
					{actions ? <div className="st-group-actions">{actions}</div> : null}
				</header>
			) : null}
			<div className="st-card">{children}</div>
		</section>
	);
}

export function Row({ label, desc, children, stacked, disabled }: {
	readonly label: ReactNode;
	readonly desc?: ReactNode;
	readonly children?: ReactNode;
	readonly stacked?: boolean;
	readonly disabled?: boolean;
}): ReactElement {
	return (
		<div className={'st-row' + (stacked ? ' is-stacked' : '') + (disabled ? ' is-disabled' : '')}>
			<div className="st-row-text">
				<div className="st-row-label">{label}</div>
				{desc ? <div className="st-row-desc">{desc}</div> : null}
			</div>
			{children ? <div className="st-row-control">{children}</div> : null}
		</div>
	);
}

export function Toggle({ checked, onChange, label, disabled }: {
	readonly checked: boolean;
	readonly onChange: (v: boolean) => void;
	readonly label: string;
	readonly disabled?: boolean;
}): ReactElement {
	return (
		<button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={'st-switch' + (checked ? ' is-on' : '')} onClick={() => onChange(!checked)}>
			<span className="st-switch-knob" />
		</button>
	);
}

export function Select<T extends string>({ value, options, onChange, label, width }: {
	readonly value: T;
	readonly options: readonly { value: T; label: string; group?: string }[];
	readonly onChange: (v: T) => void;
	readonly label: string;
	readonly width?: number;
}): ReactElement {
	const groups = new Map<string, { value: T; label: string }[]>();
	for (const o of options) {
		const g = o.group ?? '';
		const list = groups.get(g) ?? [];
		list.push(o);
		groups.set(g, list);
	}
	return (
		<span className="st-select" style={width ? { width } : undefined}>
			<select value={value} aria-label={label} onChange={e => onChange(e.target.value as T)}>
				{[...groups.entries()].map(([g, list]) => g ? (
					<optgroup key={g} label={g}>
						{list.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
					</optgroup>
				) : list.map(o => <option key={o.value} value={o.value}>{o.label}</option>))}
			</select>
			<Icon name="chevronDown" size={11} className="st-select-chev" />
		</span>
	);
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
	readonly value: T;
	readonly options: readonly { value: T; label: string }[];
	readonly onChange: (v: T) => void;
	readonly label: string;
}): ReactElement {
	return (
		<div className="st-seg" role="radiogroup" aria-label={label}>
			{options.map(o => (
				<button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'is-on' : ''} onClick={() => onChange(o.value)}>
					{o.label}
				</button>
			))}
		</div>
	);
}

/** Text field that commits on blur or Enter, so every keystroke is not a settings.json write. */
export function TextField({ value, onCommit, placeholder, width, mono, label, type = 'text', list }: {
	readonly value: string;
	readonly onCommit: (v: string) => void;
	readonly placeholder?: string;
	readonly width?: number | string;
	readonly mono?: boolean;
	readonly label: string;
	readonly type?: 'text' | 'password';
	readonly list?: string;
}): ReactElement {
	const [draft, setDraft] = useState(value);
	useEffect(() => { setDraft(value); }, [value]);
	const commit = (): void => { if (draft !== value) { onCommit(draft); } };
	return (
		<input
			className={'st-input' + (mono ? ' is-mono' : '')}
			style={width ? { width } : undefined}
			type={type}
			list={list}
			value={draft}
			placeholder={placeholder}
			aria-label={label}
			spellCheck={false}
			autoComplete="off"
			onChange={e => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
				if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
				if (e.key === 'Escape') { setDraft(value); (e.target as HTMLInputElement).blur(); }
			}}
		/>
	);
}

export function NumberField({ value, onCommit, min, max, step, width = 84, label }: {
	readonly value: number;
	readonly onCommit: (v: number) => void;
	readonly min?: number;
	readonly max?: number;
	readonly step?: number;
	readonly width?: number;
	readonly label: string;
}): ReactElement {
	const [draft, setDraft] = useState(String(value));
	useEffect(() => { setDraft(String(value)); }, [value]);
	const commit = (): void => {
		let n = Number(draft);
		if (!Number.isFinite(n) || draft.trim() === '') { setDraft(String(value)); return; }
		if (min !== undefined) { n = Math.max(min, n); }
		if (max !== undefined) { n = Math.min(max, n); }
		setDraft(String(n));
		if (n !== value) { onCommit(n); }
	};
	return (
		<input
			className="st-input"
			style={{ width }}
			type="number"
			min={min}
			max={max}
			step={step}
			value={draft}
			aria-label={label}
			onChange={e => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={e => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); } }}
		/>
	);
}

export function TextArea({ value, onCommit, rows = 6, placeholder, label }: {
	readonly value: string;
	readonly onCommit: (v: string) => void;
	readonly rows?: number;
	readonly placeholder?: string;
	readonly label: string;
}): ReactElement {
	const [draft, setDraft] = useState(value);
	useEffect(() => { setDraft(value); }, [value]);
	return (
		<textarea
			className="st-textarea"
			rows={rows}
			value={draft}
			placeholder={placeholder}
			aria-label={label}
			spellCheck={false}
			onChange={e => setDraft(e.target.value)}
			onBlur={() => { if (draft !== value) { onCommit(draft); } }}
		/>
	);
}

export function ListEditor({ items, onChange, placeholder, label }: {
	readonly items: readonly string[];
	readonly onChange: (items: string[]) => void;
	readonly placeholder: string;
	readonly label: string;
}): ReactElement {
	const [draft, setDraft] = useState('');
	const add = (): void => {
		const v = draft.trim();
		if (v && !items.includes(v)) { onChange([...items, v]); }
		setDraft('');
	};
	return (
		<div className="st-list">
			{items.length ? (
				<ul className="st-chips">
					{items.map(it => (
						<li key={it} className="st-chip">
							<code>{it}</code>
							<button type="button" aria-label={'Remove ' + it} onClick={() => onChange(items.filter(x => x !== it))}><Icon name="x" size={10} /></button>
						</li>
					))}
				</ul>
			) : null}
			<div className="st-list-add">
				<input
					className="st-input is-mono"
					value={draft}
					placeholder={placeholder}
					aria-label={label}
					spellCheck={false}
					onChange={e => setDraft(e.target.value)}
					onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
				/>
				<button type="button" className="st-btn" onClick={add} disabled={!draft.trim()}>Add</button>
			</div>
		</div>
	);
}

export function Button({ children, onClick, primary, danger, disabled, small, title }: {
	readonly children: ReactNode;
	readonly onClick: () => void;
	readonly primary?: boolean;
	readonly danger?: boolean;
	readonly disabled?: boolean;
	readonly small?: boolean;
	readonly title?: string;
}): ReactElement {
	return (
		<button type="button" title={title} disabled={disabled} className={'st-btn' + (primary ? ' is-primary' : '') + (danger ? ' is-danger' : '') + (small ? ' is-sm' : '')} onClick={onClick}>
			{children}
		</button>
	);
}

export function StatusDot({ kind, label }: { readonly kind: 'ok' | 'warn' | 'error' | 'idle' | 'busy'; readonly label?: string }): ReactElement {
	return <span className={'st-dot is-' + kind} role={label ? 'img' : undefined} aria-label={label} title={label} />;
}

export function Empty({ children }: { readonly children: ReactNode }): ReactElement {
	return <div className="st-empty">{children}</div>;
}
