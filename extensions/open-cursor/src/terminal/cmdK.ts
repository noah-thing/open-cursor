/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Cmd+K in the terminal: describe a command, get it typed at the prompt (not executed).
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as vscode from 'vscode';
import type { Services } from '../services';
import { collectText, pickInlineModel } from '../inline/oneshot';
import { OutputBuffer, TERMINAL_SYSTEM, buildTerminalPrompt, cleanCommand } from './logic';

export function registerTerminalCmdK(ctx: vscode.ExtensionContext, services: Services): void {
	const buffers = new WeakMap<vscode.Terminal, OutputBuffer>();
	const bufferOf = (t: vscode.Terminal): OutputBuffer => {
		let b = buffers.get(t);
		if (!b) { b = new OutputBuffer(); buffers.set(t, b); }
		return b;
	};

	// Capture output of commands run with shell integration (the only way to read terminal text).
	ctx.subscriptions.push(vscode.window.onDidStartTerminalShellExecution(async e => {
		const buf = bufferOf(e.terminal);
		buf.append(`\n$ ${e.execution.commandLine.value}\n`);
		try {
			for await (const chunk of e.execution.read()) { buf.append(chunk); }
		} catch { /* terminal closed */ }
	}));

	function shellName(t: vscode.Terminal): string {
		const p = (t.creationOptions as vscode.TerminalOptions).shellPath ?? vscode.env.shell ?? process.env.SHELL ?? 'sh';
		return p.split(/[\\/]/).pop() ?? p;
	}

	function cwdOf(t: vscode.Terminal): string {
		const c = t.shellIntegration?.cwd?.fsPath;
		if (c) { return c; }
		const opt = (t.creationOptions as vscode.TerminalOptions).cwd;
		if (opt) { return typeof opt === 'string' ? opt : opt.fsPath; }
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
	}

	async function run(): Promise<void> {
		const terminal = vscode.window.activeTerminal;
		if (!terminal) { return; }
		const request = await vscode.window.showInputBox({
			title: 'Terminal Cmd+K',
			prompt: 'Describe the command…',
			placeHolder: 'e.g. find files larger than 100 MB in this folder',
			ignoreFocusOut: true,
		});
		if (!request?.trim()) { void terminal.show(false); return; }
		const model = pickInlineModel(services);
		if (!model) { void vscode.window.showErrorMessage('Open Cursor: no model available. Add an API key or start a local model.'); return; }
		const user = buildTerminalPrompt(request, {
			os: `${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'} ${os.release()} (${process.arch})`,
			shell: shellName(terminal), cwd: cwdOf(terminal), output: bufferOf(terminal).tail(50),
		});
		const ac = new AbortController();
		try {
			const raw = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Open Cursor: writing command…', cancellable: true }, (_p, token) => {
				token.onCancellationRequested(() => ac.abort());
				return collectText(services, model, TERMINAL_SYSTEM, user, ac.signal, { maxTokens: 300, temperature: 0 });
			});
			const cmd = cleanCommand(raw);
			if (!cmd) { void vscode.window.showWarningMessage('Open Cursor: the model returned no command.'); return; }
			terminal.show(false);
			terminal.sendText(cmd, false);
		} catch (err) {
			if (ac.signal.aborted) { return; }
			void vscode.window.showErrorMessage(`Open Cursor: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	ctx.subscriptions.push(vscode.commands.registerCommand('openCursor.terminal.cmdK', run));
}
