/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  The start screen of an empty chat: where you are above the composer, ways to begin below it.
 *  App renders the three pieces around one composer so the composer node never remounts and
 *  can glide from the middle of the panel to the bottom when the first message is sent.
 *--------------------------------------------------------------------------------------------*/

import type { ReactElement } from 'react';
import type { ChatMode, ChatSummary } from '../../../src/shared/protocol';
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
		return [
			{ key: 'sub', icon: 'user', title: 'Use a subscription you have', detail: 'Claude Code, Codex or Gemini CLI on this Mac', run: () => post({ type: 'openSettings', section: 'subscriptions' }) },
			{ key: 'key', icon: 'key', title: 'Add an API key', detail: 'Anthropic, OpenAI, Gemini, OpenRouter and more', run: () => post({ type: 'openSettings', section: 'models' }) },
			{ key: 'local', icon: 'cube', title: 'Run a model locally', detail: 'Ollama or LM Studio, free and offline', run: () => post({ type: 'openSettings', section: 'models' }) },
		];
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

/** Below the composer: ways to begin, recent chats and the three keys worth knowing. */
export function HomeBottom({ starters, recent, onPick }: {
	readonly starters: readonly Starter[];
	readonly recent: readonly ChatSummary[];
	readonly onPick: (id: string) => void;
}): ReactElement {
	return (
		<div className="oc-home-bottom">
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
