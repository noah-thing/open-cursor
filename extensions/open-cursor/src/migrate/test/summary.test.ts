import { assert, done, test } from '../../agent/test/harness';
import { summarizeImport } from '../summary';

const base = { label: 'Cursor', settings: 4, keybindings: true, snippets: false, installed: 3, failed: [] as string[], offline: false };

test('a clean import lists what came over', () => {
	assert.strictEqual(summarizeImport(base), 'Imported 4 settings, keybindings, 3 extensions from Cursor.');
});

test('missing extensions are named', () => {
	assert.ok(summarizeImport({ ...base, failed: ['a.b'] }).includes('1 extensions are not on Open VSX: a.b'));
});

test('offline does not blame the extensions', () => {
	const s = summarizeImport({ ...base, offline: true, installed: 0 });
	assert.ok(s.includes('Could not reach Open VSX'));
	assert.ok(!s.includes('not on Open VSX'));
	assert.ok(!s.includes('0 extensions'));
});

void done('summary');
