import { assert, done, test } from '../../agent/test/harness';
import { pingBody, telemetryOff } from '../ping';

test('a ping carries exactly the random ID, version, OS and processor', () => {
	const b = pingBody('7f3a9c2e-1b4d-4f6a-9c8e-2d5b7a1f3e90', '0.1.2', 'darwin', 'arm64');
	assert.deepStrictEqual(b, { id: '7f3a9c2e-1b4d-4f6a-9c8e-2d5b7a1f3e90', version: '0.1.2', os: 'darwin', arch: 'arm64' });
	assert.deepStrictEqual(Object.keys(b!).sort(), ['arch', 'id', 'os', 'version']);
	assert.strictEqual(pingBody('x', '0.1.2', 'freebsd', 'x64'), undefined);
	assert.strictEqual(pingBody('x', '0.1.2', 'linux', 'ia32'), undefined);
});

test('the count follows the telemetry setting the user chose, on by default', () => {
	assert.strictEqual(telemetryOff(undefined, undefined), false);
	assert.strictEqual(telemetryOff('all', undefined), false);
	assert.strictEqual(telemetryOff('error', undefined), false);
	assert.strictEqual(telemetryOff('off', undefined), true);
	assert.strictEqual(telemetryOff('all', false), true);
});

void done('install count');
