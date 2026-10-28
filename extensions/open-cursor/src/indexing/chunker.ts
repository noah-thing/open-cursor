/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

export interface Chunk {
	/** 0-based inclusive start line. */
	readonly startLine: number;
	/** 0-based inclusive end line. */
	readonly endLine: number;
	readonly text: string;
}

export interface ChunkOptions {
	target?: number;
	overlap?: number;
	maxChars?: number;
}

const BOUNDARY = /^\s*$|^\s{0,2}[}\])]+[;,]?\s*$|^\s{0,2}(end|fi|done)\s*$/;

/**
 * ~`target` lines per chunk, cut at a blank line or closing brace near the target (window target-15 .. target+10),
 * consecutive chunks share `overlap` lines. Returns [] for files with minified-looking lines.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
	const target = opts.target ?? 60;
	const overlap = Math.min(opts.overlap ?? 10, Math.floor(target / 2));
	const maxChars = opts.maxChars ?? 6000;
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	if (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
	if (!lines.length) { return []; }
	for (const l of lines) {
		if (l.length > 2000) { return []; }
	}
	const chunks: Chunk[] = [];
	let start = 0;
	while (start < lines.length) {
		let end = Math.min(start + target, lines.length); // exclusive
		if (end < lines.length) {
			const lo = start + Math.max(1, target - 15);
			const hi = Math.min(start + target + 10, lines.length);
			// Prefer the boundary closest to the target within the window.
			let best = -1;
			for (let i = lo; i < hi; i++) {
				if (BOUNDARY.test(lines[i - 1]) && (best === -1 || Math.abs(i - (start + target)) < Math.abs(best - (start + target)))) {
					best = i;
				}
			}
			if (best !== -1) { end = best; }
		}
		let chars = 0;
		let capped = start;
		while (capped < end && (chars + lines[capped].length + 1 <= maxChars || capped === start)) {
			chars += lines[capped].length + 1;
			capped++;
		}
		end = capped;
		const body = lines.slice(start, end).join('\n');
		if (body.trim()) {
			chunks.push({ startLine: start, endLine: end - 1, text: body });
		}
		if (end >= lines.length) { break; }
		start = Math.max(end - overlap, start + 1);
	}
	return chunks;
}
