/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  The anonymous install counter. Once a day each copy of OpenCursor that has not turned the count
 *  off sends a random ID it made on first launch, its version and its OS. The ID is hashed before it
 *  is stored, IP addresses are never stored, and requests are not logged. /stats shows the totals
 *  to whoever holds STATS_KEY.
 *--------------------------------------------------------------------------------------------*/

interface Env {
	DB: D1Database;
	STATS_KEY: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9a-z.]{1,20})?$/;
const OS = new Set(['darwin', 'win32', 'linux']);
const ARCH = new Set(['arm64', 'x64']);

function day(offset = 0): string {
	return new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
}

async function sha256(s: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function ping(req: Request, env: Env): Promise<Response> {
	let body: { id?: unknown; version?: unknown; os?: unknown; arch?: unknown };
	try {
		body = await req.json();
	} catch {
		return new Response('bad json', { status: 400 });
	}
	const id = String(body.id ?? '').toLowerCase();
	const version = String(body.version ?? '');
	const os = String(body.os ?? '');
	const arch = String(body.arch ?? '');
	if (!UUID.test(id) || !VERSION.test(version) || !OS.has(os) || !ARCH.has(arch)) {
		return new Response('bad ping', { status: 400 });
	}
	const hash = await sha256(id);
	const today = day();
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO installs (hash, first_day, last_day, os, arch, version) VALUES (?1, ?2, ?2, ?3, ?4, ?5)
			 ON CONFLICT (hash) DO UPDATE SET last_day = ?2, os = ?3, arch = ?4, version = ?5`,
		).bind(hash, today, os, arch, version),
		env.DB.prepare('INSERT OR IGNORE INTO active (day, hash) VALUES (?1, ?2)').bind(today, hash),
	]);
	return new Response(null, { status: 204 });
}

/** Constant time comparison, so the key cannot be guessed one character at a time. */
function sameKey(a: string, b: string): boolean {
	if (!a || !b || a.length !== b.length) { return false; }
	let diff = 0;
	for (let i = 0; i < a.length; i++) { diff |= a.charCodeAt(i) ^ b.charCodeAt(i); }
	return diff === 0;
}

async function stats(env: Env): Promise<Record<string, unknown>> {
	const one = async (sql: string, ...args: unknown[]): Promise<number> => Number((await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0);
	const all = async <T>(sql: string, ...args: unknown[]): Promise<T[]> => (await env.DB.prepare(sql).bind(...args).all<T>()).results;
	return {
		total: await one('SELECT COUNT(*) AS n FROM installs'),
		newToday: await one('SELECT COUNT(*) AS n FROM installs WHERE first_day = ?1', day()),
		newWeek: await one('SELECT COUNT(*) AS n FROM installs WHERE first_day >= ?1', day(6)),
		activeToday: await one('SELECT COUNT(*) AS n FROM active WHERE day = ?1', day()),
		activeWeek: await one('SELECT COUNT(DISTINCT hash) AS n FROM active WHERE day >= ?1', day(6)),
		activeMonth: await one('SELECT COUNT(DISTINCT hash) AS n FROM active WHERE day >= ?1', day(29)),
		byOs: await all<{ os: string; n: number }>('SELECT os, COUNT(*) AS n FROM installs WHERE last_day >= ?1 GROUP BY os ORDER BY n DESC', day(29)),
		byVersion: await all<{ version: string; n: number }>('SELECT version, COUNT(*) AS n FROM installs WHERE last_day >= ?1 GROUP BY version ORDER BY n DESC', day(29)),
		daily: await all<{ day: string; active: number }>('SELECT day, COUNT(*) AS active FROM active WHERE day >= ?1 GROUP BY day ORDER BY day', day(29)),
		newDaily: await all<{ day: string; n: number }>('SELECT first_day AS day, COUNT(*) AS n FROM installs WHERE first_day >= ?1 GROUP BY first_day ORDER BY first_day', day(29)),
	};
}

const OS_NAME: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

function esc(s: unknown): string {
	return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function page(s: Awaited<ReturnType<typeof stats>>): string {
	const daily = s.daily as { day: string; active: number }[];
	const newDaily = new Map((s.newDaily as { day: string; n: number }[]).map(r => [r.day, r.n]));
	const days = Array.from({ length: 30 }, (_, i) => day(29 - i));
	const activeBy = new Map(daily.map(r => [r.day, r.active]));
	const max = Math.max(1, ...days.map(d => activeBy.get(d) ?? 0));
	const bars = days.map(d => {
		const a = activeBy.get(d) ?? 0;
		const n = newDaily.get(d) ?? 0;
		return `<div class="bar" title="${d}: ${a} active, ${n} new"><i style="height:${(a / max) * 100}%"></i><b style="height:${(n / max) * 100}%"></b></div>`;
	}).join('');
	const rows = (list: { n: number }[], label: (r: never) => string): string => {
		const total = list.reduce((x, r) => x + r.n, 0) || 1;
		return list.map(r => `<li><span>${esc(label(r as never))}</span><span class="track"><span style="width:${(r.n / total) * 100}%"></span></span><span class="n">${r.n}</span></li>`).join('') || '<li class="none">No data yet</li>';
	};
	const tile = (label: string, n: unknown, sub = ''): string => `<div class="tile"><div class="label">${label}</div><div class="num">${Number(n).toLocaleString('en')}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>OpenCursor installs</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--mute:#78716c;--line:#e7e5e4;--card:#fff;--a:#1c1917;--b:#a8a29e}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#f5f5f4;--mute:#a8a29e;--line:#2a2a2a;--card:#1b1b1b;--a:#f5f5f4;--b:#57534e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 20px 60px}h1{font-size:20px;margin:0 0 4px}p.lead{color:var(--mute);margin:0 0 28px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:28px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.label{color:var(--mute);font-size:12px}.num{font-size:28px;font-weight:600;font-variant-numeric:tabular-nums}.sub{color:var(--mute);font-size:12px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}h2{font-size:13px;margin:0 0 12px;color:var(--mute);font-weight:500}
.chart{display:flex;align-items:flex-end;gap:3px;height:120px}.bar{flex:1;height:100%;position:relative}.bar i,.bar b{position:absolute;bottom:0;left:0;right:0;border-radius:3px 3px 0 0}.bar i{background:var(--b)}.bar b{background:var(--a)}
.legend{display:flex;gap:16px;color:var(--mute);font-size:12px;margin-top:8px}.legend span::before{content:"";display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:var(--b)}.legend span.new::before{background:var(--a)}
ul{list-style:none;margin:0;padding:0}li{display:grid;grid-template-columns:110px 1fr 48px;gap:10px;align-items:center;padding:4px 0}.track{height:8px;background:var(--line);border-radius:4px;overflow:hidden}.track span{display:block;height:100%;background:var(--a)}.n{text-align:right;font-variant-numeric:tabular-nums}.none{color:var(--mute);display:block}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media (max-width:640px){.cols{grid-template-columns:1fr}}
footer{color:var(--mute);font-size:12px;margin-top:20px}
</style></head><body><main>
<h1>OpenCursor installs</h1><p class="lead">Anonymous counts from copies that have the count turned on. Days are UTC.</p>
<div class="tiles">${tile('Total installs', s.total)}${tile('New today', s.newToday, `${Number(s.newWeek).toLocaleString('en')} this week`)}${tile('Active today', s.activeToday)}${tile('Active this week', s.activeWeek)}${tile('Active this month', s.activeMonth)}</div>
<section><h2>Last 30 days</h2><div class="chart">${bars}</div><div class="legend"><span>Active</span><span class="new">New installs</span></div></section>
<div class="cols"><section><h2>System, active this month</h2><ul>${rows(s.byOs as { os: string; n: number }[], (r: { os: string }) => OS_NAME[r.os] ?? r.os)}</ul></section>
<section><h2>Version, active this month</h2><ul>${rows(s.byVersion as { version: string; n: number }[], (r: { version: string }) => r.version)}</ul></section></div>
<footer>Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</footer>
</main></body></html>`;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === '/v1/ping' && req.method === 'POST') {
			return ping(req, env);
		}
		if (url.pathname === '/stats' || url.pathname === '/stats.json') {
			if (!sameKey(url.searchParams.get('key') ?? '', env.STATS_KEY ?? '')) {
				return new Response('Not found', { status: 404 });
			}
			const s = await stats(env);
			const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };
			return url.pathname === '/stats.json'
				? Response.json(s, { headers })
				: new Response(page(s), { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
		}
		return new Response('OpenCursor install counter. See https://github.com/noah-thing/open-cursor/tree/main/stats', { status: 200 });
	},
} satisfies ExportedHandler<Env>;
