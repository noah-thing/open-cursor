/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Pure restore planning for checkpoints, no vscode import.
 *--------------------------------------------------------------------------------------------*/

export interface CheckpointRecord {
	readonly id: string;
	/** uri string to blob hash of the content before the checkpoint; null if the file did not exist. */
	readonly files: Readonly<Record<string, string | null>>;
}

/**
 * `records` are the chat's checkpoints in creation order. Restoring checkpoint T means every file
 * touched in T or any later checkpoint goes back to its EARLIEST captured before-content.
 * Returns undefined when T is unknown.
 */
export function planRestore(records: readonly CheckpointRecord[], targetId: string): Map<string, string | null> | undefined {
	const start = records.findIndex(r => r.id === targetId);
	if (start === -1) {
		return undefined;
	}
	const plan = new Map<string, string | null>();
	for (let i = start; i < records.length; i++) {
		for (const [uri, hash] of Object.entries(records[i].files)) {
			if (!plan.has(uri)) {
				plan.set(uri, hash);
			}
		}
	}
	return plan;
}
