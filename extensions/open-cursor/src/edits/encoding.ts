/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Detects files the agent must not rewrite through a UTF-8 round trip. No vscode import.
 *--------------------------------------------------------------------------------------------*/

export const MAX_EDIT_BYTES = 4 * 1024 * 1024;

/** Null when the bytes are safe to edit as UTF-8 text (with or without a BOM), else a reason. */
export function unsafeEncoding(bytes: Uint8Array): string | null {
	if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
		return 'it is encoded as UTF-16';
	}
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return null;
	} catch {
		return 'it is not valid UTF-8 (probably Latin-1 or Windows-1252)';
	}
}

export function tooLargeMessage(name: string, bytes: number): string {
	return `${name} is ${(bytes / 1048576).toFixed(1)} MB, over the ${MAX_EDIT_BYTES / 1048576} MB limit for edits, so it was left alone.`;
}
