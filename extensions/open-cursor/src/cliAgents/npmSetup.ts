/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Installs an npm based agent CLI (Codex, Gemini CLI) on a computer without Node.js: a private
 *  copy of the current Node.js LTS from nodejs.org, checked against its published checksums, goes
 *  into ~/.open-cursor/node, and the CLI into ~/.open-cursor/cli. No admin rights, nothing outside
 *  those two folders. No vscode import.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runQuick, tail } from './util';

const DIST = 'https://nodejs.org/dist';

/** Where the private Node.js and the CLIs installed with it live. */
export function privateDirs(): { node: string; nodeBin: string; cli: string; cliBin: string } {
	const root = path.join(os.homedir(), '.open-cursor');
	const node = path.join(root, 'node');
	const cli = path.join(root, 'cli');
	const win = process.platform === 'win32';
	return { node, nodeBin: win ? node : path.join(node, 'bin'), cli, cliBin: win ? cli : path.join(cli, 'bin') };
}

/** `node-v24.11.0-darwin-arm64.tar.gz`, or the zip on Windows; undefined on a platform nodejs.org does not build for. */
export function nodeArchiveName(version: string, platform: NodeJS.Platform, arch: string): string | undefined {
	const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'win' : undefined;
	const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : undefined;
	if (!os || !cpu) { return undefined; }
	return `node-${version}-${os}-${cpu}.${os === 'win' ? 'zip' : 'tar.gz'}`;
}

/** The newest LTS version in nodejs.org's index.json. */
export function latestLts(index: unknown): string | undefined {
	if (!Array.isArray(index)) { return undefined; }
	const lts = index.find((r: { version?: unknown; lts?: unknown }) => typeof r.version === 'string' && r.lts);
	return lts ? String(lts.version) : undefined;
}

/** The sha256 for `file` in a SHASUMS256.txt. */
export function shaFor(shasums: string, file: string): string | undefined {
	for (const line of shasums.split('\n')) {
		const [hash, name] = line.trim().split(/\s+/);
		if (name === file && /^[a-f0-9]{64}$/.test(hash)) { return hash; }
	}
	return undefined;
}

async function get(url: string, timeoutMs = 120_000): Promise<Response> {
	const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!r.ok) { throw new Error(`${url} answered ${r.status}`); }
	return r;
}

/** The private Node.js, downloaded the first time. Resolves to its npm. */
async function ensureNode(report: (message: string) => void): Promise<string> {
	const dirs = privateDirs();
	const win = process.platform === 'win32';
	const npm = path.join(dirs.nodeBin, win ? 'npm.cmd' : 'npm');
	if (fs.existsSync(npm)) { return npm; }
	report('Finding the current Node.js');
	const version = latestLts(await (await get(`${DIST}/index.json`, 30_000)).json());
	if (!version) { throw new Error('could not read the Node.js versions from nodejs.org'); }
	const file = nodeArchiveName(version, process.platform, process.arch);
	if (!file) { throw new Error(`Node.js has no build for ${process.platform} ${process.arch}`); }
	const want = shaFor(await (await get(`${DIST}/${version}/SHASUMS256.txt`, 30_000)).text(), file);
	if (!want) { throw new Error(`nodejs.org lists no checksum for ${file}`); }
	report(`Downloading Node.js ${version}`);
	const data = Buffer.from(await (await get(`${DIST}/${version}/${file}`, 300_000)).arrayBuffer());
	if (crypto.createHash('sha256').update(data).digest('hex') !== want) { throw new Error('the Node.js download does not match the checksum nodejs.org published'); }
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-node-'));
	try {
		const archive = path.join(tmp, file);
		fs.writeFileSync(archive, data);
		report('Unpacking Node.js');
		// Windows: the tar that ships with the system reads zips; a Git for Windows tar earlier on PATH does not
		const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
		const x = await runQuick(tar, ['-xf', archive, '-C', tmp], { timeoutMs: 180_000 });
		if (!x || x.code !== 0) { throw new Error(`could not unpack Node.js${x ? `: ${tail(x.stderr, 200)}` : ''}`); }
		const unpacked = path.join(tmp, file.replace(/\.(tar\.gz|zip)$/, ''));
		// copy beside the final folder and rename into place, so an interrupted copy never leaves a half node that ensureNode accepts
		const parent = path.dirname(dirs.node);
		fs.mkdirSync(parent, { recursive: true });
		const next = `${dirs.node}.new-${process.pid}-${Date.now()}`;
		try {
			fs.cpSync(unpacked, next, { recursive: true, verbatimSymlinks: true });
			if (!fs.existsSync(path.join(next, win ? 'npm.cmd' : path.join('bin', 'npm')))) { throw new Error('Node.js unpacked without npm'); }
			fs.rmSync(dirs.node, { recursive: true, force: true });
			fs.renameSync(next, dirs.node);
		} catch (e) {
			fs.rmSync(next, { recursive: true, force: true });
			throw e;
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	if (!fs.existsSync(npm)) { throw new Error('Node.js unpacked without npm'); }
	return npm;
}

export interface NpmInstallResult {
	readonly ok: boolean;
	readonly message: string;
	/** The installed command, when it worked. */
	readonly binary?: string;
}

/** Installs `pkg` with the private Node.js into ~/.open-cursor/cli. `bin` is the command it provides. */
export async function installWithPrivateNode(pkg: string, bin: string, env: NodeJS.ProcessEnv, report: (message: string) => void = () => undefined): Promise<NpmInstallResult> {
	try {
		const npm = await ensureNode(report);
		const dirs = privateDirs();
		report(`Installing ${pkg}`);
		const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
		const childEnv = { ...env, [pathKey]: [dirs.nodeBin, env[pathKey] ?? ''].join(path.delimiter), npm_config_prefix: dirs.cli, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
		const r = await runQuick(npm, ['install', '-g', pkg], { timeoutMs: 600_000, env: childEnv });
		if (!r || r.code !== 0) { return { ok: false, message: `npm could not install ${pkg}${r ? `: ${tail(r.stderr || r.stdout, 300)}` : ''}` }; }
		const binary = path.join(dirs.cliBin, process.platform === 'win32' ? `${bin}.cmd` : bin);
		return fs.existsSync(binary) ? { ok: true, message: `Installed ${pkg}.`, binary } : { ok: false, message: `${pkg} installed, but ${bin} was not found in ${dirs.cliBin}.` };
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : String(e) };
	}
}
