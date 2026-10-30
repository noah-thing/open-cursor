import { assert, done, test } from './harness';
import { cdLine, shellKind } from '../tools/shellSyntax';

test('shell kind from path', () => {
	assert.equal(shellKind('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'powershell');
	assert.equal(shellKind('/usr/local/bin/pwsh'), 'powershell');
	assert.equal(shellKind('C:\\Windows\\System32\\cmd.exe'), 'cmd');
	assert.equal(shellKind('/bin/zsh'), 'posix');
	assert.equal(shellKind('C:\\Program Files\\Git\\bin\\bash.exe', 'win32'), 'posix');
	assert.equal(shellKind(undefined, 'win32'), 'powershell');
	assert.equal(shellKind(undefined, 'darwin'), 'posix');
});

test('cd line per shell', () => {
	assert.equal(cdLine('powershell', "D:\\it's $x", 'npm test'), "Set-Location -LiteralPath 'D:\\it''s $x' -ErrorAction Stop; npm test");
	assert.equal(cdLine('cmd', 'D:\\proj', 'dir'), 'cd /d "D:\\proj" && dir');
	assert.equal(cdLine('posix', "/a/it's", 'ls'), "cd '/a/it'\\''s' && ls");
});

void done('shellSyntax');
