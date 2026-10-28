/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as vscode from 'vscode';

const AUTH_URL = 'https://openrouter.ai/auth';
const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
const WAIT_MS = 5 * 60_000;

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>OpenCursor</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#141416;color:#ececee}p{opacity:.6}</style>
<div><h2>Connected</h2><p>You can close this tab and go back to OpenCursor.</p></div>`;

/**
 * OpenRouter's PKCE flow for desktop apps: the user signs in on openrouter.ai, approves, and the
 * browser comes back to a one shot localhost listener with a code that we trade for the user's own key.
 */
export async function signInWithOpenRouter(token?: vscode.CancellationToken): Promise<string> {
	const verifier = crypto.randomBytes(32).toString('base64url');
	const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
	const server = http.createServer();
	try {
		const code = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Sign in timed out. Try again.')), WAIT_MS);
			token?.onCancellationRequested(() => { clearTimeout(timer); reject(new Error('Cancelled.')); });
			server.on('request', (req, res) => {
				const url = new URL(req.url ?? '/', 'http://localhost');
				if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
				const got = url.searchParams.get('code');
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE);
				clearTimeout(timer);
				if (got) { resolve(got); } else { reject(new Error('OpenRouter did not return a code.')); }
			});
			server.on('error', reject);
			server.listen(0, '127.0.0.1', () => {
				const port = (server.address() as AddressInfo).port;
				const query = `callback_url=${encodeURIComponent(`http://localhost:${port}/callback`)}&code_challenge=${challenge}&code_challenge_method=S256`;
				void vscode.env.openExternal(vscode.Uri.parse(`${AUTH_URL}?${query}`, true));
			});
		});
		const res = await fetch(EXCHANGE_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
			signal: AbortSignal.timeout(20_000),
		});
		if (!res.ok) { throw new Error(`OpenRouter refused the sign in (HTTP ${res.status}).`); }
		const body = await res.json() as { key?: string };
		if (!body.key) { throw new Error('OpenRouter did not return a key.'); }
		return body.key;
	} finally {
		server.close();
	}
}
