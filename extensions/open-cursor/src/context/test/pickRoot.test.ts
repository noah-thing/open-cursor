import { assert, done, test } from '../../agent/test/harness';
import { pickRoot } from '../pickRoot';

const has = (set: string[]) => (root: string, rel: string) => set.includes(`${root}:${rel}`);

test('first root wins when it has the path or none do', () => {
	assert.equal(pickRoot('a.txt', ['/r0', '/r1'], has(['/r0:a.txt', '/r1:a.txt'])).index, 0);
	assert.equal(pickRoot('new.txt', ['/r0', '/r1'], has([])).index, 0);
	assert.equal(pickRoot('a.txt', ['/r0'], has([])).index, 0);
});

test('a single other root that has it is used', () => {
	const r = pickRoot('src/a.ts', ['/r0', '/r1', '/r2'], has(['/r2:src/a.ts']));
	assert.equal(r.index, 2);
	assert.equal(r.ambiguous, undefined);
});

test('several other roots are ambiguous', () => {
	const r = pickRoot('a.ts', ['/r0', '/r1', '/r2'], has(['/r1:a.ts', '/r2:a.ts']));
	assert.deepEqual(r.ambiguous, [1, 2]);
});

void done('pickRoot');
