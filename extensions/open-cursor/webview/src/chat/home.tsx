/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  The start screen of an empty chat: where you are above the composer, ways to begin below it.
 *  App renders the three pieces around one composer so the composer node never remounts and
 *  can glide from the middle of the panel to the bottom when the first message is sent.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import type { AgentStatus, ApiProviderStatus, ChatMode, ChatSummary, LocalServerStatus } from '../../../src/shared/protocol';
import { BrandMark, hasBrandMark } from '../common/brands';
import { Icon, Spinner, type IconName } from '../common/icons';
import { post } from './host';
import { MOD } from './menus';
import { MODE_META, relativeTime } from './util';

export interface Starter {
	readonly key: string;
	readonly icon: IconName;
	readonly title: string;
	readonly detail: string;
	readonly run: () => void;
}

/** Above the composer: the folder this chat works in. */
export function HomeTop({ workspaceName }: { readonly workspaceName: string | undefined }): ReactElement {
	return (
		<div className="oc-home-top">
			<button
				type="button"
				className="oc-place"
				title={workspaceName ? 'Switch folder' : 'Open a folder to work in'}
				onClick={() => post({ type: 'workbench', action: workspaceName ? 'openRecent' : 'openFolder' })}
			>
				<Icon name="folder" size={13} />
				<span className="oc-place-name">{workspaceName ?? 'No folder open'}</span>
				<Icon name="chevronDown" size={11} className="oc-chip-chev" />
			</button>
		</div>
	);
}

export function buildStarters({ hasFolder, hasModel, recent, onMode, onPick }: {
	readonly hasFolder: boolean;
	readonly hasModel: boolean;
	readonly recent: ChatSummary | undefined;
	readonly onMode: (mode: ChatMode, text?: string) => void;
	readonly onPick: (id: string) => void;
}): Starter[] {
	if (!hasModel) {
		// The connect block above says how to get a model; starting rows would only lead to an error.
		return [];
	}
	const rows: Starter[] = [];
	if (recent) {
		rows.push({ key: 'continue', icon: 'history', title: 'Continue', detail: recent.title || 'Last chat', run: () => onPick(recent.id) });
	}
	if (!hasFolder) {
		rows.push(
			{ key: 'open', icon: 'folder', title: 'Open a folder', detail: 'Work on a project on this computer', run: () => post({ type: 'workbench', action: 'openFolder' }) },
			{ key: 'clone', icon: 'git', title: 'Clone a repository', detail: 'From GitHub or any git URL', run: () => post({ type: 'workbench', action: 'cloneRepo' }) },
		);
		return rows;
	}
	rows.push(
		{ key: 'plan', icon: MODE_META.plan.icon, title: 'Start with a plan', detail: 'Agree on the approach before any code changes', run: () => onMode('plan') },
		{ key: 'debug', icon: MODE_META.debug.icon, title: 'Fix a bug', detail: 'Find the cause, then fix it step by step', run: () => onMode('debug') },
		{ key: 'tour', icon: MODE_META.ask.icon, title: 'Explain this codebase', detail: 'A short tour of how the project fits together', run: () => onMode('ask', 'Give me a short tour of this codebase: what it does, how it is laid out, and where to start reading.') },
	);
	return rows;
}

const ORDER = ['claude-code', 'codex', 'grok', 'gemini-cli'];

type Tab = 'subs' | 'local' | 'keys';

let lastConnectRequest = 0;
const TABS: { id: Tab; label: string }[] = [{ id: 'subs', label: 'Subscriptions' }, { id: 'local', label: 'Local' }, { id: 'keys', label: 'API keys' }];

function Logo({ id, fallback }: { readonly id: string; readonly fallback: IconName }): ReactElement {
	return <span className="oc-conn-logo" aria-hidden="true">{hasBrandMark(id) ? <BrandMark id={id} size={15} /> : <Icon name={fallback} size={14} />}</span>;
}

function hostOf(url: string): string {
	try { return new URL(url).host; } catch { return url; }
}

/** A button that shows it is working while the host answers. */
function Busy({ busy, children, ...rest }: { readonly busy: boolean; readonly children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement {
	return <button type="button" {...rest} disabled={busy || rest.disabled}>{busy ? <Spinner size={11} /> : null}{children}</button>;
}

/**
 * Every way to give OpenCursor a model, in one place: subscriptions you already pay for (agent CLIs),
 * local models on this computer or another one on the network, and API keys typed in place.
 */
export function ConnectBlock({ agents, local, providers, results, modelId, needed, onUse, onHide }: {
	readonly agents: readonly AgentStatus[];
	readonly local: readonly LocalServerStatus[] | undefined;
	readonly providers: readonly ApiProviderStatus[] | undefined;
	readonly results: Readonly<Record<string, { ok: boolean; message: string }>>;
	readonly modelId: string;
	/** No model can run yet: the panel cannot be put away. */
	readonly needed: boolean;
	readonly onUse: (modelId: string) => void;
	readonly onHide: () => void;
}): ReactElement {
	const [tab, setTab] = useState<Tab>(() => agents.some(a => a.installed) ? 'subs' : 'local');
	const [busy, setBusy] = useState<Record<string, boolean>>({});
	// Probing servers takes a moment and re-lays out the panel; do it once in a while, not on every visit.
	useEffect(() => {
		if (local && Date.now() - lastConnectRequest < 30_000) { return; }
		lastConnectRequest = Date.now();
		post({ type: 'requestConnect' });
	}, []); // eslint-disable-line react-hooks/exhaustive-deps
	// A result arriving ends the wait for that target.
	useEffect(() => { setBusy(b => { const n = { ...b }; for (const k of Object.keys(results)) { delete n[k]; } return n; }); }, [results]);

	// The pill under the active tab slides to it; the body eases to the new height.
	const segRef = useRef<HTMLDivElement>(null);
	const [pill, setPill] = useState<{ x: number; w: number } | undefined>(undefined);
	useLayoutEffect(() => {
		const btn = segRef.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
		if (btn) { setPill({ x: btn.offsetLeft, w: btn.offsetWidth }); }
	}, [tab]);
	const bodyRef = useRef<HTMLDivElement>(null);
	const innerRef = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState<number | undefined>(undefined);
	useLayoutEffect(() => {
		const inner = innerRef.current;
		if (!inner || typeof ResizeObserver === 'undefined') { return; }
		const ro = new ResizeObserver(() => setHeight(inner.offsetHeight));
		ro.observe(inner);
		return () => ro.disconnect();
	}, []);

	const start = (key: string): void => setBusy(b => ({ ...b, [key]: true }));
	const inUse = (id?: string): boolean => !!id && id === modelId;

	return (
		<section className="oc-connect" aria-label="Connect a model">
			<header className="oc-connect-head">
				<div className="oc-connect-titles">
					<span className="oc-connect-title">{needed ? 'Connect a model to start' : 'Models'}</span>
					<span className="oc-connect-sub">Use what you already have: a subscription, a model on your computer or network, or an API key.</span>
				</div>
				{needed ? null : <button type="button" className="oc-iconbtn" title="Hide" aria-label="Hide" onClick={onHide}><Icon name="x" size={13} /></button>}
			</header>
			<div className="oc-seg" role="tablist" ref={segRef}>
				{pill ? <span className="oc-seg-pill" style={{ transform: `translateX(${pill.x}px)`, width: pill.w }} aria-hidden="true" /> : null}
				{TABS.map(t => (
					<button key={t.id} type="button" role="tab" data-tab={t.id} aria-selected={tab === t.id} className={'oc-seg-tab' + (tab === t.id ? ' is-on' : '')} onClick={() => setTab(t.id)}>
						{t.label}
					</button>
				))}
			</div>
			<div className="oc-connect-body" ref={bodyRef} style={height !== undefined ? { height } : undefined}>
				<div ref={innerRef}>
					<div key={tab} className="oc-connect-pane">
						{tab === 'subs' ? (
							<ul className="oc-conn-list">
								{[...agents].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id)).map((a, i) => {
									const using = !!a.modelId && modelId.startsWith('cli:' + a.id + '/');
									const ready = a.installed && a.loggedIn !== false;
									return (
										<li key={a.id} className={'oc-conn-row' + (ready ? ' is-ready' : '')} style={{ ['--i' as string]: i }}>
											<Logo id={a.id} fallback="terminal" />
											<span className="oc-conn-name">{a.label}</span>
											<span className={'oc-conn-status' + (ready ? ' is-ok' : '')}>{!a.installed ? 'Not installed' : a.loggedIn === false ? 'Not signed in' : using ? 'In use' : 'Signed in'}</span>
											{using ? <Icon name="check" size={13} className="oc-conn-check" />
												: ready && a.modelId ? <button type="button" className="oc-btn is-sm" onClick={() => onUse(a.modelId!)}>Use</button>
													: a.installed ? <button type="button" className="oc-btn is-sm" onClick={() => post({ type: 'agentAction', id: a.id, action: 'signIn' })}>Sign in</button>
														: <button type="button" className="oc-btn is-sm is-ghost" onClick={() => post({ type: 'agentAction', id: a.id, action: 'install' })}>Install</button>}
										</li>
									);
								})}
								<li className="oc-conn-note">
									Signed in somewhere else? <button type="button" className="oc-linkbtn" onClick={() => post({ type: 'agentAction', id: '', action: 'refresh' })}>Check again</button>
								</li>
							</ul>
						) : tab === 'local' ? (
							<LocalPane local={local} result={results['server']} busy={!!busy['server']} onStart={() => start('server')} inUse={inUse} onUse={onUse} />
						) : (
							<KeysPane providers={providers} results={results} busy={busy} onStart={start} inUse={inUse} onUse={onUse} />
						)}
					</div>
				</div>
			</div>
		</section>
	);
}

function LocalPane({ local, result, busy, onStart, inUse, onUse }: {
	readonly local: readonly LocalServerStatus[] | undefined;
	readonly result: { ok: boolean; message: string } | undefined;
	readonly busy: boolean;
	readonly onStart: () => void;
	readonly inUse: (id?: string) => boolean;
	readonly onUse: (id: string) => void;
}): ReactElement {
	const [address, setAddress] = useState('');
	const rows = (local ?? []).filter(s => s.id !== 'custom' || s.configured);
	const connect = (): void => {
		if (!address.trim() || busy) { return; }
		onStart();
		post({ type: 'connectServer', address });
	};
	return (
		<div>
			<ul className="oc-conn-list">
				{local === undefined ? <li className="oc-conn-row is-loading"><Spinner size={12} /><span className="oc-conn-status">Looking for model servers</span></li> : null}
				{rows.map((s, i) => (
					<li key={s.id} className={'oc-conn-row' + (s.reachable ? ' is-ready' : '')} style={{ ['--i' as string]: i }}>
						<Logo id={s.id} fallback="cube" />
						<span className="oc-conn-name">{s.label}{s.remote ? <span className="oc-conn-where"> on {hostOf(s.baseUrl)}</span> : null}</span>
						<span className={'oc-conn-status' + (s.reachable ? ' is-ok' : '')}>
							{s.reachable ? `${s.models} ${s.models === 1 ? 'model' : 'models'}` : s.remote ? 'Not reachable' : 'Not running'}
						</span>
						{s.reachable && s.modelId ? (inUse(s.modelId) ? <Icon name="check" size={13} className="oc-conn-check" /> : <button type="button" className="oc-btn is-sm" onClick={() => onUse(s.modelId!)}>Use</button>)
							: !s.remote && s.id !== 'custom' ? <button type="button" className="oc-btn is-sm is-ghost" onClick={() => post({ type: 'localApp', id: s.id as 'ollama' | 'lmstudio' })}>{s.id === 'ollama' ? 'Start' : 'Open'}</button>
								: <span />}
						{s.configured ? <button type="button" className="oc-iconbtn oc-conn-x" title="Use this computer again" aria-label={'Disconnect ' + s.label} onClick={() => post({ type: 'resetServer', id: s.id })}><Icon name="x" size={12} /></button> : null}
					</li>
				))}
			</ul>
			<div className="oc-conn-remote">
				<div className="oc-conn-remote-label">Model on another computer</div>
				<div className="oc-conn-field">
					<Icon name="globe" size={13} />
					<input
						value={address}
						onChange={e => setAddress(e.target.value)}
						onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); connect(); } }}
						placeholder="mac-mini.local or 192.168.1.20:11434"
						aria-label="Address of a model server"
						spellCheck={false}
					/>
					<Busy busy={busy} className="oc-btn is-sm is-primary" onClick={connect} disabled={!address.trim()}>Connect</Busy>
				</div>
				{result ? <div key={result.message} className={'oc-conn-result' + (result.ok ? ' is-ok' : ' is-err')}>{result.message}</div>
					: <div className="oc-conn-hint">Ollama, LM Studio or any OpenAI-compatible server on your network or Tailscale.</div>}
			</div>
		</div>
	);
}

function KeysPane({ providers, results, busy, onStart, inUse, onUse }: {
	readonly providers: readonly ApiProviderStatus[] | undefined;
	readonly results: Readonly<Record<string, { ok: boolean; message: string }>>;
	readonly busy: Readonly<Record<string, boolean>>;
	readonly onStart: (key: string) => void;
	readonly inUse: (id?: string) => boolean;
	readonly onUse: (id: string) => void;
}): ReactElement {
	const [open, setOpen] = useState<string | undefined>(undefined);
	const [key, setKey] = useState('');
	const save = (id: string): void => {
		if (!key.trim() || busy[id]) { return; }
		onStart(id);
		post({ type: 'connectKey', provider: id, key });
	};
	// A key that verified closes its form.
	useEffect(() => { if (open && results[open]?.ok) { setOpen(undefined); setKey(''); } }, [results, open]);
	if (!providers) { return <ul className="oc-conn-list"><li className="oc-conn-row is-loading"><Spinner size={12} /><span className="oc-conn-status">Loading providers</span></li></ul>; }
	return (
		<ul className="oc-conn-list">
			{providers.map((p, i) => (
				<li key={p.id} className={'oc-conn-item' + (open === p.id ? ' is-open' : '')} style={{ ['--i' as string]: i }}>
					<div className={'oc-conn-row' + (p.hasKey ? ' is-ready' : '')}>
						<Logo id={p.id} fallback="key" />
						<span className="oc-conn-name">{p.label}</span>
						<span className={'oc-conn-status' + (p.hasKey ? ' is-ok' : '')}>{p.hasKey ? (inUse(p.modelId) ? 'In use' : 'Key saved') : ''}</span>
						{p.hasKey && p.modelId ? (inUse(p.modelId) ? <Icon name="check" size={13} className="oc-conn-check" /> : <button type="button" className="oc-btn is-sm" onClick={() => onUse(p.modelId!)}>Use</button>)
							: <button type="button" className="oc-btn is-sm is-ghost" aria-expanded={open === p.id} onClick={() => { setOpen(open === p.id ? undefined : p.id); setKey(''); }}>{p.hasKey ? 'Change' : 'Add key'}</button>}
					</div>
					{open === p.id ? (
						<div className="oc-conn-keyform">
							<div className="oc-conn-field">
								<Icon name="key" size={13} />
								<input
									type="password"
									autoFocus
									value={key}
									onChange={e => setKey(e.target.value)}
									onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save(p.id); } else if (e.key === 'Escape') { setOpen(undefined); } }}
									placeholder={'Paste your ' + p.label + ' API key'}
									aria-label={p.label + ' API key'}
									spellCheck={false}
									autoComplete="off"
								/>
								<Busy busy={!!busy[p.id]} className="oc-btn is-sm is-primary" onClick={() => save(p.id)} disabled={!key.trim()}>Save</Busy>
							</div>
							{results[p.id] && !results[p.id].ok ? <div className="oc-conn-result is-err">{results[p.id].message}</div>
								: <div className="oc-conn-hint">Stored in your system keychain and checked with {p.label} before use.</div>}
						</div>
					) : null}
				</li>
			))}
		</ul>
	);
}

/** Below the composer: ways to begin, recent chats and the three keys worth knowing. */
export function HomeBottom({ starters, recent, onPick, connect }: {
	readonly starters: readonly Starter[];
	readonly recent: readonly ChatSummary[];
	readonly onPick: (id: string) => void;
	readonly connect?: ReactElement | null;
}): ReactElement {
	return (
		<div className="oc-home-bottom">
			{connect}
			<ul className="oc-starters">
				{starters.map((s, i) => (
					<li key={s.key} style={{ ['--i' as string]: i }}>
						<button type="button" className="oc-starter" onClick={s.run}>
							<Icon name={s.icon} size={14} className="oc-starter-icon" />
							<span className="oc-starter-title">{s.title}</span>
							<span className="oc-starter-detail">{s.detail}</span>
							<Icon name="arrowRight" size={12} className="oc-starter-go" />
						</button>
					</li>
				))}
			</ul>
			{recent.length ? (
				<section className="oc-home-recent" style={{ ['--i' as string]: starters.length }}>
					<h3 className="oc-home-label">Recent</h3>
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
				</section>
			) : null}
			<p className="oc-home-keys" style={{ ['--i' as string]: starters.length + 1 }}>
				<span><kbd>@</kbd> context</span>
				<span><kbd>/</kbd> commands</span>
				<span><kbd>{MOD}.</kbd> modes</span>
			</p>
		</div>
	);
}
