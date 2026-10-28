import { assert, done, test } from '../../agent/test/harness';
import { cliModeGuidance } from '../../agent/prompts';
import { DEBUG_MARKER } from '../../agent/modes';
import { claudeModeArgs, cliPromptPrefix, codexModeArgs, geminiModeArgs, CLAUDE_EDIT_TOOLS } from '../modeArgs';
import { grokPermissionArgs } from '../grok';
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
		assert.ok(p.includes('Open Cursor') && p.includes(cliModeGuidance(mode)), mode);
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
