/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Shows messages from the signed feed (feed.ts). Each message shows once: it counts as seen the
 *  moment it appears, whatever the person does with it. At most one tab per session and one card at
 *  a time, nothing in the very first session of a new install, and none at all with
 *  openCursor.notices.enabled off. The feed is read at startup and every half hour; it sends nothing.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { FEED_URL, remember, safeLink, verifyFeed, visible, type Notice } from './feed';
import { noticePage } from './page';

const SEEN_KEY = 'openCursor.notices.seen';
const ISSUED_KEY = 'openCursor.notices.issued';
const FIRST_MS = 8_000;
const EVERY_MS = 30 * 60 * 1000;

/** Where a card notice is drawn: the chat panel. */
export interface NoticeHost {
	showNotice(n: Notice | undefined): void;
	onNoticeAction(handler: (id: string, open: boolean) => void): void;
}

export function registerNotices(ctx: vscode.ExtensionContext, chat: NoticeHost, opts: { freshInstall: boolean }): void {
	const version = String(ctx.extension.packageJSON.version ?? '0.0.0');
	// For testing a feed before it is published: OPENCURSOR_NOTICES_URL=the http(s) address of a feed.
	const url = process.env.OPENCURSOR_NOTICES_URL || FEED_URL;
	let feed: readonly Notice[] = [];
	let tabShown = false;
	let card: Notice | undefined;
	let panel: vscode.WebviewPanel | undefined;

	const enabled = (): boolean => vscode.workspace.getConfiguration('openCursor').get<boolean>('notices.enabled', true);
	const seen = (): string[] => ctx.globalState.get<string[]>(SEEN_KEY, []);
	const markSeen = (id: string): Thenable<void> => ctx.globalState.update(SEEN_KEY, remember(seen(), id, feed));

	const open = (n: Notice): void => {
		if (n.action && safeLink(n.action.url)) { void vscode.env.openExternal(vscode.Uri.parse(n.action.url, true)); }
	};

	const showTab = (n: Notice): void => {
		tabShown = true;
		void markSeen(n.id);
		const p = panel = vscode.window.createWebviewPanel('openCursor.notice', n.brand?.name ?? 'OpenCursor', { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: true });
		p.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'chat.svg');
		p.webview.html = noticePage(n, p.webview.cspSource, randomBytes(16).toString('base64').replace(/[^a-z0-9]/gi, ''));
		p.webview.onDidReceiveMessage((m: { type?: string }) => {
			if (m?.type === 'open') { open(n); }
			if (m?.type === 'open' || m?.type === 'close') { p.dispose(); }
		});
		p.onDidDispose(() => { if (panel === p) { panel = undefined; } });
	};

	const showToast = (n: Notice): void => {
		void markSeen(n.id);
		const text = n.body ? `${n.title} ${n.body}` : n.title;
		void vscode.window.showInformationMessage(text, ...(n.action ? [n.action.label] : [])).then(pick => { if (pick) { open(n); } });
	};

	const showCard = (n: Notice): void => {
		card = n;
		void markSeen(n.id);
		chat.showNotice(n);
	};

	chat.onNoticeAction((id, go) => {
		if (!card || card.id !== id) { return; }
		if (go) { open(card); }
		card = undefined;
		chat.showNotice(undefined);
	});

	const read = async (): Promise<void> => {
		if (!enabled()) { return; }
		let body: unknown;
		try {
			const sep = url.includes('?') ? '&' : '?';
			const r = await fetch(`${url}${sep}t=${Math.floor(Date.now() / 60e3)}`, { headers: { 'user-agent': 'OpenCursor' }, signal: AbortSignal.timeout(10_000) });
			if (!r.ok) { return; }
			body = await r.json();
		} catch {
			return; // offline or blocked: look again at the next interval, never bother anyone
		}
		const f = verifyFeed(body, ctx.globalState.get<number>(ISSUED_KEY, 0));
		if (!f) { return; }
		if (f.issued !== ctx.globalState.get<number>(ISSUED_KEY)) { await ctx.globalState.update(ISSUED_KEY, f.issued); }
		feed = f.notices;
		// A card taken out of the feed leaves the chat too.
		if (card && !feed.some(n => n.id === card!.id)) { card = undefined; chat.showNotice(undefined); }
		// a test feed shows at once, even in the fresh profile a test run starts with
		if (opts.freshInstall && !process.env.OPENCURSOR_NOTICES_URL) { return; }
		const due = visible(feed, version, process.platform, seen());
		const tab = due.find(n => n.kind === 'tab');
		if (tab && !tabShown && !panel) { showTab(tab); }
		const next = due.find(n => n.kind === 'card');
		if (next && !card) { showCard(next); }
		for (const t of due.filter(n => n.kind === 'toast').slice(0, 1)) { showToast(t); }
	};

	const first = setTimeout(() => void read(), FIRST_MS);
	const timer = setInterval(() => void read(), EVERY_MS);
	ctx.subscriptions.push(
		{ dispose: () => { clearTimeout(first); clearInterval(timer); panel?.dispose(); } },
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('openCursor.notices.enabled') && !enabled()) {
				card = undefined;
				chat.showNotice(undefined);
				panel?.dispose();
			}
		}),
	);
}
