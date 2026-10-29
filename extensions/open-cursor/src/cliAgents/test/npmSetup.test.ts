import { assert, done, test } from '../../agent/test/harness';
import { latestLts, nodeArchiveName, shaFor } from '../npmSetup';

test('private Node.js: archive names for every platform and processor', () => {
	assert.strictEqual(nodeArchiveName('v24.11.0', 'darwin', 'arm64'), 'node-v24.11.0-darwin-arm64.tar.gz');
	assert.strictEqual(nodeArchiveName('v24.11.0', 'darwin', 'x64'), 'node-v24.11.0-darwin-x64.tar.gz');
	assert.strictEqual(nodeArchiveName('v24.11.0', 'linux', 'arm64'), 'node-v24.11.0-linux-arm64.tar.gz');
	assert.strictEqual(nodeArchiveName('v24.11.0', 'win32', 'x64'), 'node-v24.11.0-win-x64.zip');
	assert.strictEqual(nodeArchiveName('v24.11.0', 'win32', 'arm64'), 'node-v24.11.0-win-arm64.zip');
	assert.strictEqual(nodeArchiveName('v24.11.0', 'linux', 'ia32'), undefined);
});

test('private Node.js: newest LTS and its checksum', () => {
	assert.strictEqual(latestLts([{ version: 'v27.1.0', lts: false }, { version: 'v26.13.0', lts: 'Wolf' }, { version: 'v24.9.0', lts: 'Krypton' }]), 'v26.13.0');
	assert.strictEqual(latestLts([]), undefined);
	const sums = 'aaa  node-v1-darwin-x64.tar.gz\n' + 'b'.repeat(64) + '  node-v1-darwin-arm64.tar.gz\n';
	assert.strictEqual(shaFor(sums, 'node-v1-darwin-arm64.tar.gz'), 'b'.repeat(64));
	assert.strictEqual(shaFor(sums, 'node-v1-darwin-x64.tar.gz'), undefined, 'not a real hash');
});

void done('npm setup');
