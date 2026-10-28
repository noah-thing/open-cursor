/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { htmlToText } from '../../context/html';
import { clip, str, type ToolDef } from './types';
import { msg } from './fsutil';

interface Args { url?: string }

const MAX_CHARS = 20000;

export const fetchUrl: ToolDef<Args> = {
	readOnly: true,
	schema: {
		name: 'fetch_url',
		description: 'Fetch a web page or text resource and return it as readable text (HTML is stripped; capped at 20k characters). Use for documentation, issues, API references.',
		parameters: {
			type: 'object',
			properties: { url: { type: 'string', description: 'http(s) URL.' } },
			required: ['url'],
		},
	},
	async run(args, ctx) {
		const url = str(args.url);
		if (!url || !/^https?:\/\//i.test(url)) { return { content: 'url must start with http:// or https://', isError: true }; }
		const timeout = AbortSignal.timeout(20000);
		try {
			const res = await fetch(url, { signal: AbortSignal.any([ctx.signal, timeout]), redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; OpenCursor/0.1)', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' } });
			const ct = res.headers.get('content-type') ?? '';
			if (!res.ok) { return { content: `HTTP ${res.status} ${res.statusText} for ${url}`, isError: true }; }
			if (/^(image|audio|video)\//.test(ct) || /octet-stream|zip|pdf/.test(ct)) {
				return { content: `Cannot show ${ct} content from ${url}.`, isError: true };
			}
			const raw = (await res.text()).slice(0, 2_000_000);
			const text = ct.includes('html') || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw;
			const out = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + `\n[truncated, ${text.length - MAX_CHARS} more characters]` : text;
			return { content: out || '(empty response)', output: `${Math.min(text.length, MAX_CHARS)} chars` };
		} catch (e) {
			if (ctx.signal.aborted) { return { content: 'Fetch cancelled.', isError: true }; }
			return { content: timeout.aborted ? `Timed out fetching ${url}` : `Fetch failed: ${msg(e)}`, isError: true };
		}
	},
	title(args, status) {
		const host = (() => { try { return new URL(args.url ?? '').host; } catch { return clip(args.url ?? '', 40); } })();
		return status === 'done' ? `Fetched ${host}` : `Fetching ${host}`;
	},
};
