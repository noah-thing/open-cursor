/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  The anonymous install count. Once a day it sends a random ID made on first launch, the version
 *  and the OS, so the project knows how many copies are in use. Nothing about the person, their
 *  code, chats or keys. Off when the user turns it off here or turns telemetry off in the editor.
 *  The counter it talks to is in /stats of the repository.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { chosen, pingBody, telemetryOff } from './ping';

const ENDPOINT = 'https://opencursor-stats.opencursor.workers.dev/v1/ping';
const ID_KEY = 'openCursor.stats.installId';
const SENT_KEY = 'openCursor.stats.lastSentDay';
const FIRST_MS = 30_000;
const EVERY_MS = 60 * 60 * 1000;

function enabled(): boolean {
	const t = vscode.workspace.getConfiguration('telemetry');
	return vscode.workspace.getConfiguration('openCursor').get<boolean>('privacy.anonymousCount', true)
		&& !telemetryOff(chosen(t.inspect('telemetryLevel')), chosen(t.inspect('enableTelemetry')));
}

export function registerInstallCount(ctx: vscode.ExtensionContext): void {
	const version = String(ctx.extension.packageJSON.version ?? '0.0.0');
	const send = async (): Promise<void> => {
		const today = new Date().toISOString().slice(0, 10);
		if (!enabled() || ctx.globalState.get<string>(SENT_KEY) === today) { return; }
		let id = ctx.globalState.get<string>(ID_KEY);
		if (!id) {
			id = randomUUID();
			await ctx.globalState.update(ID_KEY, id);
		}
		const body = pingBody(id, version, process.platform, process.arch);
		if (!body) { return; }
		try {
			const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'OpenCursor' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
			if (r.ok) { await ctx.globalState.update(SENT_KEY, today); }
		} catch {
			// offline or blocked: try again later, never bother the user
		}
	};
	const first = setTimeout(() => void send(), FIRST_MS);
	// a window left open over midnight still counts the new day
	const timer = setInterval(() => void send(), EVERY_MS);
	ctx.subscriptions.push({ dispose: () => { clearTimeout(first); clearInterval(timer); } });
}
