/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Diagnostics formatting shared by the read_lints tool and the @Lints mention.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { toDisplayPath } from './paths';

const SEVERITY: readonly string[] = ['error', 'warning', 'info', 'hint'];

export interface FormatOptions {
	/** Restrict to these files; default is every file with diagnostics. */
	readonly uris?: vscode.Uri[];
	readonly limit?: number;
	readonly includeInfo?: boolean;
}

export function formatDiagnostics(opts: FormatOptions = {}): { text: string; count: number } {
	const limit = opts.limit ?? 100;
	const groups: [vscode.Uri, readonly vscode.Diagnostic[]][] = opts.uris
		? opts.uris.map(u => [u, vscode.languages.getDiagnostics(u)] as [vscode.Uri, readonly vscode.Diagnostic[]])
		: vscode.languages.getDiagnostics();
	const lines: string[] = [];
	let count = 0;
	let total = 0;
	for (const [uri, diags] of groups) {
		if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote' && uri.scheme !== 'untitled') {
			continue;
		}
		const relevant = diags.filter(d => d.severity <= (opts.includeInfo ? 2 : 1)).sort((a, b) => a.severity - b.severity || a.range.start.line - b.range.start.line);
		for (const d of relevant) {
			total++;
			if (count >= limit) {
				continue;
			}
			count++;
			const sev = SEVERITY[d.severity] ?? 'info';
			const code = d.code !== undefined ? ` ${typeof d.code === 'object' ? d.code.value : d.code}` : '';
			const src = d.source ? ` [${d.source}${code}]` : code ? ` [${code.trim()}]` : '';
			lines.push(`${toDisplayPath(uri)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}: ${d.message.split('\n')[0]}${src}`);
		}
	}
	if (total > count) {
		lines.push(`... ${total - count} more not shown`);
	}
	return { text: lines.join('\n'), count: total };
}
