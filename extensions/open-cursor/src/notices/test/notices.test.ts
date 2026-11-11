import { generateKeyPairSync, sign } from 'crypto';
import { assert, done, test } from '../../agent/test/harness';
import { remember, safeImage, safeLink, verifyFeed, visible, wellFormed, type Notice } from '../feed';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signed = (notices: unknown[], issued: number, key = privateKey) =>
	({ notices, issued, sig: sign(null, Buffer.from(JSON.stringify({ notices, issued })), key).toString('base64') });

const tab: Notice = {
	id: 'lunchbox-launch', kind: 'tab', title: 'Want the best AI workspace? Meet Lunchbox.',
	brand: { name: 'Lunchbox', icon: 'https://mylunchbox.dev/assets/mark.svg' },
	image: { url: 'https://mylunchbox.dev/assets/room-poster.jpg' },
	action: { label: 'Get Lunchbox, free', url: 'https://mylunchbox.dev' },
};

test('only a feed signed with the project key counts', () => {
	const now = 1_800_000_000_000;
	const f = signed([tab], now - 1000);
	assert.strictEqual(verifyFeed(f, 0, now, publicKey)?.notices.length, 1);
	assert.strictEqual(verifyFeed({ ...f, notices: [{ ...tab, title: 'Changed' }] }, 0, now, publicKey), undefined, 'edited after signing');
	const other = generateKeyPairSync('ed25519').privateKey;
	assert.strictEqual(verifyFeed(signed([tab], now - 1000, other), 0, now, publicKey), undefined, 'someone else\'s key');
	assert.strictEqual(verifyFeed(f, now, now, publicKey), undefined, 'older than the last feed seen');
	assert.strictEqual(verifyFeed(signed([tab], now + 2 * 3600e3), 0, now, publicKey), undefined, 'dated in the future');
	assert.strictEqual(verifyFeed({ notices: [tab] }, 0, now, publicKey), undefined, 'unsigned');
	assert.strictEqual(verifyFeed(null, 0, now, publicKey), undefined);
});

test('a notice reaches the versions, systems and dates it names, once', () => {
	const now = Date.parse('2026-11-12T10:00:00Z');
	assert.strictEqual(visible([tab], '0.1.10', 'win32', [], now).length, 1);
	assert.strictEqual(visible([tab], '0.1.10', 'win32', ['lunchbox-launch'], now).length, 0, 'seen before');
	assert.strictEqual(visible([{ ...tab, from: '0.1.11' }], '0.1.10', 'win32', [], now).length, 0);
	assert.strictEqual(visible([{ ...tab, to: '0.1.9' }], '0.1.10', 'win32', [], now).length, 0);
	assert.strictEqual(visible([{ ...tab, to: '0.1.10' }], '0.1.10', 'win32', [], now).length, 1, 'to is inclusive');
	assert.strictEqual(visible([{ ...tab, platforms: ['darwin'] }], '0.1.10', 'win32', [], now).length, 0);
	assert.strictEqual(visible([{ ...tab, after: '2026-11-13T00:00:00Z' }], '0.1.10', 'win32', [], now).length, 0);
	assert.strictEqual(visible([{ ...tab, until: '2026-11-12T00:00:00Z' }], '0.1.10', 'win32', [], now).length, 0);
});

test('links and images only go to the project\'s own sites', () => {
	assert.ok(safeLink('https://mylunchbox.dev') && safeLink('https://www.mylunchbox.dev/x') && safeLink('https://opencursor.org/update'));
	assert.ok(!safeLink('http://mylunchbox.dev'), 'plain http');
	assert.ok(!safeLink('https://mylunchbox.dev.evil.com'));
	assert.ok(!safeLink('https://user:pw@mylunchbox.dev'));
	assert.ok(!safeLink('javascript:alert(1)') && !safeLink('command:workbench.action.terminal.new') && !safeLink(42));
	assert.ok(safeImage('https://mylunchbox.dev/assets/mark.svg') && !safeImage('https://x.com/a.png'));
	assert.ok(!wellFormed({ ...tab, action: { label: 'Go', url: 'https://evil.example' } }), 'a bad link drops the whole notice');
	assert.ok(!wellFormed({ ...tab, image: { url: 'https://evil.example/a.png' } }));
	assert.ok(!wellFormed({ ...tab, kind: 'popup' as Notice['kind'] }));
	assert.ok(!wellFormed({ ...tab, title: '' }));
	assert.ok(wellFormed(tab));
});

test('the seen list stays short without forgetting live notices', () => {
	let seen: string[] = [];
	for (let i = 0; i < 300; i++) { seen = remember(seen, `old-${i}`, [tab]); }
	seen = remember(seen, 'lunchbox-launch', [tab]);
	assert.ok(seen.length <= 200);
	assert.ok(seen.includes('lunchbox-launch'));
	assert.deepStrictEqual(remember(['a'], 'a', []), ['a']);
});

void done('notices');
