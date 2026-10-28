import { assert, done, test } from '../../agent/test/harness';
import { toolBlockedReason, isReadOnlyMode } from '../../agent/modes';
import { buildSystemPrompt, cliModeGuidance } from '../../agent/prompts';
import { claudeModeArgs } from '../../cliAgents/modeArgs';
import { MANUAL } from '../manual';
import { buildHelpSystemPrompt } from '../prompt';
import { actionLabel, firstInPlaceLink, formatHelpLink, HELP_TARGETS, parseHelpLink, validateAction } from '../targets';

test('links parse into catalog actions', () => {
	assert.deepStrictEqual(parseHelpLink('opencursor:settings/models'), { target: 'settings', arg: 'models' });
	assert.deepStrictEqual(parseHelpLink('opencursor:editor-settings/font%20size'), { target: 'editor-settings', arg: 'font size' });
	assert.deepStrictEqual(parseHelpLink('opencursor:editor-settings?q=tab+size'), { target: 'editor-settings', arg: 'tab size' });
	assert.deepStrictEqual(parseHelpLink('OpenCursor:color-theme'), { target: 'color-theme' });
	assert.deepStrictEqual(parseHelpLink('opencursor:settings/Tools and MCP'), { target: 'settings', arg: 'mcp' });
});
test('unknown targets, bad sections and other schemes are refused', () => {
	assert.strictEqual(parseHelpLink('opencursor:delete-everything'), undefined);
	assert.strictEqual(parseHelpLink('https://example.com'), undefined);
	assert.strictEqual(parseHelpLink('opencursor:view/nowhere'), undefined);
	assert.deepStrictEqual(parseHelpLink('opencursor:settings/bogus'), { target: 'settings' });
	assert.strictEqual(validateAction(42), undefined);
});
test('format and parse round trip', () => {
	for (const a of [{ target: 'shortcuts' as const, arg: 'cmd+k' }, { target: 'view' as const, arg: 'source-control' }, { target: 'free-models' as const }]) {
		assert.deepStrictEqual(parseHelpLink(formatHelpLink(a)), a);
	}
});
test('first link that may open on its own skips chat moving targets', () => {
	const text = 'Start one here: [Chat](opencursor:new-chat/fix%20it), then [Models](opencursor:settings/models).';
	assert.deepStrictEqual(firstInPlaceLink(text), { target: 'settings', arg: 'models' });
	assert.strictEqual(firstInPlaceLink('[Chat](opencursor:new-chat) only'), undefined);
	assert.strictEqual(firstInPlaceLink('no links'), undefined);
});
test('labels read like places', () => {
	assert.strictEqual(actionLabel({ target: 'settings', arg: 'mcp' }), 'Settings: Tools and MCP');
	assert.strictEqual(actionLabel({ target: 'free-models' }), 'Free models');
});
test('every link in the manual is a real target', () => {
	const links = [...MANUAL.matchAll(/\]\((opencursor:[^)]+)\)/g)].map(m => m[1]);
	assert.ok(links.length >= 15, `only ${links.length} links`);
	for (const l of links) { assert.ok(parseHelpLink(l), `bad manual link ${l}`); }
	for (const t of HELP_TARGETS.filter(x => x.inPlace && x.id !== 'icon-theme' && x.id !== 'command-palette')) {
		assert.ok(links.some(l => l.startsWith('opencursor:' + t.id)), `manual never links ${t.id}`);
	}
});
test('help mode is read only and only allows open_in_app', () => {
	assert.ok(isReadOnlyMode('help'));
	assert.strictEqual(toolBlockedReason('help', { name: 'open_in_app', readOnly: true }, {}), undefined);
	for (const name of ['read_file', 'edit_file', 'run_terminal_cmd', 'mcp_x']) {
		assert.ok(toolBlockedReason('help', { name, readOnly: name === 'read_file' }, { command: 'ls' }));
	}
});
test('help prompts carry the manual and the catalog', () => {
	const native = buildHelpSystemPrompt({ os: 'macOS', date: 'today', setup: '- API keys added: none' }, true);
	assert.ok(native.includes('open_in_app') && native.includes('# OpenCursor manual') && native.includes('- free-models') && native.includes('Cmd on macOS'));
	assert.ok(!native.includes('{os}') && !native.includes('{targets}'));
	assert.ok(!buildHelpSystemPrompt({ os: 'Linux', date: 'd', setup: '' }, false).includes('Call open_in_app'));
	const viaMode = buildSystemPrompt('help', { os: 'macOS', date: 'd', workspaceFolders: [], openFiles: [], rules: [], agentRules: [] });
	assert.ok(viaMode.includes('OpenCursor Help') && !viaMode.includes('edit_file'));
	assert.ok(cliModeGuidance('help').includes('Do not read, search or change any files'));
});
test('Claude Code runs Help with no tools at all', () => {
	const args = claudeModeArgs({ mode: 'help' });
	const i = args.indexOf('--tools');
	assert.ok(i > 0 && args[i + 1] === '');
	assert.ok(args.includes('plan'));
	assert.ok(!args.join(' ').includes('edit files directly'));
});
void done('help');
