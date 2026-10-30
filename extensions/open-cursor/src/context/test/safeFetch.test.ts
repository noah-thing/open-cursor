import { assert, done, test } from '../../agent/test/harness';
import { isBlockedAddress, safeFetch } from '../safeFetch';
import { htmlToText } from '../html';
import { dropSecretSections } from '../../scm/logic';
import { OutputBuffer } from '../../terminal/logic';
import { isSecretFile } from '../../indexing/ignore';

test('blocked addresses', () => {
	for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::1]']) {
		assert.ok(isBlockedAddress(a), a);
	}
	for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '93.184.216.34']) {
		assert.ok(!isBlockedAddress(a), a);
	}
});

test('safeFetch refuses bad targets before connecting', async () => {
	for (const u of ['file:///etc/passwd', 'ftp://example.com/', 'http://127.0.0.1:8080/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/']) {
		await assert.rejects(() => safeFetch(u, { timeoutMs: 2000 }), u);
	}
});

test('htmlToText stays fast on many unclosed tags', () => {
	const t0 = Date.now();
	const nasty = '<pre>'.repeat(50000) + '<a href="x">'.repeat(50000) + '<script'.repeat(50000) + '<'.repeat(50000);
	htmlToText(nasty);
	assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0}ms`);
	const out = htmlToText('<html><head><title>T</title><style>p{}</style></head><body><h2>Hi</h2><p>a &amp; b <a href="/x">link</a></p><pre>x < y</pre><ul><li>one</li></ul></body></html>');
	assert.ok(out.startsWith('# T') && out.includes('## Hi') && out.includes('a & b [link](/x)') && out.includes('```\nx < y\n```') && out.includes('- one') && !out.includes('p{}'), out);
});

test('commit diff drops secret file sections', () => {
	const d = 'diff --git a/src/a.ts b/src/a.ts\n+ok\ndiff --git a/.env b/.env\n+KEY=1\ndiff --git a/id_rsa b/id_rsa\n+x\n';
	const out = dropSecretSections(d, isSecretFile);
	assert.ok(out.includes('src/a.ts') && !out.includes('KEY=1') && !out.includes('id_rsa'), out);
});

test('terminal buffer caps one huge line', () => {
	const b = new OutputBuffer();
	for (let i = 0; i < 100; i++) { b.append('x'.repeat(10000)); }
	assert.ok(b.tail(5).length <= 4000);
});

void done('safeFetch');
