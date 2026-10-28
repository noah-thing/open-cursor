import { applyEdit, stripLineNumberPrefixes } from '../editMatch';
import { assert, done, test } from './harness';

const file = 'function a() {\n\treturn 1;\n}\n\nfunction b() {\n\treturn 1;\n}\n';

test('exact unique replace', () => {
	const r = applyEdit(file, 'function a() {\n\treturn 1;\n}', 'function a() {\n\treturn 2;\n}');
	assert.ok(r.ok && r.content.startsWith('function a() {\n\treturn 2;') && !r.fuzzy);
});
test('ambiguous match errors, replace_all works', () => {
	const e = applyEdit(file, 'return 1;', 'return 3;');
	assert.ok(!e.ok && /2 places/.test(e.error));
	const r = applyEdit(file, 'return 1;', 'return 3;', true);
	assert.ok(r.ok && r.replacements === 2 && !r.content.includes('return 1;'));
});
test('identical strings rejected', () => {
	assert.ok(!applyEdit(file, 'a', 'a').ok);
});
test('whitespace tolerant: spaces vs tabs, with reindent', () => {
	const src = 'class X {\n\tfoo() {\n\t\treturn 1;\n\t}\n}\n';
	const r = applyEdit(src, '    foo() {\n        return 1;\n    }', '    foo() {\n        return 2;\n    }');
	assert.ok(r.ok && r.fuzzy);
	if (r.ok) { assert.ok(r.content.includes('return 2;'), r.content); }
});
test('trailing whitespace and blank edge lines tolerated', () => {
	const src = 'a\nb   \nc\n';
	const r = applyEdit(src, '\nb\nc\n\n', 'B\nc');
	assert.ok(r.ok, JSON.stringify(r));
	if (r.ok) { assert.strictEqual(r.content, 'a\nB\nc\n'); }
});
test('indentation shift is applied to new_string', () => {
	const src = 'if (x) {\n        doIt();\n}\n';
	const r = applyEdit(src, '    doIt();', '    doIt();\n    more();');
	assert.ok(r.ok);
	if (r.ok) { assert.strictEqual(r.content, 'if (x) {\n        doIt();\n        more();\n}\n'); }
});
test('read_file line number prefixes are stripped', () => {
	assert.strictEqual(stripLineNumberPrefixes('  1|a\n  2|b'), 'a\nb');
	assert.strictEqual(stripLineNumberPrefixes('1|a\nb'), undefined);
	const r = applyEdit('x\ny\nz\n', '2|y', '2|Y');
	assert.ok(r.ok && r.content === 'x\nY\nz\n', JSON.stringify(r));
});
test('CRLF files keep CRLF', () => {
	const r = applyEdit('a\r\nb\r\nc\r\n', 'b\nc', 'B\nC');
	assert.ok(r.ok && r.content === 'a\r\nB\r\nC\r\n');
});
test('not found reports closest region', () => {
	const src = 'one\ntwo\nconst value = compute(a, b);\nfour\n';
	const r = applyEdit(src, 'const value = compute(a, c);', 'x');
	assert.ok(!r.ok);
	if (!r.ok) { assert.ok(/lines 3-3/.test(r.error) && /compute\(a, b\)/.test(r.error), r.error); }
});
test('empty old_string only for empty or new files', () => {
	assert.ok(applyEdit('', '', 'hello').ok);
	assert.ok(!applyEdit('x', '', 'hello').ok);
});
test('replacement containing $ patterns is literal', () => {
	const r = applyEdit('price', 'price', '$& $1 $$');
	assert.ok(r.ok && r.content === '$& $1 $$');
});
void done('editMatch');
