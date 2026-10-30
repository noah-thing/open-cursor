/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { ProviderId } from './types';

export interface FreeModel {
	readonly provider: ProviderId;
	readonly model: string;
	readonly label: string;
	readonly contextWindow: number;
}

/**
 * Models each provider serves at no cost on its free tier, checked against the providers' own pages
 * on 2026-10-28. Order inside a provider is best first. NVIDIA, Z.ai and SambaNova list many paid
 * models too, so for them only these are shown.
 */
export const FREE_MODELS: readonly FreeModel[] = [
	{ provider: 'nvidia', model: 'deepseek-ai/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', contextWindow: 128_000 },
	{ provider: 'nvidia', model: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', contextWindow: 128_000 },
	{ provider: 'nvidia', model: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6', contextWindow: 128_000 },
	{ provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super', contextWindow: 128_000 },
	{ provider: 'zai', model: 'glm-4.7-flash', label: 'GLM 4.7 Flash', contextWindow: 200_000 },
	{ provider: 'zai', model: 'glm-4.5-flash', label: 'GLM 4.5 Flash', contextWindow: 128_000 },
	{ provider: 'groq', model: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', contextWindow: 131_072 },
	{ provider: 'groq', model: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B', contextWindow: 131_072 },
	{ provider: 'groq', model: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', contextWindow: 131_072 },
	{ provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra', contextWindow: 1_000_000 },
	{ provider: 'openrouter', model: 'poolside/laguna-s-2.1:free', label: 'Poolside Laguna S 2.1', contextWindow: 128_000 },
	{ provider: 'openrouter', model: 'cohere/north-mini-code:free', label: 'North Mini Code', contextWindow: 128_000 },
	{ provider: 'google', model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_000_000 },
	{ provider: 'google', model: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', contextWindow: 1_000_000 },
	{ provider: 'mistral', model: 'mistral-medium-3-5', label: 'Mistral Medium 3.5', contextWindow: 128_000 },
	{ provider: 'mistral', model: 'codestral-2508', label: 'Codestral', contextWindow: 256_000 },
	{ provider: 'sambanova', model: 'DeepSeek-V3.1', label: 'DeepSeek V3.1', contextWindow: 128_000 },
	{ provider: 'sambanova', model: 'gpt-oss-120b', label: 'GPT-OSS 120B', contextWindow: 128_000 },
];

/** Providers whose catalogue is mostly paid: only the free models above are listed for them. */
export const FREE_ONLY: ReadonlySet<ProviderId> = new Set<ProviderId>(['nvidia', 'zai', 'sambanova']);

export const FREE_AUTO_ID = 'free/auto';

const FREE_IDS = new Set(FREE_MODELS.map(m => `${m.provider}/${m.model}`));

/** OpenRouter marks every zero priced model with a `:free` suffix, including ones added after this list. */
export function isFreeModel(id: string): boolean {
	return id === FREE_AUTO_ID || FREE_IDS.has(id) || (id.startsWith('openrouter/') && id.endsWith(':free'));
}

/** The order Free (auto) tries models in: generous limits first, small daily caps last. */
const CHAIN_ORDER = [
	'nvidia/deepseek-ai/deepseek-v4.1-flash', 'zai/glm-4.7-flash', 'groq/openai/gpt-oss-120b', 'nvidia/z-ai/glm-5.3-flash',
	'nvidia/moonshotai/kimi-k2.6', 'nvidia/nvidia/nemotron-3-super-120b-a12b',
	'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemini-3.8-flash', 'zai/glm-4.5-flash', 'groq/qwen/qwen3.8-27b',
	'groq/llama-3.3-70b-versatile', 'mistral/mistral-medium-3-5', 'openrouter/poolside/laguna-s-2.1:free',
	'openrouter/cohere/north-mini-code:free', 'google/gemini-3.5-flash-lite', 'mistral/codestral-2508',
	'sambanova/DeepSeek-V3.1', 'sambanova/gpt-oss-120b',
];

export const FREE_CHAIN: readonly FreeModel[] = CHAIN_ORDER.map(id => {
	const m = FREE_MODELS.find(x => `${x.provider}/${x.model}` === id);
	if (!m) { throw new Error(`Free chain names an unknown model: ${id}`); }
	return m;
});
