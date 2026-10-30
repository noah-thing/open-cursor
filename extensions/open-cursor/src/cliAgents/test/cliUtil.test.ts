import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assert, done, test } from '../../agent/test/harness';
import { claudeSettingsAuth } from '../detect';
import { diffStat, FsTracker, matchEol, setMaxFilesForTest } from '../fileTracker';
import { cmdQuote, friendlyError, isStaleSessionError, samePath, shimTarget } from '../util';
import { cliHint, installCommand } from '../../shared/cliHints';
import { openCodeMajor } from '../opencodeSetup';

test('shim: node script, native exe, and the node.exe in the IF EXIST line is not the target', () => {
	const js = '@IF EXIST "%~dp0\\node.exe" (\r\n  SET "_prog=%~dp0\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*';
	assert.deepStrictEqual(shimTarget(js), { kind: 'js', rel: 'node_modules\\@openai\\codex\\bin\\codex.js' });
	const exe = '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%dp0%\\node_modules\\pkg\\vendor\\tool.exe"   %*\r\n';
	assert.deepStrictEqual(shimTarget(exe), { kind: 'exe', rel: 'node_modules\\pkg\\vendor\\tool.exe' });
	assert.strictEqual(shimTarget('@echo off\r\ncall something.bat'), undefined);
});

test('diff stat ignores a CRLF vs LF difference of the whole file', () => {
	assert.deepStrictEqual(diffStat('a\r\nb\r\nc\r\n', 'a\nb\nc\n'), { added: 0, removed: 0 });
	assert.deepStrictEqual(diffStat('a\r\nb\r\nc\r\n', 'a\nB\nc\n'), { added: 1, removed: 1 });
});

test('samePath is exact off Windows', () => {
	if (process.platform !== 'win32') {
		assert.ok(samePath('/a/b', '/a/b') && !samePath('/a/b', '/a/B'));
	} else {
		assert.ok(samePath('C:\\Foo\\a.ts', 'c:/foo/a.ts'));
	}
});

test('cmd.exe quoting never lets a newline through', () => {
	const q = cmdQuote('line one\nline "two"\r\nend\\');
	assert.ok(!/[\r\n]/.test(q));
	assert.strictEqual(q, '"line one line \\"two\\" end\\\\"');
});

test('friendlyError: ids and URLs with 401 or 429 are not auth or rate limit errors', () => {
	const plain = 'Cannot read file /tmp/build-4012/out-429.txt (id 401a)';
	assert.ok(!/not signed in/.test(friendlyError('codex', plain)));
	assert.ok(!/rate limit/.test(friendlyError('codex', plain)));
	assert.ok(!/rate limit/.test(friendlyError('codex', 'fetch https://x.test/items/429 failed: ENOTFOUND')));
	assert.ok(/not signed in/.test(friendlyError('codex', 'unexpected status 401 Unauthorized')));
	assert.ok(/not signed in/.test(friendlyError('claude-code', 'Not logged in. Please run /login')));
	assert.ok(/rate limit/.test(friendlyError('codex', 'HTTP 429 Too Many Requests')));
	assert.ok(/rate limit/.test(friendlyError('gemini-cli', 'Quota exceeded for metric')));
	assert.ok(!/not signed in/.test(friendlyError('claude-code', 'authentication layer of my app crashed in module x')));
});

test('friendlyError: OpenCode shows the raw error instead of a sign in message', () => {
	const e = friendlyError('opencode', 'Error: 401 Unauthorized from provider');
	assert.ok(!/not signed in|auth login/.test(e));
	assert.ok(e.includes('401 Unauthorized'));
});

test('stale session errors', () => {
	for (const t of ['No saved session found with ID abc', 'Error: No conversation found with session ID: x', 'session not found', 'Could not resume session 1234', 'unknown session', 'No sessions available']) {
		assert.ok(isStaleSessionError(t), t);
	}
	for (const t of ['rate limit', 'The model is overloaded', undefined]) {
		assert.ok(!isStaleSessionError(t), String(t));
	}
});

test('line endings: LF original follows a CRLF working file', () => {
	assert.strictEqual(matchEol('a\nb\n', 'a\r\nb\r\nc\r\n'), 'a\r\nb\r\n');
	assert.strictEqual(matchEol('a\nb\n', 'a\nb\nc\n'), 'a\nb\n');
	assert.strictEqual(matchEol('a\nb\n', 'a\r\nb\nc\n'), 'a\nb\n', 'mixed endings stay as they are');
	assert.strictEqual(matchEol(undefined, 'x\r\n'), undefined);
});

test('folder tracker: lists edits, new and deleted files in a folder without git', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fs-'));
	try {
		fs.mkdirSync(path.join(dir, 'node_modules'));
		fs.writeFileSync(path.join(dir, 'node_modules', 'skip.js'), 'x');
		fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
		fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n');
		const t = FsTracker.create(dir)!;
		assert.ok(t);
		fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
		fs.writeFileSync(path.join(dir, 'new.txt'), 'hi\n');
		fs.writeFileSync(path.join(dir, 'node_modules', 'skip.js'), 'changed');
		fs.rmSync(path.join(dir, 'gone.txt'));
		const files = await t.scan();
		const by = new Map(files.map(f => [path.basename(f.absPath), f]));
		assert.strictEqual(by.size, 3);
		assert.strictEqual(by.get('a.txt')!.original, 'one\ntwo\n');
		assert.strictEqual(by.get('a.txt')!.added, 1);
		assert.strictEqual(by.get('new.txt')!.original, undefined);
		assert.strictEqual(by.get('gone.txt')!.current, undefined);
		assert.strictEqual((await t.scan()).length, 0, 'nothing new on a second scan');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('FsTracker: a truncated walk never reports unreached files as new or deleted', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fst-cap-'));
	try {
		for (const n of ['a', 'b', 'c', 'd']) { fs.writeFileSync(path.join(dir, n + '.txt'), n + '\n'); }
		setMaxFilesForTest(2);
		const t = FsTracker.create(dir)!;
		for (const n of ['a', 'b', 'c', 'd']) { fs.writeFileSync(path.join(dir, n + '.txt'), n + ' edited\n'); }
		const files = await t.scan();
		for (const f of files) { assert.ok(f.original !== undefined, 'no file may look new'); }
		assert.ok(files.length <= 2, 'only baselined files are reported');
		for (const n of ['a', 'b']) { fs.rmSync(path.join(dir, n + '.txt')); }
		fs.writeFileSync(path.join(dir, 'e.txt'), 'e\n');
		fs.writeFileSync(path.join(dir, 'f.txt'), 'f\n');
		for (const f of await t.scan()) { assert.ok(f.current !== undefined, 'no deletion from a truncated scan'); }
	} finally {
		setMaxFilesForTest(4000);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('friendlyError: raw API errors from the CLIs', () => {
	assert.ok(/not signed in/.test(friendlyError('claude-code', 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"x"}}')));
	assert.ok(/rate limit/.test(friendlyError('claude-code', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}')));
	assert.ok(/rate limit/.test(friendlyError('claude-code', '{"error":{"type":"overloaded_error"}}')));
	assert.ok(/not signed in/.test(friendlyError('grok', 'Please run grok login')));
	assert.ok(/not signed in/.test(friendlyError('gemini-cli', 'Failed to login. Message: x')));
	assert.ok(!/not signed in/.test(friendlyError('codex', 'build-4012 and id 401a')));
});

test('claude sign in from settings, OpenCode version, OpenCode install hint', () => {
	assert.ok(claudeSettingsAuth({ apiKeyHelper: '~/bin/key.sh' }));
	assert.ok(claudeSettingsAuth({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }));
	assert.ok(!claudeSettingsAuth({ env: { CLAUDE_CODE_USE_VERTEX: '0' } }));
	assert.ok(!claudeSettingsAuth(undefined));
	assert.strictEqual(openCodeMajor(undefined), 0);
	for (const platform of ['win32', 'darwin', 'linux']) {
		assert.ok(/Get Free Models/.test(installCommand(cliHint('opencode'), platform)));
		assert.ok(!/curl/.test(installCommand(cliHint('opencode'), platform)));
	}
});

void done('cli util');
