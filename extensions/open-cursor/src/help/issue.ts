/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  A GitHub issue prefilled from a Help chat: the user's own words and a few app details. It
 *  opens in the browser, where the user reads it and submits it themselves. Never keys, code or
 *  file contents. Pure.
 *--------------------------------------------------------------------------------------------*/

export const ISSUES_URL = 'https://github.com/noah-thing/open-cursor/issues/new';

/** Browsers and GitHub cope with much longer URLs, but a prefilled issue past this gets cut. */
const MAX_URL = 7000;

export interface IssueFacts {
	/** Short title from Help, or empty. */
	readonly title: string;
	/** What the user wrote in the Help chat, oldest first. */
	readonly userMessages: readonly string[];
	readonly version: string;
	/** e.g. `macOS 15.4 (arm64)`. */
	readonly system: string;
	/** Mode and model of the chat the user came from, e.g. `Agent`, `Claude Code subscription`. */
	readonly mode?: string;
	readonly model?: string;
}

/** What kind of model a model id points at, without the id itself: `cli:claude-code/...` -> `Claude Code subscription`. */
export function modelKind(modelId: string | undefined): string | undefined {
	if (!modelId) { return undefined; }
	const cli: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok', 'gemini-cli': 'Gemini CLI', opencode: 'OpenCode' };
	if (modelId.startsWith('cli:')) {
		const agent = modelId.slice(4).split('/')[0];
		return `${cli[agent] ?? agent} subscription`;
	}
	const provider = modelId.split('/')[0];
	const names: Record<string, string> = {
		anthropic: 'Anthropic API', openai: 'OpenAI API', google: 'Google Gemini API', openrouter: 'OpenRouter', deepseek: 'DeepSeek API', xai: 'xAI API',
		mistral: 'Mistral API', groq: 'Groq', nvidia: 'NVIDIA', zai: 'Z.ai', sambanova: 'SambaNova', ollama: 'Ollama (local)', lmstudio: 'LM Studio (local)', free: 'Free (auto)', custom: 'Custom endpoint',
	};
	return names[provider] ?? provider;
}

function clean(s: string): string {
	// drop anything shaped like a key, in case one was pasted into the chat
	return s.replace(/\b(sk|gsk|xai|nvapi|AIza|ghp|gho|github_pat)[-_A-Za-z0-9]{16,}/g, '[removed]').trim();
}

export function issueTitle(f: IssueFacts): string {
	const t = clean(f.title).replace(/\s+/g, ' ').slice(0, 90);
	if (t) { return t; }
	const first = clean(f.userMessages[0] ?? '').replace(/\s+/g, ' ');
	return first ? (first.length > 80 ? first.slice(0, 77).trimEnd() + '...' : first) : 'Problem report';
}

export function issueBody(f: IssueFacts, maxDescription = 4000): string {
	let description = f.userMessages.map(clean).filter(Boolean).join('\n\n');
	if (description.length > maxDescription) { description = description.slice(0, maxDescription).trimEnd() + '\n\n(cut short)'; }
	const details = [
		`- OpenCursor ${f.version}`,
		`- ${f.system}`,
		...(f.mode ? [`- Mode: ${f.mode}`] : []),
		...(f.model ? [`- Model: ${f.model}`] : []),
	];
	return [
		'### What happened',
		'',
		description || '(describe the problem)',
		'',
		'### Details',
		'',
		...details,
		'',
		'Reported from Help in OpenCursor.',
	].join('\n');
}

/** The prefilled new issue URL, shortened until it fits. */
export function issueUrl(f: IssueFacts): string {
	const build = (max: number): string => `${ISSUES_URL}?title=${encodeURIComponent(issueTitle(f))}&body=${encodeURIComponent(issueBody(f, max))}`;
	let max = 4000;
	let url = build(max);
	while (url.length > MAX_URL && max > 200) {
		max = Math.floor(max * 0.7);
		url = build(max);
	}
	return url;
}
