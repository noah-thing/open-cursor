/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  The Help chat's start screen, its mode chip and the row an opened page leaves behind.
 *--------------------------------------------------------------------------------------------*/

import { memo, type ReactElement } from 'react';
import type { ToolPart } from '../../../src/shared/protocol';
import { Icon, type IconName } from '../common/icons';
import { post } from './host';

const QUESTIONS: readonly string[] = [
	'Where do I add an API key?',
	'How do I get free models?',
	'What do the four modes do?',
	'How do I undo what the agent changed?',
	'Can I use my ChatGPT or Claude subscription?',
	'How do I change the color theme?',
];

const JUMPS: readonly { label: string; href: string; icon: IconName }[] = [
	{ label: 'Free models', href: 'opencursor:free-models', icon: 'sparkle' },
	{ label: 'Models', href: 'opencursor:settings/models', icon: 'key' },
	{ label: 'Shortcuts', href: 'opencursor:shortcuts', icon: 'keyboard' },
	{ label: 'Themes', href: 'opencursor:color-theme', icon: 'image' },
	{ label: 'Settings', href: 'opencursor:settings/general', icon: 'gear' },
];

export function openHelpLink(href: string): void {
	post({ type: 'helpAction', href });
}

export function HelpTop(): ReactElement {
	return (
		<div className="oc-help-top">
			<span className="oc-help-mark" aria-hidden="true"><Icon name="help" size={18} /></span>
			<h2 className="oc-help-title">How can I help?</h2>
			<p className="oc-help-lead">Ask about anything in OpenCursor, and I will take you to the right place.</p>
		</div>
	);
}

export function HelpBottom({ hasModel, onAsk }: { readonly hasModel: boolean; readonly onAsk: (q: string) => void }): ReactElement {
	return (
		<div className="oc-home-bottom oc-help-bottom">
			{hasModel ? (
				<ul className="oc-starters">
					{QUESTIONS.map((q, i) => (
						<li key={q} style={{ ['--i' as string]: i }}>
							<button type="button" className="oc-starter oc-help-q" onClick={() => onAsk(q)}>
								<span className="oc-starter-title">{q}</span>
								<Icon name="arrowRight" size={12} className="oc-starter-go" />
							</button>
						</li>
					))}
				</ul>
			) : (
				<div className="oc-help-need" style={{ ['--i' as string]: 0 }}>
					<p>Help answers with the model you connect. A free one takes about a minute.</p>
					<div className="oc-help-need-row">
						<button type="button" className="oc-btn is-primary is-sm" onClick={() => openHelpLink('opencursor:free-models')}>Get free models</button>
						<button type="button" className="oc-btn is-ghost is-sm" onClick={() => openHelpLink('opencursor:connect')}>Connect a model</button>
					</div>
				</div>
			)}
			<section className="oc-help-jumps" style={{ ['--i' as string]: QUESTIONS.length }} aria-label="Go to">
				<h3 className="oc-home-label">Go to</h3>
				<div className="oc-help-jump-row">
					{JUMPS.map(j => (
						<button key={j.href} type="button" className="oc-help-jump" onClick={() => openHelpLink(j.href)}>
							<Icon name={j.icon} size={12} />{j.label}
						</button>
					))}
				</div>
			</section>
		</div>
	);
}

/** Always at the top of a Help chat: the plain way out, back to the chat you came from. */
export function HelpBar(): ReactElement {
	return (
		<div className="oc-help-bar">
			<button type="button" className="oc-help-back" onClick={() => post({ type: 'leaveHelp' })}>
				<Icon name="arrowLeft" size={12} />
				<span>Leave Help</span>
				<kbd>esc</kbd>
			</button>
		</div>
	);
}

/** Stands where the mode menu is: a Help chat stays Help, and the x leaves for a normal chat. */
export function HelpChip(): ReactElement {
	return (
		<span className="oc-chip oc-mode-chip is-help oc-help-chip" title="Help explains OpenCursor and opens the right place">
			<Icon name="help" size={13} />
			<span>Help</span>
			<button type="button" className="oc-help-leave" title="Leave Help (Esc)" aria-label="Leave Help" onClick={() => post({ type: 'leaveHelp' })}>
				<Icon name="x" size={9} />
			</button>
		</span>
	);
}

/** What open_in_app leaves in the answer: where it went, and a way back there. */
export const HelpJumpRow = memo(function HelpJumpRow({ part }: { readonly part: ToolPart }): ReactElement {
	const target = typeof part.args?.target === 'string' ? part.args.target : '';
	const arg = typeof part.args?.argument === 'string' ? part.args.argument : '';
	const href = 'opencursor:' + target + (arg ? '/' + encodeURIComponent(arg) : '');
	const live = part.status === 'running' || part.status === 'streaming';
	const failed = part.status === 'error';
	return (
		<div className={'oc-help-jumped' + (live ? ' is-live' : '') + (failed ? ' is-err' : '')}>
			<span className="oc-help-jumped-dot" aria-hidden="true" />
			<span className="oc-help-jumped-title">{part.title}</span>
			{!live && !failed && target ? (
				<button type="button" className="oc-help-again" onClick={() => openHelpLink(href)}>Open again</button>
			) : null}
		</div>
	);
});
