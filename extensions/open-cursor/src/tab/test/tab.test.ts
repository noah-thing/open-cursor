/* Plain node test: npx esbuild src/tab/test/tab.test.ts --bundle --platform=node | node */
import assert from 'node:assert/strict';
import { trimOverlapInfo, postProcess, CompletionCache, buildHeader, cleanCompletion, extractWindow, fixIndent, parseNextEdit, restOfLineAllowsTab, trimOverlap, truncateCompletion } from '../logic';

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log('ok', name); };
const T = (text: string, o: Partial<{ maxLines: number; baseIndent: number; midLine: boolean; final: boolean }> = {}) =>
	truncateCompletion(text, { maxLines: 10, baseIndent: 0, midLine: false, final: true, ...o });

t('window: small text untouched', () => {
	const w = extractWindow('abc\ndef', 4, 100, 100);
	assert.deepEqual([w.prefix, w.suffix, w.prefixTruncated], ['abc\n', 'def', false]);
});
t('window: truncates at line boundary', () => {
	const text = 'line1\nline2\nline3\nline4\nline5';
	const w = extractWindow(text, text.length - 2, 14, 100);
	assert.ok(w.prefixTruncated);
	assert.ok(w.prefix.startsWith('line') && !w.prefix.startsWith('ine'), w.prefix);
	const w2 = extractWindow('a\nbbbb\ncccc\ndddd', 0, 100, 9);
	assert.equal(w2.suffix, 'a\nbbbb');
});
t('header: comment leader per language, budget', () => {
	const h = buildHeader('src/a.py', 'python', [{ path: 'b.py', text: 'x = 1\ny = 2' }]);
	assert.ok(h.startsWith('# Path: src/a.py\n# Language: python\n# Recent in b.py:\n# x = 1'));
	assert.equal(buildHeader('a.html', 'html', []), '');
	const tiny = buildHeader('a.ts', 'typescript', [{ path: 'b.ts', text: 'x'.repeat(5000) }], 200);
	assert.ok(!tiny.includes('Recent'));
});
t('clean: fences and special tokens', () => {
	assert.equal(cleanCompletion('```ts\nfoo()\n```'), 'foo()');
	assert.equal(cleanCompletion('foo()<|endoftext|>garbage'), 'foo()');
	assert.equal(cleanCompletion('a<|fim_middle|>b'), 'ab');
	assert.equal(cleanCompletion('x\r\ny'), 'x\ny');
});
t('overlap: closing bracket in suffix', () => {
	assert.equal(trimOverlap('a, b)', ')'), 'a, b');
	assert.equal(trimOverlap('a, b)', ');\nnext'), 'a, b');
	assert.equal(trimOverlap('x = 1;\n}', '\n}\n'), 'x = 1;');
});
t('overlap: next line repeated', () => {
	assert.equal(trimOverlap('return a + b;\n}', '\n}\n\nfunction z() {}'), 'return a + b;');
	assert.equal(trimOverlap('foo();\nbar();', '\nbar();\nbaz();'), 'foo();');
});
t('overlap: leaves unrelated alone, empties fully redundant', () => {
	assert.equal(trimOverlap('hello', 'world'), 'hello');
	// inner closer of a method inside a class is kept, the class closer stays in the suffix
	assert.equal(trimOverlap('  foo() {\n    return 1;\n  }', '\n}\n'), '  foo() {\n    return 1;\n  }');
	assert.equal(trimOverlap('x = 1;\n  }', '\n}\n'), 'x = 1;');
	assert.equal(trimOverlap(')', ')'), '');
	assert.equal(trimOverlap('</li>`).join(\'\');', '</li>`).join(\'\');\n}'), '');
	assert.equal(trimOverlap('abc', ''), 'abc');
});
t('truncate: blank line stops multi-line', () => {
	const r = T('if (x) {\n\treturn 1;\n}\n\nfunction other() {}', { baseIndent: 0 });
	assert.equal(r.text, 'if (x) {\n\treturn 1;\n}');
	assert.ok(r.stopped);
});
t('truncate: maxLines', () => {
	const r = T('a\nb\nc\nd\ne', { maxLines: 3 });
	assert.equal(r.text, 'a\nb\nc');
});
t('truncate: dedent stops, closer included', () => {
	assert.equal(T('x = 1;\n\ty = 2;\nz();', { baseIndent: 4 }).text, 'x = 1;\n\ty = 2;');
	assert.equal(T('x = 1;\n    y = 2;\n}\nnext();', { baseIndent: 4 }).text, 'x = 1;\n    y = 2;\n}');
});
t('truncate: mid line is single line', () => {
	assert.equal(T('foo(a);\nsecond', { midLine: true }).text, 'foo(a);');
});
t('truncate: leading newline kept (block after brace)', () => {
	assert.equal(T('\n\treturn 1;\n}', { baseIndent: 0 }).text, '\n\treturn 1;\n}');
});
t('truncate: streaming ignores unterminated last line', () => {
	const r = T('a\nb', { final: false });
	assert.equal(r.stopped, false);
	const r2 = T('a\n\nb', { final: false });
	assert.equal(r2.stopped, true);
	assert.equal(r2.text, 'a');
});
t('postProcess: midline repeat of suffix yields nothing', () => {
	const o = { maxLines: 10, baseIndent: 0, midLine: true, final: true, linePrefix: 'x', suffix: "</li>`).join('');\n}\n" };
	assert.equal(postProcess("</li>`).join('');\n}\n\nrender([])", o).text, '');
	assert.equal(postProcess('```\nfoo(a);\nmore\n```', { ...o, suffix: ');' }).text, 'foo(a');
});
t('indent: duplicated whitespace dropped', () => {
	assert.equal(fixIndent('    foo()', '    '), 'foo()');
	assert.equal(fixIndent('\tfoo()', '    '), 'foo()');
	assert.equal(fixIndent('foo()', 'x = '), 'foo()');
	assert.equal(fixIndent('\n  a', '  '), '\n  a');
});
t('rest of line gating', () => {
	assert.ok(restOfLineAllowsTab(''));
	assert.ok(restOfLineAllowsTab(')'));
	assert.ok(restOfLineAllowsTab('  });'));
	assert.ok(!restOfLineAllowsTab(' + other'));
});
t('cache: typing through a suggestion reuses it', () => {
	const c = new CompletionCache();
	const prefix = 'function add(a, b) {\n\t';
	const suffix = '\n}\n';
	c.put('f', prefix, suffix, 'return a + b;');
	assert.equal(c.get('f', prefix, suffix), 'return a + b;');
	assert.equal(c.get('f', prefix + 'ret', suffix), 'urn a + b;');
	assert.equal(c.get('f', prefix + 'rex', suffix), undefined);
	assert.equal(c.get('f', prefix + 'return a + b;', suffix), undefined); // fully typed
	assert.equal(c.get('g', prefix, suffix), undefined);
	assert.equal(c.get('f', prefix, '\n}\nextra'), undefined); // suffix changed
});
t('cache: LRU bound', () => {
	const c = new CompletionCache(2);
	c.put('f', 'a', '', 'x1'); c.put('f', 'bb', '', 'x2'); c.put('f', 'ccc', '', 'x3');
	assert.equal(c.get('f', 'a', ''), undefined);
	assert.equal(c.get('f', 'ccc', ''), 'x3');
});
t('next edit: parse', () => {
	const ok = parseNextEdit('LINES 5-6\n```ts\nfoo(1);\nbar(2);\n```', 20);
	assert.deepEqual(ok, { startLine: 5, endLine: 6, text: 'foo(1);\nbar(2);' });
	assert.equal(parseNextEdit('NONE', 20), undefined);
	assert.equal(parseNextEdit('LINES 5-99\n```\nx\n```', 20), undefined);
	assert.equal(parseNextEdit('I think so', 20), undefined);
});
t('overlap: closers with different indentation', () => {
	assert.equal(trimOverlap('foo();\n    }', '\n}\n'), 'foo();');
	assert.equal(trimOverlap('x\n    }\n  }', '\n}\n}\n'), 'x');
	assert.equal(trimOverlap('foo();\n    }', '\n  return 1;\n}\n'), 'foo();\n    }');
	assert.equal(trimOverlapInfo('foo();\n  }', '\n}\n').cut > 0, true);
});

console.log(`${n} tab tests passed`);
