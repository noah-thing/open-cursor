/* Plain node test: bundle + run with `npm run test:edits` or
   npx esbuild src/edits/test/edits.test.ts --bundle --platform=node | node */
import assert from 'node:assert/strict';
import { computeHunks, foldAccept, applyReject, minimalEdit, minimalRawEdit, norm, withEol } from '../hunks';
import { unsafeEncoding } from '../encoding';
import { planRestore, type CheckpointRecord } from '../checkpointLogic';

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log('ok', name); };

const orig = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', ''].join('\n');
const cur = ['a', 'B', 'B2', 'c', 'd', 'e', 'f', 'g', 'h', 'i', ''].join('\n');

t('hunks: positions and content', () => {
	const hs = computeHunks(orig, cur);
	assert.equal(hs.length, 2);
	assert.deepEqual(hs[0].removedLines, ['b']);
	assert.deepEqual(hs[0].addedLines, ['B', 'B2']);
	assert.equal(hs[0].curStart, 1);
	assert.equal(hs[0].curCount, 2);
	assert.equal(hs[1].origCount, 0);
	assert.deepEqual(hs[1].addedLines, ['i']);
	assert.equal(computeHunks(orig, orig).length, 0);
});

t('accept folds into original until equal', () => {
	let o = orig;
	for (let i = 0; i < 2; i++) {
		o = foldAccept(o, computeHunks(o, cur)[0]);
	}
	assert.equal(o, cur);
	assert.equal(computeHunks(o, cur).length, 0);
});

t('reject reverts to original until equal', () => {
	let c = cur;
	for (let i = 0; i < 2; i++) {
		c = applyReject(c, computeHunks(orig, c)[0]);
	}
	assert.equal(c, orig);
});

t('mixed accept + reject ends equal', () => {
	const [h1, h2] = computeHunks(orig, cur);
	const o2 = foldAccept(orig, h1);
	const c2 = applyReject(cur, computeHunks(o2, cur).find(h => h.id === h2.id)!);
	assert.equal(o2, c2);
});

t('ids stay stable when unrelated hunk resolved', () => {
	const [h1, h2] = computeHunks(orig, cur);
	const o2 = foldAccept(orig, h1);
	const after = computeHunks(o2, cur);
	assert.equal(after.length, 1);
	assert.equal(after[0].id, h2.id);
	const c2 = applyReject(cur, h1);
	assert.equal(computeHunks(orig, c2)[0].id, h2.id);
});

t('identical hunks get distinct ids', () => {
	const o = 'x\nm\nx\nm\nx\n';
	const c = 'x\nm\nNEW\nx\nm\nNEW\nx\n';
	const hs = computeHunks(o, c);
	assert.equal(hs.length, 2);
	assert.notEqual(hs[0].id, hs[1].id);
});

t('deletion and new file', () => {
	const hs = computeHunks('a\nb\nc\n', 'a\nc\n');
	assert.equal(hs.length, 1);
	assert.equal(hs[0].curCount, 0);
	assert.deepEqual(hs[0].removedLines, ['b']);
	assert.equal(applyReject('a\nc\n', hs[0]), 'a\nb\nc\n');
	const nf = computeHunks('', 'hello\nworld\n');
	assert.equal(nf.length, 1);
	assert.equal(applyReject('hello\nworld\n', nf[0]), '');
});

t('CRLF is normalised', () => {
	assert.equal(computeHunks('a\r\nb\r\n', 'a\nb\n').length, 0);
	assert.equal(withEol('a\nb', '\r\n'), 'a\r\nb');
	assert.equal(norm('a\r\nb\rc'), 'a\nb\nc');
});

t('minimalEdit', () => {
	const m = minimalEdit('hello world', 'hello brave world')!;
	assert.equal('hello world'.slice(0, m.start) + m.text + 'hello world'.slice(m.end), 'hello brave world');
	assert.equal(minimalEdit('same', 'same'), undefined);
	const crlf = minimalEdit('a\r\nb\r\n', 'a\r\nc\r\n')!;
	assert.equal('a\r\nb\r\n'.slice(0, crlf.start) + crlf.text + 'a\r\nb\r\n'.slice(crlf.end), 'a\r\nc\r\n');
});

t('checkpoint restore picks earliest before-content at or after target', () => {
	const recs: CheckpointRecord[] = [
		{ id: 'c1', files: { 'file:///a': 'h-a0', 'file:///new': null } },
		{ id: 'c2', files: { 'file:///a': 'h-a1', 'file:///b': 'h-b1' } },
		{ id: 'c3', files: { 'file:///b': 'h-b2', 'file:///c': null } },
	];
	const p1 = planRestore(recs, 'c1')!;
	assert.equal(p1.get('file:///a'), 'h-a0');
	assert.equal(p1.get('file:///new'), null);
	assert.equal(p1.get('file:///b'), 'h-b1');
	assert.equal(p1.get('file:///c'), null);
	const p2 = planRestore(recs, 'c2')!;
	assert.equal(p2.get('file:///a'), 'h-a1');
	assert.equal(p2.has('file:///new'), false);
	assert.equal(p2.get('file:///b'), 'h-b1');
	const p3 = planRestore(recs, 'c3')!;
	assert.equal(p3.get('file:///b'), 'h-b2');
	assert.equal(planRestore(recs, 'nope'), undefined);
});

const apply = (old: string, m: { start: number; end: number; text: string } | undefined) => m ? old.slice(0, m.start) + m.text + old.slice(m.end) : old;

t('raw edit: mixed endings keep untouched lines', () => {
	const old = 'a\r\nb\nc\r\nd\ne';
	const m = minimalRawEdit(old, 'a\nb\nc\nD\ne', '\r\n');
	assert.equal(apply(old, m), 'a\r\nb\nc\r\nD\ne');
});

t('raw edit: inserted lines match the surrounding ending', () => {
	const old = 'a\r\nb\r\nc\n';
	assert.equal(apply(old, minimalRawEdit(old, 'a\nb\nX\nY\nc\n', '\n')), 'a\r\nb\r\nX\r\nY\r\nc\n');
	const lf = 'a\nb\nc\n';
	assert.equal(apply(lf, minimalRawEdit(lf, 'a\nX\nb\nc\n', '\r\n')), 'a\nX\nb\nc\n');
});

t('raw edit: unchanged and pure CRLF', () => {
	assert.equal(minimalRawEdit('a\r\nb', 'a\nb', '\r\n'), undefined);
	const old = 'a\r\nb\r\n';
	assert.equal(apply(old, minimalRawEdit(old, 'a\nB\n', '\r\n')), 'a\r\nB\r\n');
});

t('raw edit: a lone CR line keeps its ending', () => {
	const old = 'a\r\nb\rc\r\nd';
	assert.equal(apply(old, minimalRawEdit(old, 'a\nb\nC\nd', '\n')), 'a\r\nb\rC\r\nd');
	assert.equal(apply(old, minimalRawEdit(old, 'a\nb\nX\nc\nd', '\n')), 'a\r\nb\rX\rc\r\nd');
	assert.equal(minimalRawEdit('a\rb', 'a\nb', '\n'), undefined);
});

t('raw edit: an edit on the first line of a CRLF file keeps CRLF', () => {
	const old = 'a\r\nb\r\n';
	assert.equal(apply(old, minimalRawEdit(old, 'X\nY\nb\n', '\n')), 'X\r\nY\r\nb\r\n');
});

t('encoding: utf8, bom, latin1, utf16', () => {
	const enc = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));
	assert.equal(unsafeEncoding(enc('håll å fäll')), null);
	assert.equal(unsafeEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), null);
	assert.ok(unsafeEncoding(new Uint8Array(Buffer.from('håll', 'latin1'))));
	assert.ok(unsafeEncoding(new Uint8Array([0xff, 0xfe, 0x61, 0x00])));
	assert.ok(unsafeEncoding(new Uint8Array([0xfe, 0xff, 0x00, 0x61])));
	assert.equal(unsafeEncoding(enc('a\ufffdb')), null);
});

console.log(`${n} tests passed`);
