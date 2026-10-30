import { assert, done, test } from '../../agent/test/harness';
import { scrub } from '../scrub';

test('home folders lose the user name on every system', () => {
	assert.strictEqual(scrub('at /Users/noahmalekani/proj/a.ts:3'), 'at ~/proj/a.ts:3');
	assert.strictEqual(scrub('ENOENT /home/anna.k/x'), 'ENOENT ~/x');
	assert.strictEqual(scrub('C:\\Users\\Åsa Berg\\AppData'.replace(' ', '_')), '~\\AppData');
	assert.strictEqual(scrub('"C:\\\\Users\\\\bob\\\\code"'), '"~\\\\code"');
	assert.strictEqual(scrub('c:/Users/bob/code'), '~/code');
	assert.strictEqual(scrub('C:\\Users\\Anna Svensson\\AppData\\x'), '~\\AppData\\x');
	assert.strictEqual(scrub('open C:\\Users\\bob failed'), 'open ~ failed');
	assert.strictEqual(scrub('see https://example.com/home/page and https://example.com/Users/x'), 'see https://example.com/home/page and https://example.com/Users/x');
});

test('UUID shaped tokens are removed', () => {
	assert.strictEqual(scrub('key 123e4567-e89b-12d3-a456-426614174000 end'), 'key [removed] end');
});

test('keys without a known prefix are removed', () => {
	assert.ok(!scrub('key 0123456789abcdef0123456789abcdef.AbCdEfGh12345678').includes('0123456789abcdef'));
	assert.ok(!scrub('x Qk3Zp9Lm2Xv7Rt5Wy8Bn4Hc6Jd1Fg0Sa end').includes('Qk3Zp9'));
	assert.ok(!scrub('b64 aGVsbG8+d29ybGQvZm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA== end').includes('aGVsbG8'));
	assert.ok(!scrub('md5 d41d8cd98f00b204e9800998ecf8427e').includes('d41d8cd9'));
});

test('normal text survives', () => {
	for (const t of [
		'Database is not empty and has no session table',
		'see https://github.com/noah-thing/open-cursor/releases/download/v0.2.0/OpenCursor-0.2.0-macos-arm64.dmg',
		'commit 0123456789abcdef0123456789abcdef01234567',
		'extremely-long-kebab-case-identifier-without-digits',
		'ThisIsAVeryLongCamelCaseIdentifierWithoutDigitsInIt',
		'TypeError: Cannot read properties of undefined (reading "map")',
	]) { assert.strictEqual(scrub(t), t); }
});

void done('scrub');
