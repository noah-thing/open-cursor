/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Icon, type IconName } from '../common/icons';
import { getVsCode } from '../common/vscode';
import {
	SECTIONS, type ConfigKey, type ConfigValues, type SettingsHostMessage, type SettingsSection, type SettingsState, type SettingsWebviewMessage,
} from '../../../src/settings/protocol';
import { Commands, General, Indexing, Mcp, Models, Rules, Subscriptions, TabSection, type VerifyMap } from './sections';

const api = getVsCode<SettingsWebviewMessage, { section?: SettingsSection }>();

const ICONS: Record<SettingsSection, IconName> = {
	general: 'gear', models: 'cube', subscriptions: 'user', tab: 'bolt', rules: 'rule', commands: 'slash', mcp: 'plug', indexing: 'database',
};

interface Toast { id: number; kind: 'info' | 'error'; text: string }

function initialSection(): SettingsSection {
	try {
		const s = api.getState()?.section;
		if (s && SECTIONS.some(x => x.id === s)) { return s; }
	} catch { /* ignore */ }
	return 'general';
}

export function App(): ReactElement {
	const [state, setState] = useState<SettingsState | undefined>(undefined);
	const [section, setSection] = useState<SettingsSection>(initialSection);
	const [verify, setVerify] = useState<VerifyMap>({});
	const [toasts, setToasts] = useState<Toast[]>([]);
	const toastId = useRef(0);
	const content = useRef<HTMLDivElement>(null);

	const send = useCallback((m: SettingsWebviewMessage) => api.postMessage(m), []);

	const go = useCallback((s: SettingsSection) => {
		setSection(s);
		try { api.setState({ section: s }); } catch { /* ignore */ }
		content.current?.scrollTo({ top: 0 });
	}, []);

	useEffect(() => {
		const onMsg = (e: MessageEvent): void => {
			const m = e.data as SettingsHostMessage | undefined;
			if (!m || typeof m !== 'object') { return; }
			switch (m.type) {
				case 'state':
					setState(m.state);
					if (m.section) { go(m.section); }
					break;
				case 'navigate': go(m.section); break;
				case 'verify': setVerify(v => ({ ...v, [m.provider]: { status: m.status, message: m.message } })); break;
				case 'toast': {
					const id = ++toastId.current;
					setToasts(t => [...t, { id, kind: m.kind, text: m.text }]);
					setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), m.kind === 'error' ? 6000 : 2800);
					break;
				}
			}
		};
		window.addEventListener('message', onMsg);
		api.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', onMsg);
	}, [go]);

	// Optimistic write: the host's configuration event confirms it a moment later.
	const set = useCallback(<K extends ConfigKey>(key: K, value: ConfigValues[K]) => {
		setState(s => (s ? { ...s, config: { ...s.config, [key]: value } } : s));
		api.postMessage({ type: 'setConfig', key, value });
	}, []);

	if (!state) {
		return <div className="st-loading">Loading settings</div>;
	}

	const props = { state, verify, set, send };
	let body: ReactElement;
	switch (section) {
		case 'general': body = <General {...props} />; break;
		case 'models': body = <Models {...props} />; break;
		case 'subscriptions': body = <Subscriptions {...props} />; break;
		case 'tab': body = <TabSection {...props} />; break;
		case 'rules': body = <Rules {...props} />; break;
		case 'commands': body = <Commands {...props} />; break;
		case 'mcp': body = <Mcp {...props} />; break;
		case 'indexing': body = <Indexing {...props} />; break;
	}

	return (
		<div className="st-app">
			<nav className="st-nav" aria-label="Settings sections">
				<div className="st-nav-title">OpenCursor</div>
				{SECTIONS.map(s => (
					<button key={s.id} type="button" className={'st-nav-item' + (s.id === section ? ' is-active' : '')} aria-current={s.id === section ? 'page' : undefined} onClick={() => go(s.id)}>
						<Icon name={ICONS[s.id]} size={15} />
						<span>{s.label}</span>
					</button>
				))}
			</nav>
			<main className="st-main" ref={content}>{body}</main>
			<div className="st-toasts" aria-live="polite">
				{toasts.map(t => <div key={t.id} className={'st-toast is-' + t.kind}>{t.text}</div>)}
			</div>
		</div>
	);
}
