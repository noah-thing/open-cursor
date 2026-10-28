/* Plain node test: npx esbuild src/inline/test/inline.test.ts --bundle --platform=node | node */
import assert from 'node:assert/strict';
import { FenceParser } from '../fence';
import { buildInlinePrompt, computeRegion, headLines, tailLines } from '../region';
import { cleanCommand, stripAnsi, OutputBuffer, buildTerminalPrompt } from '../../terminal/logic';
import { cleanCommitMessage, truncateDiff, buildCommitPrompt } from '../../scm/logic';

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log('ok', name); };

const feed = (chunks: string[]) => { const p = new FenceParser(); for (const c of chunks) { p.push(c); } return p; };

t('fence: simple block', () => {
	const p = feed(['```ts\nconst a = 1;\n', 'const b = 2;\n```\n']);
	assert.equal(p.finish(), 'const a = 1;\nconst b = 2;');
	assert.ok(p.done);
});
t('fence: preamble text and char-by-char streaming', () => {
	const src = 'Sure, here you go:\n```js\nx();\ny();\n```\nHope it helps';
	const p = new FenceParser();
	const seen: string[] = [];
	for (const ch of src) { p.push(ch); seen.push(p.content); }
	assert.equal(p.finish(), 'x();\ny();');
	// content only ever grows (no flicker of fence chars)
	for (let i = 1; i < seen.length; i++) { assert.ok(seen[i].startsWith(seen[i - 1]) || seen[i - 1].startsWith(seen[i]), `${JSON.stringify(seen[i - 1])} -> ${JSON.stringify(seen[i])}`); }
	assert.ok(seen.every(s => !s.includes('`')));
});
t('fence: partial closing fence is held back', () => {
	const p = feed(['```\nabc\n``']);
	assert.equal(p.content, 'abc');
});
t('fence: longer outer fence keeps inner fences', () => {
	const p = feed(['````md\n# T\n```js\nx\n```\n````\n']);
	assert.equal(p.finish(), '# T\n```js\nx\n```');
});
t('fence: no fence falls back to whole text', () => {
	const p = feed(['return 1;\n', 'return 2;']);
	assert.equal(p.content, '');
	assert.equal(p.finish(), 'return 1;\nreturn 2;');
});
t('fence: unterminated block', () => {
	assert.equal(feed(['```\na\nb\n']).finish(), 'a\nb');
});
t('fence: blank lines and indentation preserved', () => {
	assert.equal(feed(['```py\n    a\n\n    b\n```']).finish(), '    a\n\n    b');
});

const doc = ['one', '  two', '', 'three', 'four'].join('\n');
t('region: partial selection expands to lines', () => {
	const r = computeRegion(doc, { startLine: 1, startCol: 3, endLine: 3, endCol: 2 });
	assert.equal(r.kind, 'lines');
	assert.equal(r.selected, '  two\n\nthree');
	assert.equal(r.before, 'one\n');
	assert.equal(r.after, '\nfour');
	assert.equal(r.before + 'X' + r.after, 'one\nX\nfour');
});
t('region: selection ending at col 0 excludes that line', () => {
	const r = computeRegion(doc, { startLine: 0, startCol: 0, endLine: 2, endCol: 0 });
	assert.equal(r.selected, 'one\n  two');
});
t('region: empty selection on code line = cursor insert', () => {
	const r = computeRegion(doc, { startLine: 3, startCol: 2, endLine: 3, endCol: 2 });
	assert.equal(r.kind, 'cursor');
	assert.equal(r.before.endsWith('th'), true);
	assert.equal(r.after.startsWith('ree'), true);
});
t('region: empty selection on blank line = replace the line', () => {
	const r = computeRegion(doc, { startLine: 2, startCol: 0, endLine: 2, endCol: 0 });
	assert.equal(r.kind, 'lines');
	assert.equal(r.selected, '');
	assert.equal(r.before + 'X' + r.after, 'one\n  two\nX\nthree\nfour');
});
t('region: CRLF and EOF', () => {
	const r = computeRegion('a\r\nb\r\nc', { startLine: 1, startCol: 0, endLine: 1, endCol: 1 });
	assert.equal(r.selected, 'b');
	assert.equal(r.after, '\r\nc');
	const e = computeRegion('a\nb', { startLine: 1, startCol: 0, endLine: 1, endCol: 1 });
	assert.equal(e.after, '');
});
t('context windows', () => {
	assert.equal(tailLines('a\nb\nc\nd\n', 2), 'c\nd\n');
	assert.equal(headLines('a\nb\nc\nd', 2), 'a\nb');
});
t('prompt: follow-up includes history and rules', () => {
	const region = computeRegion(doc, { startLine: 1, startCol: 0, endLine: 1, endCol: 5 });
	const p = buildInlinePrompt({ path: 'src/a.ts', languageId: 'typescript', region, instructions: ['make it async', 'add a log'], rules: [{ name: 'style', content: 'use tabs' }] });
	assert.ok(p.includes('<rules>') && p.includes('use tabs'));
	assert.ok(p.includes('1. make it async') && p.includes('add a log'));
	assert.ok(p.includes('<selected>\n  two\n</selected>'));
	const c = buildInlinePrompt({ path: 'a', languageId: 'ts', region: computeRegion(doc, { startLine: 3, startCol: 2, endLine: 3, endCol: 2 }), instructions: ['x'], rules: [] });
	assert.ok(c.includes('th<CURSOR>ree'));
});

t('terminal: clean command', () => {
	assert.equal(cleanCommand('```bash\nls -la\n```'), 'ls -la');
	assert.equal(cleanCommand('`git status`'), 'git status');
	assert.equal(cleanCommand('$ npm test'), 'npm test');
	assert.equal(cleanCommand('# list\nfind . -size +100M'), 'find . -size +100M');
});
t('terminal: ansi + ring buffer', () => {
	assert.equal(stripAnsi('\u001b[31mred\u001b[0m ok'), 'red ok');
	const b = new OutputBuffer(5);
	b.append('a\nb\nc'); b.append('d\ne\nf\ng\nh\n');
	assert.equal(b.tail(3), 'g\nh');
	assert.ok(buildTerminalPrompt('list', { os: 'macOS', shell: 'zsh', cwd: '/x', output: 'err' }).includes('Shell: zsh'));
});
t('scm: clean message and diff truncation', () => {
	assert.equal(cleanCommitMessage('```\nfeat: x\n\nbody\n```'), 'feat: x\n\nbody');
	assert.equal(cleanCommitMessage('"fix: y"'), 'fix: y');
	const big = Array.from({ length: 10 }, (_, i) => `diff --git a/f${i} b/f${i}\n` + 'x'.repeat(5000)).join('\n');
	const tr = truncateDiff(big, 8000);
	assert.ok(tr.length < 11000 && tr.includes('f9'));
	assert.ok(buildCommitPrompt('d', ['feat: a'], [{ name: 'r', content: 'use gitmoji' }]).includes('gitmoji'));
});
console.log(`${n} inline/terminal/scm tests passed`);
