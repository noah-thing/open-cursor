/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Dependency free HTML to readable text, plus ANSI stripping. Pure.
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

export function htmlToText(html: string): string {
	let s = html;
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1];
	s = s.replace(/<!--[\s\S]*?-->/g, '');
	s = s.replace(/<(script|style|noscript|svg|template|head|nav|footer|iframe)[\s\S]*?<\/\1>/gi, '');
	s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => '\n```\n' + inner.replace(/<[^>]+>/g, '') + '\n```\n');
	s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, inner: string) => `\n\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`);
	s = s.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
		const text = inner.replace(/<[^>]+>/g, '').trim();
		return text && !href.startsWith('#') && !href.startsWith('javascript:') ? `[${text}](${href})` : text;
	});
	s = s.replace(/<li[^>]*>/gi, '\n- ');
	s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
	s = s.replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote|header|main)>/gi, '\n\n');
	s = s.replace(/<\/t[dh]>/gi, '\t');
	s = s.replace(/<[^>]+>/g, '');
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
