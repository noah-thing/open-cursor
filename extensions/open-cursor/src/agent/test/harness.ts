import * as assert from 'assert';

let passed = 0;
const pending: Promise<void>[] = [];
export function test(name: string, fn: () => void | Promise<void>): void {
	pending.push((async () => {
		try { await fn(); passed++; } catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack?.split('\n').slice(0, 4).join('\n    ')}`); process.exitCode = 1; }
	})());
}
export async function done(label: string): Promise<void> {
	await Promise.all(pending);
	console.log(`${label}: ${passed} passed`);
}
export { assert };
