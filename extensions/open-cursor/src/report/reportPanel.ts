/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Report a Problem: a short form that sends the person's own words and a few app facts, listed
 *  on the form before sending, to the project's report inbox. No account. Never code, chats or keys.
 *  GitHub stays available for people who prefer an issue.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';
import { ISSUES_URL, issueBody, issueTitle, modelKind } from '../help/issue';
import { scrub } from './scrub';

const ENDPOINT = 'https://opencursor-stats.opencursor.workers.dev/v1/report';
const ID_KEY = 'openCursor.stats.installId';

export interface ReportContext {
	/** The error text when opened from an error card. */
	readonly error?: string;
	readonly modelId?: string;
	readonly mode?: string;
}

interface Facts {
	readonly version: string;
	readonly os: 'darwin' | 'win32' | 'linux';
	readonly arch: 'arm64' | 'x64';
	readonly system: string;
	readonly model?: string;
	readonly mode?: string;
	readonly folder: boolean;
	readonly error?: string;
}

const OS_NAME: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

export class ReportPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private context: ReportContext = {};
	private sent = false;

	constructor(private readonly ctx: vscode.ExtensionContext) {}

	dispose(): void { this.panel?.dispose(); }

	private facts(): Facts | undefined {
		const platform = process.platform;
		const arch = process.arch;
		if ((platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') || (arch !== 'arm64' && arch !== 'x64')) { return undefined; }
		const kind = modelKind(this.context.modelId);
		return {
			version: String(this.ctx.extension.packageJSON.version ?? '0.0.0'),
			os: platform, arch,
			system: `${OS_NAME[platform]} ${os.release()} (${arch})`,
			...(this.context.modelId ? { model: kind && kind !== this.context.modelId ? `${this.context.modelId} (${kind})` : this.context.modelId } : {}),
			...(this.context.mode ? { mode: this.context.mode } : {}),
			folder: !!vscode.workspace.workspaceFolders?.length,
			...(this.context.error ? { error: scrub(this.context.error).slice(0, 3000) } : {}),
		};
	}

	open(context: ReportContext = {}): void {
		this.context = context;
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);
			if (this.sent) {
				// the old Thanks page has no form; a fresh one posts 'ready' and gets its facts then
				this.sent = false;
				this.panel.webview.html = this.html(this.panel.webview);
			} else {
				void this.panel.webview.postMessage({ type: 'facts', facts: this.facts() ?? null });
			}
			return;
		}
		this.sent = false;
		const panel = this.panel = vscode.window.createWebviewPanel('openCursor.report', 'Report a problem', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
		panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'chat.svg');
		panel.webview.html = this.html(panel.webview);
		panel.onDidDispose(() => { this.panel = undefined; this.sent = false; });
		panel.webview.onDidReceiveMessage((m: { type: string; message?: string; contact?: string; includeError?: boolean }) => { void this.onMessage(m); });
	}

	private installId(): string {
		let id = this.ctx.globalState.get<string>(ID_KEY);
		if (!id) { id = crypto.randomUUID(); void this.ctx.globalState.update(ID_KEY, id); }
		return id;
	}

	private async onMessage(m: { type: string; message?: string; contact?: string; includeError?: boolean }): Promise<void> {
		if (m.type === 'send' && this.sent) { return; }
		if (m.type === 'ready') { void this.panel?.webview.postMessage({ type: 'facts', facts: this.facts() ?? null }); return; }
		if (m.type === 'close') { this.panel?.dispose(); return; }
		const f = this.facts();
		const message = scrub(String(m.message ?? '')).trim().slice(0, 4000);
		if (m.type === 'github') {
			const facts = { title: '', userMessages: [message, ...(f?.error ? ['Error:\n```\n' + f.error + '\n```'] : [])].filter(Boolean), version: f?.version ?? '', system: f?.system ?? process.platform, ...(f?.mode ? { mode: f.mode } : {}), ...(f?.model ? { model: f.model } : {}) };
			const url = `${ISSUES_URL}?title=${encodeURIComponent(issueTitle(facts))}&body=${encodeURIComponent(issueBody(facts))}`;
			await vscode.env.openExternal(vscode.Uri.parse(url, true));
			return;
		}
		if (m.type !== 'send' || !this.panel) { return; }
		if (!f) { void this.panel.webview.postMessage({ type: 'result', ok: false, message: 'This system cannot send reports. Use GitHub instead.' }); return; }
		if (message.length < 3) { void this.panel.webview.postMessage({ type: 'result', ok: false, message: 'Write a few words about what happened.' }); return; }
		const body = {
			id: this.installId(), version: f.version, os: f.os, arch: f.arch, message,
			contact: scrub(String(m.contact ?? '')).trim().slice(0, 120) || undefined,
			model: f.model, mode: f.mode, folder: f.folder,
			error: m.includeError === false ? undefined : f.error,
		};
		let reply: string;
		try {
			const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'OpenCursor' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
			if (r.status === 429) {
				reply = 'Too many reports from this computer in the last hour. Try again later, or use GitHub.';
			} else if (!r.ok) {
				reply = `The report did not go through (${r.status}). Try again, or use GitHub.`;
			} else {
				const j = await r.json() as { id?: string };
				this.sent = true;
				void this.panel?.webview.postMessage({ type: 'result', ok: true, ref: String(j.id ?? '') });
				return;
			}
		} catch {
			reply = 'Could not reach the report inbox. Check the connection and try again, or use GitHub.';
		}
		void this.panel?.webview.postMessage({ type: 'result', ok: false, message: reply });
	}

	private html(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const csp = [`default-src 'none'`, `style-src 'nonce-${nonce}'`, `script-src 'nonce-${nonce}'`].join('; ');
		return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Report a problem</title>
<style nonce="${nonce}">
:root { --fg: var(--vscode-foreground); --mute: var(--vscode-descriptionForeground); --line: var(--vscode-widget-border, rgba(128,128,128,.22)); --field: var(--vscode-input-background); --accent: var(--vscode-button-background); --accent-fg: var(--vscode-button-foreground); --ok: var(--vscode-testing-iconPassed, #3fb950); --err: var(--vscode-errorForeground, #f14c4c); --ease: cubic-bezier(0.23, 1, 0.32, 1); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--vscode-editor-background); color: var(--fg); font-family: var(--vscode-font-family); font-size: 13px; -webkit-font-smoothing: antialiased; }
main { max-width: 560px; margin: 0 auto; padding: 48px 28px 64px; animation: rise 380ms var(--ease) both; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
.lead { margin: 6px 0 26px; color: var(--mute); line-height: 1.5; }
label { display: block; margin: 0 0 7px; font-weight: 500; }
.hint { color: var(--mute); font-weight: 400; }
textarea, input { width: 100%; border: 0; outline: 0; border-radius: 9px; padding: 10px 12px; color: var(--fg); background: var(--field); font: inherit; box-shadow: inset 0 0 0 1px var(--line); transition: box-shadow 140ms ease; }
textarea { min-height: 128px; resize: vertical; line-height: 1.5; }
textarea:focus, input:focus { box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
.field { margin-bottom: 18px; }
.error { margin: 0 0 18px; border-radius: 9px; box-shadow: inset 0 0 0 1px var(--line); overflow: hidden; }
.error-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; color: var(--mute); }
.error pre { margin: 0; padding: 0 12px 10px; max-height: 120px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); font-size: 12px; color: var(--fg); opacity: .85; }
.error.is-off pre { opacity: .35; text-decoration: line-through; }
.toggle { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; }
.toggle input { width: auto; margin: 0; box-shadow: none; }
.facts { margin: 0 0 22px; padding: 12px 14px; border-radius: 9px; background: color-mix(in srgb, var(--fg) 4%, transparent); color: var(--mute); font-size: 12px; line-height: 1.6; }
.facts b { color: var(--fg); font-weight: 500; }
.row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
button { font: inherit; border: 0; cursor: pointer; }
.send { height: 32px; padding: 0 16px; border-radius: 8px; background: var(--accent); color: var(--accent-fg); font-weight: 500; transition: transform 120ms var(--ease), filter 120ms ease, opacity 120ms ease; }
.send:hover:not(:disabled) { filter: brightness(1.08); }
.send:active:not(:disabled) { transform: scale(0.97); }
.send:disabled { opacity: .55; cursor: default; }
.link { background: none; padding: 0; color: var(--mute); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: color-mix(in srgb, var(--mute) 50%, transparent); }
.link:hover { color: var(--fg); }
.msg { margin-top: 14px; color: var(--err); line-height: 1.5; animation: rise 240ms var(--ease) both; }
.done { text-align: center; padding-top: 40px; animation: rise 420ms var(--ease) both; }
.done svg { width: 44px; height: 44px; color: var(--ok); }
.done path { stroke-dasharray: 30; stroke-dashoffset: 30; animation: draw 520ms 120ms var(--ease) forwards; }
@keyframes draw { to { stroke-dashoffset: 0; } }
.done h1 { margin-top: 16px; }
.done p { color: var(--mute); line-height: 1.55; margin: 8px auto 22px; max-width: 40ch; }
.kbd { color: var(--mute); font-size: 12px; }
@media (prefers-reduced-motion: reduce) { main, .msg, .done { animation: none; } .done path { stroke-dashoffset: 0; animation: none; } }
</style></head><body><main id="app">
<h1>Report a problem</h1>
<p class="lead">Tell us what went wrong. It goes straight to the person who builds OpenCursor. No account needed.</p>
<div class="field"><label for="what">What happened?</label><textarea id="what" placeholder="What you did, what you expected, and what happened instead." autofocus></textarea></div>
<div class="error" id="err" hidden><div class="error-head"><span>The error</span><label class="toggle"><input type="checkbox" id="inc" checked> Include it</label></div><pre id="errtext"></pre></div>
<div class="field"><label for="who">How can we reach you? <span class="hint">Optional</span></label><input id="who" placeholder="Discord name or email, if you want a reply" maxlength="120"></div>
<div class="facts" id="facts"></div>
<div class="row"><button class="send" id="send" disabled>Send report</button><button class="link" id="gh">Report on GitHub instead</button><span class="kbd" id="kbd"></span></div>
<div class="msg" id="msg" hidden></div>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const what = $('what'), send = $('send'), msg = $('msg');
const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
$('kbd').textContent = (navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+') + 'Enter to send';
const sync = () => { send.disabled = what.value.trim().length < 3 || send.dataset.busy === '1'; };
what.addEventListener('input', sync);
let sent = false;
const go = () => {
	if (sent || send.disabled) return;
	send.dataset.busy = '1'; send.textContent = 'Sending'; sync(); msg.hidden = true;
	vscode.postMessage({ type: 'send', message: what.value, contact: $('who').value, includeError: $('inc').checked });
};
send.addEventListener('click', go);
const onKey = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } };
document.addEventListener('keydown', onKey);
$('gh').addEventListener('click', () => vscode.postMessage({ type: 'github', message: what.value }));
$('inc').addEventListener('change', e => $('err').classList.toggle('is-off', !e.target.checked));
window.addEventListener('message', e => {
	const m = e.data;
	if (m.type === 'facts') {
		const f = m.facts;
		if (!$('err') || !$('facts')) return;
		if (!f) { $('facts').textContent = 'Reports cannot be sent from this system. Use GitHub instead.'; return; }
		$('err').hidden = !f.error; $('errtext').textContent = f.error || '';
		const parts = ['OpenCursor <b>' + f.version + '</b>', '<b>' + OS[f.os] + '</b> ' + f.arch];
		if (f.model) parts.push('model <b></b>');
		if (f.mode) parts.push('mode <b></b>');
		parts.push(f.folder ? 'a folder was open' : '<b>no folder open</b>');
		$('facts').innerHTML = 'Sent with it: ' + parts.join(' · ') + '. Never your code, chats or API keys.';
		const bs = $('facts').querySelectorAll('b');
		let i = 2;
		if (f.model) bs[i++].textContent = f.model;
		if (f.mode) bs[i++].textContent = f.mode;
	} else if (m.type === 'result') {
		send.dataset.busy = '0'; send.textContent = 'Send report'; sync();
		if (m.ok) {
			sent = true;
			document.removeEventListener('keydown', onKey);
			$('app').innerHTML = '<div class="done"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><h1>Thanks, it is sent</h1><p id="ref"></p><button class="send" id="close">Close</button></div>';
			$('ref').textContent = (m.ref ? 'Reference ' + m.ref + '. ' : '') + 'Every report is read. If you left a way to reach you, you may get a reply.';
			$('close').addEventListener('click', () => vscode.postMessage({ type: 'close' }));
		} else {
			msg.textContent = m.message; msg.hidden = false;
		}
	}
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
	}
}
