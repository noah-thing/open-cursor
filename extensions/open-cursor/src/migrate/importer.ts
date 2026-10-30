/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  One-time import from Cursor or VS Code: settings, keybindings, snippets and extensions.
 *  Nothing is read until the user picks a source.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { summarizeImport } from './summary';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

interface Source {
	readonly label: string;
	/** The editor's `User` folder (settings.json, keybindings.json, snippets/). */
	readonly userDir: string;
	readonly extensionsDir: string;
}

const PROMPTED_KEY = 'openCursor.import.prompted';
const IGNORED_KEY = 'openCursor.import.ignored';

function appSupport(): string {
	switch (process.platform) {
		case 'darwin': return path.join(os.homedir(), 'Library', 'Application Support');
		case 'win32': return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
		default: return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
	}
}

async function exists(p: string): Promise<boolean> {
	return fs.stat(p).then(() => true, () => false);
}

async function findSources(): Promise<Source[]> {
	const candidates: Source[] = [
		{ label: 'Cursor', userDir: path.join(appSupport(), 'Cursor', 'User'), extensionsDir: path.join(os.homedir(), '.cursor', 'extensions') },
		{ label: 'VS Code', userDir: path.join(appSupport(), 'Code', 'User'), extensionsDir: path.join(os.homedir(), '.vscode', 'extensions') },
		{ label: 'VS Code Insiders', userDir: path.join(appSupport(), 'Code - Insiders', 'User'), extensionsDir: path.join(os.homedir(), '.vscode-insiders', 'extensions') },
		{ label: 'Windsurf', userDir: path.join(appSupport(), 'Windsurf', 'User'), extensionsDir: path.join(os.homedir(), '.windsurf', 'extensions') },
	];
	const found: Source[] = [];
	for (const c of candidates) {
		if (await exists(path.join(c.userDir, 'settings.json')) || await exists(c.extensionsDir)) {
			found.push(c);
		}
	}
	return found;
}

/** Extension ids installed in another editor, from its extensions.json or folder names. */
async function listExtensionIds(dir: string): Promise<string[]> {
	try {
		const manifest = JSON.parse(await fs.readFile(path.join(dir, 'extensions.json'), 'utf8')) as { identifier?: { id?: string } }[];
		const ids = manifest.map(e => e.identifier?.id).filter((id): id is string => !!id);
		if (ids.length) {
			return [...new Set(ids.map(id => id.toLowerCase()))];
		}
	} catch { /* fall back to folder names */ }
	try {
		const names = await fs.readdir(dir);
		return [...new Set(names
			.map(n => /^([a-z0-9-]+\.[a-z0-9-]+)-\d/i.exec(n)?.[1]?.toLowerCase())
			.filter((id): id is string => !!id))];
	} catch {
		return [];
	}
}

/** Settings that belong to the other editor's own product or AI features and would only confuse us. */
function isForeignSetting(key: string): boolean {
	return /^(cursor|aipopup|composer|github\.copilot|chat|windsurf|codeium)\b/i.test(key) || key === 'workbench.colorTheme' || key === 'workbench.activityBar.location';
}

async function copySettings(src: Source, userDir: string): Promise<{ count: number; error?: string }> {
	let incoming: Record<string, unknown>;
	try {
		incoming = parseJsonc(await fs.readFile(path.join(src.userDir, 'settings.json'), 'utf8'));
	} catch {
		return { count: 0 };
	}
	const target = path.join(userDir, 'settings.json');
	let current: Record<string, unknown> = {};
	let existing: string | undefined;
	try { existing = await fs.readFile(target, 'utf8'); } catch { /* new file */ }
	if (existing !== undefined) {
		try {
			current = parseJsonc(existing);
		} catch {
			// treating a broken file as {} would wipe the user's settings on write
			return { count: 0, error: 'Your settings.json could not be read (invalid JSON), so settings were not imported. Fix it and import again.' };
		}
		await fs.copyFile(target, target + '.bak');
	}
	let count = 0;
	for (const [k, v] of Object.entries(incoming)) {
		if (!isForeignSetting(k) && !(k in current)) {
			current[k] = v;
			count++;
		}
	}
	await fs.mkdir(userDir, { recursive: true });
	await fs.writeFile(target, JSON.stringify(current, null, '\t') + '\n');
	return { count };
}

async function copyIfMissing(from: string, to: string): Promise<boolean> {
	if (!await exists(from) || await exists(to)) {
		return false;
	}
	await fs.mkdir(path.dirname(to), { recursive: true });
	await fs.cp(from, to, { recursive: true });
	return true;
}

/** Lenient JSON with comments and trailing commas, as VS Code writes it. */
function parseJsonc(text: string): Record<string, unknown> {
	const noComments = text.replace(/^\uFEFF/, '').replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '');
	const noTrailing = noComments.replace(/,(\s*[}\]])/g, '$1');
	const parsed = JSON.parse(noTrailing.replace(/^\uFEFF/, '') || '{}');
	return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

async function openVsxReachable(): Promise<boolean> {
	try {
		await fetch('https://open-vsx.org/api/-/search?size=1', { signal: AbortSignal.timeout(6000) });
		return true;
	} catch {
		return false;
	}
}

async function runImport(ctx: vscode.ExtensionContext, src: Source): Promise<void> {
	// globalStorageUri = <user data>/User/globalStorage/<extension id>
	const userDir = path.dirname(path.dirname(ctx.globalStorageUri.fsPath));
	const summary = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Importing from ${src.label}`, cancellable: true }, async (progress, token) => {
		progress.report({ message: 'Settings' });
		const settingsResult = await copySettings(src, userDir);
		const settings = settingsResult.count;
		const keybindings = await copyIfMissing(path.join(src.userDir, 'keybindings.json'), path.join(userDir, 'keybindings.json'));
		const snippets = await copyIfMissing(path.join(src.userDir, 'snippets'), path.join(userDir, 'snippets'));

		const installed = new Set(vscode.extensions.all.map(e => e.id.toLowerCase()));
		const ids = (await listExtensionIds(src.extensionsDir)).filter(id => !installed.has(id) && !/^(anysphere|github\.copilot|codeium)/.test(id));
		const failed: string[] = [];
		let done = 0;
		// Offline, every install fails the same way; say so instead of blaming the extensions.
		// The check ignores http.proxy, so a failed check is only a hint: the first install decides.
		let offline = false;
		let checkFailed = ids.length > 0 && !(await openVsxReachable());
		for (const id of ids) {
			if (token.isCancellationRequested) {
				break;
			}
			progress.report({ message: `Extensions ${done + 1}/${ids.length}: ${id}`, increment: 100 / Math.max(ids.length, 1) });
			try {
				await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
			} catch (e) {
				if (checkFailed && done === 0 && /fetch|network|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|offline|reach/i.test(String((e as Error)?.message ?? e))) {
					offline = true;
					break;
				}
				failed.push(id);
			}
			checkFailed = false;
			done++;
		}

		return summarizeImport({ label: src.label, settings, keybindings, snippets, installed: done - failed.length, failed, offline, warning: settingsResult.error });
	});
	// Asked after the progress closes, so the spinner does not hang around until the user answers.
	const reload = await vscode.window.showInformationMessage(summary, 'Reload Window');
	if (reload) {
		await vscode.commands.executeCommand('workbench.action.reloadWindow');
	}
}

export function registerImporter(ctx: vscode.ExtensionContext): void {
	ctx.subscriptions.push(vscode.commands.registerCommand('openCursor.import', async () => {
		const sources = await findSources();
		if (!sources.length) {
			vscode.window.showInformationMessage('No Cursor or VS Code installation was found to import from.');
			return;
		}
		const pick = sources.length === 1 ? sources[0] : (await vscode.window.showQuickPick(sources.map(s => ({ label: s.label, source: s })), { placeHolder: 'Import settings and extensions from' }))?.source;
		if (pick) {
			await runImport(ctx, pick);
		}
	}));

	// Offer until the user answers. Closing the window without answering asks again next time, up to three times.
	if (!ctx.globalState.get<boolean>(PROMPTED_KEY)) {
		void findSources().then(async sources => {
			if (!sources.length) {
				return;
			}
			const names = sources.map(s => s.label).join(' or ');
			const choice = await vscode.window.showInformationMessage(`Bring your settings, keybindings and extensions over from ${names}?`, 'Import', 'Not now');
			if (choice === undefined) {
				const ignored = ctx.globalState.get<number>(IGNORED_KEY, 0) + 1;
				await ctx.globalState.update(IGNORED_KEY, ignored);
				if (ignored >= 3) { await ctx.globalState.update(PROMPTED_KEY, true); }
				return;
			}
			await ctx.globalState.update(PROMPTED_KEY, true);
			if (choice === 'Import') {
				await vscode.commands.executeCommand('openCursor.import');
			}
		});
	}
}
