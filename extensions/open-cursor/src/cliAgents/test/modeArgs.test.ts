import { assert, done, test } from '../../agent/test/harness';
import { cliModeGuidance } from '../../agent/prompts';
import { DEBUG_MARKER } from '../../agent/modes';
import { claudeModeArgs, cliPromptPrefix, codexModeArgs, geminiModeArgs, CLAUDE_EDIT_TOOLS } from '../modeArgs';
import { grokPermissionArgs } from '../grok';
import { VARIANT_ERROR, openCodeArgs, openCodeCommandNote, openCodeEnv, openCodePermission } from '../opencode';
import type { AutoRun } from '../types';
import { effectiveAutoRun } from '../policy';
import { DEFAULT_ALLOWLIST } from '../../agent/approval';
import type { ChatMode } from '../../shared/protocol';

const after = (args: string[], flag: string): string | undefined => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };
const RO: ChatMode[] = ['ask', 'plan'];
const FULL: ChatMode[] = ['agent', 'debug'];
const RUNS: AutoRun[] = ['ask', 'allowlist', 'auto', 'always'];

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

test('gemini: allowlisted commands pass in Allowlist and Auto only', () => {
	assert.deepStrictEqual(geminiModeArgs({ mode: 'agent', autoRun: 'auto', commandAllowlist: ['npm test', 'ls > x'] }), ['--approval-mode', 'auto_edit', '--allowed-tools', 'run_shell_command(npm test)']);
	assert.deepStrictEqual(geminiModeArgs({ mode: 'agent', autoRun: 'allowlist', commandAllowlist: ['git status'] }), ['--approval-mode', 'auto_edit', '--allowed-tools', 'run_shell_command(git status)']);
	assert.deepStrictEqual(geminiModeArgs({ mode: 'agent', autoRun: 'ask', commandAllowlist: ['git status'] }), ['--approval-mode', 'auto_edit']);
	assert.deepStrictEqual(geminiModeArgs({ mode: 'ask', autoRun: 'auto', commandAllowlist: ['git status'] }), ['--approval-mode', 'plan']);
});

test('grok: Auto allows the shell in the workspace sandbox but denies careful commands', () => {
	const a = grokPermissionArgs({ mode: 'agent', autoRun: 'auto', commandAllowlist: [] });
	assert.strictEqual(after(a, '--sandbox'), 'workspace');
	assert.strictEqual(after(a, '--allow'), 'Bash');
	for (const c of ['rm', 'rm *', 'git push *', 'npm install *', 'curl *', 'sudo *']) { assert.ok(a.includes(`Bash(${c})`), c); }
});

test('prompt prefix (gemini, grok) carries the per-mode guidance', () => {
	for (const mode of ['agent', 'plan', 'debug', 'ask'] as const) { assert.ok(cliPromptPrefix(mode).startsWith(cliModeGuidance(mode))); }
	assert.ok(cliPromptPrefix('plan').includes('read only') && cliPromptPrefix('ask').includes('read only'));
});

test('codex: below Full access the user tools are off, and in Ask the shell too', () => {
	const toml = 'model = "x"\n[mcp_servers.node_repl]\ncommand = "n"\n[mcp_servers."my server"]\n';
	const ask = codexModeArgs({ mode: 'agent', autoRun: 'ask', configToml: toml });
	for (const f of ['mcp_servers.node_repl.enabled=false', 'mcp_servers."my server".enabled=false', 'features.plugins=false', 'features.computer_use=false', 'features.shell_tool=false', 'features.unified_exec=false']) { assert.ok(ask.includes(f), f); }
	const auto = codexModeArgs({ mode: 'agent', autoRun: 'auto', configToml: toml });
	assert.ok(auto.includes('features.plugins=false') && !auto.includes('features.shell_tool=false'));
	assert.strictEqual(after(auto, '-s'), 'workspace-write');
	const full = codexModeArgs({ mode: 'agent', autoRun: 'always', configToml: toml });
	assert.ok(full.includes('--dangerously-bypass-approvals-and-sandbox') && !full.some(a => a.includes('enabled=false') || a.includes('features.')));
});

test('tools that cannot ask run Allowlist like Auto; Ask, Auto, Full access and the asking tools are unchanged', () => {
	for (const a of ['opencode', 'gemini-cli', 'grok'] as const) {
		assert.strictEqual(effectiveAutoRun(a, 'allowlist'), 'auto');
		assert.strictEqual(effectiveAutoRun(a, 'ask'), 'ask');
		assert.strictEqual(effectiveAutoRun(a, 'always'), 'always');
	}
	assert.strictEqual(effectiveAutoRun('claude-code', 'allowlist'), 'allowlist');
	assert.strictEqual(effectiveAutoRun('codex', 'allowlist'), 'allowlist');
	// and through OpenCode's rules: Auto lets dir run but still refuses deleting
	const rule = openCodePermission({ mode: 'agent', autoRun: effectiveAutoRun('opencode', 'allowlist'), commandAllowlist: DEFAULT_ALLOWLIST }) as { bash: Record<string, string> };
	assert.strictEqual(rule.bash['*'], 'allow');
	assert.strictEqual(rule.bash['rm *'], 'deny');
});

test('the default allowlist covers looking around on Windows', () => {
	for (const c of ['dir', 'type', 'Get-ChildItem', 'Get-Content']) { assert.ok(DEFAULT_ALLOWLIST.includes(c), c); }
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
		const auto = openCodePermission({ mode, autoRun: 'auto', commandAllowlist: ['npm test'] });
		assert.strictEqual(auto.bash && (auto.bash as Record<string, string>)['*'], 'allow');
		for (const c of ['rm', 'rm *', 'git push *', 'npm install *', 'curl *', 'sudo *']) { assert.strictEqual((auto.bash as Record<string, string>)[c], 'deny', c); }
		const always = openCodePermission({ mode, autoRun: 'always', commandAllowlist: [] });
		assert.deepStrictEqual(always, { '*': 'allow', question: 'deny' });
		// no rule may be `ask`: a headless OpenCode would wait forever
		for (const r of [ask, list, auto, always]) { assert.ok(!JSON.stringify(r).includes('"ask"')); }
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


{
	// thinking effort reaches OpenCode 2 as a model variant; Auto and older versions leave the model alone
	const m = (effort?: import('../../shared/protocol').Effort, version = '2.0.25', model = 'opencode/big-pickle'): string | undefined => {
		const a = openCodeArgs({ mode: 'agent', autoRun: 'ask', model, version, effort, extraArgs: [] });
		return a[a.indexOf('-m') + 1];
	};
	assert.strictEqual(m('high'), 'opencode/big-pickle#high');
	assert.strictEqual(m('off'), 'opencode/big-pickle#low');
	assert.strictEqual(m('max'), 'opencode/big-pickle#max');
	assert.strictEqual(m('auto'), 'opencode/big-pickle');
	assert.strictEqual(m(undefined), 'opencode/big-pickle');
	assert.strictEqual(m('high', '1.4.0'), 'opencode/big-pickle');
	assert.ok(!openCodeArgs({ mode: 'agent', autoRun: 'ask', model: 'default', effort: 'high', extraArgs: [] }).some(x => x.includes('#')));
}

{
	// OpenCode is told up front which commands run, so it does not burn requests retrying blocked ones
	const note = (mode: ChatMode, autoRun: AutoRun): string => openCodeCommandNote({ mode, autoRun, commandAllowlist: ['ls', 'npm test'] });
	assert.ok(note('agent', 'allowlist').includes('ls, npm test'));
	assert.ok(note('agent', 'ask').includes('Shell commands are blocked'));
	assert.ok(note('agent', 'auto').includes('delete files') && !note('agent', 'auto').includes('Only these'));
	assert.strictEqual(note('agent', 'always'), '');
	assert.strictEqual(note('ask', 'allowlist'), '');
}

{
	// the variant: never on a model id that already has one, and the early-failure test is not a DNS error
	const base = { mode: 'agent' as const, autoRun: 'always' as const, version: '2.0.25', extraArgs: [] as string[], effort: 'high' as const };
	assert.ok(openCodeArgs({ ...base, model: 'opencode/big-pickle' }).includes('opencode/big-pickle#high'));
	assert.ok(openCodeArgs({ ...base, model: 'opencode/big-pickle#max' }).includes('opencode/big-pickle#max'));
	assert.ok(!openCodeArgs({ ...base, model: 'opencode/big-pickle#max' }).some(a => a.includes('#max#')));
	assert.ok(!openCodeArgs({ ...base, version: '1.4.0', model: 'opencode/big-pickle' }).some(a => a.includes('#')));
	assert.ok(VARIANT_ERROR.test('Model variant "high" not found') && !VARIANT_ERROR.test('getaddrinfo: could not resolve host api.example.com'));
	const noted = openCodeCommandNote({ mode: 'agent', autoRun: 'allowlist', commandAllowlist: ['npm test', 'ls && rm -rf x'] });
	assert.ok(noted.includes('npm test') && !noted.includes('rm -rf'));
}
