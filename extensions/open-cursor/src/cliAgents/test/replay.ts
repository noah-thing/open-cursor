/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Replays recorded CLI event streams through the parsers in plain node. Run: node test/run.mjs
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolPart } from '../../shared/protocol';
import { ApprovalBroker } from '../approvalBroker';
import { ClaudeParser, claudeToolView } from '../claude';
import { CodexParser, unwrapShell } from '../codex';
import { parseStatusZ, diffStat } from '../fileTracker';
import { GeminiParser } from '../gemini';
import { GrokParser, grokPermissionArgs, grokToolView, stripAnsi } from '../grok';
import { parseGrokModels } from '../detect';
import { OpenCodeParser, openCodeToolView } from '../opencode';
import { buildOpenCodeModels, fallbackOpenCodeModels, openCodeMajor, openCodeModelLabel, parseOpenCodeAuth, parseOpenCodeModelList } from '../opencodeSetup';
import { commandAllowed } from '../policy';
import { TurnTracker } from '../tracking';
import type { TurnHost } from '../types';
import { LineSplitter, parseJson, spawnCli } from '../util';

const FIXTURES = process.env.FIXTURES ?? path.join(__dirname, 'fixtures');
const CWD = '/work';

interface Rec {
	text: string;
	thinking: string;
	tools: ToolPart[]; // every start/update in order
	finalTools: Map<string, ToolPart>;
	originals: [string, string | undefined][];
	changed: string[];
	usage: { inputTokens: number; outputTokens: number }[];
	approvals: ToolPart[];
}

function recorder(): { host: TurnHost; rec: Rec } {
	const rec: Rec = { text: '', thinking: '', tools: [], finalTools: new Map(), originals: [], changed: [], usage: [], approvals: [] };
	const host: TurnHost = {
		text: d => (rec.text += d),
		thinking: d => (rec.thinking += d),
		toolStart: p => (rec.tools.push(p), rec.finalTools.set(p.id, p)),
		toolUpdate: p => (rec.tools.push(p), rec.finalTools.set(p.id, p)),
		requestApproval: async p => (rec.approvals.push(p), 'run'),
		fileOriginal: (p, c) => rec.originals.push([p, c]),
		fileChanged: p => rec.changed.push(p),
		usage: u => rec.usage.push(u),
		uri: p => 'file://' + p,
	};
	return { host, rec };
}

function lines(name: string): Record<string, unknown>[] {
	return fs
		.readFileSync(path.join(FIXTURES, name), 'utf8')
		.split('\n')
		.filter(Boolean)
		.map(l => {
			const j = parseJson(l);
			assert.ok(j, 'fixture line parses: ' + l.slice(0, 60));
			return j;
		});
}

const tests: [string, () => Promise<void> | void][] = [];
const test = (name: string, fn: () => Promise<void> | void): void => void tests.push([name, fn]);

test('claude: approvals fixture (read, edit, bash)', () => {
	const { host, rec } = recorder();
	const originals = new Map<string, string | undefined>([['/work/a.txt', 'hello\nworld\n']]);
	const p = new ClaudeParser(CWD, host, abs => (originals.has(abs) ? originals.get(abs) : 'unknown'));
	for (const ev of lines('claude-approvals.jsonl')) {
		p.feed(ev);
	}
	assert.ok(p.result.sessionId && p.result.sawResult && !p.result.isError);
	assert.ok(rec.text.length > 20, 'streamed text');
	const titles = [...rec.finalTools.values()].map(t => t.title);
	assert.deepStrictEqual(titles, ['Read a.txt', 'Edited a.txt', 'Ran `rm -f nothing.tmp`']);
	const edit = [...rec.finalTools.values()][1];
	assert.strictEqual(edit.name, 'edit_file');
	assert.deepStrictEqual(edit.edit, { uri: 'file:///work/a.txt', path: 'a.txt', added: 1, removed: 1, isNew: undefined });
	assert.deepStrictEqual(rec.changed, ['/work/a.txt']);
	assert.ok([...rec.finalTools.values()].every(t => t.status === 'done'));
	assert.ok(rec.usage.length === 1 && rec.usage[0].outputTokens > 0 && rec.usage[0].inputTokens > 1000);
});

test('claude: denied tool becomes an error part, resume keeps going', () => {
	const { host, rec } = recorder();
	const p = new ClaudeParser(CWD, host);
	for (const ev of lines('claude-deny-resume.jsonl')) {
		p.feed(ev);
	}
	const last = [...rec.finalTools.values()].pop()!;
	assert.strictEqual(last.status, 'error');
	assert.match(last.output ?? '', /declined/);
	assert.ok(!rec.changed.length);
	assert.ok(p.result.sessionId);
});

test('claude: plan mode fixture streams text and thinking, no edits', () => {
	const { host, rec } = recorder();
	const p = new ClaudeParser(CWD, host);
	for (const ev of lines('claude-plan.jsonl')) {
		p.feed(ev);
	}
	assert.match(rec.text, /Plan/);
	assert.ok(!rec.changed.length);
	assert.ok(!p.result.isError);
});

test('claude: tool titles', () => {
	const t = (n: string, i: Record<string, unknown>, ph: 'run' | 'done' = 'done'): string => claudeToolView(n, i, ph, '/work').title;
	assert.strictEqual(t('Read', { file_path: '/work/src/a.ts' }), 'Read src/a.ts');
	assert.strictEqual(t('Read', { file_path: '/work/src/a.ts', offset: 10, limit: 40 }), 'Read src/a.ts L11-50');
	assert.strictEqual(t('Write', { file_path: '/work/new.ts' }), 'Wrote new.ts');
	assert.strictEqual(t('Edit', { file_path: '/work/a.ts' }, 'run'), 'Editing a.ts');
	assert.strictEqual(t('Bash', { command: 'npm test' }), 'Ran `npm test`');
	assert.strictEqual(t('Grep', { pattern: 'foo' }), 'Searched `foo`');
	assert.strictEqual(t('mcp__github__create_issue', {}), 'github · create_issue');
	assert.strictEqual(t('Read', { file_path: '/elsewhere/x' }), 'Read /elsewhere/x');
});

test('claude: error result maps to isError', () => {
	const { host } = recorder();
	const p = new ClaudeParser(CWD, host);
	p.feed({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } });
	assert.strictEqual(p.result.isError, true);
	assert.match(p.result.message ?? '', /login/);
});

test('codex: patch fixture (non git cwd falls back to hint rows + one warning)', async () => {
	const { host, rec } = recorder();
	const tracker = await TurnTracker.create(CWD, process.env, host);
	assert.strictEqual(tracker.active, false);
	const p = new CodexParser(CWD, host, tracker);
	for (const ev of lines('codex-patch.jsonl')) {
		await p.feed(ev);
	}
	assert.ok(p.sessionId && p.sawTurnCompleted);
	assert.deepStrictEqual(rec.changed.map(x => path.basename(x)).sort(), ['a.txt', 'b.txt', 'c.txt']);
	assert.strictEqual((rec.text.match(/not a git repository/g) ?? []).length, 1);
	assert.match(rec.text, /ok/);
	assert.strictEqual(rec.usage[0].outputTokens > 0, true);
});

test('codex: shell fixture shows the command, unwraps zsh -lc', async () => {
	const { host, rec } = recorder();
	const p = new CodexParser(CWD, host, await TurnTracker.create(CWD, process.env, host));
	for (const ev of lines('codex-resume-shell.jsonl')) {
		await p.feed(ev);
	}
	const cmd = [...rec.finalTools.values()].find(t => t.name === 'run_terminal_cmd')!;
	assert.strictEqual(cmd.status, 'done');
	assert.ok(cmd.title.includes("sed -i '' 's/there/over/' a.txt"), cmd.title);
	assert.strictEqual(unwrapShell('/bin/zsh -lc "echo \\"hi\\""'), 'echo "hi"');
	assert.strictEqual(unwrapShell('npm test'), 'npm test');
});

test('codex: reasoning, mcp, failed command, turn.failed', async () => {
	const { host, rec } = recorder();
	const p = new CodexParser(CWD, host, await TurnTracker.create(CWD, process.env, host));
	for (const ev of lines('codex-synthetic.jsonl')) {
		await p.feed(ev);
	}
	assert.match(rec.thinking, /Thinking/);
	assert.strictEqual(rec.finalTools.get('item_1')!.title, 'docs · search');
	assert.strictEqual(rec.finalTools.get('item_1')!.output, 'found it');
	assert.strictEqual(rec.finalTools.get('item_2')!.status, 'error');
	assert.strictEqual(p.failure, 'You have hit your usage limit.');
});

test('gemini: synthetic stream-json (schema from docs, CLI auth is broken on this Mac)', async () => {
	const { host, rec } = recorder();
	const p = new GeminiParser(CWD, host, await TurnTracker.create(CWD, process.env, host));
	for (const ev of lines('gemini-synthetic.jsonl')) {
		await p.feed(ev);
	}
	assert.strictEqual(p.sessionId, '2be2f984-5d0a-4736-a69a-5e81c8702c54');
	assert.ok(rec.text.startsWith("I'll read the file first.") && rec.text.endsWith('Edited a.txt.'), rec.text);
	assert.deepStrictEqual(
		[...rec.finalTools.values()].filter(t => !t.id.startsWith('edit-')).map(t => `${t.status}:${t.title}`),
		['done:Read a.txt', 'done:Edited a.txt', 'error:Ran `npm test`'],
	);
	assert.deepStrictEqual(rec.usage, [{ inputTokens: 1000, outputTokens: 200 }]);
	assert.ok(p.sawResult && !p.failure);
});

test('grok: edit + shell fixture (real run): tools, ANSI stripped, usage, session', async () => {
	const evs = lines('grok-edit-shell.jsonl');
	const cwd = path.dirname(String((evs.find(e => e.toolName === 'read_file')!.rawInput as Record<string, unknown>).target_file));
	const { host, rec } = recorder();
	const p = new GrokParser(cwd, host, await TurnTracker.create(cwd, process.env, host));
	for (const ev of evs) {
		await p.feed(ev);
	}
	assert.strictEqual(p.sessionId, '01a1828a-f02a-7b23-b90a-4e2a173d65ae');
	assert.ok(p.sawEnd && !p.failure && !p.blockedCommand);
	const tools = [...rec.finalTools.values()].filter(t => !t.id.startsWith('edit-'));
	assert.deepStrictEqual(
		tools.map(t => `${t.status}:${t.name}:${t.title}`),
		['done:grep:Searched `beta`', 'done:run_terminal_cmd:Ran `find . -name \'hello.txt\' -o -name \'hello.txt\' 2>/dev/null; ls -la`', 'done:read_file:Read hello.txt', 'done:edit_file:Edited hello.txt', 'done:run_terminal_cmd:Ran `ls`'],
	);
	const ls = tools.find(t => t.title === 'Ran `find . -name \'hello.txt\' -o -name \'hello.txt\' 2>/dev/null; ls -la`')!;
	assert.ok(ls.output && !ls.output.includes('\u001b'), 'ANSI stripped from command output');
	assert.ok(ls.output.includes('hello.txt'));
	assert.match(rec.text, /^I'll read `hello.txt`/);
	assert.match(rec.thinking, /Reading hello\.txt/);
	assert.ok(rec.text.includes('\n\n'), 'prose after tool calls starts a new paragraph');
	assert.strictEqual(rec.usage.length, 1);
	assert.strictEqual(rec.usage[0].outputTokens, 454);
	assert.strictEqual(rec.usage[0].inputTokens, 21960 + 135552);
	// Not a git repo here, so the edit is reported through the path hint from the diff.
	assert.deepStrictEqual(rec.changed.map(x => path.basename(x)), ['hello.txt']);
});

test('grok: refused command (headless cannot approve) ends the turn with a clear note', async () => {
	const { host, rec } = recorder();
	const p = new GrokParser(CWD, host, await TurnTracker.create(CWD, process.env, host));
	for (const ev of lines('grok-cancelled.jsonl')) {
		await p.feed(ev);
	}
	assert.strictEqual(p.blockedCommand, 'rm made.txt');
	const t = rec.finalTools.get('call-x-0')!;
	assert.strictEqual(t.status, 'error');
	assert.match(t.output ?? '', /cancelled/);
	assert.match(rec.text, /needs your approval/);
	assert.ok(!p.failure);
});

test('grok: plan file write becomes the plan text, exit_plan_mode is hidden', async () => {
	const { host, rec } = recorder();
	const p = new GrokParser(CWD, host, await TurnTracker.create(CWD, process.env, host));
	const plan = '/Users/x/.grok/sessions/%2Fwork/abc/plan.md';
	await p.feed({ type: 'tool_call', toolCallId: 'a', toolName: 'search_replace', rawInput: { file_path: plan, old_string: '', new_string: '# Plan\n- step' } });
	await p.feed({ type: 'tool_call_update', toolCallId: 'a', status: 'completed', content: [{ type: 'diff', path: plan, oldText: '', newText: '# Plan' }] });
	await p.feed({ type: 'tool_call', toolCallId: 'b', toolName: 'exit_plan_mode', rawInput: {} });
	await p.feed({ type: 'end', stopReason: 'end_turn', sessionId: 's1' });
	assert.strictEqual(rec.text, '# Plan\n- step');
	assert.deepStrictEqual([...rec.finalTools.values()].map(t => t.name), ['create_plan']);
	assert.ok(!rec.changed.length);
});

test('opencode: edit + shell fixture (real run): tools, session, usage, edits via hints', async () => {
	const evs = lines('opencode-edit-shell.jsonl');
	const { host, rec } = recorder();
	const p = new OpenCodeParser(CWD, host, await TurnTracker.create(CWD, process.env, host));
	for (const ev of evs) {
		await p.feed(ev);
	}
	p.finish();
	assert.strictEqual(p.sessionId, 'ses_e7ce1be17ffeMEtEHBY5JFJkrq');
	assert.ok(!p.failure && !p.denied.length);
	const tools = [...rec.finalTools.values()].filter(t => !t.id.startsWith('edit-'));
	assert.deepStrictEqual(
		tools.map(t => `${t.status}:${t.name}:${t.title}`),
		['done:read_file:Read hello.txt', 'done:run_terminal_cmd:Ran `ls`'],
	);
	assert.ok(tools[1].output?.includes('new.txt'));
	assert.strictEqual(tools[1].command?.text, 'ls');
	assert.match(rec.text, /Done\. I read hello\.txt/);
	assert.deepStrictEqual(rec.changed.map(x => path.basename(x)), ['hello.txt', 'new.txt']);
	assert.deepStrictEqual(rec.usage, [{ inputTokens: 16579 + 70 + 138 + 16651, outputTokens: 68 + 13 + 156 }]);
});

test('opencode: edits in a git repo get real +/- counts and originals', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-opencode-git-'));
	try {
		const git = (...a: string[]): void => void cp.execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, stdio: 'ignore' });
		git('init', '-q');
		fs.writeFileSync(path.join(dir, 'hello.txt'), 'alpha\nbeta\ndelta\n');
		git('add', '.');
		git('commit', '-qm', 'i');
		const { host, rec } = recorder();
		const p = new OpenCodeParser(dir, host, await TurnTracker.create(dir, process.env, host));
		for (const ev of lines('opencode-edit-shell.jsonl')) {
			const tool = (ev.part as Record<string, unknown> | undefined)?.tool;
			// the real CLI changed the files before it reported the tool call
			if (tool === 'edit') {
				fs.writeFileSync(path.join(dir, 'hello.txt'), 'alpha\ngamma\ndelta\n');
			} else if (tool === 'write') {
				fs.writeFileSync(path.join(dir, 'new.txt'), 'line1\nline2');
			}
			const s = JSON.stringify(ev).split('/work').join(dir);
			await p.feed(JSON.parse(s) as Record<string, unknown>);
		}
		const edits = [...rec.finalTools.values()].filter(t => t.edit).map(t => t.edit!);
		assert.deepStrictEqual(edits.map(e => [e.path, e.added, e.removed, !!e.isNew]), [['hello.txt', 1, 1, false], ['new.txt', 2, 0, true]]);
		const orig = new Map(rec.originals.map(([f, c]) => [path.basename(f), c]));
		assert.strictEqual(orig.get('hello.txt'), 'alpha\nbeta\ndelta\n');
		assert.strictEqual(orig.get('new.txt'), undefined);
		assert.ok(orig.has('new.txt'));
		assert.ok(!rec.text.includes('not a git repository'));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('opencode: a command the permission config refused is a failed row and is remembered', async () => {
	const { host, rec } = recorder();
	const p = new OpenCodeParser(CWD, host, await TurnTracker.create(CWD, process.env, host));
	for (const ev of lines('opencode-denied.jsonl')) {
		await p.feed(ev);
	}
	assert.deepStrictEqual(p.denied, ['touch chained.txt']);
	const rows = [...rec.finalTools.values()];
	const bad = rows.find(t => t.status === 'error')!;
	assert.strictEqual(bad.name, 'run_terminal_cmd');
	assert.match(bad.output ?? '', /Permission denied/);
	assert.ok(rows.some(t => t.status === 'done' && t.title === 'Ran `ls`'));
	assert.deepStrictEqual(rec.changed, []);
});

test('opencode: reasoning becomes thinking, error events become the failure', async () => {
	const { host, rec } = recorder();
	const p = new OpenCodeParser(CWD, host, await TurnTracker.create(CWD, process.env, host));
	for (const ev of lines('opencode-reasoning.jsonl')) {
		await p.feed(ev);
	}
	assert.match(rec.thinking, /17\*23 = 391/);
	assert.strictEqual(rec.text, '17 × 23 = 391');
	const q = new OpenCodeParser(CWD, host, await TurnTracker.create(CWD, process.env, host));
	for (const ev of lines('opencode-error.jsonl')) {
		await q.feed(ev);
	}
	assert.strictEqual(q.failure, 'Model unavailable: opencode/nope');
});

test('opencode: tool titles', () => {
	const t = (n: string, i: Record<string, unknown>, ph: 'run' | 'done' = 'done'): string => openCodeToolView(n, i, ph, '/work').title;
	assert.strictEqual(t('read', { path: '/work/src/a.ts' }), 'Read src/a.ts');
	assert.strictEqual(t('edit', { path: '/work/a.ts' }, 'run'), 'Editing a.ts');
	assert.strictEqual(t('shell', { command: 'npm test' }), 'Ran `npm test`');
	assert.strictEqual(t('grep', { pattern: 'foo' }), 'Searched `foo`');
	assert.strictEqual(t('websearch', { query: 'x' }), 'Searched the web for `x`');
});

test('opencode: free models are labelled readably and listed first; other providers only when signed in', () => {
	assert.deepStrictEqual(
		['opencode/big-pickle', 'opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free', 'opencode/nemotron-3-ultra-free', 'opencode/flint-40b-free', 'opencode/mimo-v2.6-flash-free', 'opencode/nemotron-3.5-super-vl-free', 'opencode/beam-free'].map(openCodeModelLabel),
		['Big Pickle', 'DeepSeek V4.1 Flash', 'GLM 5.3 Flash', 'Nemotron 3 Ultra', 'Flint 40B', 'MiMo V2.6 Flash', 'Nemotron 3.5 Super VL', 'Beam'],
	);
	const out = 'opencode/nemotron-3-ultra-free\nopencode/big-pickle\nopenai/gpt-5\nanthropic/claude-sonnet-4\nopencode/zen-paid-model\nnoise line\n';
	const all = parseOpenCodeModelList(out);
	assert.strictEqual(all.length, 5);
	const none = buildOpenCodeModels(all, []);
	assert.deepStrictEqual(none.map(m => m.id), ['opencode/big-pickle', 'opencode/nemotron-3-ultra-free']);
	assert.ok(none.every(m => m.free));
	const signed = buildOpenCodeModels(all, parseOpenCodeAuth('[{"id":"openai","name":"OpenAI","connections":[{"type":"env","name":"OPENAI_API_KEY"}]}]'));
	assert.deepStrictEqual(signed.map(m => [m.id, m.label, !!m.free]), [
		['opencode/big-pickle', 'Big Pickle', true],
		['opencode/nemotron-3-ultra-free', 'Nemotron 3 Ultra', true],
		['openai/gpt-5', 'OpenAI: gpt-5', false],
	]);
	assert.strictEqual(fallbackOpenCodeModels()[0].id, 'opencode/big-pickle');
	assert.strictEqual(openCodeMajor('2.0.25'), 2);
	assert.strictEqual(openCodeMajor('1.19.5'), 1);
	assert.deepStrictEqual(parseOpenCodeAuth('not json'), []);
});

test('grok: permission flags per mode', () => {
	const flags = (mode: 'agent' | 'ask' | 'plan', autoRun: 'ask' | 'allowlist' | 'auto' | 'always', commandAllowlist: string[] = []): string => grokPermissionArgs({ mode, autoRun, commandAllowlist }).join(' ');
	assert.strictEqual(flags('agent', 'ask'), '--permission-mode acceptEdits --sandbox workspace --deny Bash');
	assert.strictEqual(flags('ask', 'always'), '--permission-mode plan --sandbox read-only');
	assert.strictEqual(flags('plan', 'ask'), '--permission-mode plan --sandbox read-only');
	assert.strictEqual(flags('agent', 'always'), '--permission-mode bypassPermissions');
	const denyFiles = ['touch', 'mkdir', 'cp', 'mv', 'sed', 'ln', 'tee', 'rm', 'rmdir'].map(c => `--deny Bash(${c}) --deny Bash(${c} *)`).join(' ');
	assert.strictEqual(flags('agent', 'allowlist', ['npm test', 'git status && rm -rf /', '']), `--permission-mode acceptEdits --sandbox workspace --allow Bash(npm test) --allow Bash(npm test *) ${denyFiles}`);
	assert.ok(!flags('agent', 'allowlist', ['mkdir']).includes('Bash(mkdir)') || flags('agent', 'allowlist', ['mkdir']).includes('--allow Bash(mkdir)'), 'a listed file command is allowed, not denied');
	assert.ok(!flags('agent', 'allowlist', ['mkdir']).includes('--deny Bash(mkdir)'));
});

test('grok: model list parsing, tool titles, ANSI', () => {
	const models = parseGrokModels('You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n');
	assert.deepStrictEqual(models, [
		{ id: 'grok-4.7', label: '4.7' },
		{ id: 'grok-4.7-build-fast', label: '4.7 build fast' },
		{ id: 'grok-4.6', label: '4.6' },
	]);
	assert.strictEqual(grokToolView('read_file', { target_file: '/work/src/a.ts' }, 'done', '/work').title, 'Read src/a.ts');
	assert.strictEqual(grokToolView('search_replace', { file_path: '/work/a.ts' }, 'run', '/work').title, 'Editing a.ts');
	assert.strictEqual(stripAnsi('\u001b[34m.\u001b[39;49m\u001b[0m x'), '. x');
});

test('git tracker: dirty-before snapshot, HEAD fallback, new file, second scan is quiet', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-git-'));
	const git = (...a: string[]): string => cp.execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
	git('init', '-q', '.');
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
	fs.writeFileSync(path.join(dir, 'c.txt'), 'keep\n');
	git('add', '.');
	git('commit', '-qm', 'i');
	fs.appendFileSync(path.join(dir, 'c.txt'), 'dirty\n'); // dirty before the turn
	const { host, rec } = recorder();
	const tr = await TurnTracker.create(dir, process.env, host);
	assert.ok(tr.active);
	await tr.afterToolCall();
	assert.strictEqual(rec.changed.length, 0, 'nothing changed yet');
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
	fs.appendFileSync(path.join(dir, 'c.txt'), 'agent\n');
	fs.writeFileSync(path.join(dir, 'new.txt'), 'x\n');
	await tr.afterToolCall();
	const byName = new Map(rec.originals.map(([p, c]) => [path.basename(p), c]));
	assert.strictEqual(byName.get('a.txt'), 'one\ntwo\n');
	assert.strictEqual(byName.get('c.txt'), 'keep\ndirty\n');
	assert.ok(byName.has('new.txt') && byName.get('new.txt') === undefined);
	assert.strictEqual(rec.changed.length, 3);
	const before = rec.originals.length;
	fs.appendFileSync(path.join(dir, 'a.txt'), 'four\n');
	await tr.afterToolCall();
	assert.strictEqual(rec.originals.length, before, 'original reported only once per file');
	assert.strictEqual(rec.changed.length, 4);
	const row = [...rec.finalTools.values()].find(t => t.edit?.path === 'new.txt')!;
	assert.strictEqual(row.title, 'Created new.txt');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('helpers: status parsing, diff stat, allowlist, line splitter', () => {
	assert.deepStrictEqual(parseStatusZ(' M a.txt\0?? b c.txt\0R  new.txt\0old.txt\0').map(e => e.rel), ['a.txt', 'b c.txt', 'new.txt', 'old.txt']);
	assert.deepStrictEqual(diffStat('a\nb\nc\n', 'a\nB\nc\nd\n'), { added: 2, removed: 1 });
	assert.deepStrictEqual(diffStat(undefined, 'a\nb\n'), { added: 2, removed: 0 });
	assert.ok(commandAllowed('npm test', ['npm test', 'git status']));
	assert.ok(commandAllowed('npm test --silent', ['npm test']));
	assert.ok(!commandAllowed('npm test && rm -rf /', ['npm test']));
	assert.ok(!commandAllowed('npm testx', ['npm test']));
	const got: string[] = [];
	const s = new LineSplitter(l => got.push(l));
	s.push('{"a":1}\r\n{"b"');
	s.push(':2}\n\n{"c":3}');
	s.end();
	assert.deepStrictEqual(got, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('process: abort kills the whole process group', async () => {
	const ac = new AbortController();
	const marker = path.join(os.tmpdir(), 'oc-kill-' + process.pid);
	const proc = spawnCli('/bin/sh', ['-c', `(sleep 30; touch ${marker}) & sleep 30; wait`], { cwd: os.tmpdir(), env: process.env, signal: ac.signal, onLine: () => undefined });
	await new Promise(r => setTimeout(r, 300));
	const pid = proc.child.pid!;
	ac.abort();
	const t0 = Date.now();
	await proc.exited;
	assert.ok(Date.now() - t0 < 4000, 'exited promptly');
	await new Promise(r => setTimeout(r, 200));
	let alive = true;
	try {
		process.kill(-pid, 0);
	} catch {
		alive = false;
	}
	assert.strictEqual(alive, false, 'process group is gone');
});

test('permission server <-> broker round trip (real MCP stdio)', async () => {
	const server = path.join(process.env.OC_DIST ?? '', 'permissionServer.js');
	assert.ok(fs.existsSync(server), 'dist/permissionServer.js built by run.mjs');
	const seen: string[] = [];
	const broker = await ApprovalBroker.start(async req => {
		seen.push(req.toolName);
		return req.toolName === 'Bash' ? { behavior: 'deny', message: 'no shell' } : { behavior: 'allow', updatedInput: { ...req.input, extra: true } };
	});
	const child = cp.spawn(process.execPath, [server], { env: { ...process.env, OC_PERM_SOCKET: broker.socketPath, OC_PERM_TOKEN: broker.token }, stdio: ['pipe', 'pipe', 'inherit'] });
	const replies = new Map<number, Record<string, unknown>>();
	const waiters = new Map<number, (r: Record<string, unknown>) => void>();
	const ls = new LineSplitter(l => {
		const j = parseJson(l)!;
		replies.set(j.id as number, j);
		waiters.get(j.id as number)?.(j);
	});
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (d: string) => ls.push(d));
	const call = (id: number, method: string, params: unknown): Promise<Record<string, unknown>> =>
		new Promise(res => {
			waiters.set(id, res);
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
		});
	const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
	assert.ok((init.result as Record<string, unknown>).capabilities);
	const list = (await call(2, 'tools/list', {})).result as { tools: { name: string }[] };
	assert.strictEqual(list.tools[0].name, 'approve');
	const text = (r: Record<string, unknown>): Record<string, unknown> => JSON.parse(((r.result as { content: { text: string }[] }).content[0].text));
	const ok = text(await call(3, 'tools/call', { name: 'approve', arguments: { tool_name: 'Edit', input: { file_path: '/x' }, tool_use_id: 't1' } }));
	assert.deepStrictEqual(ok, { behavior: 'allow', updatedInput: { file_path: '/x', extra: true } });
	const no = text(await call(4, 'tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' } } }));
	assert.deepStrictEqual(no, { behavior: 'deny', message: 'no shell' });
	assert.deepStrictEqual(seen, ['Edit', 'Bash']);
	child.kill();
	broker.close();
});

(async () => {
	let failed = 0;
	for (const [name, fn] of tests) {
		try {
			await fn();
			console.log('ok   ' + name);
		} catch (e) {
			failed++;
			console.log('FAIL ' + name + '\n     ' + (e instanceof Error ? e.stack ?? e.message : String(e)).split('\n').slice(0, 6).join('\n     '));
		}
	}
	console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
	process.exit(failed ? 1 : 0);
})();
