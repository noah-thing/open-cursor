/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Update notice and one click install. Asks GitHub for the latest release at startup and every
 *  few hours; when it is newer, offers it. Update downloads the file for this install, checks it
 *  against GitHub's checksum, and hands it to a small script that installs it once the app quits.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	detectInstall, installRoot, isNewer, linuxPackageCommand, parseRelease, pickAsset, relaunchScript, swapScript, windowsScript,
	type InstallKind, type Release, type ReleaseAsset,
} from './plan';

const FEED = 'https://api.github.com/repos/noah-thing/open-cursor/releases/latest';
const FIRST_CHECK_MS = 20_000;
const EVERY_MS = 6 * 60 * 60 * 1000;
const SNOOZE_MS = 24 * 60 * 60 * 1000;
const SNOOZE_KEY = 'openCursor.update.snoozed';

interface Ready {
	readonly version: string;
	/** Creating this file makes the install script reopen the app. */
	readonly relaunchFlag: string;
	/** Linux packages are already installed; the app only needs a restart. */
	readonly installed: boolean;
}

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
		if (!manual && cfg().get<string>('mode', 'notify') === 'off') { return; }
		let release: Release | undefined;
		try {
			release = await this.latest();
		} catch (e) {
			if (manual) { void vscode.window.showWarningMessage(`Could not check for updates: ${e instanceof Error ? e.message : String(e)}`); }
			return;
		}
		// a release whose file for this system is still uploading is not offered yet
		const kind = this.kind();
		const waiting = !!release && (kind !== 'unknown' && kind !== 'win-portable') && !pickAsset(release, kind, process.arch);
		if (!release || !isNewer(release.version, this.current) || waiting) {
			if (manual) { void vscode.window.showInformationMessage(`OpenCursor ${this.current} is the latest version.`); }
			return;
		}
		const snoozed = this.ctx.globalState.get<{ version: string; until: number }>(SNOOZE_KEY);
		if (!manual && snoozed && snoozed.version === release.version && Date.now() < snoozed.until) { return; }
		const pick = await vscode.window.showInformationMessage(`OpenCursor ${release.version} is available. You have ${this.current}.`, 'Update', 'What\'s new', 'Later');
		if (pick === 'Update') {
			await this.install(release);
		} else if (pick === 'What\'s new') {
			void vscode.env.openExternal(vscode.Uri.parse(release.pageUrl || 'https://github.com/noah-thing/open-cursor/releases'));
		} else {
			await this.ctx.globalState.update(SNOOZE_KEY, { version: release.version, until: Date.now() + SNOOZE_MS });
		}
	}

	private kind(): InstallKind {
		const appRoot = vscode.env.appRoot;
		const root = installRoot(process.platform, appRoot);
		let linuxPackage: 'deb' | 'rpm' | undefined;
		if (process.platform === 'linux' && root.startsWith('/usr/')) {
			linuxPackage = fs.existsSync('/usr/bin/dpkg') && cp.spawnSync('dpkg', ['-S', root], { stdio: 'ignore' }).status === 0 ? 'deb'
				: fs.existsSync('/usr/bin/rpm') && cp.spawnSync('rpm', ['-qf', root], { stdio: 'ignore' }).status === 0 ? 'rpm' : undefined;
		}
		return detectInstall({ platform: process.platform, appRoot, portable: !!process.env.VSCODE_PORTABLE, linuxPackage, writable: writable(path.dirname(root)) && writable(root) });
	}

	private async install(release: Release): Promise<void> {
		const kind = this.kind();
		const asset = pickAsset(release, kind, process.arch);
		if (!asset) {
			const go = await vscode.window.showInformationMessage(
				kind === 'win-portable' ? 'Portable copies update by downloading the new zip.' : 'This copy of OpenCursor cannot update itself. Download the new version from the release page.',
				'Open release page');
			if (go) { void vscode.env.openExternal(vscode.Uri.parse(release.pageUrl || 'https://github.com/noah-thing/open-cursor/releases')); }
			return;
		}
		this.busy = true;
		try {
			const ready = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Updating OpenCursor to ${release.version}`, cancellable: true }, (progress, token) => this.prepare(release, asset, kind, progress, token));
			if (ready) {
				this.ready = ready;
				this.status.text = '$(sync) Restart to update';
				this.status.tooltip = `OpenCursor ${ready.version} is ready. Restart to finish updating.`;
				this.status.show();
				void this.offerRestart(ready);
			}
		} catch (e) {
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
		if (!this.ready) { return; }
		fs.writeFileSync(this.ready.relaunchFlag, '');
		await vscode.commands.executeCommand('workbench.action.quit');
	}

	private async download(asset: ReleaseAsset, file: string, progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken): Promise<void> {
		const abort = new AbortController();
		const sub = token.onCancellationRequested(() => abort.abort());
		try {
			const r = await fetch(asset.url, { headers: { 'User-Agent': 'OpenCursor' }, signal: abort.signal });
			if (!r.ok || !r.body) { throw new Error(`download answered ${r.status}`); }
			const total = Number(r.headers.get('content-length')) || asset.size;
			const hash = crypto.createHash('sha256');
			const out = fs.createWriteStream(file);
			let got = 0;
			let shown = 0;
			const reader = r.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) { break; }
				hash.update(value);
				got += value.length;
				if (!out.write(value)) { await new Promise<void>(res => out.once('drain', () => res())); }
				if (total) {
					const pct = Math.floor((got / total) * 80);
					if (pct > shown) { progress.report({ increment: pct - shown, message: `${Math.round(got / 1048576)} of ${Math.round(total / 1048576)} MB` }); shown = pct; }
				}
			}
			await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
			const want = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : undefined;
			if (want && hash.digest('hex') !== want) { throw new Error('the download does not match the checksum GitHub published'); }
		} finally {
			sub.dispose();
		}
	}

	private async prepare(release: Release, asset: ReleaseAsset, kind: InstallKind, progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken): Promise<Ready | undefined> {
		const work = fs.mkdtempSync(path.join(os.tmpdir(), 'opencursor-update-'));
		const file = path.join(work, asset.name);
		const log = path.join(work, 'update.log');
		const relaunchFlag = path.join(work, 'relaunch');
		await this.download(asset, file, progress, token);
		if (token.isCancellationRequested) { return undefined; }
		progress.report({ message: 'Preparing the new version' });
		const root = installRoot(process.platform, vscode.env.appRoot);
		const script = (name: string, body: string): string => {
			const p = path.join(work, name);
			fs.writeFileSync(p, body, { mode: 0o755 });
			return p;
		};
		const detach = (cmd: string, args: string[]): void => {
			cp.spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
		};

		if (kind === 'mac-app' || kind === 'linux-tar') {
			// staged beside the install, so the final swap is a rename on the same disk
			const staged = root + '.new-update';
			fs.rmSync(staged, { recursive: true, force: true });
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
			} else {
				fs.mkdirSync(staged);
				const x = await run('tar', ['-xzf', file, '-C', staged, '--strip-components=1']);
				if (x.code !== 0) { throw new Error(`could not unpack the new version (${x.out})`); }
			}
			detach('/bin/sh', [script('install.sh', swapScript({ platform: process.platform === 'darwin' ? 'darwin' : 'linux', staged, target: root, relaunchFlag, log }))]);
			return { version: release.version, relaunchFlag, installed: false };
		}

		if (kind === 'win-setup') {
			// newer Windows installs keep the versioned files one folder below the launcher
			const exe = [root, path.dirname(root)].map(d => path.join(d, 'OpenCursor.exe')).find(p => fs.existsSync(p)) ?? path.join(root, 'OpenCursor.exe');
			detach('cmd.exe', ['/d', '/c', script('install.cmd', windowsScript({ setup: file, exe, relaunchFlag, log }))]);
			return { version: release.version, relaunchFlag, installed: false };
		}

		if (kind === 'linux-deb' || kind === 'linux-rpm') {
			const command = linuxPackageCommand(kind, file);
			if (!fs.existsSync('/usr/bin/pkexec')) {
				const manual = `sudo sh -c '${command.replace(/'/g, `'\\''`)}'`;
				await vscode.env.clipboard.writeText(manual);
				void vscode.window.showInformationMessage('Run the copied command in a terminal to finish the update, then restart OpenCursor.');
				return undefined;
			}
			progress.report({ message: 'Waiting for your password' });
			const r = await run('pkexec', ['sh', '-c', command]);
			if (r.code !== 0) { throw new Error(r.code === 126 || r.code === 127 ? 'the password prompt was cancelled' : `the package manager failed (${r.out.slice(-300)})`); }
			detach('/bin/sh', [script('restart.sh', relaunchScript({ target: root, relaunchFlag, log }))]);
			return { version: release.version, relaunchFlag, installed: true };
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
