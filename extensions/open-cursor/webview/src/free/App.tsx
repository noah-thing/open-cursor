/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState, type ReactElement } from 'react';
import type { FreeCard, FreeHostMessage, FreeWebviewMessage, OpenCodeState } from '../../../src/connect/freeProtocol';
import { BrandMark, hasBrandMark } from '../common/brands';
import { Icon, Spinner } from '../common/icons';
import { Loader } from '../common/loader';
import { getVsCode } from '../common/vscode';

const vscode = getVsCode<FreeWebviewMessage, unknown>();
const post = (m: FreeWebviewMessage): void => vscode.postMessage(m);

interface Result { readonly ok: boolean; readonly message: string }

function Logo({ id, size = 18 }: { readonly id: string; readonly size?: number }): ReactElement {
	return <span className="fm-logo" aria-hidden="true">{hasBrandMark(id) ? <BrandMark id={id} size={size} /> : <Icon name="key" size={size - 3} />}</span>;
}

function Check(): ReactElement {
	return (
		<svg className="fm-check" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function OpenCodeCard({ oc, active, busy, result, act }: {
	readonly act: (m: FreeWebviewMessage) => void;
	readonly oc: OpenCodeState;
	readonly active: string;
	readonly busy: boolean;
	readonly result: Result | undefined;
}): ReactElement {
	const models = oc.models.slice(0, 6);
	return (
		<section className="fm-hero" style={{ ['--i' as string]: 0 }}>
			<div className="fm-hero-head">
				<Logo id="opencode" size={20} />
				<div className="fm-hero-titles">
					<div className="fm-hero-title">OpenCode <span className="fm-tag">Free</span></div>
					<div className="fm-hero-sub">{oc.installed ? 'Pick a model and start. No account, no key.' : 'Free models with nothing to sign up for. One click installs it.'}</div>
				</div>
				{oc.installed ? <span className="fm-status is-on"><Check /> Ready</span> : (
					<button type="button" className="fm-btn is-primary" disabled={busy || oc.installing} onClick={() => act({ type: 'installOpenCode' })}>
						{busy || oc.installing ? <><Spinner size={12} /> Installing</> : 'Get OpenCode'}
					</button>
				)}
			</div>
			{oc.installed && models.length ? (
				<ul className="fm-models">
					{models.map((m, i) => {
						const on = m.id === active;
						return (
							<li key={m.id} style={{ ['--i' as string]: i }}>
								<button type="button" className={'fm-model' + (on ? ' is-on' : '')} onClick={() => act({ type: 'use', modelId: m.id })}>
									<span className="fm-model-name">{m.label}</span>
									{on ? <span className="fm-model-act"><Check /> In use</span> : <span className="fm-model-act">Use</span>}
								</button>
							</li>
						);
					})}
				</ul>
			) : null}
			{result && !result.ok ? <div className="fm-result is-err">{result.message}</div> : null}
			<div className="fm-hero-foot">Some free models may use prompts to improve the model.</div>
		</section>
	);
}

function KeyCard({ card, index, open, onToggle, busy, result, act }: {
	readonly act: (m: FreeWebviewMessage) => void;
	readonly card: FreeCard;
	readonly index: number;
	readonly open: boolean;
	readonly onToggle: () => void;
	readonly busy: boolean;
	readonly result: Result | undefined;
}): ReactElement {
	const [typing, setTyping] = useState(false);
	const [key, setKey] = useState('');
	useEffect(() => { if (result?.ok) { setTyping(false); setKey(''); } }, [result]);
	return (
		<li className={'fm-card' + (open ? ' is-open' : '') + (card.connected ? ' is-connected' : '')} style={{ ['--i' as string]: index }}>
			<button type="button" className="fm-card-head" aria-expanded={open} onClick={onToggle}>
				<Logo id={card.id} />
				<span className="fm-card-titles">
					<span className="fm-card-name">{card.name}</span>
					<span className="fm-card-models">{card.models.join(', ')}</span>
				</span>
				{card.connected ? <span className="fm-status is-on"><Check /> Connected</span> : <span className="fm-status">Add</span>}
				<Icon name="chevronDown" size={12} className="fm-chev" />
			</button>
			<div className="fm-card-body">
				<div className="fm-card-inner">
					<div className="fm-facts">
						<span>{card.limits}</span>
						{card.privacy ? <span className={'fm-privacy is-' + card.privacy.tone}>{card.privacy.text}</span> : null}
					</div>
					{card.connected ? (
						<div className="fm-row">
							<span className="fm-done"><Check /> {result?.ok && result.message !== 'Connected' ? result.message : 'Connected and ready.'}</span>
							<button type="button" className="fm-link" onClick={() => act({ type: 'disconnect', id: card.id })}>Disconnect</button>
						</div>
					) : (
						<>
							{card.oauth ? (
								<div className="fm-oauth">
									<button type="button" className="fm-btn is-primary" disabled={busy} onClick={() => act({ type: 'oauth', id: card.id })}>
										{busy ? <><Spinner size={12} /> Waiting for the browser</> : `Connect with ${card.name}`}
									</button>
									<span className="fm-or">Sign in, approve, done. No key to copy.</span>
								</div>
							) : null}
							<ol className="fm-steps">
								<li>
									<span className="fm-n">1</span>
									<button type="button" className="fm-btn" onClick={() => act({ type: 'open', url: card.keyUrl })}>Open the key page <Icon name="external" size={11} /></button>
									<button type="button" className="fm-link" onClick={() => act({ type: 'open', url: card.signupUrl })}>No account? Sign up</button>
								</li>
								<li>
									<span className="fm-n">2</span>
									<span className="fm-step-text">{card.steps.join(', then ')}</span>
								</li>
								<li>
									<span className="fm-n">3</span>
									{typing ? (
										<form className="fm-field" onSubmit={e => { e.preventDefault(); if (key.trim()) { act({ type: 'key', id: card.id, key }); } }}>
											<input type="password" autoFocus value={key} onChange={e => setKey(e.target.value)} placeholder={`${card.name} API key`} aria-label={`${card.name} API key`} spellCheck={false} autoComplete="off" />
											<button type="submit" className="fm-btn is-primary" disabled={busy || !key.trim()}>{busy ? <Spinner size={12} /> : 'Connect'}</button>
										</form>
									) : (
										<>
											<button type="button" className="fm-btn is-primary" disabled={busy} onClick={() => act({ type: 'paste', id: card.id })}>
												{busy ? <><Spinner size={12} /> Checking</> : 'Paste key'}
											</button>
											<button type="button" className="fm-link" onClick={() => setTyping(true)}>or type it</button>
										</>
									)}
								</li>
							</ol>
							{result && !result.ok ? <div key={result.message} className="fm-result is-err">{result.message}</div> : null}
						</>
					)}
				</div>
			</div>
		</li>
	);
}

export function App(): ReactElement {
	const [cards, setCards] = useState<FreeCard[] | undefined>(undefined);
	const [oc, setOc] = useState<OpenCodeState>({ installed: false, installing: false, models: [] });
	const [active, setActive] = useState('');
	const [open, setOpen] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState<Record<string, boolean>>({});
	const [results, setResults] = useState<Record<string, Result>>({});

	useEffect(() => {
		const onMessage = (e: MessageEvent<FreeHostMessage>): void => {
			const m = e.data;
			if (m.type === 'state') {
				setCards(m.cards);
				setOc(m.opencode);
				setActive(m.activeModel);
			} else if (m.type === 'result') {
				setBusy(b => ({ ...b, [m.id]: false }));
				setResults(r => ({ ...r, [m.id]: { ok: m.ok, message: m.message } }));
			}
		};
		window.addEventListener('message', onMessage);
		post({ type: 'ready' });
		return () => window.removeEventListener('message', onMessage);
	}, []);

	// Actions that wait on the host mark their card busy until a result comes back.
	const act = (m: FreeWebviewMessage): void => {
		if (m.type === 'paste' || m.type === 'key' || m.type === 'oauth') {
			setBusy(b => ({ ...b, [m.id]: true }));
			setResults(r => { const n = { ...r }; delete n[m.id]; return n; });
		}
		if (m.type === 'installOpenCode') { setBusy(b => ({ ...b, opencode: true })); }
		post(m);
	};

	if (!cards) { return <div className="fm-loading"><Loader /></div>; }
	const connected = cards.filter(c => c.connected).length + (oc.installed ? 1 : 0);
	const anyKey = cards.some(c => c.connected);

	return (
		<main className="fm">
			<header className="fm-head">
				<div>
					<h1>Free models</h1>
					<p>Code with AI at no cost. Start with no account, then add free keys for more room.</p>
				</div>
				<div className="fm-count" aria-label={`${connected} connected`}>
					<span key={connected} className="fm-count-n">{connected}</span>
					<span className="fm-count-l">connected</span>
				</div>
			</header>

			<h2 className="fm-section">No account needed</h2>
			<OpenCodeCard act={act} oc={oc} active={active} busy={!!busy.opencode} result={results.opencode} />

			<h2 className="fm-section">Free keys, about a minute each</h2>
			<ul className="fm-grid">
				{cards.map((c, i) => (
					<KeyCard key={c.id} act={act} card={c} index={i + 1} open={open === c.id} onToggle={() => setOpen(open === c.id ? undefined : c.id)} busy={!!busy[c.id]} result={results[c.id]} />
				))}
			</ul>

			{anyKey ? (
				<footer className="fm-foot">
					<div>
						<div className="fm-foot-title">Free (auto)</div>
						<div className="fm-foot-sub">Uses whichever connected free model has room, and moves on when one runs out.</div>
					</div>
					{active === 'free/auto'
						? <span className="fm-status is-on"><Check /> In use</span>
						: <button type="button" className="fm-btn is-primary" onClick={() => act({ type: 'use', modelId: 'free/auto' })}>Use Free (auto)</button>}
				</footer>
			) : null}
		</main>
	);
}
