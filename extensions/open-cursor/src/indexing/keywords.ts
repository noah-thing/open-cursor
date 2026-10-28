/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Pure keyword extraction and ranking for the ripgrep fallback (no vscode import).
 *--------------------------------------------------------------------------------------------*/

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'how', 'where', 'what', 'does', 'are', 'was', 'into', 'code', 'file', 'function', 'find', 'all', 'not', 'use', 'used', 'using']);

export function keywordsOf(query: string): string[] {
	const out: string[] = [];
	for (const w of query.match(/[A-Za-z0-9_$]+/g) ?? []) {
		const lw = w.toLowerCase();
		if (lw.length >= 3 && !STOP.has(lw) && !out.includes(lw)) { out.push(lw); }
	}
	return out.slice(0, 8);
}

export interface KeywordHit {
	file: string;
	startLine: number;
	endLine: number;
	score: number;
}

/** Windowed hit lines -> best 30-line window per file, ranked by distinct keywords then density. */
export function rankHits(perFile: Map<string, { line: number; kws: Set<string> }[]>, total: number, limit: number): KeywordHit[] {
	const hits: KeywordHit[] = [];
	for (const [file, lines] of perFile) {
		lines.sort((a, b) => a.line - b.line);
		let best: { score: number; start: number; end: number } | undefined;
		for (let i = 0; i < lines.length; i++) {
			const kws = new Set<string>();
			let count = 0;
			let last = lines[i].line;
			for (let j = i; j < lines.length && lines[j].line < lines[i].line + 30; j++) {
				lines[j].kws.forEach(k => kws.add(k));
				count++;
				last = lines[j].line;
			}
			const score = kws.size / total + Math.min(count, 10) * 0.01;
			if (!best || score > best.score) {
				best = { score, start: Math.max(0, lines[i].line - 3), end: last + 3 };
			}
		}
		if (best) { hits.push({ file, startLine: best.start, endLine: best.end, score: best.score }); }
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

