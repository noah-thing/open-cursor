/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

/** Anything shaped like a key goes, in case one was pasted or sits in an error. */
export function scrub(s: string): string {
	return s.replace(/\b(sk|gsk|xai|nvapi|AIza|ghp|gho|github_pat|sk-ant|sk-or|hf)[-_A-Za-z0-9]{16,}/g, '[removed]')
		.replace(/\b(Bearer|token|api[_-]?key|key)([=:\s"']+)[A-Za-z0-9._\-]{20,}/gi, '$1$2[removed]');
}

