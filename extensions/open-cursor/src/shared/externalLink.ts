/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Which links a webview may ask the host to open in the browser. Shared by both webview hosts.
 *--------------------------------------------------------------------------------------------*/

const HOSTS: ReadonlySet<string> = new Set(['x.com', 'github.com']);

/** Only https URLs on x.com and github.com, so a message from a webview cannot open anything else. */
export function isAllowedExternalUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === 'https:' && HOSTS.has(u.hostname);
	} catch {
		return false;
	}
}
