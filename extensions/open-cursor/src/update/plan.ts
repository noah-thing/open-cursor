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
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
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

export interface InstallFacts {
	readonly platform: NodeJS.Platform;
	/** `vscode.env.appRoot`: `<bundle>/Contents/Resources/app` on macOS, `<dir>/resources/app` elsewhere. */
	readonly appRoot: string;
	/** Set by the app when it runs from a portable folder. */
	readonly portable: boolean;
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
		return f.portable ? 'win-portable' : 'win-setup';
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

const ASSET_SUFFIX: Record<Exclude<InstallKind, 'unknown' | 'win-portable'>, string> = {
	'mac-app': 'macos-{arch}.dmg',
	'win-setup': 'windows-{arch}-setup.exe',
	'linux-deb': 'linux-{arch}.deb',
	'linux-rpm': 'linux-{arch}.rpm',
	'linux-tar': 'linux-{arch}.tar.gz',
};

/** The release file for this install and processor (`arm64` or `x64`). */
export function pickAsset(release: Release, kind: InstallKind, arch: string): ReleaseAsset | undefined {
	if (kind === 'unknown' || kind === 'win-portable') { return undefined; }
	const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : undefined;
	if (!a) { return undefined; }
	const suffix = '-' + ASSET_SUFFIX[kind].replace('{arch}', a);
	return release.assets.find(x => x.name.endsWith(suffix));
}

/** Quotes a path for a POSIX shell script. */
function sh(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The lines that wait, up to an hour, until no process runs from `target`. Electron's crash
 * reporter outlives the app, so it does not count.
 */
function waitForQuit(target: string): string[] {
	return [
		'echo "update: waiting for OpenCursor to quit"',
		'i=0',
		`while ps ax -o command= | grep -F ${sh(target + '/')} | grep -v -e crashpad_handler -e 'grep -F' >/dev/null 2>&1; do`,
		'	i=$((i + 1))',
		'	[ $i -gt 7200 ] && { echo "update: gave up waiting"; exit 1; }',
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
export function swapScript(o: { readonly platform: 'darwin' | 'linux'; readonly staged: string; readonly target: string; readonly relaunchFlag: string; readonly log: string }): string {
	const t = sh(o.target);
	const old = sh(o.target + '.old-update');
	return [
		'#!/bin/sh',
		`exec >>${sh(o.log)} 2>&1`,
		...waitForQuit(o.target),
		`rm -rf ${old}`,
		`mv ${t} ${old} || { echo "update: could not move the old copy"; exit 1; }`,
		`if mv ${sh(o.staged)} ${t}; then rm -rf ${old}; echo "update: done"; else mv ${old} ${t}; echo "update: failed, old copy restored"; exit 1; fi`,
		relaunchLine(o.platform, o.target, o.relaunchFlag),
		'',
	].join('\n');
}

/** Linux packages are installed while the app runs; this only reopens it once it has quit. */
export function relaunchScript(o: { readonly target: string; readonly relaunchFlag: string; readonly log: string }): string {
	return ['#!/bin/sh', `exec >>${sh(o.log)} 2>&1`, ...waitForQuit(o.target), relaunchLine('linux', o.target, o.relaunchFlag), ''].join('\n');
}

/** Quotes a path for a cmd.exe script. */
function cmd(s: string): string {
	return `"${s.replace(/"/g, '')}"`;
}

/** Windows: waits for OpenCursor.exe to exit, runs the setup silently, reopens it if the flag file exists. */
export function windowsScript(o: { readonly setup: string; readonly exe: string; readonly relaunchFlag: string; readonly log: string }): string {
	const name = o.exe.split('\\').pop() ?? 'OpenCursor.exe';
	return [
		'@echo off',
		'set /a n=0',
		':wait',
		`tasklist /FI "IMAGENAME eq ${name}" 2>nul | find /I "${name}" >nul`,
		'if errorlevel 1 goto install',
		'set /a n+=1',
		'if %n% gtr 3600 exit /b 1',
		'timeout /t 1 /nobreak >nul',
		'goto wait',
		':install',
		`${cmd(o.setup)} /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /MERGETASKS=!runcode /LOG=${cmd(o.log)}`,
		`if exist ${cmd(o.relaunchFlag)} start "" ${cmd(o.exe)}`,
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
