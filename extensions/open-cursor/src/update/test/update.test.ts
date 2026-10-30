import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assert, done, test } from '../../agent/test/harness';
import { assetProblem, detectInstall, installRoot, isNewer, linuxPackageCommand, parseRelease, pickAsset, portableScript, relaunchScript, swapScript, windowsScript } from '../plan';

const NAMES = [
	'OpenCursor-0.2.0-linux-arm64.deb', 'OpenCursor-0.2.0-linux-arm64.rpm', 'OpenCursor-0.2.0-linux-arm64.tar.gz',
	'OpenCursor-0.2.0-linux-x64.deb', 'OpenCursor-0.2.0-linux-x64.rpm', 'OpenCursor-0.2.0-linux-x64.tar.gz',
	'OpenCursor-0.2.0-macos-arm64.dmg', 'OpenCursor-0.2.0-macos-x64.dmg',
	'OpenCursor-0.2.0-windows-arm64-portable.zip', 'OpenCursor-0.2.0-windows-arm64-setup.exe',
	'OpenCursor-0.2.0-windows-x64-portable.zip', 'OpenCursor-0.2.0-windows-x64-setup.exe',
];
const json = {
	tag_name: 'v0.2.0', html_url: 'https://github.com/noah-thing/open-cursor/releases/tag/v0.2.0', body: 'Fixes', draft: false,
	assets: NAMES.map(name => ({ name, browser_download_url: `https://github.com/noah-thing/open-cursor/releases/download/v0.2.0/${name}`, size: 100, digest: 'sha256:abc' })),
};

test('versions compare numerically, releases beat their prereleases', () => {
	assert.ok(isNewer('0.2.0', '0.1.0'));
	assert.ok(isNewer('v0.10.0', '0.9.9'));
	assert.ok(isNewer('1.0.0', '1.0.0-beta.2'));
	assert.ok(isNewer('1.0.0-beta.10', '1.0.0-beta.2'));
	assert.ok(!isNewer('0.1.0', '0.1.0'));
	assert.ok(!isNewer('0.1.0', '0.2.0'));
	assert.ok(!isNewer('1.0.0-beta.1', '1.0.0'));
	assert.ok(!isNewer('nightly', '0.1.0'));
	// +build metadata is ignored, not rejected
	assert.ok(isNewer('v0.2.0+build.5', '0.1.0'));
	assert.ok(isNewer('0.2.0', '0.1.0+abc'));
	assert.ok(!isNewer('0.1.0+b2', '0.1.0+b1'));
	assert.ok(isNewer('1.0.0', '1.0.0-beta.2+x'));
});

test('release files need a checksum and a GitHub https address', () => {
	const ok = { name: 'a.dmg', url: 'https://github.com/noah-thing/open-cursor/releases/download/v1/a.dmg', size: 1, digest: 'sha256:' + 'a'.repeat(64) };
	assert.strictEqual(assetProblem(ok), undefined);
	assert.strictEqual(assetProblem({ ...ok, url: 'https://objects.githubusercontent.com/x' }), undefined);
	assert.strictEqual(assetProblem({ ...ok, url: 'https://release-assets.githubusercontent.com/x' }), undefined);
	assert.ok(assetProblem({ ...ok, digest: undefined }));
	assert.ok(assetProblem({ ...ok, digest: 'sha256:abc' }));
	assert.ok(assetProblem({ ...ok, url: 'http://github.com/x/a.dmg' }));
	assert.ok(assetProblem({ ...ok, url: 'https://evilgithub.com/a.dmg' }));
	assert.ok(assetProblem({ ...ok, url: 'https://github.com.evil.example/a.dmg' }));
	assert.ok(assetProblem({ ...ok, url: 'not a url' }));
});

test('Windows scripts use UTF-8, wait with ping, and reopen the app on every path', () => {
	const w = windowsScript({ setup: 'C:\\T\\setup.exe', exe: 'C:\\P\\OpenCursor.exe', relaunchFlag: 'C:\\T\\relaunch', log: 'C:\\T\\log', download: 'C:\\T\\setup.exe' }).split('\r\n');
	const p = portableScript({ staged: 'C:\\P.new-update-1-2', root: 'C:\\P', exe: 'C:\\P\\OpenCursor.exe', relaunchFlag: 'C:\\T\\relaunch', log: 'C:\\T\\log', download: 'C:\\T\\p.zip' }).split('\r\n');
	for (const lines of [w, p]) {
		assert.strictEqual(lines[0], '@echo off');
		assert.strictEqual(lines[1], 'chcp 65001 >nul');
		assert.ok(lines.includes('ping -n 2 127.0.0.1 >nul'));
		assert.ok(!lines.some(l => l.startsWith('timeout')), 'timeout fails when stdin is NUL');
	}
	assert.ok(w.some(l => l.startsWith('if %rc% equ 0 del /f /q "C:\\T\\setup.exe"')));
	assert.ok(w.indexOf('set rc=%errorlevel%') < w.indexOf('if exist "C:\\T\\relaunch" start "" "C:\\P\\OpenCursor.exe"'));
	const fail = p.slice(p.indexOf(':fail'));
	assert.ok(fail.includes('if exist "C:\\T\\relaunch" start "" "C:\\P\\OpenCursor.exe"'), 'reopen after a failed copy');
	assert.ok(p.includes('del /f /q "C:\\T\\p.zip"'));
});

test('release JSON: drafts and odd tags are ignored, assets keep their checksum', () => {
	const r = parseRelease(json)!;
	assert.strictEqual(r.version, '0.2.0');
	assert.strictEqual(r.assets.length, 12);
	assert.strictEqual(r.assets[0].digest, 'sha256:abc');
	assert.strictEqual(parseRelease({ ...json, draft: true }), undefined);
	assert.strictEqual(parseRelease({ ...json, tag_name: 'latest' }), undefined);
	assert.strictEqual(parseRelease(null), undefined);
});

test('how this copy was installed, on every platform', () => {
	const mac = { platform: 'darwin' as const, appRoot: '/Applications/OpenCursor.app/Contents/Resources/app', portable: false, writable: true };
	assert.strictEqual(detectInstall(mac), 'mac-app');
	assert.strictEqual(detectInstall({ ...mac, writable: false }), 'unknown');
	assert.strictEqual(detectInstall({ ...mac, appRoot: '/private/var/folders/x/AppTranslocation/y/d/OpenCursor.app/Contents/Resources/app', writable: false }), 'unknown');
	const win = { platform: 'win32' as const, appRoot: 'C:\\Users\\a\\AppData\\Local\\Programs\\OpenCursor\\resources\\app', portable: false, writable: true };
	assert.strictEqual(detectInstall(win), 'win-setup');
	assert.strictEqual(detectInstall({ ...win, portable: true }), 'win-portable');
	const linux = { platform: 'linux' as const, appRoot: '/usr/share/open-cursor/resources/app', portable: false, writable: false };
	assert.strictEqual(detectInstall({ ...linux, linuxPackage: 'deb' }), 'linux-deb');
	assert.strictEqual(detectInstall({ ...linux, linuxPackage: 'rpm' }), 'linux-rpm');
	assert.strictEqual(detectInstall(linux), 'unknown');
	assert.strictEqual(detectInstall({ ...linux, appRoot: '/home/a/.local/share/opencursor/resources/app', writable: true }), 'linux-tar');
});

test('install roots', () => {
	assert.strictEqual(installRoot('darwin', '/Applications/OpenCursor.app/Contents/Resources/app'), '/Applications/OpenCursor.app');
	assert.strictEqual(installRoot('win32', 'C:\\Programs\\OpenCursor\\resources\\app'), 'C:\\Programs\\OpenCursor');
	assert.strictEqual(installRoot('linux', '/home/a/.local/share/opencursor/resources/app/'), '/home/a/.local/share/opencursor');
});

test('the right file for every install and processor', () => {
	const r = parseRelease(json)!;
	const name = (k: Parameters<typeof pickAsset>[1], arch: string): string | undefined => pickAsset(r, k, arch)?.name;
	assert.strictEqual(name('mac-app', 'arm64'), 'OpenCursor-0.2.0-macos-arm64.dmg');
	assert.strictEqual(name('mac-app', 'x64'), 'OpenCursor-0.2.0-macos-x64.dmg');
	assert.strictEqual(name('win-setup', 'x64'), 'OpenCursor-0.2.0-windows-x64-setup.exe');
	assert.strictEqual(name('win-setup', 'arm64'), 'OpenCursor-0.2.0-windows-arm64-setup.exe');
	assert.strictEqual(name('linux-deb', 'x64'), 'OpenCursor-0.2.0-linux-x64.deb');
	assert.strictEqual(name('linux-rpm', 'arm64'), 'OpenCursor-0.2.0-linux-arm64.rpm');
	assert.strictEqual(name('linux-tar', 'x64'), 'OpenCursor-0.2.0-linux-x64.tar.gz');
	assert.strictEqual(name('win-portable', 'x64'), 'OpenCursor-0.2.0-windows-x64-portable.zip');
	assert.strictEqual(name('unknown', 'x64'), undefined);
	assert.strictEqual(name('mac-app', 'ia32'), undefined);
});

test('scripts quote paths and only reopen when asked to', () => {
	const s = swapScript({ platform: 'darwin', staged: "/Apps/Open Cursor's.app.new-update", target: "/Apps/Open Cursor's.app", relaunchFlag: '/tmp/x/relaunch', log: '/tmp/x/log' });
	assert.ok(s.includes(`mv '/Apps/Open Cursor'\\''s.app.new-update' '/Apps/Open Cursor'\\''s.app'`));
	assert.ok(s.includes(`[ -f '/tmp/x/relaunch' ] && { sleep 1; open -n '/Apps/Open Cursor'\\''s.app'; }`));
	const w = windowsScript({ setup: 'C:\\T\\setup.exe', exe: 'C:\\P\\OpenCursor\\OpenCursor.exe', relaunchFlag: 'C:\\T\\relaunch', log: 'C:\\T\\log' });
	assert.ok(w.includes('IMAGENAME eq OpenCursor.exe'));
	assert.ok(w.includes('"C:\\T\\setup.exe" /VERYSILENT'));
	assert.ok(w.includes('if exist "C:\\T\\relaunch" start "" "C:\\P\\OpenCursor\\OpenCursor.exe"'));
	assert.ok(w.includes('\r\n'));
	assert.ok(relaunchScript({ target: '/usr/share/open-cursor', relaunchFlag: '/tmp/r', log: '/tmp/l' }).includes("/usr/share/open-cursor/bin/open-cursor"));
	assert.ok(linuxPackageCommand('linux-deb', '/tmp/a b.deb').includes("apt-get install -y '/tmp/a b.deb'"));
	assert.ok(linuxPackageCommand('linux-rpm', '/tmp/a.rpm').includes('dnf install -y'));
});

test('the swap script really swaps, keeps the old copy on failure, and reopens only with the flag', () => {
	if (process.platform === 'win32') { return; }
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-swap-'));
	try {
		const target = path.join(dir, 'App');
		const staged = target + '.new-update';
		fs.mkdirSync(path.join(target, 'bin'), { recursive: true });
		fs.writeFileSync(path.join(target, 'version'), 'old');
		fs.mkdirSync(path.join(staged, 'bin'), { recursive: true });
		fs.writeFileSync(path.join(staged, 'version'), 'new');
		const opened = path.join(dir, 'opened');
		fs.writeFileSync(path.join(staged, 'bin', 'open-cursor'), `#!/bin/sh\ntouch '${opened}'\n`, { mode: 0o755 });
		const flag = path.join(dir, 'relaunch');
		const script = path.join(dir, 'install.sh');
		fs.writeFileSync(script, swapScript({ platform: 'linux', staged, target, relaunchFlag: flag, log: path.join(dir, 'log') }));
		// a crash reporter left running from the install must not block the swap
		fs.writeFileSync(path.join(target, 'bin', 'chrome_crashpad_handler'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
		const reporter = spawn(path.join(target, 'bin', 'chrome_crashpad_handler'), [], { stdio: 'ignore' });
		try {
			execFileSync('/bin/sh', [script], { timeout: 10_000 });
		} finally {
			reporter.kill();
		}
		assert.strictEqual(fs.readFileSync(path.join(target, 'version'), 'utf8'), 'new');
		assert.ok(!fs.existsSync(staged) && !fs.existsSync(target + '.old-update'));
		assert.ok(!fs.existsSync(opened), 'no flag, no reopen');
		// second run: nothing staged, so the old copy must come back
		try { execFileSync('/bin/sh', [script]); } catch { /* exits 1 */ }
		assert.strictEqual(fs.readFileSync(path.join(target, 'version'), 'utf8'), 'new');
		// a failed swap with the flag still reopens the restored old copy
		fs.rmSync(opened, { force: true });
		fs.writeFileSync(path.join(target, 'bin', 'open-cursor'), `#!/bin/sh\ntouch '${opened}'\n`, { mode: 0o755 });
		fs.writeFileSync(flag, '');
		try { execFileSync('/bin/sh', [script]); } catch { /* exits 1 */ }
		for (let i = 0; i < 50 && !fs.existsSync(opened); i++) { execFileSync('sleep', ['0.1']); }
		assert.ok(fs.existsSync(opened), 'reopened after failure');
		assert.strictEqual(fs.readFileSync(path.join(target, 'version'), 'utf8'), 'new');
		fs.rmSync(opened, { force: true });
		// with the flag it reopens
		fs.mkdirSync(path.join(staged, 'bin'), { recursive: true });
		fs.writeFileSync(path.join(staged, 'version'), 'newer');
		fs.writeFileSync(path.join(staged, 'bin', 'open-cursor'), `#!/bin/sh\ntouch '${opened}'\n`, { mode: 0o755 });
		fs.writeFileSync(flag, '');
		execFileSync('/bin/sh', [script]);
		for (let i = 0; i < 50 && !fs.existsSync(opened); i++) { execFileSync('sleep', ['0.1']); }
		assert.strictEqual(fs.readFileSync(path.join(target, 'version'), 'utf8'), 'newer');
		assert.ok(fs.existsSync(opened), 'reopened');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('an unzipped Windows copy without an uninstaller updates as portable, never through the setup', () => {
	const win = { platform: 'win32' as const, appRoot: 'C:\\Tools\\OpenCursor\\resources\\app', portable: false, writable: true };
	assert.strictEqual(detectInstall({ ...win, hasUninstaller: false }), 'win-portable');
	assert.strictEqual(detectInstall({ ...win, hasUninstaller: true }), 'win-setup');
	assert.strictEqual(detectInstall({ ...win, portable: true, hasUninstaller: true }), 'win-portable');
	assert.strictEqual(detectInstall(win), 'win-setup');
});

test('the portable script only mirrors resources and never touches data', () => {
	const s = portableScript({ staged: 'C:\\Tools\\OpenCursor.new-update', root: 'C:\\Tools\\OpenCursor', exe: 'C:\\Tools\\OpenCursor\\OpenCursor.exe', relaunchFlag: 'C:\\T\\relaunch', log: 'C:\\T\\update.log' });
	const lines = s.split('\r\n');
	const mir = lines.filter(l => l.includes('/MIR'));
	assert.strictEqual(mir.length, 1);
	assert.ok(mir[0].includes('"C:\\Tools\\OpenCursor.new-update\\resources" "C:\\Tools\\OpenCursor\\resources"'));
	const rest = lines.find(l => l.startsWith('robocopy') && !l.includes('/MIR'))!;
	assert.ok(rest.includes('/XD') && rest.includes('"C:\\Tools\\OpenCursor\\data"') && !rest.includes('/PURGE'));
	assert.ok(!/\b(del|rd|rmdir)\b[^\r\n]*C:\\Tools\\OpenCursor"/i.test(s), 'never deletes the install folder');
	assert.ok(s.includes('rmdir /s /q "C:\\Tools\\OpenCursor.new-update"'));
	assert.ok(s.indexOf('if not exist "C:\\Tools\\OpenCursor.new-update\\OpenCursor.exe" goto fail') < s.indexOf('robocopy'));
	assert.ok(s.includes('if errorlevel 8 goto fail'));
});

void done('update');
