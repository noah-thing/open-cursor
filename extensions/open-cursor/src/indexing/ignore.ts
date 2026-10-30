/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
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

/**
 * Ignore files found anywhere in the tree (`dir` is posix, relative to the folder, '' for its root).
 * Each file's rules apply to paths beneath its own folder, as git does. A path is skipped when any of
 * them ignores it: for what may leave the computer, ignoring too much is the safe mistake.
 */
export function makeNestedIgnore(files: readonly { dir: string; text: string }[]): (relPath: string) => boolean {
	const compiled = files.map(f => ({ dir: f.dir.replace(/^\/+|\/+$/g, ''), ignored: makeIgnore(f.text) }));
	return rel => compiled.some(c => {
		if (!c.dir) { return c.ignored(rel); }
		return rel.startsWith(c.dir + '/') && c.ignored(rel.slice(c.dir.length + 1));
	});
}

/** Files that hold secrets by convention. Never indexed, whatever the ignore files say. */
const SECRET = /(^|\/)(\.env(\.[^/]*)?|[^/]*\.(pem|key|p12|pfx|jks|keystore|asc|gpg)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|credentials(\.[a-z]+)?|secrets?(\.[a-z]+)?|service-account[^/]*\.json)$/i;

export function isSecretFile(relPath: string): boolean {
	return SECRET.test(relPath);
}
