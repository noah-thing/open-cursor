import { assert, done, test } from '../../agent/test/harness';
import { commandWithBinary, lmStudioAppPaths } from '../lmStudio';

test('PowerShell needs the call operator', () => {
	assert.strictEqual(commandWithBinary('codex login', 'C:\\Users\\A B\\codex.cmd', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), "& 'C:\\Users\\A B\\codex.cmd' login");
});

test('PowerShell doubles typographic apostrophes in a user name', () => {
	assert.strictEqual(commandWithBinary('codex login', 'C:\\Users\\O\u2019Neil\\codex.cmd', 'pwsh.exe'), "& 'C:\\Users\\O\u2019\u2019Neil\\codex.cmd' login");
});

test('POSIX shells get single quotes', () => {
	assert.strictEqual(commandWithBinary('opencode auth login', "/home/o'neil/bin/opencode", '/bin/zsh'), "'/home/o'\\''neil/bin/opencode' auth login");
});

test('cmd gets double quotes, and no path leaves the command alone', () => {
	assert.strictEqual(commandWithBinary('gemini', 'C:\\x y\\gemini.cmd', 'cmd.exe'), '"C:\\x y\\gemini.cmd"');
	assert.strictEqual(commandWithBinary('claude', undefined, '/bin/bash'), 'claude');
});

test('LM Studio app paths exist per system', () => {
	assert.ok(lmStudioAppPaths('darwin')[0].endsWith('LM Studio.app'));
	assert.ok(lmStudioAppPaths('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' })[0].endsWith('LM Studio.exe'));
	assert.strictEqual(lmStudioAppPaths('linux').length, 0);
});

void done('lmStudio');

test('Git Bash gets a path it can run', () => {
	const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
	assert.strictEqual(commandWithBinary('codex login', 'C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd', bash), "cmd //c 'C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd' login");
	assert.strictEqual(commandWithBinary('gemini', 'D:\\My Tools\\gemini.exe', bash), "'/d/My Tools/gemini.exe'");
	assert.strictEqual(commandWithBinary('gemini', '/usr/bin/gemini', '/bin/bash'), "'/usr/bin/gemini'");
});
