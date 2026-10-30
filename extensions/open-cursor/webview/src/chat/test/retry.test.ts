import { assert, done, test } from '../../../../src/agent/test/harness';
import type { ChatMessage } from '../../../../src/shared/protocol';
import { retryTarget } from '../util';

const user = (id: string): ChatMessage => ({ id, role: 'user', text: id, context: [], createdAt: 1 });
const asst = (id: string): ChatMessage => ({ id, role: 'assistant', parts: [], createdAt: 1, done: true });

test('retry resends the message that owns the last turn', () => {
	const ms = [user('u1'), asst('a1'), user('u2'), asst('a2')];
	assert.strictEqual(retryTarget(ms, 'a2')?.id, 'u2');
});

test('an error card deep in history has no retry target', () => {
	const ms = [user('u1'), asst('a1'), user('u2'), asst('a2')];
	assert.strictEqual(retryTarget(ms, 'a1'), undefined);
	assert.strictEqual(retryTarget(ms, 'nope'), undefined);
});

void done('retry');
