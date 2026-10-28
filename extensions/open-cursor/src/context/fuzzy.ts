/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Scores `query` against a relative path. Returns undefined when it is not a subsequence match.
 * Higher is better. Basename matches dominate, then consecutive runs and word boundary hits.
 */
export function fuzzyScore(query: string, path: string): number | undefined {
	const q = query.toLowerCase().replace(/\\/g, '/');
	if (!q) {
		return 0;
	}
	const p = path.toLowerCase();
	const slash = p.lastIndexOf('/');
	const base = p.slice(slash + 1);
	let score = 0;

	if (base === q) {
		score += 1000;
	} else if (base.startsWith(q)) {
		score += 700 - Math.min(base.length - q.length, 50);
	} else if (base.includes(q)) {
		score += 500 - Math.min(base.indexOf(q), 50);
	} else if (p.includes(q)) {
		score += 300;
	}

	let qi = 0;
	let run = 0;
	let best = 0;
	let boundary = 0;
	let gaps = 0;
	let lastMatch = -1;
	for (let i = 0; i < p.length && qi < q.length; i++) {
		if (p[i] === q[qi]) {
			const prev = i > 0 ? p[i - 1] : '/';
			if (prev === '/' || prev === '.' || prev === '-' || prev === '_' || prev === ' ') {
				boundary++;
			}
			if (lastMatch === i - 1) {
				run++;
			} else {
				run = 1;
				if (lastMatch >= 0) {
					gaps += i - lastMatch - 1;
				}
			}
			best = Math.max(best, run);
			if (i > slash) {
				score += 3;
			}
			lastMatch = i;
			qi++;
		}
	}
	if (qi < q.length) {
		return undefined;
	}
	score += best * 12 + boundary * 8 - Math.min(gaps, 60) - Math.min(p.length, 120) * 0.25;
	return score;
}
