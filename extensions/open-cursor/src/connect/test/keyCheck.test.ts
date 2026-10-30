import { assert, done, test } from '../../agent/test/harness';
import { judgeKeyStatus, keyCheckRequest } from '../keyCheck';

test('only 401 and 403 count as a refused key', () => {
	assert.strictEqual(judgeKeyStatus('openai', 200), 'ok');
	assert.strictEqual(judgeKeyStatus('openai', 401), 'refused');
	assert.strictEqual(judgeKeyStatus('anthropic', 403), 'unsure');
	assert.strictEqual(judgeKeyStatus('openai', 429), 'unsure');
	assert.strictEqual(judgeKeyStatus('openai', 503), 'unsure');
	assert.strictEqual(judgeKeyStatus('openai', 404), 'unsure');
});

test('Google answers a wrong key with 400', () => {
	assert.strictEqual(judgeKeyStatus('google', 400), 'refused');
	assert.strictEqual(judgeKeyStatus('openai', 400), 'unsure');
});

test('each provider sends the key the way it expects', () => {
	assert.strictEqual(keyCheckRequest('anthropic', 'k')?.headers['x-api-key'], 'k');
	assert.strictEqual(keyCheckRequest('groq', 'k')?.headers.authorization, 'Bearer k');
	assert.strictEqual(keyCheckRequest('google', 'k')?.headers['x-goog-api-key'], 'k');
	assert.strictEqual(keyCheckRequest('ollama' as never, 'k'), undefined);
});

void done('keyCheck');
