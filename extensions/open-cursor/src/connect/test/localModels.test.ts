import { assert, done, test } from '../../agent/test/harness';
import { budget, needGB, parseNvidiaSmi, pickModels, type Hardware } from '../localModels';

const mac = (memGB: number): Hardware => ({ platform: 'darwin', arch: 'arm64', cpu: 'Apple M4', memGB, diskFreeGB: 100 });

test('a 16 GB Mac gets a 9B model first, nothing that would not fit', () => {
	const p = pickModels(mac(16));
	assert.strictEqual(p[0].model.tag, 'qwen3.5:9b');
	assert.ok(p.every(x => needGB(x.model) <= 16 * 0.66));
	assert.ok(p[0].recommended && !p[1].recommended);
});

test('a 32 GB Mac gets the coding agent model', () => {
	assert.strictEqual(pickModels(mac(32))[0].model.tag, 'qwen3-coder:30b');
});

test('an 8 GB Mac still gets something small', () => {
	const p = pickModels(mac(8));
	assert.ok(p.length > 0);
	assert.ok(p.every(x => x.model.sizeGB < 4));
});

test('an NVIDIA card is sized by its own memory, not the system memory', () => {
	const hw: Hardware = { platform: 'win32', arch: 'x64', cpu: 'Intel', memGB: 64, gpu: { name: 'NVIDIA GeForce RTX 3060', memGB: 12 } };
	const b = budget(hw);
	assert.strictEqual(b.speed, 'fast');
	assert.ok(pickModels(hw).every(x => needGB(x.model) <= 12 * 0.92));
	assert.strictEqual(pickModels(hw)[0].model.tag, 'qwen2.5-coder:14b');
});

test('no graphics card means small models, marked slower', () => {
	const hw: Hardware = { platform: 'win32', arch: 'x64', cpu: 'Intel', memGB: 32 };
	assert.strictEqual(budget(hw).speed, 'slow');
	assert.ok(pickModels(hw).every(x => x.model.sizeGB <= 6.6));
});

test('a full disk is flagged per model', () => {
	const p = pickModels({ ...mac(64), diskFreeGB: 10 });
	assert.strictEqual(p.find(x => x.model.tag === 'qwen3-coder:30b')?.diskOk, false);
});

test('nvidia-smi output: the biggest card wins', () => {
	const g = parseNvidiaSmi('NVIDIA GeForce RTX 3060, 12288\nNVIDIA GeForce RTX 4090, 24564\n');
	assert.strictEqual(g?.name, 'NVIDIA GeForce RTX 4090');
	assert.ok(Math.abs((g?.memGB ?? 0) - 24) < 0.1);
	assert.strictEqual(parseNvidiaSmi(''), undefined);
	assert.strictEqual(parseNvidiaSmi('No devices were found'), undefined);
});

void done('local models');
