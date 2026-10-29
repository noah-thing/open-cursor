/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as os from 'os';
import * as nodePath from 'path';
import { DEFAULT_ALLOWLIST, DEFAULT_DENYLIST, type AutoRun } from './approval';
import { toDisplayPath } from '../context/paths';
import type { ContextItem, ChatMode, Effort, UiSettings } from '../shared/protocol';
import type { PromptEnv, PromptRule } from './prompts';

export function cfg(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('openCursor');
}

export function readAutoRun(): AutoRun {
	const v = cfg().get<string>('agent.autoRun', 'allowlist');
	return v === 'ask' || v === 'auto' || v === 'always' ? v : 'allowlist';
}

/** The chat's permission menu writes the same user setting as Settings > General. */
export async function setAutoRun(v: AutoRun): Promise<void> {
	await cfg().update('agent.autoRun', v === 'allowlist' ? undefined : v, vscode.ConfigurationTarget.Global);
}

/** Effort from the chat box. Someone who switched thinking off with the old setting starts at Off. */
export function readEffort(): Effort {
	const v = cfg().get<string>('agent.effort', 'auto');
	if (v === 'off' || v === 'low' || v === 'medium' || v === 'high' || v === 'max') { return v; }
	return cfg().get<boolean>('agent.thinking', true) === false ? 'off' : 'auto';
}

export async function setEffort(v: Effort): Promise<void> {
	await cfg().update('agent.effort', v === 'auto' ? undefined : v, vscode.ConfigurationTarget.Global);
}

export function readLists(): { allowlist: string[]; denylist: string[] } {
	const c = cfg();
	const allow = c.get<string[]>('agent.commandAllowlist');
	const deny = c.get<string[]>('agent.commandDenylist');
	return { allowlist: Array.isArray(allow) ? allow : DEFAULT_ALLOWLIST, denylist: Array.isArray(deny) ? deny : DEFAULT_DENYLIST };
}

export function readMaxIterations(): number {
	const n = cfg().get<number>('agent.maxIterations', 50);
	return typeof n === 'number' && n >= 1 ? Math.min(500, Math.floor(n)) : 50;
}

export function readUiSettings(): UiSettings {
	const c = cfg();
	return {
		autoRun: readAutoRun(),
		effort: readEffort(),
		showThinking: c.get<boolean>('chat.showThinking', true),
		fontSize: c.get<number>('chat.fontSize', 13),
		submitWithModEnter: c.get<boolean>('chat.submitWithModEnter', false),
	};
}

export function readDefaultMode(): ChatMode {
	const v = cfg().get<string>('chat.defaultMode', 'agent');
	return v === 'ask' || v === 'plan' || v === 'debug' ? v : 'agent';
}

export function editorSnapshot(): Pick<PromptEnv, 'activeFile' | 'openFiles'> {
	const active = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
	const open = new Set<string>();
	for (const g of vscode.window.tabGroups.all) {
		for (const t of g.tabs) {
			const u = (t.input as { uri?: vscode.Uri } | undefined)?.uri;
			if (u && (u.scheme === 'file' || u.scheme === 'vscode-remote')) { open.add(toDisplayPath(u)); }
		}
	}
	const activeFile = active && active.document.uri.scheme === 'file' ? { path: toDisplayPath(active.document.uri), line: active.selection.active.line + 1 } : undefined;
	return { activeFile, openFiles: [...open] };
}

export function buildEnv(rules: PromptRule[], agentRules: { name: string; description: string }[]): PromptEnv {
	const snap = editorSnapshot();
	const shell = process.env.SHELL ? nodePath.basename(process.env.SHELL) : vscode.env.shell ? nodePath.basename(vscode.env.shell) : undefined;
	return {
		os: `${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'} ${os.release()} (${process.arch})`,
		shell,
		workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.scheme === 'file' ? f.uri.fsPath : f.uri.toString()),
		openFiles: snap.openFiles,
		activeFile: snap.activeFile,
		date: new Date().toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
		rules,
		agentRules,
	};
}

/** Paths used to select glob rules and nested AGENTS.md. */
export function referencedFiles(items: readonly ContextItem[]): string[] {
	const out = new Set<string>();
	for (const i of items) {
		if (i.uri && (i.kind === 'file' || i.kind === 'code' || i.kind === 'selection' || i.kind === 'lints')) {
			try { out.add(toDisplayPath(vscode.Uri.parse(i.uri))); } catch { /* bad uri */ }
		}
	}
	const snap = editorSnapshot();
	if (snap.activeFile) { out.add(snap.activeFile.path); }
	return [...out];
}

export function selectionItem(editor: vscode.TextEditor): ContextItem | undefined {
	const sel = editor.selection;
	if (sel.isEmpty) { return undefined; }
	const doc = editor.document;
	const startLine = sel.start.line + 1;
	const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
	const text = doc.getText(sel);
	const name = nodePath.posix.basename(toDisplayPath(doc.uri));
	return {
		id: `sel:${doc.uri.toString()}:${startLine}-${endLine}`,
		kind: 'selection',
		label: startLine === endLine ? `${name} (${startLine})` : `${name} (${startLine}-${endLine})`,
		detail: toDisplayPath(doc.uri),
		uri: doc.uri.toString(),
		range: { startLine, endLine },
		content: text.length > 30000 ? text.slice(0, 30000) : text,
		languageId: doc.languageId,
	};
}

export function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | undefined {
	const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl);
	return m ? { mediaType: m[1], data: m[2] } : undefined;
}
