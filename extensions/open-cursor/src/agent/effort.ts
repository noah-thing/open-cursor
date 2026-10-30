/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  How hard the model thinks. One setting for every chat, picked in the chat box next to the model.
 *  Auto keeps each backend's own default where the provider documents one, CLIs use theirs. For
 *  Anthropic, which needs an explicit budget, Auto thinks at a moderate one. Auto never means high:
 *  an agent loop thinks on every step, so high on every step is slow and costly.
 *--------------------------------------------------------------------------------------------*/

import type { Effort } from '../shared/protocol';

export type ApiEffort = 'auto' | 'low' | 'medium' | 'high' | 'max';

/** What an API model is asked for; undefined means no thinking. 'auto' lets each provider mapping pick its default. */
export function apiEffort(e: Effort): ApiEffort | undefined {
	return e === 'off' ? undefined : e;
}

/** Anthropic thinking budget. Always below max_tokens, which has to hold the answer too. */
export function anthropicBudget(e: ApiEffort | undefined, maxTokens: number): number {
	const want = e === 'low' ? 2_048 : e === 'medium' || e === 'auto' || e === undefined ? 8_000 : e === 'max' ? 31_000 : 16_000;
	return Math.max(1_024, Math.min(want, maxTokens - 1_024));
}

/** OpenAI style reasoning_effort; providers stop at high. Auto is medium, which is OpenAI's own default. */
export function openaiEffort(e: ApiEffort | undefined): 'low' | 'medium' | 'high' {
	return e === 'low' || e === 'high' ? e : e === 'max' ? 'high' : 'medium';
}

/** Claude Code's --effort. Auto leaves its own default alone; it cannot switch thinking off, so Off is its lowest. */
export function claudeEffortArgs(e: Effort | undefined): string[] {
	if (!e || e === 'auto') { return []; }
	return ['--effort', e === 'off' ? 'low' : e];
}

/** Codex's model_reasoning_effort. Max is its xhigh, Off its minimal. */
export function codexEffortArgs(e: Effort | undefined): string[] {
	if (!e || e === 'auto') { return []; }
	const level = e === 'off' ? 'minimal' : e === 'max' ? 'xhigh' : e;
	return ['-c', `model_reasoning_effort="${level}"`];
}

/** OpenCode 2's model variant (`provider/model#variant`). Auto keeps the model's default; Off is its lowest, Low. */
export function openCodeVariant(e: Effort | undefined): string | undefined {
	if (!e || e === 'auto') { return undefined; }
	return e === 'off' ? 'low' : e;
}

/** CLIs that take an effort level from us. */
export const EFFORT_CLIS: readonly string[] = ['claude-code', 'codex', 'opencode'];
