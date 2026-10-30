/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  How each provider switches thinking on hybrid models. Only models whose provider documents the
 *  parameter are listed; everything else gets nothing, because an unknown field can be a 400.
 *  Sources (checked 2026-10-30):
 *   DeepSeek   https://api-docs.deepseek.com/guides/thinking_mode  (thinking.type, reasoning_effort low/high/max, default on and high; medium maps to high)
 *   NVIDIA V4  https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash-infer  (top level reasoning_effort none/high/max, default high)
 *   NVIDIA Kimi K2.6  https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k2-6-infer  (chat_template_kwargs.thinking, default on)
 *   NVIDIA Nemotron 3 Super  https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b  (chat_template_kwargs.enable_thinking, low_effort)
 *   Z.ai       https://docs.z.ai/guides/capabilities/thinking-mode  (thinking.type; GLM 5.3 cannot be switched off)
 *   Groq       https://console.groq.com/docs/reasoning  (gpt-oss low/medium/high; Qwen 3.8 none/low/medium/high)
 *--------------------------------------------------------------------------------------------*/

import type { ApiEffort } from '../agent/effort';
import type { ProviderId } from './types';

type Params = Record<string, unknown>;

const DEEPSEEK = /^deepseek-(flash|v4)/i;
// V4 on NVIDIA. The V4.1 endpoint documents no request parameter, so `deepseek-v4.1-*` is left out on purpose.
const NVIDIA_DEEPSEEK = /^deepseek-ai\/deepseek-v4-/i;
// V4.1 documents no parameter. It gets V4's only when the user picks a level, and a rejection turns it off for the session (see thinkingRejected).
const NVIDIA_DEEPSEEK_41 = /^deepseek-ai\/deepseek-v4\.1-/i;
const REJECTED = new Set<string>();

/** Models whose thinking fields are not documented: tried, and dropped for the session if the provider refuses them. */
export function thinkingUnverified(provider: ProviderId, model: string): boolean {
	return provider === 'nvidia' && NVIDIA_DEEPSEEK_41.test(model);
}

/** The provider refused the thinking fields for this model: never send them again this session. */
export function thinkingRejected(provider: ProviderId, model: string): void {
	REJECTED.add(`${provider}/${model}`);
}
const NVIDIA_KIMI = /^moonshotai\/kimi-k2\.6/i;
const NVIDIA_NEMOTRON = /^nvidia\/nemotron-3-super/i;
const ZAI_GLM = /^glm-(4\.7|5|5\.[12])(-|$)/i;
const GROQ_OSS = /gpt-oss/i;
const GROQ_QWEN = /qwen3\.8/i;

/** True when thinkingParams knows how to steer this model, so the effort picker can be shown. */
export function hasThinkingControl(provider: ProviderId, model: string): boolean {
	switch (provider) {
		case 'deepseek': return DEEPSEEK.test(model);
		case 'nvidia': return (NVIDIA_DEEPSEEK.test(model) || NVIDIA_DEEPSEEK_41.test(model) || NVIDIA_KIMI.test(model) || NVIDIA_NEMOTRON.test(model)) && !REJECTED.has(`nvidia/${model}`);
		case 'zai': return ZAI_GLM.test(model);
		case 'groq': return GROQ_OSS.test(model) || GROQ_QWEN.test(model);
		default: return false;
	}
}

/**
 * Request body fields for one model. `thinking` undefined means the caller never asked (Free (auto)),
 * false is Off, true uses `effort`; Auto ('auto') keeps the provider default except where noted.
 */
export function thinkingParams(provider: ProviderId, model: string, thinking: boolean | undefined, effort: ApiEffort | undefined): Params {
	if (thinking === undefined || !hasThinkingControl(provider, model)) { return {}; }
	const e = effort ?? 'auto';
	if (provider === 'deepseek') {
		if (!thinking) { return { thinking: { type: 'disabled' } }; }
		// DeepSeek has no level between low and high (medium is high), so Auto takes low: thinking stays on, steps get quicker
		const level = e === 'auto' || e === 'low' ? 'low' : e === 'max' ? 'max' : 'high';
		return { thinking: { type: 'enabled' }, reasoning_effort: level };
	}
	if (provider === 'nvidia') {
		if (NVIDIA_DEEPSEEK.test(model) || NVIDIA_DEEPSEEK_41.test(model)) {
			if (!thinking) { return { reasoning_effort: 'none' }; }
			return e === 'auto' ? {} : { reasoning_effort: e === 'max' ? 'max' : 'high' };
		}
		if (NVIDIA_KIMI.test(model)) {
			return !thinking ? { chat_template_kwargs: { thinking: false } } : e === 'auto' ? {} : { chat_template_kwargs: { thinking: true } };
		}
		if (!thinking) { return { chat_template_kwargs: { enable_thinking: false } }; }
		if (e === 'low') { return { chat_template_kwargs: { enable_thinking: true, low_effort: true } }; }
		return e === 'auto' ? {} : { chat_template_kwargs: { enable_thinking: true } };
	}
	if (provider === 'zai') {
		return !thinking ? { thinking: { type: 'disabled' } } : e === 'auto' ? {} : { thinking: { type: 'enabled' } };
	}
	// groq
	const level = e === 'max' ? 'high' : e;
	if (GROQ_OSS.test(model)) { return { reasoning_effort: !thinking ? 'low' : e === 'auto' ? 'medium' : level }; }
	return !thinking ? { reasoning_effort: 'none' } : e === 'auto' ? {} : { reasoning_effort: level };
}
