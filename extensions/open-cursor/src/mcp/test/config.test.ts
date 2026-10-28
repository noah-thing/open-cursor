import assert from 'node:assert/strict';
import { mergeLayers, interpolateConfig, prefixedToolName, isHttp } from '../config';

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log('ok', name); };

t('merge: later layers win by name', () => {
	const r = mergeLayers([
		{ source: 'a', text: JSON.stringify({ mcpServers: { x: { command: 'one' }, y: { url: 'http://y' } } }) },
		{ source: 'b', text: '{ // comment\n "mcpServers": { "x": { "command": "two", "args": ["1"], }, "z": { "command": "z", "disabled": true } } }' },
		{ source: 'c', text: 'not json' },
	]);
	const by = Object.fromEntries(r.map(s => [s.name, s]));
	assert.equal((by.x.config as { command: string }).command, 'two');
	assert.equal(by.x.source, 'b');
	assert.ok(isHttp(by.y.config));
	assert.equal(by.z.config.disabled, true);
});

t('interpolation', () => {
	const c = interpolateConfig({ command: '${env:BIN}/run', args: ['${workspaceFolder}/x'], env: { K: '${env:SECRET}' } }, { workspaceFolder: '/w', home: '/h', env: { BIN: '/usr/bin', SECRET: 's' } });
	assert.equal((c as { command: string }).command, '/usr/bin/run');
	assert.deepEqual((c as { args: string[] }).args, ['/w/x']);
	assert.equal((c as { env: Record<string, string> }).env.K, 's');
});

t('tool names', () => {
	assert.equal(prefixedToolName('my server', 'do.thing'), 'mcp_my_server_do_thing');
	const long = prefixedToolName('s', 'a'.repeat(100));
	assert.ok(long.length <= 64);
	assert.notEqual(long, prefixedToolName('s', 'a'.repeat(99) + 'b'));
	assert.match(long, /^[a-zA-Z0-9_-]+$/);
});

console.log(`${n} tests passed`);
