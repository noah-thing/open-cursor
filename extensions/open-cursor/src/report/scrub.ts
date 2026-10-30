/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

/** Anything shaped like a key goes, in case one was pasted or sits in an error. Home folders lose the user's name. */
export function scrub(s: string): string {
	return s
		// /Users/<name>, /home/<name>, C:\Users\<name> and the escaped C:\\Users\\<name> become ~
		.replace(/[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\s"'`:]+/gi, '~')
		.replace(/\/(?:Users|home)\/[^/\s"'`:\\]+/g, '~')
		.replace(/\b(sk|gsk|xai|nvapi|AIza|ghp|gho|github_pat|sk-ant|sk-or|hf)[-_A-Za-z0-9]{16,}/g, '[removed]')
		.replace(/\b(Bearer|token|api[_-]?key|key)([=:\s"']+)[A-Za-z0-9._\-+/]{20,}/gi, '$1$2[removed]')
		// keys with no known prefix: hex.alnum (Z.ai) and long runs of random looking characters
		.replace(/\b[0-9a-f]{24,}\.[A-Za-z0-9]{8,}\b/gi, '[removed]')
		.replace(/(?<![\w+.=-])(?=[A-Za-z0-9+/]*\+)[A-Za-z0-9+/]{32,}={0,2}/g, '[removed]')
		.replace(/(?<![\w+.=-])[A-Za-z0-9_-]{32,}(?![\w+.=-])/g, m => (looksRandom(m) ? '[removed]' : m));
}

/** A long token is a key when it mixes upper case, lower case and digits, or is hex. Plain words and kebab-case names stay. */
function looksRandom(m: string): boolean {
	// git commit hashes are 40 or 64 hex characters and are not secrets
	if (/^[0-9a-f]+$/i.test(m)) { return m.length !== 40 && m.length !== 64; }
	if (!/[a-z]/.test(m) || !/[A-Z]/.test(m) || !/\d/.test(m)) { return false; }
	return true;
}
