/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  In-memory vector store with binary persistence and cosine top-k (no vscode import).
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FileEntry {
	/** Stable key, the file's uri string. */
	readonly key: string;
	/** mtime + size signature. */
	readonly sig: string;
	readonly chunks: { startLine: number; endLine: number }[];
	/** chunks.length * dim floats, each vector L2-normalised. */
	readonly vectors: Float32Array;
}

export interface Hit {
	key: string;
	startLine: number;
	endLine: number;
	score: number;
}

export function normalize(v: Float32Array): Float32Array {
	let n = 0;
	for (let i = 0; i < v.length; i++) { n += v[i] * v[i]; }
	n = Math.sqrt(n) || 1;
	const out = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) { out[i] = v[i] / n; }
	return out;
}

export class VectorStore {
	embedder = '';
	dim = 0;
	private files = new Map<string, FileEntry>();

	get fileCount(): number { return this.files.size; }
	get chunkCount(): number {
		let n = 0;
		for (const f of this.files.values()) { n += f.chunks.length; }
		return n;
	}
	get(key: string): FileEntry | undefined { return this.files.get(key); }
	keys(): string[] { return [...this.files.keys()]; }
	set(entry: FileEntry): void { this.files.set(entry.key, entry); }
	delete(key: string): void { this.files.delete(key); }
	clear(): void { this.files.clear(); this.dim = 0; }

	/** Cosine top-k (vectors are pre-normalised, so a dot product). `filter` is checked per file. */
	search(query: Float32Array, k: number, filter?: (key: string) => boolean): Hit[] {
		const q = normalize(query);
		const dim = q.length;
		const top: Hit[] = [];
		let min = -Infinity;
		for (const f of this.files.values()) {
			if (filter && !filter(f.key)) { continue; }
			for (let c = 0; c < f.chunks.length; c++) {
				let s = 0;
				const off = c * dim;
				for (let i = 0; i < dim; i++) { s += q[i] * f.vectors[off + i]; }
				if (top.length < k || s > min) {
					top.push({ key: f.key, startLine: f.chunks[c].startLine, endLine: f.chunks[c].endLine, score: s });
					top.sort((a, b) => b.score - a.score);
					if (top.length > k) { top.pop(); }
					min = top.length === k ? top[top.length - 1].score : -Infinity;
				}
			}
		}
		return top;
	}

	async save(dir: string): Promise<void> {
		await fs.promises.mkdir(dir, { recursive: true });
		const meta: { embedder: string; dim: number; files: { key: string; sig: string; chunks: FileEntry['chunks'] }[] } = { embedder: this.embedder, dim: this.dim, files: [] };
		const parts: Buffer[] = [];
		for (const f of this.files.values()) {
			meta.files.push({ key: f.key, sig: f.sig, chunks: f.chunks });
			parts.push(Buffer.from(f.vectors.buffer, f.vectors.byteOffset, f.vectors.byteLength));
		}
		// Write the binary first, then the metadata that points at it.
		await fs.promises.writeFile(path.join(dir, 'vectors.bin.tmp'), Buffer.concat(parts));
		await fs.promises.rename(path.join(dir, 'vectors.bin.tmp'), path.join(dir, 'vectors.bin'));
		await fs.promises.writeFile(path.join(dir, 'index.json.tmp'), JSON.stringify(meta));
		await fs.promises.rename(path.join(dir, 'index.json.tmp'), path.join(dir, 'index.json'));
	}

	async load(dir: string): Promise<boolean> {
		try {
			const meta = JSON.parse(await fs.promises.readFile(path.join(dir, 'index.json'), 'utf8')) as { embedder: string; dim: number; files: { key: string; sig: string; chunks: FileEntry['chunks'] }[] };
			const bin = await fs.promises.readFile(path.join(dir, 'vectors.bin'));
			const all = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
			let off = 0;
			const files = new Map<string, FileEntry>();
			for (const f of meta.files) {
				const len = f.chunks.length * meta.dim;
				if (off + len > all.length) { return false; }
				files.set(f.key, { key: f.key, sig: f.sig, chunks: f.chunks, vectors: all.subarray(off, off + len) });
				off += len;
			}
			this.embedder = meta.embedder;
			this.dim = meta.dim;
			this.files = files;
			return true;
		} catch {
			return false;
		}
	}
}
