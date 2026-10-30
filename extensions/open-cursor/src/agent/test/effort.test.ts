import { assert, done, test } from './harness';
import { anthropicBudget, apiEffort, claudeEffortArgs, codexEffortArgs, openaiEffort } from '../effort';

test('auto stays auto for API models, off sends no thinking', () => {
	assert.strictEqual(apiEffort('auto'), 'auto');
	assert.strictEqual(apiEffort('off'), undefined);
	assert.strictEqual(apiEffort('low'), 'low');
	assert.strictEqual(apiEffort('max'), 'max');
});

test('the Anthropic budget grows with effort and always leaves room for the answer', () => {
	assert.ok(anthropicBudget('low', 32_000) < anthropicBudget('medium', 32_000));
	assert.ok(anthropicBudget('medium', 32_000) < anthropicBudget('high', 32_000));
	assert.ok(anthropicBudget('high', 32_000) < anthropicBudget('max', 32_000));
	assert.strictEqual(anthropicBudget('max', 32_000), 30_976);
	assert.ok(anthropicBudget('max', 8_192) <= 8_192 - 1_024);
	assert.strictEqual(anthropicBudget('high', 4_096), 3_072);
	// Auto is a moderate budget, not the high one
	assert.strictEqual(anthropicBudget('auto', 32_000), anthropicBudget('medium', 32_000));
	assert.ok(anthropicBudget('auto', 32_000) < anthropicBudget('high', 32_000));
});

test('OpenAI style effort stops at high', () => {
	assert.strictEqual(openaiEffort('max'), 'high');
	assert.strictEqual(openaiEffort('medium'), 'medium');
	assert.strictEqual(openaiEffort('auto'), 'medium');
	assert.strictEqual(openaiEffort(undefined), 'medium');
	assert.strictEqual(openaiEffort('high'), 'high');
});

test('CLIs get a flag only when the person picked a level', () => {
	assert.deepStrictEqual(claudeEffortArgs('auto'), []);
	assert.deepStrictEqual(claudeEffortArgs(undefined), []);
	assert.deepStrictEqual(claudeEffortArgs('max'), ['--effort', 'max']);
	assert.deepStrictEqual(claudeEffortArgs('off'), ['--effort', 'low']);
	assert.deepStrictEqual(codexEffortArgs('auto'), []);
	assert.deepStrictEqual(codexEffortArgs('max'), ['-c', 'model_reasoning_effort="xhigh"']);
	assert.deepStrictEqual(codexEffortArgs('off'), ['-c', 'model_reasoning_effort="minimal"']);
	assert.deepStrictEqual(codexEffortArgs('medium'), ['-c', 'model_reasoning_effort="medium"']);
});

void done('effort');
