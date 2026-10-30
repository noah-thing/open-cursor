/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: '\'', lsquo: '\'', rdquo: '"', ldquo: '"', copy: '(c)' };

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === '#') {
			const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			try {
				return Number.isFinite(code) ? String.fromCodePoint(code) : m;
			} catch {
				return m;
			}
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}

interface Tok { tag: boolean; name: string; closing: boolean; raw: string }

const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'template', 'head', 'nav', 'footer', 'iframe']);
const BLOCK_END = new Set(['p', 'div', 'section', 'article', 'tr', 'table', 'ul', 'ol', 'blockquote', 'header', 'main']);
const MAX_HTML_CHARS = 2_000_000;

/** One pass with indexOf only, so thousands of unclosed tags cannot make it quadratic. */
function tokenize(html: string): Tok[] {
	const out: Tok[] = [];
	let pos = 0;
	while (pos < html.length) {
		const lt = html.indexOf('<', pos);
		if (lt < 0) { out.push({ tag: false, name: '', closing: false, raw: html.slice(pos) }); break; }
		if (lt > pos) { out.push({ tag: false, name: '', closing: false, raw: html.slice(pos, lt) }); }
		if (html.startsWith('<!--', lt)) {
			const end = html.indexOf('-->', lt + 4);
			pos = end < 0 ? html.length : end + 3;
			continue;
		}
		const gt = html.indexOf('>', lt + 1);
		if (gt < 0 || !/[a-z/!?]/i.test(html[lt + 1])) {
			out.push({ tag: false, name: '', closing: false, raw: '<' });
			pos = lt + 1;
			continue;
		}
		const raw = html.slice(lt + 1, gt);
		const m = /^(\/?)([a-z][a-z0-9]*)/i.exec(raw.slice(0, 40));
		out.push({ tag: true, name: m ? m[2].toLowerCase() : '', closing: !!m && m[1] === '/', raw });
		pos = gt + 1;
	}
	return out;
}

export function htmlToText(html: string): string {
	const toks = tokenize(html.slice(0, MAX_HTML_CHARS));
	// last index of each closing tag: a skip/pre/heading/link only opens when a close exists later
	const lastClose = new Map<string, number>();
	toks.forEach((t, i) => { if (t.tag && t.closing) { lastClose.set(t.name, i); } });
	const hasClose = (name: string, from: number) => (lastClose.get(name) ?? -1) > from;
	const innerText = (from: number, name: string): { text: string; end: number } => {
		let text = '';
		let i = from + 1;
		for (; i < toks.length; i++) {
			const t = toks[i];
			if (t.tag && t.closing && t.name === name) { break; }
			if (!t.tag) { text += t.raw; }
		}
		return { text, end: i };
	};

	let title: string | undefined;
	for (let i = 0; i < toks.length; i++) {
		if (toks[i].tag && !toks[i].closing && toks[i].name === 'title' && hasClose('title', i)) { title = innerText(i, 'title').text; break; }
	}

	let s = '';
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if (!t.tag) { s += t.raw; continue; }
		if (t.closing) {
			if (BLOCK_END.has(t.name)) { s += '\n\n'; } else if (t.name === 'td' || t.name === 'th') { s += '\t'; }
			continue;
		}
		if (SKIP.has(t.name) && hasClose(t.name, i)) {
			while (i < toks.length && !(toks[i].tag && toks[i].closing && toks[i].name === t.name)) { i++; }
		} else if (t.name === 'pre' && hasClose('pre', i)) {
			const r = innerText(i, 'pre');
			s += '\n```\n' + r.text + '\n```\n';
			i = r.end;
		} else if (/^h[1-6]$/.test(t.name) && hasClose(t.name, i)) {
			const r = innerText(i, t.name);
			s += `\n\n${'#'.repeat(Number(t.name[1]))} ${r.text.trim()}\n\n`;
			i = r.end;
		} else if (t.name === 'a' && hasClose('a', i)) {
			const r = innerText(i, 'a');
			const href = /\shref=["']([^"']+)["']/i.exec(t.raw)?.[1];
			const text = r.text.trim();
			s += href && text && !href.startsWith('#') && !href.startsWith('javascript:') ? `[${text}](${href})` : text;
			i = r.end;
		} else if (t.name === 'li') {
			s += '\n- ';
		} else if (t.name === 'br' || t.name === 'hr') {
			s += '\n';
		}
	}
	s = decodeEntities(s);
	s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
	if (title && !/^# /.test(s)) {
		s = `# ${decodeEntities(title.trim())}\n\n${s}`;
	}
	return s;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[()][A-Za-z0-9]|\u001b[=>MNOPXZ\\^_78]|\r(?!\n)/g;

/** Removes ANSI/OSC escape sequences (including VS Code shell integration 633 marks) and lone carriage returns. */
export function stripAnsi(s: string): string {
	return s.replace(ANSI, '');
}
