/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Commit message pure logic: diff truncation, prompt, output cleanup.
 *--------------------------------------------------------------------------------------------*/

export const COMMIT_SYSTEM = 'You write git commit messages. Use the Conventional Commits style (type(scope): summary) unless the project rules or recent commits show a different convention. Subject line at most 72 characters, imperative mood, no trailing period. Add a short body (wrapped at 72) only when the change needs explanation, separated by a blank line. Describe what changed and why, based only on the diff. Reply with ONLY the commit message: no quotes, no markdown fences, no preamble.';

/** Keep a diff under `max` chars, trimming each file section fairly and noting what was cut. */
export function truncateDiff(diff: string, max = 24000): string {
	if (diff.length <= max) { return diff; }
	const sections = diff.split(/^(?=diff --git )/m);
	if (sections.length <= 1) { return diff.slice(0, max) + '\n[diff truncated]'; }
	const per = Math.max(600, Math.floor(max / sections.length));
	let out = '';
	for (const s of sections) {
		if (s.length <= per) { out += s; continue; }
		const nl = s.lastIndexOf('\n', per);
		out += s.slice(0, nl > 0 ? nl : per) + '\n[file diff truncated]\n';
		if (out.length > max * 1.2) { out += '[remaining files omitted]\n'; break; }
	}
	return out;
}

export function buildCommitPrompt(diff: string, recent: string[], rules: { name: string; content: string }[], untracked: string[] = []): string {
	const parts: string[] = [];
	if (rules.length) {
		parts.push('Project rules (follow any commit message conventions in them):\n' + rules.map(r => `## ${r.name}\n${r.content.trim().slice(0, 1500)}`).join('\n\n').slice(0, 5000));
	}
	if (recent.length) { parts.push('Recent commit subjects (match their style):\n' + recent.map(m => `- ${m}`).join('\n')); }
	if (untracked.length) { parts.push('New untracked files (no diff shown):\n' + untracked.slice(0, 30).map(f => `- ${f}`).join('\n')); }
	parts.push(`Diff:\n${truncateDiff(diff)}`);
	return parts.join('\n\n');
}

export function cleanCommitMessage(raw: string): string {
	let t = raw.trim();
	const fence = /^```[\w-]*\r?\n([\s\S]*?)(?:\r?\n```|$)/.exec(t);
	if (fence) { t = fence[1].trim(); }
	t = t.replace(/^(?:commit message|message)\s*:\s*/i, '');
	if (/^"[\s\S]*"$/.test(t) || /^'[\s\S]*'$/.test(t)) { t = t.slice(1, -1); }
	return t.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
