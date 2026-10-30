/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  The sentence shown after an import. No VS Code imports, so it can be tested alone.
 *--------------------------------------------------------------------------------------------*/

export interface ImportOutcome {
	readonly label: string;
	readonly settings: number;
	readonly keybindings: boolean;
	readonly snippets: boolean;
	readonly installed: number;
	readonly failed: readonly string[];
	/** Open VSX did not answer, so nothing was tried. */
	readonly offline: boolean;
	readonly warning?: string;
}

export function summarizeImport(o: ImportOutcome): string {
	const parts = [`${o.settings} settings`];
	if (o.keybindings) { parts.push('keybindings'); }
	if (o.snippets) { parts.push('snippets'); }
	if (!o.offline) { parts.push(`${o.installed} extensions`); }
	let tail = '';
	if (o.offline) { tail = ' Could not reach Open VSX, so no extensions were added. Try again when you are online.'; }
	else if (o.failed.length) { tail = ` ${o.failed.length} extensions are not on Open VSX: ${o.failed.slice(0, 5).join(', ')}${o.failed.length > 5 ? '…' : ''}.`; }
	return `Imported ${parts.join(', ')} from ${o.label}.${tail}${o.warning ? ' ' + o.warning : ''}`;
}
