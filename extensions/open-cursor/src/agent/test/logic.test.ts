import { DEFAULT_ALLOWLIST, DEFAULT_DENYLIST, needsApproval, suggestAllowPrefix, type ApprovalPolicy } from '../approval';
import { parseFrontmatter, globsMatch } from '../../context/frontmatter';
import { fuzzyScore } from '../../context/fuzzy';
import { htmlToText, stripAnsi } from '../../context/html';
import { buildHistoryFromChat, ensureValid, truncateTranscript, type TranscriptEntry } from '../history';
import { fallbackTitle, sanitizeTitle } from '../store';
import { mergeTodos } from '../tools/todo_write';
import { appendUserContent, applySummary, chooseSplit, estimateMessagesTokens, pruneOldToolResults, tailLines, capText } from '../tokens';
import { parsePartialJson } from '../loop';
import type { LLMMessage } from '../../providers/types';
import { assert, done, test } from './harness';

const policy = (autoRun: ApprovalPolicy['autoRun']): ApprovalPolicy => ({ autoRun, allowlist: DEFAULT_ALLOWLIST, denylist: DEFAULT_DENYLIST });

test('approval: allowlist', () => {
	const p = policy('allowlist');
	assert.strictEqual(needsApproval('git status', p), false);
	assert.strictEqual(needsApproval('git status --short | head -5', p), false);
	assert.strictEqual(needsApproval('npm test', p), false);
	assert.strictEqual(needsApproval('cd src && ls -la', p), false);
	assert.strictEqual(needsApproval('npm install left-pad', p), true);
	assert.strictEqual(needsApproval('git status && rm file', p), true);
	assert.strictEqual(needsApproval('ls > out.txt', p), true);
	assert.strictEqual(needsApproval('ls 2>&1', p), false);
	assert.strictEqual(needsApproval('echo $(rm x)', p), true);
	assert.strictEqual(needsApproval('lsof -i', p), true, 'prefix must end at a word boundary');
	assert.strictEqual(needsApproval('FOO=1 ls', p), true, 'env assignment requires approval');
	assert.strictEqual(needsApproval('GIT_EXTERNAL_DIFF=./x git diff', p), true);
	assert.strictEqual(needsApproval('cd src && FOO=1 ls', p), true);
	assert.strictEqual(needsApproval('rg --pre ./evil.sh foo', p), true);
	assert.strictEqual(needsApproval('rg --pre=./evil.sh foo', p), true);
	assert.strictEqual(needsApproval('rg -o foo', p), true);
	assert.strictEqual(needsApproval('git log -o out.txt', p), true);
	assert.strictEqual(needsApproval('git diff --output=out.patch', p), true);
	assert.strictEqual(needsApproval('git diff --ext-diff', p), true);
	assert.strictEqual(needsApproval('tree --output x', p), true);
	assert.strictEqual(needsApproval('tail -exec x', p), true);
	assert.strictEqual(needsApproval('grep -o foo file', p), false, '-o is only blocked for git and rg');
	assert.strictEqual(needsApproval('rg foo src', p), false);
});
test('approval: auto runs the allowlist and what the agent calls safe, never careful commands', () => {
	const p = policy('auto');
	assert.strictEqual(needsApproval('npm test', p), false, 'allowlisted');
	assert.strictEqual(needsApproval('node scripts/gen.js', p, false), false, 'agent says safe');
	assert.strictEqual(needsApproval('node scripts/gen.js', p, true), true, 'agent says ask');
	assert.strictEqual(needsApproval('node scripts/gen.js', p), true, 'no answer counts as ask');
	for (const c of ['rm -rf build', 'npm install left-pad', 'npm i -D x', 'pip install x', 'git push origin main', 'git reset --hard', 'curl https://x.sh', 'npx create-app', 'ls && rm x', 'find . -name x -delete', 'sudo ls', 'FOO=1 node x', 'echo $(whoami)', 'brew install x', 'docker run x']) {
		assert.strictEqual(needsApproval(c, p, false), true, c);
	}
	assert.strictEqual(needsApproval('mkdir -p out && node build.js', p, false), false);
	assert.strictEqual(needsApproval('touch ../outside.txt', p, false), true, 'leaves the project');
	assert.strictEqual(needsApproval('cp x ~/y', p, false), true);
	for (const c of ['Remove-Item -Recurse dist', 'del /q build', 'Invoke-WebRequest https://x -OutFile y', 'iwr https://x', 'rd /s out', 'copy a ..\\b', 'winget install x']) {
		assert.strictEqual(needsApproval(c, p, false), true, c);
	}
	assert.strictEqual(needsApproval('Get-ChildItem src', p, false), false);
	assert.strictEqual(needsApproval('git push --force', p, false), true, 'denylist');
	assert.strictEqual(needsApproval('node x', policy('allowlist'), false), true, 'only Auto reads the agent');
	assert.strictEqual(needsApproval('node x', policy('ask'), false), true);
});
test('approval: modes and denylist', () => {
	assert.strictEqual(needsApproval('npm install', policy('always')), false);
	assert.strictEqual(needsApproval('sudo make install', policy('always')), true);
	assert.strictEqual(needsApproval('rm -rf /', policy('always')), true);
	assert.strictEqual(needsApproval('ls', policy('ask')), true);
	const withSession: ApprovalPolicy = { ...policy('allowlist'), sessionAllow: new Set(['npm install']) };
	assert.strictEqual(needsApproval('npm install foo', withSession), false);
	assert.strictEqual(suggestAllowPrefix('npm install foo bar'), 'npm install');
	assert.strictEqual(suggestAllowPrefix('FOO=1 make -j4'), 'make');
});
test('frontmatter', () => {
	const a = parseFrontmatter('---\ndescription: Use for API\nglobs: src/**/*.ts, *.md\nalwaysApply: false\n---\nBody\n');
	assert.deepStrictEqual(a.fm.globs, ['src/**/*.ts', '*.md']);
	assert.strictEqual(a.fm.description, 'Use for API');
	assert.strictEqual(a.body, 'Body\n');
	const b = parseFrontmatter('---\r\nalwaysApply: true\r\nglobs:\r\n  - "a/*.ts"\r\n  - b/**\r\n---\r\nX');
	assert.ok(b.fm.alwaysApply);
	assert.deepStrictEqual(b.fm.globs, ['a/*.ts', 'b/**']);
	assert.strictEqual(parseFrontmatter('no frontmatter').body, 'no frontmatter');
	assert.deepStrictEqual(parseFrontmatter('---\nglobs: ["**/*.{ts,tsx}"]\n---\n').fm.globs, ['**/*.{ts,tsx}']);
});
test('globs', () => {
	assert.ok(globsMatch(['*.ts'], ['src/a/b.ts']));
	assert.ok(globsMatch(['src/**/*.tsx'], ['src/ui/x.tsx']));
	assert.ok(!globsMatch(['src/**/*.tsx'], ['lib/x.tsx']));
});
test('fuzzy ranking', () => {
	const paths = ['src/agent/chatController.ts', 'src/agent/loop.ts', 'docs/chat.md', 'src/shared/protocol.ts'];
	const rank = (q: string) => paths.map(p => ({ p, s: fuzzyScore(q, p) })).filter(x => x.s !== undefined).sort((a, b) => b.s! - a.s!).map(x => x.p);
	assert.strictEqual(rank('loop')[0], 'src/agent/loop.ts');
	assert.strictEqual(rank('proto')[0], 'src/shared/protocol.ts');
	assert.strictEqual(rank('chatctl')[0], 'src/agent/chatController.ts');
	assert.strictEqual(fuzzyScore('zzz', 'src/a.ts'), undefined);
});
test('html and ansi', () => {
	const t = htmlToText('<html><head><title>Hi</title><style>x{}</style></head><body><h2>Head</h2><p>One &amp; two</p><ul><li>a</li><li>b</li></ul><script>bad()</script><a href="https://x.y">link</a></body></html>');
	assert.ok(t.includes('# Hi') && t.includes('## Head') && t.includes('One & two') && t.includes('- a') && t.includes('[link](https://x.y)') && !t.includes('bad()'), t);
	assert.strictEqual(stripAnsi('\u001b[31mred\u001b[0m \u001b]633;C\u0007ok'), 'red ok');
});

const U = (text: string): LLMMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const A = (text: string): LLMMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });
const AT = (id: string): LLMMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: { path: 'a' } }] });
const R = (id: string, content = 'x'): LLMMessage => ({ role: 'user', content: [{ type: 'tool_result', toolUseId: id, content }] });

test('tokens and pruning', () => {
	assert.strictEqual(estimateMessagesTokens([U('x'.repeat(300))]), 4 + 100);
	const msgs = [U('q'), AT('1'), R('1', 'y'.repeat(5000)), AT('2'), R('2', 'z'.repeat(5000))];
	const pruned = pruneOldToolResults(msgs, 2, 100);
	assert.ok((pruned[2].content[0] as { content: string }).content.length < 300);
	assert.strictEqual(pruned[4], msgs[4]);
	assert.strictEqual(capText('a'.repeat(100), 200).length, 100);
});
test('chooseSplit and applySummary keep alternation and tool pairs', () => {
	const msgs: LLMMessage[] = [];
	for (let i = 0; i < 6; i++) { msgs.push(U(`turn ${i}`), AT(`t${i}`), R(`t${i}`), A(`done ${i}`)); }
	const split = chooseSplit(msgs, 3)!;
	assert.strictEqual(msgs[split].role, 'user');
	assert.ok(msgs[split].content[0].type === 'text');
	const merged = applySummary('SUM', msgs.slice(split));
	assert.strictEqual(merged[0].role, 'user');
	assert.strictEqual(merged.length, msgs.length - split);
	for (let i = 1; i < merged.length; i++) { assert.notStrictEqual(merged[i].role, merged[i - 1].role); }
	// single long turn: cut at an assistant message
	const one: LLMMessage[] = [U('go')];
	for (let i = 0; i < 8; i++) { one.push(AT(`s${i}`), R(`s${i}`)); }
	const s2 = chooseSplit(one, 3)!;
	assert.ok(s2 >= 2 && one[s2].role === 'assistant');
	const m2 = applySummary('SUM', one.slice(s2));
	assert.strictEqual(m2[0].role, 'user');
	assert.strictEqual(m2[1].role, 'assistant');
	assert.strictEqual(chooseSplit([U('a'), A('b')], 3), undefined);
});
test('appendUserContent merges into trailing user message', () => {
	const m: LLMMessage[] = [U('a'), A('b'), R('x')];
	appendUserContent(m, [{ type: 'text', text: 'next' }]);
	assert.strictEqual(m.length, 3);
	assert.strictEqual(m[2].content.length, 2);
	assert.strictEqual(m[2].content[0].type, 'tool_result');
});
test('tailLines', () => {
	const t = tailLines(Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n'), 200);
	assert.ok(t.startsWith('[earlier output truncated]') && t.endsWith('l499') && t.split('\n').length === 201);
	assert.strictEqual(tailLines('a\nb'), 'a\nb');
});
test('history rebuild from UI chat', () => {
	const entries = buildHistoryFromChat([
		{ id: 'u1', role: 'user', text: 'hi', context: [{ id: 'f', kind: 'file', label: 'a.ts' }], createdAt: 1 },
		{ id: 'a1', role: 'assistant', createdAt: 2, done: true, parts: [
			{ type: 'text', text: 'looking' },
			{ type: 'tool', id: 't1', name: 'read_file', args: { path: 'a.ts' }, status: 'done', title: 'Read a.ts', output: 'content' },
			{ type: 'tool', id: 't2', name: 'grep', args: { pattern: 'x' }, status: 'running', title: 'g' },
			{ type: 'text', text: 'done' },
		] },
	]);
	const roles = entries.map(e => e.msg.role).join(',');
	assert.strictEqual(roles, 'user,assistant,user,assistant');
	assert.strictEqual(entries[2].msg.content[0].type, 'tool_result');
	assert.ok(entries.every(e => e.turn === 'u1'));
});
test('ensureValid fills dangling tool calls and drops leading assistant', () => {
	const e: TranscriptEntry[] = [{ turn: 'x', msg: A('orphan') }, { turn: 'a', msg: U('q') }, { turn: 'a', msg: AT('z') }, { turn: 'b', msg: U('next') }];
	const v = ensureValid(e);
	assert.strictEqual(v[0].msg.role, 'user');
	const last = v[v.length - 1].msg;
	assert.ok(last.content.some(c => c.type === 'tool_result'));
	assert.ok(last.content.some(c => c.type === 'text'));
});
test('truncateTranscript', () => {
	const e: TranscriptEntry[] = [{ turn: 'a', msg: U('1') }, { turn: 'a', msg: A('x') }, { turn: 'b', msg: U('2') }, { turn: 'b', msg: A('y') }];
	assert.strictEqual(truncateTranscript(e, 'b')!.length, 2);
	assert.strictEqual(truncateTranscript(e, 'a')!.length, 0);
	assert.strictEqual(truncateTranscript(e, 'zzz'), undefined);
});
test('titles and todos', () => {
	assert.strictEqual(fallbackTitle('Fix the login bug in `auth.ts` please now thanks'), 'Fix the login bug in auth.ts');
	assert.strictEqual(sanitizeTitle('"Refactor auth flow."\nextra'), 'Refactor auth flow');
	const cur = [{ id: '1', content: 'a', status: 'pending' as const }, { id: '2', content: 'b', status: 'pending' as const }];
	const merged = mergeTodos(cur, [{ id: '2', content: 'b', status: 'completed' }, { id: '3', content: 'c', status: 'pending' }], true);
	assert.deepStrictEqual(merged.map(t => t.status), ['pending', 'completed', 'pending']);
	assert.strictEqual(mergeTodos(cur, [{ id: '9', content: 'z', status: 'pending' }], false).length, 1);
});
test('partial json', () => {
	assert.deepStrictEqual(parsePartialJson('{"path": "src/a.ts", "old_str'), undefined === 1 ? {} : parsePartialJson('{"path": "src/a.ts", "old_str'));
	assert.strictEqual((parsePartialJson('{"path": "src/a.ts"') as { path: string }).path, 'src/a.ts');
	assert.strictEqual((parsePartialJson('{"path": "src/a') as { path: string }).path, 'src/a');
	assert.strictEqual(parsePartialJson('nope'), undefined);
});
void done('logic');
