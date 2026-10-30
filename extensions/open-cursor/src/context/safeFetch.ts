/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  fetch for URLs a model or a pasted link supplies: http(s) only, no loopback or private
 *  networks (checked on every redirect hop), bounded body and time.
 *--------------------------------------------------------------------------------------------*/

import * as dns from 'node:dns';
import * as net from 'node:net';

export interface SafeFetchResult { status: number; contentType: string; text: string; finalUrl: string }

function v4Blocked(a: number, b: number): boolean {
	return a === 0 || a === 10 || a === 127
		|| (a === 100 && b >= 64 && b <= 127) // CGNAT
		|| (a === 169 && b === 254) // link local and cloud metadata
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && b === 168)
		|| a >= 224; // multicast, reserved, broadcast
}

/** True for loopback, private, link local, CGNAT, unspecified, multicast and metadata addresses. */
export function isBlockedAddress(addr: string): boolean {
	let ip = addr.trim().toLowerCase().replace(/^\[|\]$/g, '');
	const zone = ip.indexOf('%');
	if (zone >= 0) { ip = ip.slice(0, zone); }
	const kind = net.isIP(ip);
	if (kind === 4) {
		const [a, b] = ip.split('.').map(Number);
		return v4Blocked(a, b);
	}
	if (kind === 6) {
		// IPv4 mapped (::ffff:a.b.c.d or ::ffff:7f00:1)
		const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
		if (dotted) { return isBlockedAddress(dotted[1]); }
		const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
		if (hex) {
			const hi = parseInt(hex[1], 16);
			return v4Blocked(hi >> 8, hi & 255);
		}
		if (ip === '::' || ip === '::1') { return true; }
		const first = parseInt(ip.split(':')[0] || '0', 16);
		if ((first & 0xfe00) === 0xfc00) { return true; } // fc00::/7
		if ((first & 0xffc0) === 0xfe80) { return true; } // fe80::/10
		if ((first & 0xff00) === 0xff00) { return true; } // multicast
		return false;
	}
	return true; // not an IP at all: refuse
}

async function assertPublicHost(url: URL): Promise<void> {
	const host = url.hostname.replace(/^\[|\]$/g, '');
	if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
		throw new Error(`blocked host ${host || '(empty)'}`);
	}
	if (net.isIP(host)) {
		if (isBlockedAddress(host)) { throw new Error(`blocked address ${host}`); }
		return;
	}
	const found = await dns.promises.lookup(host, { all: true });
	if (!found.length) { throw new Error(`could not resolve ${host}`); }
	for (const f of found) {
		if (isBlockedAddress(f.address)) { throw new Error(`blocked: ${host} resolves to a private address`); }
	}
}

export async function safeFetch(url: string, opts: { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number } = {}): Promise<SafeFetchResult> {
	const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
	const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20000);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	let current = url;
	for (let hop = 0; hop <= 5; hop++) {
		const u = new URL(current);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') { throw new Error(`unsupported protocol ${u.protocol}`); }
		await assertPublicHost(u);
		const res = await fetch(u, { signal, redirect: 'manual', headers: { 'user-agent': 'OpenCursor/0.1', accept: 'text/html,text/plain,*/*' } });
		if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
			void res.body?.cancel().catch(() => undefined);
			current = new URL(res.headers.get('location')!, u).toString();
			continue;
		}
		const chunks: Uint8Array[] = [];
		let total = 0;
		if (res.body) {
			const reader = res.body.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) { break; }
					const room = maxBytes - total;
					if (value.length >= room) { chunks.push(value.subarray(0, room)); total += room; break; }
					chunks.push(value); total += value.length;
				}
			} finally {
				void reader.cancel().catch(() => undefined);
			}
		}
		const text = new TextDecoder('utf-8').decode(Buffer.concat(chunks));
		return { status: res.status, contentType: res.headers.get('content-type') ?? '', text, finalUrl: u.toString() };
	}
	throw new Error('too many redirects');
}
