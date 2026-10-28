/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { ModelInfo, ProviderId } from './types';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
	anthropic: 'Anthropic',
	openai: 'OpenAI',
	google: 'Google Gemini',
	openrouter: 'OpenRouter',
	deepseek: 'DeepSeek',
	xai: 'xAI',
	mistral: 'Mistral',
	groq: 'Groq',
	ollama: 'Ollama',
	lmstudio: 'LM Studio',
	custom: 'Custom',
};

/** Providers that need no key (local servers). `custom` may or may not. */
export const KEYLESS: ReadonlySet<ProviderId> = new Set<ProviderId>(['ollama', 'lmstudio']);
export const LOCAL: ReadonlySet<ProviderId> = new Set<ProviderId>(['ollama', 'lmstudio']);

export const ENV_KEYS: Partial<Record<ProviderId, string[]>> = {
	anthropic: ['ANTHROPIC_API_KEY'],
	openai: ['OPENAI_API_KEY'],
	google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
	openrouter: ['OPENROUTER_API_KEY'],
	deepseek: ['DEEPSEEK_API_KEY'],
	xai: ['XAI_API_KEY'],
	mistral: ['MISTRAL_API_KEY'],
	groq: ['GROQ_API_KEY'],
};

export function modelId(provider: ProviderId, model: string): string {
	return `${provider}/${model}`;
}

function anthropic(model: string, label: string, maxOutputTokens: number): ModelInfo {
	return { id: modelId('anthropic', model), provider: 'anthropic', model, label, contextWindow: 200_000, maxOutputTokens, supportsTools: true, supportsImages: true, supportsThinking: true };
}

export const ANTHROPIC_MODELS: readonly ModelInfo[] = [
	anthropic('claude-opus-5-5', 'Claude Opus 5.5', 32_000),
	anthropic('claude-sonnet-5-5', 'Claude Sonnet 5.5', 64_000),
	anthropic('claude-haiku-5-5', 'Claude Haiku 5.5', 64_000),
	anthropic('claude-fable-5-1', 'Claude Fable 5.1', 64_000),
];

export const CATALOG: readonly ModelInfo[] = [...ANTHROPIC_MODELS];

const FIM_NAMES = /codestral|coder|starcoder|codellama|codegemma|deepseek-coder/i;

export function isFimName(provider: ProviderId, model: string): boolean {
	if (provider === 'mistral') { return /codestral/i.test(model); }
	if (provider === 'deepseek') { return model === 'deepseek-chat'; }
	if (provider === 'ollama' || provider === 'lmstudio') { return FIM_NAMES.test(model); }
	return false;
}

/** Reasoning-capable by name (used when the provider API does not say). */
export function isReasoningName(provider: ProviderId, model: string): boolean {
	const m = model.toLowerCase();
	if (provider === 'openai') { return /^(o\d|gpt-5)/.test(m) && !/chat/.test(m); }
	return /(^|[-/:])(r1|reasoner|thinking|magistral|qwq|gpt-oss)|qwen3|deepseek-r1|grok-4|grok-3-mini|gemini-(2\.5|3)|\bo\d\b/.test(m);
}

function isVisionName(model: string): boolean {
	return /vision|vl\b|-vl|llava|gpt-4o|gpt-4\.1|gpt-5|^o\d|gemini|claude|pixtral|grok-4|grok-2-vision|llama-?4|gemma-?3|mistral-(medium|small)|minicpm-v|moondream|qwen2\.5vl/i.test(model);
}

/** Best-effort metadata for a model id that the provider API did not describe in detail. */
export function guessModelInfo(provider: ProviderId, model: string, over: Partial<ModelInfo> = {}): ModelInfo {
	const m = model.toLowerCase();
	let ctx = 128_000;
	let out = 8_192;
	if (provider === 'openai') {
		if (/^gpt-5/.test(m)) { ctx = 400_000; out = 128_000; }
		else if (/^gpt-4\.1/.test(m)) { ctx = 1_047_576; out = 32_768; }
		else if (/^o\d/.test(m)) { ctx = 200_000; out = 100_000; }
		else if (/^gpt-4o|^chatgpt-4o/.test(m)) { out = 16_384; }
		else { out = 16_384; }
	} else if (provider === 'deepseek') {
		out = /reasoner/.test(m) ? 64_000 : 8_192;
	} else if (provider === 'xai') {
		ctx = /grok-4|code-fast/.test(m) ? 256_000 : 131_072;
		out = 32_768;
	} else if (provider === 'google') {
		ctx = 1_048_576; out = 65_536;
	} else if (provider === 'anthropic') {
		ctx = 200_000; out = 64_000;
	}
	return {
		id: modelId(provider, model),
		provider,
		model,
		label: model,
		contextWindow: ctx,
		maxOutputTokens: Math.min(out, ctx),
		supportsTools: true,
		supportsImages: isVisionName(m),
		supportsThinking: isReasoningName(provider, model),
		supportsFim: isFimName(provider, model) || undefined,
		...over,
	};
}

const NON_CHAT = /embed|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image|imagen|veo|rerank|guard|playai|orpheus|speech|aqa|babbage|davinci|search|instruct$|codex|computer-use|omni-moderation/i;

/** True if an id from a provider's /models listing looks like a chat model. */
export function isChatModelId(provider: ProviderId, id: string): boolean {
	if (NON_CHAT.test(id)) { return false; }
	switch (provider) {
		case 'openai': return /^(gpt-|o\d|chatgpt-)/i.test(id);
		case 'google': return /^gemini/i.test(id);
		case 'anthropic': return /^claude/i.test(id);
		case 'xai': return /^grok/i.test(id);
		default: return true;
	}
}
