/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Incremental parser for "one fenced code block" model output. No vscode import.
 *--------------------------------------------------------------------------------------------*/

/**
 * Feed streamed text with `push`; `content` is the code inside the first fenced block seen so far
 * (never includes the closing fence, holds back a trailing partial fence line). If the model never
 * emits a fence, `finish()` falls back to the whole text.
 */
export class FenceParser {
	private raw = '';
	private openEnd = -1; // offset right after the opening fence line
	private fenceLen = 3;
	private closeAt = -1; // offset where the closing fence line starts

	get done(): boolean { return this.closeAt >= 0; }
	get opened(): boolean { return this.openEnd >= 0; }
	get text(): string { return this.raw; }

	push(chunk: string): void {
		this.raw += chunk;
		if (this.closeAt >= 0) { return; }
		if (this.openEnd < 0) { this.findOpen(); }
		if (this.openEnd >= 0) { this.findClose(); }
	}

	private findOpen(): void {
		let pos = 0;
		while (pos < this.raw.length) {
			const nl = this.raw.indexOf('\n', pos);
			if (nl < 0) { return; } // the line is still incomplete
			const m = /^\s{0,3}(`{3,})[^`\n]*$/.exec(this.raw.slice(pos, nl).replace(/\r$/, ''));
			if (m) {
				this.fenceLen = m[1].length;
				this.openEnd = nl + 1;
				return;
			}
			pos = nl + 1;
		}
	}

	private findClose(): void {
		let pos = this.openEnd;
		while (pos < this.raw.length) {
			const nl = this.raw.indexOf('\n', pos);
			const lineEnd = nl < 0 ? this.raw.length : nl;
			const line = this.raw.slice(pos, lineEnd).replace(/\r$/, '');
			if (nl >= 0 || line.length >= this.fenceLen) {
				if (new RegExp('^\\s{0,3}`{' + this.fenceLen + ',}\\s*$').test(line)) { this.closeAt = pos; return; }
			}
			if (nl < 0) { return; }
			pos = nl + 1;
		}
	}

	/** Code so far. */
	get content(): string {
		if (this.openEnd < 0) { return ''; }
		if (this.closeAt >= 0) { return stripFinalNewline(this.raw.slice(this.openEnd, this.closeAt)); }
		let body = this.raw.slice(this.openEnd);
		// Hold back an incomplete last line that could still become the closing fence.
		const lastNl = body.lastIndexOf('\n');
		const tail = body.slice(lastNl + 1);
		if (/^\s{0,3}`*$/.test(tail) && tail.trim() !== '') { body = body.slice(0, lastNl + 1); }
		return stripFinalNewline(body);
	}

	/** Final code: the fenced block, or the whole text (minus stray fence lines) if there was none. */
	finish(): string {
		if (this.openEnd >= 0) { return stripFinalNewline(this.closeAt >= 0 ? this.raw.slice(this.openEnd, this.closeAt) : this.raw.slice(this.openEnd)); }
		let t = this.raw.replace(/\r\n/g, '\n');
		t = t.replace(/^\s*`{3,}[^\n`]*\n?/, '').replace(/\n?`{3,}\s*$/, '');
		return stripFinalNewline(t);
	}
}

function stripFinalNewline(s: string): string {
	if (s.endsWith('\r\n')) { return s.slice(0, -2); }
	return s.endsWith('\n') ? s.slice(0, -1) : s;
}
