import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assert, done, test } from '../../agent/test/harness';
import { BROKEN_DB, openCodeDbPath, setAsideOpenCodeDb } from '../opencode';
import { friendlyError } from '../util';

test('the OpenCode database is found where OpenCode looks for it', () => {
	assert.strictEqual(openCodeDbPath({}, '/home/a'), path.join('/home/a', '.local', 'share', 'opencode', 'opencode.db'));
	assert.strictEqual(openCodeDbPath({ XDG_DATA_HOME: '/x' }, '/home/a'), path.join('/x', 'opencode', 'opencode.db'));
	assert.strictEqual(openCodeDbPath({ OPENCODE_DB: '/custom.db' }, '/home/a'), '/custom.db');
	assert.strictEqual(openCodeDbPath({ OPENCODE_DB: ':memory:' }, '/home/a'), undefined);
});

test('a damaged database is renamed aside with its wal and shm files, never deleted', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-db-'));
	const db = path.join(dir, 'opencode.db');
	for (const ext of ['', '-wal', '-shm']) { fs.writeFileSync(db + ext, 'x' + ext); }
	const aside = setAsideOpenCodeDb(db, 'stamp')!;
	assert.strictEqual(aside, db + '.broken-stamp');
	assert.ok(!fs.existsSync(db) && !fs.existsSync(db + '-wal'));
	assert.strictEqual(fs.readFileSync(aside + '-wal', 'utf8'), 'x-wal');
	assert.strictEqual(setAsideOpenCodeDb(path.join(dir, 'missing.db')), undefined);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('the exact OpenCode message is recognised and its color codes are removed', () => {
	const raw = '\u001b[91m\u001b[1mError: \u001b[0mUnexpected error\n\nDatabase is not empty and has no session table';
	assert.ok(BROKEN_DB.test(raw));
	const shown = friendlyError('opencode', raw);
	assert.ok(!shown.includes('\u001b') && !shown.includes('[91m'), shown);
	assert.ok(shown.startsWith('Error: Unexpected error'));
});

void done('opencode database');
