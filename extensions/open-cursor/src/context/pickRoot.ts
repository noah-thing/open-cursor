/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Root choice for relative paths in multi root workspaces. No vscode import.
 *--------------------------------------------------------------------------------------------*/

/** Picks the root for a relative path that does not start with a folder name: the first, unless only later ones have it. */
export function pickRoot(rel: string, roots: readonly string[], has: (root: string, rel: string) => boolean): { index: number; ambiguous?: number[] } {
	if (roots.length < 2 || has(roots[0], rel)) { return { index: 0 }; }
	const hits = roots.map((r, i) => (i > 0 && has(r, rel) ? i : -1)).filter(i => i > 0);
	if (hits.length === 1) { return { index: hits[0] }; }
	return hits.length > 1 ? { index: hits[0], ambiguous: hits } : { index: 0 };
}
