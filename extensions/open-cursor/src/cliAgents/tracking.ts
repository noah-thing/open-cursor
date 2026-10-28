/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Glue between GitTracker and the host callbacks for CLIs that edit files themselves (Codex,
 *  Gemini): after each tool call, report originals, changed files and an "Edited x +n -m" row.
 *--------------------------------------------------------------------------------------------*/

import { GitTracker } from './fileTracker';
import type { TurnHost } from './types';
import { displayPath } from './util';

export class TurnTracker {
	private rows = 0;
	private warned = false;

	private constructor(
		private readonly tracker: GitTracker | undefined,
		private readonly cwd: string,
		private readonly host: TurnHost,
	) {}

	static async create(cwd: string, env: NodeJS.ProcessEnv, host: TurnHost): Promise<TurnTracker> {
		return new TurnTracker(await GitTracker.create(cwd, env).catch(() => undefined), cwd, host);
	}

	get active(): boolean {
		return !!this.tracker;
	}

	/** Call after any tool call that may have touched files. */
	async afterToolCall(hint?: readonly string[]): Promise<void> {
		if (!this.tracker) {
			// Not a git repo: no baseline to diff against. Still tell the UI which files changed.
			if (hint?.length) {
				for (const abs of hint) {
					this.row(abs, 0, 0, undefined);
					this.host.fileChanged(abs);
				}
				this.warn();
			}
			return;
		}
		const files = await this.tracker.scan();
		for (const f of files) {
			if (f.first) {
				this.host.fileOriginal(f.absPath, f.original);
			}
			this.row(f.absPath, f.added, f.removed, f.original === undefined && f.current !== undefined);
			this.host.fileChanged(f.absPath);
		}
	}

	private row(abs: string, added: number, removed: number, isNew: boolean | undefined): void {
		const rel = displayPath(this.cwd, abs);
		this.host.toolStart({
			type: 'tool',
			id: `edit-${++this.rows}-${rel}`,
			name: 'edit_file',
			status: 'done',
			title: `${isNew ? 'Created' : 'Edited'} ${rel}`,
			edit: { uri: this.host.uri(abs), path: rel, added, removed, isNew: isNew || undefined },
		});
	}

	private warn(): void {
		if (!this.warned) {
			this.warned = true;
			this.host.text('\n\n> Open Cursor cannot snapshot files here because this folder is not a git repository, so these edits are not available for Keep/Undo review or checkpoints.\n\n');
		}
	}
}
