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

const MAX_BODY = 64 * 1024;
const NEW_INSTALLS_PER_IP_PER_DAY = 20;
const REPORTS_PER_IP_PER_HOUR = 10;

/** The JSON object in the body, reading at most 64 KB. A Response when it is too big, not JSON, or not an object. */
async function readObject(req: Request): Promise<Record<string, unknown> | Response> {
	if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) { return new Response('too big', { status: 413 }); }
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (req.body) {
		const reader = req.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) { break; }
			size += value.length;
			if (size > MAX_BODY) { void reader.cancel(); return new Response('too big', { status: 413 }); }
			chunks.push(value);
		}
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) { bytes.set(c, at); at += c.length; }
	try {
		const j: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (!j || typeof j !== 'object' || Array.isArray(j)) { return new Response('bad json', { status: 400 }); }
		return j as Record<string, unknown>;
	} catch {
		return new Response('bad json', { status: 400 });
	}
}

/** Counts one use for this network in the given period and says whether it is over the limit. Only a salted hash of the IP is kept, and the salt changes every day. */
async function overIpLimit(req: Request, env: Env, kind: string, period: string, limit: number): Promise<boolean> {
	const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
	const hash = await sha256(`${env.STATS_KEY ?? ''}|${day()}|${ip}`);
	const row = await env.DB.prepare(
		'INSERT INTO ip_limits (kind, period, hash, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT (kind, period, hash) DO UPDATE SET n = n + 1 RETURNING n',
	).bind(kind, period, hash).first<{ n: number }>();
	// old windows go with the next write; strings of this shape sort by time
	await env.DB.prepare('DELETE FROM ip_limits WHERE period < ?1').bind(day(2)).run();
	return Number(row?.n ?? 0) > limit;
}

const str = (v: unknown): v is string => typeof v === 'string';
/** Optional text fields must be text when present. */
const optionalText = (...vs: unknown[]): boolean => vs.every(v => v === undefined || v === null || str(v));

async function ping(req: Request, env: Env): Promise<Response> {
	const body = await readObject(req);
	if (body instanceof Response) { return body; }
	if (!str(body.id) || !str(body.version) || !str(body.os) || !str(body.arch)) { return new Response('bad ping', { status: 400 }); }
	const id = body.id.toLowerCase();
	const { version, os, arch } = body;
	if (!UUID.test(id) || !VERSION.test(version) || !OS.has(os) || !ARCH.has(arch)) {
		return new Response('bad ping', { status: 400 });
	}
	const hash = await sha256(id);
	const today = day();
	// known installs just check in; only new IDs count against the network's daily limit, so a script cannot inflate the total
	const known = await env.DB.prepare('SELECT 1 AS k FROM installs WHERE hash = ?1').bind(hash).first();
	if (!known && await overIpLimit(req, env, 'ping', today, NEW_INSTALLS_PER_IP_PER_DAY)) {
		return new Response('too many new installs from this network', { status: 429 });
	}
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

const clipText = (v: unknown, n: number): string => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, n);

/** The first line of an error with numbers, paths and ids blurred, so the same problem groups together. */
function signature(error: string, message: string): string {
	const line = (error || message).split('\n').find(l => l.trim()) ?? '';
	return line.replace(/[A-Za-z]:\\[^\s"']+|\/[^\s"']+/g, '<path>').replace(/\b[0-9a-f]{8,}\b/gi, '<id>').replace(/\d+/g, '#').trim().slice(0, 140);
}

async function report(req: Request, env: Env): Promise<Response> {
	const b = await readObject(req);
	if (b instanceof Response) { return b; }
	if (!str(b.message) || !str(b.version) || !str(b.os) || !str(b.arch) || !str(b.id) || !optionalText(b.error, b.model, b.mode, b.contact)) {
		return new Response('bad report', { status: 400 });
	}
	const message = clipText(b.message, 4000);
	const version = clipText(b.version, 24);
	const os = clipText(b.os, 12);
	const arch = clipText(b.arch, 8);
	const id = String(b.id ?? '').toLowerCase();
	if (message.length < 3 || !VERSION.test(version) || !OS.has(os) || !ARCH.has(arch) || !UUID.test(id)) {
		return new Response('bad report', { status: 400 });
	}
	const hash = await sha256(id);
	const hour = new Date().toISOString().slice(0, 13);
	const used = Number((await env.DB.prepare('SELECT n FROM report_limits WHERE hash = ?1 AND hour = ?2').bind(hash, hour).first<{ n: number }>())?.n ?? 0);
	const today = Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE time >= ?1').bind(Date.now() - 86_400_000).first<{ n: number }>())?.n ?? 0);
	if (used >= 10 || today >= 2000) { return new Response('too many reports, try again later', { status: 429 }); }
	if (await overIpLimit(req, env, 'report', hour, REPORTS_PER_IP_PER_HOUR)) { return new Response('too many reports from this network, try again later', { status: 429 }); }
	const error = clipText(b.error, 3000);
	const rid = crypto.randomUUID();
	await env.DB.batch([
		env.DB.prepare(
			'INSERT INTO reports (id, time, version, os, arch, model, mode, folder, error, message, contact, sig) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)',
		).bind(rid, Date.now(), version, os, arch, clipText(b.model, 120) || null, clipText(b.mode, 12) || null, b.folder === true ? 1 : b.folder === false ? 0 : null, error || null, message, clipText(b.contact, 120) || null, signature(error, message)),
		env.DB.prepare('INSERT INTO report_limits (hash, hour, n) VALUES (?1, ?2, 1) ON CONFLICT (hash, hour) DO UPDATE SET n = n + 1').bind(hash, hour),
		env.DB.prepare('DELETE FROM report_limits WHERE hour < ?1').bind(new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 13)),
	]);
	return Response.json({ id: rid.slice(0, 8) });
}

interface ReportRow { id: string; time: number; version: string; os: string; arch: string; model: string | null; mode: string | null; folder: number | null; error: string | null; message: string; contact: string | null; sig: string | null; status: string }

function reportsPage(rows: ReportRow[], key: string, show: string): string {
	const groups = new Map<string, number>();
	for (const r of rows) { if (r.status === 'new' && r.sig) { groups.set(r.sig, (groups.get(r.sig) ?? 0) + 1); } }
	const top = [...groups.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 8);
	const when = (t: number): string => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
	const cards = rows.map(r => `<article class="${r.status === 'fixed' ? 'is-fixed' : ''}" id="r-${esc(r.id)}">
<header><span class="when">${when(r.time)} UTC</span><span class="facts">${esc(r.version)} · ${esc(OS_NAME[r.os] ?? r.os)} ${esc(r.arch)}${r.model ? ' · ' + esc(r.model) : ''}${r.mode ? ' · ' + esc(r.mode) : ''}${r.folder === 0 ? ' · no folder open' : ''}</span>
<button data-id="${esc(r.id)}" data-to="${r.status === 'fixed' ? 'new' : 'fixed'}">${r.status === 'fixed' ? 'Reopen' : 'Mark fixed'}</button></header>
<p class="msg">${esc(r.message)}</p>${r.error ? `<pre>${esc(r.error)}</pre>` : ''}${r.contact ? `<p class="contact">Reply to: ${esc(r.contact)}</p>` : ''}</article>`).join('') || '<p class="none">No reports.</p>';
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>OpenCursor reports</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--mute:#78716c;--line:#e7e5e4;--card:#fff;--hi:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#f5f5f4;--mute:#a8a29e;--line:#2a2a2a;--card:#1b1b1b;--hi:#f59e0b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 20px 60px}h1{font-size:20px;margin:0 0 4px}.lead{color:var(--mute);margin:0 0 20px}
nav{display:flex;gap:14px;margin-bottom:18px}nav a{color:var(--mute);text-decoration:none}nav a.on{color:var(--fg);font-weight:600}
.groups{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin-bottom:18px}.groups h2{font-size:13px;color:var(--mute);font-weight:500;margin:0 0 6px}.groups li{margin:2px 0}.groups b{color:var(--hi)}
article{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px}article.is-fixed{opacity:.55}
header{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;color:var(--mute);font-size:12.5px}.facts{flex:1}
button{font:inherit;font-size:12px;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:7px;padding:3px 9px;cursor:pointer}
.msg{margin:8px 0 0;white-space:pre-wrap}pre{margin:8px 0 0;padding:8px 10px;background:var(--bg);border-radius:8px;overflow:auto;font-size:12px;white-space:pre-wrap}
.contact{margin:8px 0 0;color:var(--mute);font-size:12.5px}.none{color:var(--mute)}ul{margin:0;padding-left:18px}
</style></head><body><main>
<h1>OpenCursor reports</h1><p class="lead">Sent from Report a Problem in the app. Newest first. Times are UTC.</p>
<nav><a class="${show === 'new' ? 'on' : ''}" href="?key=${encodeURIComponent(key)}">Open</a><a class="${show === 'all' ? 'on' : ''}" href="?key=${encodeURIComponent(key)}&show=all">All</a></nav>
${top.length ? `<section class="groups"><h2>Reported more than once</h2><ul>${top.map(([s, n]) => `<li><b>${n}×</b> ${esc(s)}</li>`).join('')}</ul></section>` : ''}
${cards}
<script>document.addEventListener('click',async e=>{const b=e.target.closest('button[data-id]');if(!b)return;b.disabled=true;const r=await fetch('/reports/status?key=${encodeURIComponent(key)}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:b.dataset.id,status:b.dataset.to})});if(r.ok)location.reload();else b.disabled=false;});</script>
</main></body></html>`;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === '/v1/report' && req.method === 'POST') {
			return report(req, env);
		}
		if (url.pathname === '/reports' || url.pathname === '/reports.json' || url.pathname === '/reports/status') {
			const key = url.searchParams.get('key') ?? '';
			if (!sameKey(key, env.STATS_KEY ?? '')) { return new Response('Not found', { status: 404 }); }
			const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };
			if (url.pathname === '/reports/status' && req.method === 'POST') {
				const b = await req.json().catch(() => ({})) as { id?: string; status?: string };
				if (!b.id || (b.status !== 'new' && b.status !== 'fixed')) { return new Response('bad', { status: 400 }); }
				await env.DB.prepare('UPDATE reports SET status = ?1 WHERE id = ?2').bind(b.status, b.id).run();
				return new Response(null, { status: 204 });
			}
			const show = url.searchParams.get('show') === 'all' ? 'all' : 'new';
			const rows = (await env.DB.prepare(`SELECT * FROM reports ${show === 'new' ? "WHERE status = 'new'" : ''} ORDER BY time DESC LIMIT 300`).all<ReportRow>()).results;
			return url.pathname === '/reports.json'
				? Response.json(rows, { headers })
				: new Response(reportsPage(rows, key, show), { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
		}
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
