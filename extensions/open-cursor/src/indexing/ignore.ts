/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Gitignore-style matcher for .cursorignore / .open-cursorignore (no vscode import).
 *--------------------------------------------------------------------------------------------*/

import { minimatch } from 'minimatch';

interface Rule {
	negate: boolean;
	patterns: string[];
}

/** Compile gitignore-ish lines into a predicate over workspace-relative posix paths. */
export function makeIgnore(text: string): (relPath: string) => boolean {
	const rules: Rule[] = [];
	for (let line of text.split(/\r?\n/)) {
		line = line.trim();
		if (!line || line.startsWith('#')) { continue; }
		let negate = false;
		if (line.startsWith('!')) { negate = true; line = line.slice(1); }
		const dirOnly = line.endsWith('/');
		if (dirOnly) { line = line.slice(0, -1); }
		const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
		line = line.replace(/^\//, '');
		const base = anchored ? line : `**/${line}`;
		// A pattern ignores the path itself (unless dirOnly) and everything beneath it.
		rules.push({ negate, patterns: dirOnly ? [`${base}/**`] : [base, `${base}/**`] });
	}
	return rel => {
		let ignored = false;
		for (const r of rules) {
			if (r.patterns.some(p => minimatch(rel, p, { dot: true }))) { ignored = !r.negate; }
		}
		return ignored;
	};
}
