import { assert, done, test } from '../../../../src/agent/test/harness';
import type { ToolPart } from '../../../../src/shared/protocol';
import { thoughtTail, toolActivity } from '../live';

const tool = (name: string, args: Record<string, unknown>, extra: Partial<ToolPart> = {}): ToolPart => ({ type: 'tool', id: '1', name, args, status: 'running', title: '', ...extra });

test('the thought tail is plain paragraphs without markdown marks', () => {
	assert.deepStrictEqual(thoughtTail('**Plan**\n\nRead `cart.ts` first.\nThen fix it.\n\n## Next\nRun tests'), ['Plan', 'Read cart.ts first. Then fix it.', 'Next Run tests']);
	assert.deepStrictEqual(thoughtTail(''), []);
});

test('a long thought keeps only its newest part and never starts mid word', () => {
	const long = Array.from({ length: 300 }, (_, i) => `Sentence number ${i} about the code.`).join(' ');
	const t = thoughtTail(long, 400);
	assert.ok(t.join(' ').length <= 400);
	assert.ok(/^Sentence|^number|^\d|^about|^the|^code/.test(t[0]), t[0].slice(0, 20));
	assert.ok(t[t.length - 1].endsWith('Sentence number 299 about the code.'));
});

test('a cut lands on a paragraph break when there is one', () => {
	const text = 'a '.repeat(300) + '\n\nSecond paragraph here.\n\nThird.';
	assert.deepStrictEqual(thoughtTail(text, 120), ['Second paragraph here.', 'Third.']);
});

test('running tools are named by what they do', () => {
	assert.strictEqual(toolActivity(tool('read_file', { path: 'src/store/cart.ts' })), 'Reading cart.ts');
	assert.strictEqual(toolActivity(tool('grep', { pattern: 'removeItem' })), 'Searching for removeItem');
	assert.strictEqual(toolActivity(tool('list_dir', { path: '.' })), 'Looking around the project');
	assert.strictEqual(toolActivity(tool('run_terminal_cmd', { command: 'npm test\nnpm run lint' })), 'Running npm test');
	assert.strictEqual(toolActivity(tool('fetch_url', { url: 'https://www.example.com/a' })), 'Reading example.com');
	assert.strictEqual(toolActivity(tool('fetch_url', { url: 'nope' })), 'Reading a web page');
	assert.strictEqual(toolActivity(tool('mcp_github_create_issue', {})), 'Using github');
	assert.strictEqual(toolActivity(tool('something_new', {})), undefined);
	assert.ok(toolActivity(tool('grep', { pattern: 'x'.repeat(100) }))!.length < 52);
});

test('partial arguments never throw', () => {
	assert.strictEqual(toolActivity(tool('read_file', { path: 42 })), 'Reading a file');
	assert.strictEqual(toolActivity(tool('codebase_search', {}, { args: undefined })), 'Searching the codebase');
});

void done('live activity');
