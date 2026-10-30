/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  What an update needs to know before it touches anything: is the release newer, how this copy
 *  was installed, which release file fits it, and the small script that swaps it in after the app
 *  quits. Pure, so every platform is testable on any machine.
 *--------------------------------------------------------------------------------------------*/

export interface ReleaseAsset {
	readonly name: string;
	readonly url: string;
	readonly size: number;
	/** `sha256:<hex>` when GitHub computed one. */
	readonly digest?: string;
}

export interface Release {
	readonly version: string;
	readonly tag: string;
	readonly pageUrl: string;
	readonly notes: string;
	readonly assets: readonly ReleaseAsset[];
}

/**
 * mac-app: an app bundle we can replace. win-setup: the per user Windows install. win-portable:
 * a portable zip. linux-deb / linux-rpm: the system package. linux-tar: an unpacked folder we can
 * replace. unknown: anything else, which only gets the release page.
 */
export type InstallKind = 'mac-app' | 'win-setup' | 'win-portable' | 'linux-deb' | 'linux-rpm' | 'linux-tar' | 'unknown';

/** `v0.2.0`, `0.2.0-beta.1` -> comparable parts; undefined when it is not a version. */
export function parseVersion(v: string): { nums: number[]; pre: string } | undefined {
	// `+build` metadata never takes part in ordering, so it is dropped before matching
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
	return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : undefined;
}

/** True when `latest` is a strictly newer version than `current`. A release beats its own prerelease. */
export function isNewer(latest: string, current: string): boolean {
	const a = parseVersion(latest);
	const b = parseVersion(current);
	if (!a || !b) { return false; }
	for (let i = 0; i < 3; i++) {
		if (a.nums[i] !== b.nums[i]) { return a.nums[i] > b.nums[i]; }
	}
	if (a.pre === b.pre) { return false; }
	if (!a.pre) { return true; }
	if (!b.pre) { return false; }
	return a.pre.localeCompare(b.pre, 'en', { numeric: true }) > 0;
}

/** The GitHub `releases/latest` JSON, reduced to what the updater uses. */
export function parseRelease(json: unknown): Release | undefined {
	const r = json as { tag_name?: unknown; html_url?: unknown; body?: unknown; draft?: unknown; assets?: unknown };
	if (!r || typeof r.tag_name !== 'string' || r.draft === true || !Array.isArray(r.assets)) { return undefined; }
	const version = r.tag_name.replace(/^v/, '');
	if (!parseVersion(version)) { return undefined; }
	const assets: ReleaseAsset[] = [];
	for (const a of r.assets as { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }[]) {
		if (typeof a.name === 'string' && typeof a.browser_download_url === 'string') {
			assets.push({ name: a.name, url: a.browser_download_url, size: typeof a.size === 'number' ? a.size : 0, digest: typeof a.digest === 'string' ? a.digest : undefined });
		}
	}
	return { version, tag: r.tag_name, pageUrl: typeof r.html_url === 'string' ? r.html_url : '', notes: typeof r.body === 'string' ? r.body : '', assets };
}

const ASSET_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'githubusercontent.com'];

/** Why this release file must not be installed, or undefined when it is fine: https from GitHub, with a sha256 digest. */
export function assetProblem(a: ReleaseAsset): string | undefined {
	let u: URL;
	try { u = new URL(a.url); } catch { return 'the download address is not valid'; }
	if (u.protocol !== 'https:' || !ASSET_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) { return 'the download does not come from GitHub'; }
	if (!/^sha256:[0-9a-f]{64}$/i.test(a.digest ?? '')) { return 'GitHub published no checksum for this file, so it cannot be verified'; }
	return undefined;
}

export interface InstallFacts {
	readonly platform: NodeJS.Platform;
	/** `vscode.env.appRoot`: `<bundle>/Contents/Resources/app` on macOS, `<dir>/resources/app` elsewhere. */
	readonly appRoot: string;
	/** Set by the app when it runs from a portable folder. */
	readonly portable: boolean;
	/** Windows: the installer left its uninstaller next to the app. Without one it is an unzipped copy. */
	readonly hasUninstaller?: boolean;
	/** The Linux package manager that owns the install, if any. */
	readonly linuxPackage?: 'deb' | 'rpm';
	/** Whether the folder that holds the install can be written by this user. */
	readonly writable: boolean;
}

export function detectInstall(f: InstallFacts): InstallKind {
	if (f.platform === 'darwin') {
		return /\.app\/Contents\/Resources\/app\/?$/.test(f.appRoot) && f.writable ? 'mac-app' : 'unknown';
	}
	if (f.platform === 'win32') {
		// an unzipped copy without a data folder is not in portable mode, but the setup must not update it
		return f.portable || f.hasUninstaller === false ? 'win-portable' : 'win-setup';
	}
	if (f.platform === 'linux') {
		if (f.linuxPackage) { return f.linuxPackage === 'deb' ? 'linux-deb' : 'linux-rpm'; }
		return f.writable ? 'linux-tar' : 'unknown';
	}
	return 'unknown';
}

/** Root of the install: the .app bundle on macOS, the folder with the executable elsewhere. */
export function installRoot(platform: NodeJS.Platform, appRoot: string): string {
	const sep = platform === 'win32' ? '\\' : '/';
	const parts = appRoot.replace(/[\\/]+$/, '').split(/[\\/]/);
	return parts.slice(0, platform === 'darwin' ? -3 : -2).join(sep);
}

const ASSET_SUFFIX: Record<Exclude<InstallKind, 'unknown'>, string> = {
	'mac-app': 'macos-{arch}.dmg',
	'win-setup': 'windows-{arch}-setup.exe',
	'win-portable': 'windows-{arch}-portable.zip',
	'linux-deb': 'linux-{arch}.deb',
	'linux-rpm': 'linux-{arch}.rpm',
	'linux-tar': 'linux-{arch}.tar.gz',
};

/** The release file for this install and processor (`arm64` or `x64`). */
export function pickAsset(release: Release, kind: InstallKind, arch: string): ReleaseAsset | undefined {
	if (kind === 'unknown') { return undefined; }
	const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : undefined;
	if (!a) { return undefined; }
	const suffix = '-' + ASSET_SUFFIX[kind].replace('{arch}', a);
	return release.assets.find(x => x.name.endsWith(suffix));
}

/**
 * The time a staged folder (`<install>.new-update-<pid>-<ms>`) was made, from its own name.
 * The folder's mtime cannot be used: ditto keeps the bundle's build date.
 */
export function stagedStamp(name: string): number | undefined {
	const m = /\.new-update-\d+-(\d{10,})$/.exec(name);
	return m ? Number(m[1]) : undefined;
}

/** Quotes a path for a POSIX shell script. */
function sh(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The lines that wait until no process runs from `target`. There is no time limit: the person may
 * keep the app open for days, and a script that gave up would leave "Restart" with nothing to
 * install. Waiting costs nothing. Electron's crash reporter outlives the app, so it does not count.
 */
function waitForQuit(target: string): string[] {
	return [
		'echo "update: waiting for OpenCursor to quit"',
		`while ps ax -o command= | grep -F ${sh(target + '/')} | grep -v -e crashpad_handler -e 'grep -F' >/dev/null 2>&1; do`,
		'	sleep 0.5',
		'done',
	];
}

/** Reopens the app after an update, only when the user chose to restart (the flag file exists). */
function relaunchLine(platform: 'darwin' | 'linux', target: string, flag: string): string {
	// right after a quit, macOS may still count the old instance as running and `open` would only focus it
	const open = platform === 'darwin' ? `{ sleep 1; open -n ${sh(target)}; }` : `nohup ${sh(target + '/bin/open-cursor')} >/dev/null 2>&1 &`;
	return `[ -f ${sh(flag)} ] && ${open}`;
}

/**
 * macOS and Linux (tar): waits until no process runs from the install, swaps the staged copy in,
 * keeps the old one until the new one is in place, and reopens the app if the flag file exists.
 */
export function swapScript(o: { readonly platform: 'darwin' | 'linux'; readonly staged: string; readonly target: string; readonly relaunchFlag: string; readonly log: string; readonly download?: string; readonly work?: string }): string {
	const t = sh(o.target);
	const old = sh(o.target + '.old-update');
	// the reopen line runs on every path, so "Restart now" never leaves the person without the app
	return [
		'#!/bin/sh',
		`exec >>${sh(o.log)} 2>&1`,
		...waitForQuit(o.target),
		`rm -rf ${old}`,
		'ok=0',
		`if mv ${t} ${old}; then`,
		`	if mv ${sh(o.staged)} ${t}; then ok=1; rm -rf ${old}; ${o.download ? `rm -f ${sh(o.download)}; ` : ''}echo "update: done"; else mv ${old} ${t}; rm -rf ${sh(o.staged)}; echo "update: failed, old copy restored"; fi`,
		'else',
		'	echo "update: could not move the old copy"',
		'fi',
		relaunchLine(o.platform, o.target, o.relaunchFlag),
		// the folder holds the script, flag, log and download; the log is only worth keeping after a failure
		...(o.work ? [`[ "$ok" = 1 ] && rm -rf ${sh(o.work)}`] : []),
		'[ "$ok" = 1 ]',
		'',
	].join('\n');
}

/** Linux packages are installed while the app runs; this only reopens it once it has quit. */
export function relaunchScript(o: { readonly target: string; readonly relaunchFlag: string; readonly log: string; readonly download?: string; readonly work?: string }): string {
	return [
		'#!/bin/sh',
		`exec >>${sh(o.log)} 2>&1`,
		...waitForQuit(o.target),
		relaunchLine('linux', o.target, o.relaunchFlag),
		// the package is installed already, so its file and the work folder are no longer needed
		...(o.download ? [`rm -f ${sh(o.download)}`] : []),
		...(o.work ? [`rm -rf ${sh(o.work)}`] : []),
		'',
	].join('\n');
}

/** Quotes a path for a cmd.exe script. */
function cmd(s: string): string {
	// a lone % would expand as a variable inside a batch file; %% is a literal one
	return `"${s.replace(/"/g, '').replace(/%/g, '%%')}"`;
}

/** Windows: waits for OpenCursor.exe to exit, runs the setup silently, reopens it if the flag file exists. */
export function windowsScript(o: { readonly setup: string; readonly exe: string; readonly relaunchFlag: string; readonly log: string; readonly download?: string }): string {
	const name = o.exe.split('\\').pop() ?? 'OpenCursor.exe';
	return [
		'@echo off',
		// cmd reads the script in the OEM code page; UTF-8 keeps names with å, ä, ö intact
		'chcp 65001 >nul',
		':wait',
		`tasklist /FI "IMAGENAME eq ${name}" 2>nul | find /I "${name}" >nul`,
		'if errorlevel 1 goto install',
		// timeout fails at once when stdin is NUL (the script runs detached); ping waits a second anywhere
		'ping -n 2 127.0.0.1 >nul',
		'goto wait',
		':install',
		`${cmd(o.setup)} /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /MERGETASKS=!runcode /LOG=${cmd(o.log)}`,
		'set rc=%errorlevel%',
		`if %rc% equ 0 del /f /q ${cmd(o.download ?? o.setup)}`,
		// reopen either way: after a failed setup the old copy is still there
		`if exist ${cmd(o.relaunchFlag)} start "" ${cmd(o.exe)}`,
		'exit /b %rc%',
		'',
	].join('\r\n');
}

/**
 * How a cmd script is started on Windows without a single window showing. Started detached, cmd has
 * no console, so every program it runs (tasklist, find, ping) would open a console window of its own,
 * about once a second while it waits. PowerShell starts it instead with a hidden console that those
 * programs share, and stays until the script ends so its exit code is still the script's.
 * Not used yet: it has to pass hidden-launch-test on a real Windows desktop first.
 */
export function hiddenCmdLauncher(script: string): { readonly file: string; readonly args: readonly string[] } {
	const q = (v: string): string => `'${v.replace(/'/g, "''")}'`;
	const ps = `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList ${q(`/d /c "${script.replace(/"/g, '')}"`)} -WindowStyle Hidden -PassThru; $p.WaitForExit(); exit $p.ExitCode`;
	// UTF-16LE base64 survives any characters in the path (spaces, quotes, å ä ö) without a second layer of quoting
	return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')] };
}

/**
 * Windows portable: waits for OpenCursor.exe to exit, then copies the unzipped new version over the
 * old one. Only the app's own `resources` folder is mirrored (old files in it removed); everything else
 * is overwritten in place and nothing is ever deleted outside `resources`, because a portable copy
 * may sit in a folder that also holds the person's own files. The `data` folder is never touched.
 */
export function portableScript(o: { readonly staged: string; readonly root: string; readonly exe: string; readonly relaunchFlag: string; readonly log: string; readonly download?: string }): string {
	const name = o.exe.split('\\').pop() ?? 'OpenCursor.exe';
	const q = (s: string): string => cmd(s);
	const r = (s: string): string => s.replace(/\\+$/, '');
	return [
		'@echo off',
		// cmd reads the script in the OEM code page; UTF-8 keeps names with å, ä, ö intact
		'chcp 65001 >nul',
		':wait',
		`tasklist /FI "IMAGENAME eq ${name}" 2>nul | find /I "${name}" >nul`,
		'if errorlevel 1 goto swap',
		// timeout fails at once when stdin is NUL (the script runs detached); ping waits a second anywhere
		'ping -n 2 127.0.0.1 >nul',
		'goto wait',
		':swap',
		`if not exist ${q(r(o.staged) + '\\' + name)} goto fail`,
		`if not exist ${q(r(o.staged) + '\\resources\\app')} goto fail`,
		// top level files first: if this copy fails, nothing has changed yet, and the old resources still match the old exe
		`robocopy ${q(r(o.staged))} ${q(r(o.root))} /E /IS /IT /XD ${q(r(o.staged) + '\\resources')} ${q(r(o.root) + '\\data')} /R:5 /W:1 /NP /NFL /NDL /LOG+:${q(o.log)}`,
		'if errorlevel 8 goto fail',
		`robocopy ${q(r(o.staged) + '\\resources')} ${q(r(o.root) + '\\resources')} /MIR /R:5 /W:1 /NP /NFL /NDL /LOG+:${q(o.log)}`,
		'if errorlevel 8 goto fail',
		`rmdir /s /q ${q(r(o.staged))}`,
		...(o.download ? [`del /f /q ${q(o.download)}`] : []),
		`echo update: done>>${q(o.log)}`,
		`if exist ${q(o.relaunchFlag)} start "" ${q(o.exe)}`,
		'exit /b 0',
		':fail',
		`echo update: failed>>${q(o.log)}`,
		`rmdir /s /q ${q(r(o.staged))}`,
		`if exist ${q(o.relaunchFlag)} start "" ${q(o.exe)}`,
		'exit /b 1',
		'',
	].join('\r\n');
}

/** Linux packages: the command run through pkexec, which shows the system password prompt. */
export function linuxPackageCommand(kind: 'linux-deb' | 'linux-rpm', file: string): string {
	const f = sh(file);
	return kind === 'linux-deb'
		? `if command -v apt-get >/dev/null 2>&1; then apt-get install -y ${f}; else dpkg -i ${f}; fi`
		: `if command -v dnf >/dev/null 2>&1; then dnf install -y ${f}; elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install --allow-unsigned-rpm ${f}; else rpm -U ${f}; fi`;
}
