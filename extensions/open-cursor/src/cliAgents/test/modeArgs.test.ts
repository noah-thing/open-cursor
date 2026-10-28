import { assert, done, test } from '../../agent/test/harness';
import { cliModeGuidance } from '../../agent/prompts';
import { DEBUG_MARKER } from '../../agent/modes';
import { claudeModeArgs, cliPromptPrefix, codexModeArgs, geminiModeArgs, CLAUDE_EDIT_TOOLS } from '../modeArgs';
import { grokPermissionArgs } from '../grok';
import { openCodeArgs, openCodeEnv, openCodePermission } from '../opencode';
import type { AutoRun } from '../types';
import type { ChatMode } from '../../shared/protocol';

const after = (args: string[], flag: string): string | undefined => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };
const RO: ChatMode[] = ['ask', 'plan'];
const FULL: ChatMode[] = ['agent', 'debug'];
const RUNS: AutoRun[] = ['ask', 'allowlist', 'always'];

test('claude: read-only modes use plan permission mode and lose the edit tools; others stay default', () => {
	for (const mode of RO) {
		const a = claudeModeArgs({ mode });
		assert.strictEqual(after(a, '--permission-mode'), 'plan');
		const denied = after(a, '--disallowed-tools')!.split(',');
		for (const t of CLAUDE_EDIT_TOOLS) { assert.ok(denied.includes(t)); }
		assert.ok(!denied.includes('MultiEdit'), 'MultiEdit is not a Claude Code tool; it makes the CLI warn');
	}
	for (const mode of FULL) {
		const a = claudeModeArgs({ mode });
		assert.strictEqual(after(a, '--permission-mode'), 'default');
		assert.ok(!a.includes('--disallowed-tools'));
	}
});

test('claude: the mode guidance is appended to the system prompt', () => {
	for (const mode of ['agent', 'plan', 'debug', 'ask'] as const) {
		const p = after(claudeModeArgs({ mode }), '--append-system-prompt')!;
		assert.ok(p.includes('OpenCursor') && p.includes(cliModeGuidance(mode)), mode);
	}
	assert.ok(after(claudeModeArgs({ mode: 'debug' }), '--append-system-prompt')!.includes(DEBUG_MARKER));
});

test('codex: read-only sandbox for ask/plan even with autoRun always; workspace-write for agent/debug', () => {
	for (const autoRun of RUNS) {
		for (const mode of RO) {
			const fresh = codexModeArgs({ mode, autoRun });
			assert.strictEqual(after(fresh, '-s'), 'read-only');
			assert.ok(!fresh.includes('--dangerously-bypass-approvals-and-sandbox'));
			assert.ok(codexModeArgs({ mode, autoRun, sessionId: 'abc' }).includes('sandbox_mode="read-only"'));
		}
		for (const mode of FULL) {
			const fresh = codexModeArgs({ mode, autoRun });
			if (autoRun === 'always') { assert.ok(fresh.includes('--dangerously-bypass-approvals-and-sandbox')); } else { assert.strictEqual(after(fresh, '-s'), 'workspace-write'); }
			if (autoRun !== 'always') { assert.ok(codexModeArgs({ mode, autoRun, sessionId: 'abc' }).includes('sandbox_mode="workspace-write"')); }
		}
	}
});

test('codex: approval never and mode guidance as developer_instructions (valid TOML string)', () => {
	for (const mode of ['agent', 'plan', 'debug', 'ask'] as const) {
		const a = codexModeArgs({ mode, autoRun: 'ask' });
		assert.ok(a.includes('approval_policy="never"'));
		const kv = a.find(x => x.startsWith('developer_instructions='))!;
		assert.strictEqual(JSON.parse(kv.slice('developer_instructions='.length)), cliModeGuidance(mode));
		assert.strictEqual(a[a.indexOf(kv) - 1], '-c');
	}
});

test('gemini: plan approval mode for ask/plan whatever autoRun says; auto_edit or yolo otherwise', () => {
	for (const autoRun of RUNS) {
		for (const mode of RO) { assert.deepStrictEqual(geminiModeArgs({ mode, autoRun }), ['--approval-mode', 'plan']); }
		for (const mode of FULL) { assert.deepStrictEqual(geminiModeArgs({ mode, autoRun }), ['--approval-mode', autoRun === 'always' ? 'yolo' : 'auto_edit']); }
	}
});

test('grok: plan permission mode inside a read-only sandbox for ask/plan; workspace sandbox otherwise', () => {
	for (const autoRun of RUNS) {
		for (const mode of RO) { assert.deepStrictEqual(grokPermissionArgs({ mode, autoRun, commandAllowlist: ['ls'] }), ['--permission-mode', 'plan', '--sandbox', 'read-only']); }
		for (const mode of FULL) {
			const a = grokPermissionArgs({ mode, autoRun, commandAllowlist: [] });
			assert.strictEqual(after(a, '--permission-mode'), autoRun === 'always' ? 'bypassPermissions' : 'acceptEdits');
			assert.ok(!a.includes('read-only'));
		}
	}
});

test('prompt prefix (gemini, grok) carries the per-mode guidance', () => {
	for (const mode of ['agent', 'plan', 'debug', 'ask'] as const) { assert.ok(cliPromptPrefix(mode).startsWith(cliModeGuidance(mode))); }
	assert.ok(cliPromptPrefix('plan').includes('read only') && cliPromptPrefix('ask').includes('read only'));
});

void done('cli modes');
test('opencode: ask/plan deny everything but reading, whatever the auto-run setting', () => {
	for (const mode of RO) {
		for (const autoRun of RUNS) {
			const rule = openCodePermission({ mode, autoRun, commandAllowlist: ['npm test'] });
			assert.strictEqual(rule['*'], 'deny');
			for (const t of ['read', 'glob', 'grep', 'list']) { assert.strictEqual(rule[t], 'allow', t); }
			for (const t of ['edit', 'bash', 'write']) { assert.ok(!(t in rule), t); }
			assert.ok(!openCodeArgs({ mode, autoRun, model: 'opencode/big-pickle', extraArgs: [] }).includes('--auto'));
		}
	}
});

test('opencode: agent/debug allow edits, gate the shell by the allowlist, never ask', () => {
	for (const mode of FULL) {
		const ask = openCodePermission({ mode, autoRun: 'ask', commandAllowlist: ['npm test'] });
		assert.strictEqual(ask['*'], 'allow');
		assert.deepStrictEqual(ask.bash, { '*': 'deny' });
		assert.strictEqual(ask.external_directory, 'deny');
		assert.strictEqual(ask.question, 'deny');
		const list = openCodePermission({ mode, autoRun: 'allowlist', commandAllowlist: ['npm test', 'git status && rm -rf /', 'ls > x', ''] });
		assert.deepStrictEqual(list.bash, { '*': 'deny', 'npm test': 'allow', 'npm test *': 'allow' });
		const always = openCodePermission({ mode, autoRun: 'always', commandAllowlist: [] });
		assert.deepStrictEqual(always, { '*': 'allow', question: 'deny' });
		// no rule may be `ask`: a headless OpenCode would wait forever
		for (const r of [ask, list, always]) { assert.ok(!JSON.stringify(r).includes('"ask"')); }
	}
});

test('opencode: the child sees the workspace as PWD and carries the permission config without touching the user config', () => {
	const env = openCodeEnv({ env: { PWD: '/somewhere/else', PATH: '/bin' }, cwd: '/work', mode: 'plan', autoRun: 'always', commandAllowlist: [] });
	assert.strictEqual(env.PWD, '/work');
	assert.strictEqual(env.PATH, '/bin');
	assert.strictEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).permission['*'], 'deny');
	assert.ok(!('OPENCODE_CONFIG' in env));
});

test('opencode: --auto only for agent/debug with auto-run always, only on OpenCode 2', () => {
	const a = (mode: ChatMode, autoRun: AutoRun, version = '2.0.25', sessionId?: string): string[] => openCodeArgs({ mode, autoRun, model: 'opencode/big-pickle', version, sessionId, extraArgs: ['--variant', 'high'] });
	assert.deepStrictEqual(a('agent', 'ask'), ['run', '--format', 'json', '--thinking', '--standalone', '-m', 'opencode/big-pickle', '--variant', 'high']);
	assert.ok(a('agent', 'always').includes('--auto'));
	assert.ok(!a('agent', 'allowlist').includes('--auto'));
	assert.ok(!a('debug', 'ask').includes('--auto'));
	assert.ok(!a('ask', 'always').includes('--auto'));
	assert.ok(!a('agent', 'always', '1.19.5').includes('--auto') && !a('agent', 'always', '1.19.5').includes('--standalone'));
	assert.strictEqual(after(a('agent', 'ask', '2.0.25', 'ses_abc'), '--session'), 'ses_abc');
	assert.ok(!openCodeArgs({ mode: 'agent', autoRun: 'ask', model: 'default', extraArgs: [] }).includes('-m'));
});

