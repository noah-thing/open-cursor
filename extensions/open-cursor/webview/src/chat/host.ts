/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { HostMessageExt, WebviewMessageExt } from '../../../src/shared/protocol';
import { getVsCode } from '../common/vscode';

export interface ChatUiState {
	drafts: Record<string, string>;
	scroll: Record<string, number>;
	mentions?: string[];
	/** The user put away the "connect your subscriptions" block on the start screen. */
	connectHidden?: boolean;
}

const api = getVsCode<WebviewMessageExt, ChatUiState>();

export function post(message: WebviewMessageExt): void {
	api.postMessage(message);
}

export function loadUiState(): ChatUiState {
	try {
		const s = api.getState();
		if (s && typeof s === 'object') {
			return { drafts: s.drafts ?? {}, scroll: s.scroll ?? {}, connectHidden: s.connectHidden };
		}
	} catch { /* ignore */ }
	return { drafts: {}, scroll: {} };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pending: ChatUiState | undefined;

/** Debounced vscode.setState. */
export function saveUiState(state: ChatUiState): void {
	pending = state;
	if (saveTimer) { return; }
	saveTimer = setTimeout(() => {
		saveTimer = undefined;
		if (pending) {
			try { api.setState(pending); } catch { /* ignore */ }
		}
	}, 250);
}

export function onHostMessage(handler: (m: HostMessageExt) => void): () => void {
	const listener = (e: MessageEvent) => {
		const d = e.data as HostMessageExt | undefined;
		if (d && typeof d === 'object' && typeof d.type === 'string') { handler(d); }
	};
	window.addEventListener('message', listener);
	return () => window.removeEventListener('message', listener);
}
