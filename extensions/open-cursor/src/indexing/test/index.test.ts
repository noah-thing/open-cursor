import assert from 'node:assert/strict';
import { chunkText } from '../chunker';
import { makeIgnore } from '../ignore';
import { VectorStore, normalize } from '../vectorStore';
import { keywordsOf, rankHits } from '../keywords';

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log('ok', name); };

t('chunker: size, overlap, boundaries', () => {
	const lines: string[] = [];
	for (let f = 0; f < 6; f++) {
		for (let i = 0; i < 29; i++) { lines.push(`  line ${f}-${i}`); }
		lines.push('}', '');
	}
	const text = lines.join('\n');
	const chunks = chunkText(text);
	assert.ok(chunks.length >= 3);
	for (const c of chunks) { assert.ok(c.endLine - c.startLine <= 75); }
	for (let i = 1; i < chunks.length; i++) {
		assert.ok(chunks[i].startLine <= chunks[i - 1].endLine, 'overlap');
		assert.ok(chunks[i].startLine > chunks[i - 1].startLine, 'progress');
	}
	assert.equal(chunks[0].startLine, 0);
	assert.equal(chunks[chunks.length - 1].endLine, lines.length - 2); // trailing empty line is dropped
	assert.equal(chunkText('x'.repeat(5000)).length, 0);
	assert.equal(chunkText('').length, 0);
});

t('ignore: gitignore semantics', () => {
	const ig = makeIgnore('# c\nsecrets/\n*.log\n/build\n!keep.log\ndocs/*.md\n');
	assert.equal(ig('secrets/a.txt'), true);
	assert.equal(ig('src/secrets/a.txt'), true);
	assert.equal(ig('a/b/x.log'), true);
	assert.equal(ig('keep.log'), false);
	assert.equal(ig('build/out.js'), true);
	assert.equal(ig('src/build/out.js'), false);
	assert.equal(ig('docs/a.md'), true);
	assert.equal(ig('src/index.ts'), false);
});

t('vector store: top-k, filter, persistence', async () => {
	const s = new VectorStore();
	s.dim = 3;
	s.embedder = 'x/y';
	const v = (...a: number[]) => normalize(Float32Array.from(a));
	const pack = (...vs: Float32Array[]) => { const o = new Float32Array(vs.length * 3); vs.forEach((x, i) => o.set(x, i * 3)); return o; };
	s.set({ key: 'a', sig: '1', chunks: [{ startLine: 0, endLine: 9 }, { startLine: 5, endLine: 20 }], vectors: pack(v(1, 0, 0), v(0, 1, 0)) });
	s.set({ key: 'b', sig: '2', chunks: [{ startLine: 0, endLine: 3 }], vectors: pack(v(1, 1, 0)) });
	const hits = s.search(Float32Array.from([2, 0, 0]), 2);
	assert.equal(hits[0].key, 'a');
	assert.equal(hits[0].startLine, 0);
	assert.equal(hits[1].key, 'b');
	assert.equal(s.search(Float32Array.from([0, 1, 0]), 1, k => k === 'b')[0].key, 'b');
	assert.equal(s.chunkCount, 3);
});

t('keywords and ranking', () => {
	assert.deepEqual(keywordsOf('where is the handleUserLogin function?'), ['handleuserlogin']);
	const m = new Map([
		['one.ts', [{ line: 10, kws: new Set(['auth']) }, { line: 12, kws: new Set(['token']) }]],
		['two.ts', [{ line: 1, kws: new Set(['auth']) }]],
	]);
	const r = rankHits(m, 2, 5);
	assert.equal(r[0].file, 'one.ts');
	assert.equal(r[0].startLine, 7);
});

// VectorStore persistence (async) runs last.
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-idx-'));
	const s = new VectorStore();
	s.dim = 2; s.embedder = 'e';
	s.set({ key: 'f', sig: 's', chunks: [{ startLine: 1, endLine: 2 }], vectors: normalize(Float32Array.from([3, 4])) });
	await s.save(dir);
	const r = new VectorStore();
	assert.equal(await r.load(dir), true);
	assert.equal(r.embedder, 'e');
	assert.ok(Math.abs(r.get('f')!.vectors[0] - 0.6) < 1e-6);
	fs.rmSync(dir, { recursive: true });
	console.log('ok vector store save/load');
	console.log(`${n + 1} tests passed`);
})();
