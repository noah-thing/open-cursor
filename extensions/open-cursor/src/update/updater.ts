/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Update notice and one click install. Asks GitHub for the latest release at startup and every
 *  few hours; when it is newer, offers it. Update downloads the file for this install, checks it
 *  against GitHub's checksum, and hands it to a small script that installs it once the app quits.
 *  With auto updates on, that download happens in the background and the notice is skipped.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	assetProblem, detectInstall, hiddenCmdLauncher, installRoot, isNewer, linuxPackageCommand, parseRelease, pickAsset, portableScript, relaunchScript, stagedStamp, swapScript, windowsScript,
	type InstallKind, type Release, type ReleaseAsset,
} from './plan';

const FEED = 'https://api.github.com/repos/noah-thing/open-cursor/releases/latest';
const FIRST_CHECK_MS = 20_000;
const EVERY_MS = 6 * 60 * 60 * 1000;
const SNOOZE_MS = 24 * 60 * 60 * 1000;
const SNOOZE_KEY = 'openCursor.update.snoozed';
const ENABLE_AUTO = 'Enable auto updates';
const UPDATE_NOW = 'Update and restart';

interface Ready {
	readonly version: string;
	/** Creating this file makes the install script reopen the app. */
	readonly relaunchFlag: string;
	/** Linux packages are already installed; the app only needs a restart. */
	readonly installed: boolean;
	readonly release: Release;
	/** True while the script that waits for the quit is still running. */
	alive(): boolean;
	/** Starts the same waiting script again; only for installs that need nothing but a relaunch. */
	revive?(): void;
	/** Removes what this preparation left in the temp folder and beside the install. */
	discard(): void;
}

/** What `build` records about the script it started. */
interface BuildState { keep: boolean; staged?: string; running: boolean }

function cfg(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('openCursor.update');
}

function run(file: string, args: string[]): Promise<{ code: number; out: string }> {
	return new Promise(resolve => {
		cp.execFile(file, args, { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
			resolve({ code, out: `${stdout}${stderr}`.trim() });
		});
	});
}

/** Removes staged copies a crashed or abandoned update left beside the install, once they are a day old by their own name. */
function cleanStale(root: string): void {
	const dir = path.dirname(root);
	const prefix = path.basename(root) + '.new-update';
	try {
		for (const n of fs.readdirSync(dir)) {
			if (!n.startsWith(prefix)) { continue; }
			const p = path.join(dir, n);
			// the name carries the time it was made; the mtime is the app's build date (ditto keeps it)
			// and would make another window's fresh staging look old. A name without a stamp is not ours to judge.
			const made = stagedStamp(n);
			if (made === undefined || Date.now() - made < 24 * 60 * 60 * 1000) { continue; }
			try {
				fs.rmSync(p, { recursive: true, force: true });
			} catch { /* in use or gone: leave it */ }
		}
	} catch { /* unreadable folder: nothing to clean */ }
}

function macBinaries(app: string): string[] {
	try { return fs.readdirSync(path.join(app, 'Contents', 'MacOS')); } catch { return []; }
}

function writable(dir: string): boolean {
	try {
		fs.accessSync(dir, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

class Updater implements vscode.Disposable {
	private readonly current: string;
	private timer: NodeJS.Timeout | undefined;
	private busy = false;
	private ready: Ready | undefined;
	private readonly status = vscode.window.createStatusBarItem('openCursor.update', vscode.StatusBarAlignment.Right, 1000);

	constructor(private readonly ctx: vscode.ExtensionContext) {
		this.current = String(ctx.extension.packageJSON.version ?? '0.0.0');
		this.status.name = 'OpenCursor Update';
		this.status.command = 'openCursor.update.restart';
		this.timer = setTimeout(() => void this.check(false), FIRST_CHECK_MS);
	}

	dispose(): void {
		if (this.timer) { clearTimeout(this.timer); }
		this.status.dispose();
	}

	private schedule(): void {
		if (this.timer) { clearTimeout(this.timer); }
		this.timer = setTimeout(() => void this.check(false), EVERY_MS);
	}

	private async latest(): Promise<Release | undefined> {
		const feed = cfg().get<string>('feedUrl') || FEED;
		const r = await fetch(feed, { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'OpenCursor' }, signal: AbortSignal.timeout(15_000) });
		if (r.status === 404) { return undefined; }
		if (!r.ok) { throw new Error(`GitHub answered ${r.status}`); }
		return parseRelease(await r.json());
	}

	/** `manual` comes from the command: it always answers, and ignores Later. */
	async check(manual: boolean): Promise<void> {
		this.schedule();
		if (this.busy || this.ready) {
			if (manual && this.ready) { void this.offerRestart(this.ready); }
			return;
		}
		if (!manual && cfg().get<string>('mode', 'auto') === 'off') { return; }
		let release: Release | undefined;
		try {
			release = await this.latest();
		} catch (e) {
			if (manual) { void vscode.window.showWarningMessage(`Could not check for updates: ${e instanceof Error ? e.message : String(e)}`); }
			return;
		}
		// a release whose file for this system is still uploading is not offered yet
		const kind = this.kind();
		const waiting = !!release && kind !== 'unknown' && !pickAsset(release, kind, process.arch);
		if (!release || !isNewer(release.version, this.current) || waiting) {
			if (manual) { void vscode.window.showInformationMessage(`OpenCursor ${this.current} is the latest version.`); }
			return;
		}
		if (!manual && this.auto() && this.silent(kind, release)) {
			await this.install(release, true);
			return;
		}
		const snoozed = this.ctx.globalState.get<{ version: string; until: number }>(SNOOZE_KEY);
		if (!manual && snoozed && snoozed.version === release.version && Date.now() < snoozed.until) { return; }
		// one click either way: Update and restart installs and reopens; Enable auto updates also does it for every later version
		const actions = this.auto() ? [UPDATE_NOW, 'What\'s new', 'Later'] : [ENABLE_AUTO, UPDATE_NOW, 'What\'s new', 'Later'];
		const pick = await vscode.window.showInformationMessage(`OpenCursor ${release.version} is available. You have ${this.current}.`, ...actions);
		if (pick === ENABLE_AUTO) {
			await cfg().update('mode', 'auto', vscode.ConfigurationTarget.Global);
			await this.install(release);
		} else if (pick === UPDATE_NOW) {
			await this.install(release, false, true);
		} else if (pick === 'What\'s new') {
			void vscode.env.openExternal(vscode.Uri.parse(release.pageUrl || 'https://github.com/noah-thing/open-cursor/releases'));
		} else {
			await this.ctx.globalState.update(SNOOZE_KEY, { version: release.version, until: Date.now() + SNOOZE_MS });
		}
	}

	private auto(): boolean {
		return cfg().get<string>('mode', 'auto') === 'auto';
	}

	/** Installs that need no password or manual step can update in the background. */
	private silent(kind: InstallKind, release: Release): boolean {
		const asset = pickAsset(release, kind, process.arch);
		return (kind === 'mac-app' || kind === 'linux-tar' || kind === 'win-setup' || kind === 'win-portable') && !!asset && !assetProblem(asset);
	}

	private kind(): InstallKind {
		const appRoot = vscode.env.appRoot;
		const root = installRoot(process.platform, appRoot);
		let linuxPackage: 'deb' | 'rpm' | undefined;
		if (process.platform === 'linux' && root.startsWith('/usr/')) {
			linuxPackage = fs.existsSync('/usr/bin/dpkg') && cp.spawnSync('dpkg', ['-S', root], { stdio: 'ignore' }).status === 0 ? 'deb'
				: fs.existsSync('/usr/bin/rpm') && cp.spawnSync('rpm', ['-qf', root], { stdio: 'ignore' }).status === 0 ? 'rpm' : undefined;
		}
		const hasUninstaller = process.platform === 'win32' ? fs.existsSync(path.join(root, 'unins000.exe')) || fs.existsSync(path.join(path.dirname(root), 'unins000.exe')) : undefined;
		return detectInstall({ platform: process.platform, appRoot, portable: !!process.env.VSCODE_PORTABLE, hasUninstaller, linuxPackage, writable: writable(path.dirname(root)) && writable(root) });
	}

	/** `quiet` downloads in the status bar instead of a notification and does not ask to restart:
	 *  the new version installs whenever the app next quits. `restartWhenReady` reopens on the new
	 *  version as soon as it is in place (hot exit keeps unsaved files), so Update is a single click. */
	private async install(release: Release, quiet = false, restartWhenReady = false): Promise<void> {
		const kind = this.kind();
		const asset = pickAsset(release, kind, process.arch);
		if (!asset) {
			const go = await vscode.window.showInformationMessage(
				'This copy of OpenCursor cannot update itself. Download the new version from the release page.',
				'Open release page');
			if (go) { void vscode.env.openExternal(vscode.Uri.parse(release.pageUrl || 'https://github.com/noah-thing/open-cursor/releases')); }
			return;
		}
		const problem = assetProblem(asset);
		if (problem) {
			// a background attempt stays quiet; the notice still offers the release page
			if (quiet) { return; }
			const go = await vscode.window.showErrorMessage(`OpenCursor will not install this update: ${problem}.`, 'Open release page');
			if (go) { void vscode.env.openExternal(vscode.Uri.parse(release.pageUrl || 'https://github.com/noah-thing/open-cursor/releases')); }
			return;
		}
		this.busy = true;
		let cancelled = false;
		try {
			const location = quiet ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification;
			const ready = await vscode.window.withProgress({ location, title: `Updating OpenCursor to ${release.version}`, cancellable: !quiet }, (progress, token) => {
				token.onCancellationRequested(() => { cancelled = true; });
				return this.prepare(release, asset, kind, progress, token);
			});
			if (ready) {
				this.ready = ready;
				this.status.text = '$(sync) Restart to update';
				this.status.tooltip = `OpenCursor ${ready.version} is ready. It installs when you quit, or restart now.`;
				this.status.show();
				if (restartWhenReady) { await this.restart(); } else if (!quiet) { void this.offerRestart(ready); }
			}
		} catch (e) {
			// the person pressed Cancel: that is an answer, not a failure
			if (cancelled || (e instanceof Error && e.name === 'AbortError')) { return; }
			// a background attempt fails quietly and tries again at the next check
			if (quiet) { return; }
			const go = await vscode.window.showErrorMessage(`The update did not finish: ${e instanceof Error ? e.message : String(e)}`, 'Open release page');
			if (go) { void vscode.env.openExternal(vscode.Uri.parse(release.pageUrl || 'https://github.com/noah-thing/open-cursor/releases')); }
		} finally {
			this.busy = false;
		}
	}

	private async offerRestart(ready: Ready): Promise<void> {
		const pick = await vscode.window.showInformationMessage(
			ready.installed ? `OpenCursor ${ready.version} is installed. Restart to start using it.` : `OpenCursor ${ready.version} is ready. It installs when you restart.`,
			'Restart now', 'Later');
		if (pick === 'Restart now') { await this.restart(); }
	}

	async restart(): Promise<void> {
		const ready = this.ready;
		if (!ready) { return; }
		if (!ready.alive()) {
			// the waiting script is gone (killed, or the temp folder was cleaned), so quitting now would
			// install nothing and not reopen the app
			if (ready.revive) {
				try { ready.revive(); } catch { /* checked below */ }
			}
			if (!ready.alive()) {
				ready.discard();
				this.ready = undefined;
				this.status.hide();
				await this.install(ready.release);
				return;
			}
		}
		try {
			fs.writeFileSync(ready.relaunchFlag, '');
		} catch {
			// the work folder is gone: prepare again instead of quitting into nothing
			ready.discard();
			this.ready = undefined;
			this.status.hide();
			await this.install(ready.release);
			return;
		}
		await vscode.commands.executeCommand('workbench.action.quit');
	}

	private async download(asset: ReleaseAsset, file: string, progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken): Promise<void> {
		const abort = new AbortController();
		const sub = token.onCancellationRequested(() => abort.abort());
		let out: fs.WriteStream | undefined;
		try {
			const r = await fetch(asset.url, { headers: { 'User-Agent': 'OpenCursor' }, signal: abort.signal });
			if (!r.ok || !r.body) { throw new Error(`download answered ${r.status}`); }
			const total = Number(r.headers.get('content-length')) || asset.size;
			const hash = crypto.createHash('sha256');
			out = fs.createWriteStream(file);
			// a full disk surfaces as a stream error; without a listener the drain wait would hang forever
			let failure: Error | undefined;
			const broke = new Promise<never>((_, rej) => out!.once('error', e => { failure = e; rej(e); }));
			broke.catch(() => undefined);
			let got = 0;
			let shown = 0;
			const reader = r.body.getReader();
			for (;;) {
				if (failure) { throw failure; }
				const { done, value } = await reader.read();
				if (done) { break; }
				hash.update(value);
				got += value.length;
				if (!out.write(value)) { await Promise.race([new Promise<void>(res => out!.once('drain', () => res())), broke]); }
				if (total) {
					const pct = Math.floor((got / total) * 80);
					if (pct > shown) { progress.report({ increment: pct - shown, message: `${Math.round(got / 1048576)} of ${Math.round(total / 1048576)} MB` }); shown = pct; }
				}
			}
			await Promise.race([new Promise<void>((res, rej) => out!.end((e?: Error | null) => (e ? rej(e) : res()))), broke]);
			const want = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : undefined;
			if (want && hash.digest('hex') !== want) { throw new Error('the download does not match the checksum GitHub published'); }
		} finally {
			sub.dispose();
			out?.destroy();
		}
	}

	private async prepare(release: Release, asset: ReleaseAsset, kind: InstallKind, progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken): Promise<Ready | undefined> {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), 'opencursor-update-'));
		// the scripts run later from the work folder, so it stays only once one is on its way
		const state: BuildState = { keep: false, running: false };
		try {
			return await this.build(work, state, release, asset, kind, progress, token);
		} finally {
			if (!state.keep) {
				fs.rmSync(work, { recursive: true, force: true });
				if (state.staged) { fs.rmSync(state.staged, { recursive: true, force: true }); }
			}
		}
	}

	private async build(work: string, state: BuildState, release: Release, asset: ReleaseAsset, kind: InstallKind, progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken): Promise<Ready | undefined> {
		const file = path.join(work, asset.name);
		const log = path.join(work, 'update.log');
		const relaunchFlag = path.join(work, 'relaunch');
		await this.download(asset, file, progress, token);
		if (token.isCancellationRequested) { return undefined; }
		progress.report({ message: 'Preparing the new version' });
		const root = installRoot(process.platform, vscode.env.appRoot);
		const script = (name: string, body: string): string => {
			const p = path.join(work, name);
			// UTF-8 without a BOM; the cmd scripts switch to that code page themselves
			fs.writeFileSync(p, body, { mode: 0o755, encoding: 'utf8' });
			return p;
		};
		const detach = (cmd: string, args: string[]): void => {
			// a failed spawn must not become an uncaught exception; either way the script is not waiting any more
			const child = cp.spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
			state.running = true;
			const stopped = (): void => { if (state.running && cur === child) { state.running = false; } };
			cur = child;
			child.on('error', stopped).on('exit', stopped).unref();
			state.keep = true;
		};
		// Windows: through hiddenCmdLauncher, so the waiting script opens no windows; plain cmd if PowerShell will not start
		const detachCmd = (file: string): void => {
			const l = hiddenCmdLauncher(file);
			detach(l.file, [...l.args]);
			const ps = cur;
			ps?.once('error', () => { if (cur === ps) { detach('cmd.exe', ['/d', '/c', file]); } });
		};
		let cur: cp.ChildProcess | undefined;
		const made = (extra: Pick<Ready, 'installed'> & { revive?: () => void }): Ready => ({
			version: release.version, relaunchFlag, release, ...extra,
			alive: () => state.running,
			discard: () => {
				fs.rmSync(work, { recursive: true, force: true });
				if (state.staged) { fs.rmSync(state.staged, { recursive: true, force: true }); }
			},
		});
		// one folder per run, so two windows updating at once never share a staging path
		const stagedName = (): string => `${root}.new-update-${process.pid}-${Date.now()}`;

		if (kind === 'mac-app' || kind === 'linux-tar') {
			// staged beside the install, so the final swap is a rename on the same disk
			cleanStale(root);
			const staged = state.staged = stagedName();
			if (kind === 'mac-app') {
				const mount = path.join(work, 'mount');
				fs.mkdirSync(mount);
				const att = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, file]);
				if (att.code !== 0) { throw new Error(`could not open the disk image (${att.out})`); }
				try {
					const app = fs.readdirSync(mount).find(n => n.endsWith('.app'));
					if (!app) { throw new Error('the disk image has no app'); }
					const copy = await run('ditto', [path.join(mount, app), staged]);
					if (copy.code !== 0) { throw new Error(`could not copy the new version (${copy.out})`); }
				} finally {
					await run('hdiutil', ['detach', '-quiet', mount]);
				}
				await run('xattr', ['-dr', 'com.apple.quarantine', staged]);
				if (!macBinaries(staged).length) { throw new Error('the new version is incomplete'); }
			} else {
				fs.mkdirSync(staged);
				const x = await run('tar', ['-xzf', file, '-C', staged, '--strip-components=1']);
				if (x.code !== 0) { throw new Error(`could not unpack the new version (${x.out})`); }
				if (!fs.existsSync(path.join(staged, 'bin', 'open-cursor'))) { throw new Error('the new version is incomplete'); }
			}
			detach('/bin/sh', [script('install.sh', swapScript({ platform: process.platform === 'darwin' ? 'darwin' : 'linux', staged, target: root, relaunchFlag, log, download: file, work }))]);
			return made({ installed: false });
		}

		if (kind === 'win-portable') {
			// unzipped beside the copy (same disk), checked, and copied over it once the app quits
			cleanStale(root);
			const staged = state.staged = stagedName();
			fs.mkdirSync(staged);
			progress.report({ message: 'Unpacking the new version' });
			let x = await run('tar', ['-xf', file, '-C', staged]);
			if (x.code !== 0) {
				x = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${file.replace(/'/g, "''")}' -DestinationPath '${staged.replace(/'/g, "''")}' -Force`]);
			}
			const exe = path.join(root, 'OpenCursor.exe');
			if (x.code !== 0 || !fs.existsSync(path.join(staged, 'OpenCursor.exe')) || !fs.existsSync(path.join(staged, 'resources', 'app'))) {
				fs.rmSync(staged, { recursive: true, force: true });
				throw new Error(`could not unpack the new version${x.out ? ` (${x.out.slice(-200)})` : ''}`);
			}
			detachCmd(script('install.cmd', portableScript({ staged, root, exe, relaunchFlag, log, download: file })));
			return made({ installed: false });
		}

		if (kind === 'win-setup') {
			// newer Windows installs keep the versioned files one folder below the launcher
			const exe = [root, path.dirname(root)].map(d => path.join(d, 'OpenCursor.exe')).find(p => fs.existsSync(p)) ?? path.join(root, 'OpenCursor.exe');
			detachCmd(script('install.cmd', windowsScript({ setup: file, exe, relaunchFlag, log, download: file })));
			return made({ installed: false });
		}

		if (kind === 'linux-deb' || kind === 'linux-rpm') {
			const command = linuxPackageCommand(kind, file);
			if (!fs.existsSync('/usr/bin/pkexec')) {
				const manual = `sudo sh -c '${command.replace(/'/g, `'\\''`)}'`;
				state.keep = true;
				await vscode.env.clipboard.writeText(manual);
				void vscode.window.showInformationMessage('Run the copied command in a terminal to finish the update, then restart OpenCursor.');
				return undefined;
			}
			progress.report({ message: 'Waiting for your password' });
			const r = await run('pkexec', ['sh', '-c', command]);
			if (r.code !== 0) { throw new Error(r.code === 126 || r.code === 127 ? 'the password prompt was cancelled' : `the package manager failed (${r.out.slice(-300)})`); }
			const restart = script('restart.sh', relaunchScript({ target: root, relaunchFlag, log, download: file, work }));
			detach('/bin/sh', [restart]);
			return made({ installed: true, revive: () => detach('/bin/sh', [restart]) });
		}
		return undefined;
	}
}

export function registerUpdater(ctx: vscode.ExtensionContext): void {
	const updater = new Updater(ctx);
	ctx.subscriptions.push(
		updater,
		vscode.commands.registerCommand('openCursor.update.check', () => updater.check(true)),
		vscode.commands.registerCommand('openCursor.update.restart', () => updater.restart()),
	);
}
