/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  The menu bar item: an icon next to the clock that opens a small panel. From it you can hand a
 *  task to the agent in any project (it opens or focuses that project and starts a chat with the
 *  task), jump to an open window, reopen a recent folder, or start a new window.
 *
 *  The panel is a frameless window showing self-contained HTML. Its links use the `oc-tray:`
 *  scheme and are caught on navigation here, so it needs no preload and no Node access.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, Menu, nativeImage, screen, Tray, app, type Rectangle } from 'electron';
import { CancellationToken } from '../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { basename } from '../../base/common/resources.js';
import { isMacintosh, isWindows } from '../../base/common/platform.js';
import { URI } from '../../base/common/uri.js';
import { IEnvironmentMainService } from '../../platform/environment/electron-main/environmentMainService.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { ICodeWindow } from '../../platform/window/electron-main/window.js';
import { IWindowsMainService, OpenContext } from '../../platform/windows/electron-main/windows.js';
import { IWorkspacesHistoryMainService } from '../../platform/workspaces/electron-main/workspacesHistoryMainService.js';
import { isRecentFolder } from '../../platform/workspaces/common/workspaces.js';
import { isSingleFolderWorkspaceIdentifier } from '../../platform/workspace/common/workspace.js';
import { TRAY_ICON_1X, TRAY_ICON_2X } from './openCursorTrayIcon.js';

const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 468;
const MODES = ['agent', 'plan', 'debug', 'ask'] as const;

interface Place { readonly key: string; readonly label: string; readonly detail: string; readonly kind: 'window' | 'recent' }

function esc(s: string): string {
	return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
}

function tildify(fsPath: string): string {
	const home = app.getPath('home');
	return fsPath.startsWith(home) ? '~' + fsPath.slice(home.length) : fsPath;
}

export class OpenCursorTray extends Disposable {

	private tray: Tray | undefined;
	private panel: BrowserWindow | undefined;
	private lastHide = 0;

	constructor(
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@IWorkspacesHistoryMainService private readonly historyService: IWorkspacesHistoryMainService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		try {
			this.create();
		} catch (error) {
			this.logService.error('[open-cursor] tray could not start', error);
		}
	}

	private create(): void {
		const icon = nativeImage.createEmpty();
		icon.addRepresentation({ scaleFactor: 1, dataURL: TRAY_ICON_1X });
		icon.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_2X });
		icon.setTemplateImage(true);
		const tray = this.tray = new Tray(icon);
		tray.setToolTip(this.productService.nameLong);
		tray.on('click', () => this.toggle());
		tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate([
			{ label: `Open ${this.productService.nameShort}`, click: () => this.focusOrOpen() },
			{ type: 'separator' },
			{ label: `Quit ${this.productService.nameShort}`, role: 'quit' },
		])));
		this._register(toDisposable(() => { this.panel?.destroy(); tray.destroy(); }));
		this.logService.info('[open-cursor] menu bar item ready');
		// Lets the end-to-end scripts open the panel and drive it without clicking the real menu bar.
		if (process.env.OPEN_CURSOR_TEST_TRAY) {
			(globalThis as { openCursorTray?: unknown }).openCursorTray = { show: () => this.show(), panel: () => this.panel, handle: (url: string) => this.handle(url) };
		}
	}

	private toggle(): void {
		// A click on the icon while the panel is open first blurs (hiding it); do not reopen it at once.
		if (this.panel?.isVisible()) { this.panel.hide(); return; }
		if (Date.now() - this.lastHide < 250) { return; }
		void this.show();
	}

	private ensurePanel(): BrowserWindow {
		if (this.panel && !this.panel.isDestroyed()) { return this.panel; }
		const panel = this.panel = new BrowserWindow({
			width: PANEL_WIDTH, height: PANEL_HEIGHT, show: false, frame: false, resizable: false, movable: false,
			minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
			transparent: isMacintosh, vibrancy: isMacintosh ? 'popover' : undefined, visualEffectState: 'active',
			backgroundColor: isMacintosh ? '#00000000' : '#1b1b1d', roundedCorners: true, hasShadow: true,
			webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, devTools: false },
		});
		panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		panel.on('blur', () => { panel.hide(); this.lastHide = Date.now(); });
		panel.webContents.on('will-navigate', (event, url) => {
			event.preventDefault();
			if (url.startsWith('oc-tray:')) { void this.handle(url); }
		});
		panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		return panel;
	}

	private async show(): Promise<void> {
		const panel = this.ensurePanel();
		const places = await this.places();
		await panel.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(this.html(places)));
		this.position(panel);
		panel.show();
		panel.focus();
	}

	/** Under the icon on macOS; above the taskbar (or below a top panel) elsewhere, always inside the work area. */
	private position(panel: BrowserWindow): void {
		const b: Rectangle = this.tray!.getBounds();
		const point = b.width ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : screen.getCursorScreenPoint();
		const area = screen.getDisplayNearestPoint(point).workArea;
		let x = Math.round(point.x - PANEL_WIDTH / 2);
		const fromTop = point.y < area.y + area.height / 2;
		let y = fromTop ? (b.height ? b.y + b.height + 4 : area.y + 4) : (b.height ? b.y - PANEL_HEIGHT - 4 : area.y + area.height - PANEL_HEIGHT - 4);
		x = Math.min(Math.max(x, area.x + 6), area.x + area.width - PANEL_WIDTH - 6);
		y = Math.min(Math.max(y, area.y + 4), area.y + area.height - PANEL_HEIGHT - 4);
		panel.setPosition(x, y, false);
	}

	private async places(): Promise<Place[]> {
		const out: Place[] = [];
		const seen = new Set<string>();
		for (const w of this.windowsMainService.getWindows()) {
			const ws = w.openedWorkspace;
			const folder = ws && isSingleFolderWorkspaceIdentifier(ws) ? ws.uri : undefined;
			if (folder) { seen.add(folder.toString()); }
			out.push({ key: 'win:' + w.id, kind: 'window', label: folder ? basename(folder) : (ws ? 'Workspace' : 'Empty window'), detail: folder?.scheme === 'file' ? tildify(folder.fsPath) : 'Open now' });
		}
		try {
			const recent = await this.historyService.getRecentlyOpened();
			for (const r of recent.workspaces) {
				if (!isRecentFolder(r) || r.folderUri.scheme !== 'file' || seen.has(r.folderUri.toString())) { continue; }
				out.push({ key: 'folder:' + r.folderUri.toString(), kind: 'recent', label: basename(r.folderUri), detail: tildify(r.folderUri.fsPath) });
				if (out.filter(p => p.kind === 'recent').length >= 6) { break; }
			}
		} catch { /* no history yet */ }
		return out;
	}

	private async handle(url: string): Promise<void> {
		const u = new URL(url);
		const action = u.hostname || u.pathname.replace(/^\/+/, '');
		const place = u.searchParams.get('place') ?? '';
		this.panel?.hide();
		try {
			switch (action) {
				case 'task': {
					const text = (u.searchParams.get('text') ?? '').trim();
					const mode = MODES.find(m => m === u.searchParams.get('mode')) ?? 'agent';
					const win = await this.target(place);
					win?.sendWhenReady('vscode:runAction', CancellationToken.None, { id: 'openCursor.chat.startTask', from: 'menu', args: [text, mode] });
					return;
				}
				case 'go': await this.target(place); return;
				case 'new': await this.openEmpty(); return;
				case 'openFolder': {
					const win = await this.target('');
					win?.sendWhenReady('vscode:runAction', CancellationToken.None, { id: 'workbench.action.files.openFolder', from: 'menu' });
					return;
				}
				case 'settings': {
					const win = await this.target('');
					win?.sendWhenReady('vscode:runAction', CancellationToken.None, { id: 'openCursor.chat.openSettings', from: 'menu' });
					return;
				}
				case 'quit': app.quit(); return;
				case 'hide': return;
			}
		} catch (error) {
			this.logService.error('[open-cursor] tray action failed', action, error);
		}
	}

	/** The window for a place: an open window by id, a folder (focused if open, else opened), or the last active window. */
	private async target(place: string): Promise<ICodeWindow | undefined> {
		if (place.startsWith('win:')) {
			const win = this.windowsMainService.getWindowById(Number(place.slice(4)));
			if (win) { win.focus(); return win; }
		}
		if (place.startsWith('folder:')) {
			const folderUri = URI.parse(place.slice(7));
			const open = this.windowsMainService.getWindows().find(w => {
				const ws = w.openedWorkspace;
				return ws && isSingleFolderWorkspaceIdentifier(ws) && ws.uri.toString() === folderUri.toString();
			});
			if (open) { open.focus(); return open; }
			const [win] = await this.windowsMainService.open({
				context: OpenContext.DOCK, cli: this.environmentMainService.args, urisToOpen: [{ folderUri }],
				forceNewWindow: this.windowsMainService.getWindowCount() > 0,
			});
			return win;
		}
		return this.focusOrOpen();
	}

	private async focusOrOpen(): Promise<ICodeWindow | undefined> {
		const last = this.windowsMainService.getLastActiveWindow();
		if (last) { last.focus(); return last; }
		return this.openEmpty();
	}

	private async openEmpty(): Promise<ICodeWindow | undefined> {
		const [win] = await this.windowsMainService.open({ context: OpenContext.DOCK, cli: this.environmentMainService.args, forceNewWindow: true, forceEmpty: true });
		return win;
	}

	private html(places: readonly Place[]): string {
		const name = esc(this.productService.nameShort);
		const windows = places.filter(p => p.kind === 'window');
		const recent = places.filter(p => p.kind === 'recent');
		const first = windows[0]?.key ?? recent[0]?.key ?? '';
		const option = (p: Place): string => `<option value="${esc(p.key)}"${p.key === first ? ' selected' : ''}>${esc(p.label)}${p.kind === 'window' ? '' : ' (recent)'}</option>`;
		const row = (p: Place, i: number): string =>
			`<a class="row" style="--i:${i}" href="oc-tray://go?place=${encodeURIComponent(p.key)}"><span class="dot ${p.kind}"></span><span class="main"><span class="label">${esc(p.label)}</span><span class="detail"><bdi>${esc(p.detail)}</bdi></span></span></a>`;
		const section = (title: string, list: readonly Place[], offset: number): string =>
			list.length ? `<h2>${title}</h2>${list.map((p, i) => row(p, i + offset)).join('')}` : '';
		return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root { color-scheme: light dark; --fg: #ececee; --fg2: rgba(236,236,238,.62); --fg3: rgba(236,236,238,.38); --line: rgba(255,255,255,.08); --field: rgba(255,255,255,.06); --hover: rgba(255,255,255,.07); --accent: #ececee; --accent-fg: #141416; --bg: ${isMacintosh ? 'rgba(28,28,30,.55)' : '#1b1b1d'}; }
@media (prefers-color-scheme: light) { :root { --fg: #1c1c1e; --fg2: rgba(28,28,30,.62); --fg3: rgba(28,28,30,.4); --line: rgba(0,0,0,.08); --field: rgba(0,0,0,.05); --hover: rgba(0,0,0,.05); --accent: #1c1c1e; --accent-fg: #fafafa; --bg: ${isMacintosh ? 'rgba(246,246,248,.6)' : '#f6f6f8'}; } }
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; background: transparent; overflow: hidden; }
body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; color: var(--fg); -webkit-user-select: none; user-select: none; }
.panel { height: 100%; display: flex; flex-direction: column; padding: 12px; background: var(--bg); border-radius: ${isWindows ? 8 : 12}px; ${isMacintosh ? '' : 'border: 1px solid var(--line);'} animation: in 220ms cubic-bezier(.23,1,.32,1) both; transform-origin: 50% 0; }
@keyframes in { from { opacity: 0; transform: translateY(-6px) scale(.98); } }
@keyframes rise { from { opacity: 0; transform: translateY(5px); filter: blur(1.5px); } }
header { display: flex; align-items: center; gap: 8px; padding: 0 2px 10px; }
header .name { font-weight: 600; font-size: 13px; flex: 1; }
.icon { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px; color: var(--fg2); text-decoration: none; transition: background-color 120ms, color 120ms, transform 120ms; }
.icon:hover { background: var(--hover); color: var(--fg); }
.icon:active { transform: scale(.92); }
form { border-radius: 12px; background: var(--field); box-shadow: inset 0 0 0 1px var(--line); padding: 10px 10px 8px; transition: box-shadow 140ms; animation: rise 260ms 40ms cubic-bezier(.23,1,.32,1) both; }
form:focus-within { box-shadow: inset 0 0 0 1px var(--fg3); }
textarea { width: 100%; height: 58px; resize: none; border: 0; outline: 0; background: none; color: var(--fg); font: inherit; -webkit-user-select: text; user-select: text; }
textarea::placeholder { color: var(--fg3); }
.bar { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
select { appearance: none; -webkit-appearance: none; max-width: 150px; height: 24px; padding: 0 20px 0 8px; border: 0; border-radius: 6px; background: var(--hover) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5l3 3 3-3' fill='none' stroke='%23888' stroke-width='1.3'/%3E%3C/svg%3E") no-repeat right 6px center; color: var(--fg2); font: inherit; font-size: 12px; outline: 0; text-overflow: ellipsis; }
select:hover { color: var(--fg); }
.spacer { flex: 1; }
button.send { width: 26px; height: 26px; border: 0; border-radius: 50%; background: var(--accent); color: var(--accent-fg); display: grid; place-items: center; transition: opacity 120ms, transform 120ms; }
button.send:disabled { opacity: .3; }
button.send:active:not(:disabled) { transform: scale(.92); }
.list { flex: 1; overflow-y: auto; margin: 10px -4px 0; padding: 0 4px; }
h2 { font-size: 11px; font-weight: 500; color: var(--fg3); padding: 10px 8px 4px; }
.row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; color: inherit; text-decoration: none; animation: rise 280ms calc(80ms + var(--i) * 35ms) cubic-bezier(.23,1,.32,1) both; transition: background-color 120ms; }
.row:hover { background: var(--hover); }
.row:active { transform: scale(.99); }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--fg3); }
.dot.window { background: #4fbf7a; box-shadow: 0 0 0 3px rgba(79,191,122,.15); }
.main { display: flex; flex-direction: column; min-width: 0; }
.label { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.detail { font-size: 11px; color: var(--fg3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
.detail bdi { direction: ltr; unicode-bidi: isolate; }
.empty { padding: 18px 8px; color: var(--fg3); font-size: 12px; }
footer { display: flex; gap: 4px; padding-top: 8px; margin-top: 6px; border-top: 1px solid var(--line); }
footer a { flex: 1; text-align: center; padding: 6px 0; border-radius: 7px; color: var(--fg2); text-decoration: none; font-size: 12px; transition: background-color 120ms, color 120ms; }
footer a:hover { background: var(--hover); color: var(--fg); }
kbd { font: 11px -apple-system, system-ui, sans-serif; color: var(--fg3); }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style></head><body><div class="panel">
<header><span class="name">${name}</span><a class="icon" title="Settings" href="oc-tray://settings"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/></svg></a></header>
<form id="f">
<textarea id="t" placeholder="What should the agent do?" autofocus></textarea>
<div class="bar">
<select id="p" title="Project">${places.map(option).join('')}<option value=""${first ? '' : ' selected'}>New window</option></select>
<select id="m" title="Mode">${MODES.map(m => `<option value="${m}">${m[0].toUpperCase() + m.slice(1)}</option>`).join('')}</select>
<span class="spacer"></span><kbd>↵</kbd>
<button class="send" id="s" type="submit" title="Start (Enter)" disabled><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg></button>
</div></form>
<div class="list">${section('Open now', windows, 0)}${section('Recent', recent, windows.length)}${places.length ? '' : '<div class="empty">Projects you open show up here.</div>'}</div>
<footer><a href="oc-tray://new">New window</a><a href="oc-tray://openFolder">Open folder…</a><a href="oc-tray://quit" title="Quit">Quit</a></footer>
</div>
<script>
const t = document.getElementById('t'), s = document.getElementById('s'), p = document.getElementById('p'), m = document.getElementById('m'), f = document.getElementById('f');
const go = () => { const text = t.value.trim(); if (!text) { return; } location.href = 'oc-tray://task?text=' + encodeURIComponent(text) + '&mode=' + m.value + '&place=' + encodeURIComponent(p.value); };
t.addEventListener('input', () => { s.disabled = !t.value.trim(); });
t.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); } });
f.addEventListener('submit', e => { e.preventDefault(); go(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { location.href = 'oc-tray://hide'; } });
t.focus();
</script></body></html>`;
	}
}
