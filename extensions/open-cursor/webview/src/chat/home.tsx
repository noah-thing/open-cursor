/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  The start screen of an empty chat: where you are above the composer, ways to begin below it.
 *  App renders the three pieces around one composer so the composer node never remounts and
 *  can glide from the middle of the panel to the bottom when the first message is sent.
 *--------------------------------------------------------------------------------------------*/

import type { ReactElement } from 'react';
import type { AgentStatus, ChatMode, ChatSummary } from '../../../src/shared/protocol';
import { Icon, type IconName } from '../common/icons';
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
			{ key: 'open', icon: 'folder', title: 'Open a folder', detail: 'Work on a project on this Mac', run: () => post({ type: 'workbench', action: 'openFolder' }) },
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

function monogram(label: string): string {
	const words = label.replace(/CLI/i, '').trim().split(/\s+/);
	return (words.length > 1 ? words[0][0] + words[1][0] : label.slice(0, 2)).toUpperCase();
}

/**
 * The subscriptions you already pay for, as they stand on this Mac: use one, sign in, or install it.
 * Nothing here asks for an API key; that is a separate, quieter link at the bottom.
 */
export function ConnectBlock({ agents, modelId, needed, onUse, onHide }: {
	readonly agents: readonly AgentStatus[];
	readonly modelId: string;
	/** No model can run yet: the block cannot be put away. */
	readonly needed: boolean;
	readonly onUse: (modelId: string) => void;
	readonly onHide: () => void;
}): ReactElement {
	const rows = [...agents].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
	return (
		<section className="oc-connect" aria-label="Connect a subscription">
			<header className="oc-connect-head">
				<span className="oc-connect-title">{needed ? 'Connect a model to start' : 'Your subscriptions'}</span>
				<span className="oc-connect-sub">Use the AI plans you already pay for. No API key needed.</span>
			</header>
			<ul className="oc-connect-list">
				{rows.map((a, i) => {
					const inUse = !!a.modelId && modelId.startsWith('cli:' + a.id + '/');
					const ready = a.installed && a.loggedIn !== false;
					const status = !a.installed ? 'Not installed' : a.loggedIn === false ? 'Not signed in' : inUse ? 'In use' : 'Signed in';
					return (
						<li key={a.id} className={'oc-connect-row' + (ready ? ' is-ready' : '') + (inUse ? ' is-in-use' : '')} style={{ ['--i' as string]: i }}>
							<span className="oc-connect-mark" aria-hidden="true">{monogram(a.label)}</span>
							<span className="oc-connect-name">{a.label}</span>
							<span className={'oc-connect-status' + (ready ? ' is-ok' : '')}>{status}</span>
							{inUse ? (
								<Icon name="check" size={13} className="oc-connect-check" />
							) : ready && a.modelId ? (
								<button type="button" className="oc-btn is-sm is-primary" onClick={() => onUse(a.modelId!)}>Use</button>
							) : a.installed ? (
								<button type="button" className="oc-btn is-sm" onClick={() => post({ type: 'agentAction', id: a.id, action: 'signIn' })}>Sign in</button>
							) : (
								<button type="button" className="oc-btn is-sm is-ghost" onClick={() => post({ type: 'agentAction', id: a.id, action: 'install' })}>Install</button>
							)}
						</li>
					);
				})}
			</ul>
			<footer className="oc-connect-foot">
				<button type="button" className="oc-linkbtn" onClick={() => post({ type: 'agentAction', id: '', action: 'refresh' })}>Check again</button>
				<span className="oc-connect-or">or</span>
				<button type="button" className="oc-linkbtn" onClick={() => post({ type: 'openSettings', section: 'models' })}>add an API key</button>
				<span className="oc-connect-or">or</span>
				<button type="button" className="oc-linkbtn" onClick={() => post({ type: 'openSettings', section: 'models' })}>run a model locally</button>
				{needed ? null : <button type="button" className="oc-linkbtn oc-connect-hide" onClick={onHide}>Hide</button>}
			</footer>
		</section>
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
