/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  How hard the model thinks. One setting for every chat, picked in the chat box next to the model.
 *  Auto keeps each backend's own sensible default: API models think at high, CLIs use theirs.
 *--------------------------------------------------------------------------------------------*/

import type { Effort } from '../shared/protocol';

export type ApiEffort = 'low' | 'medium' | 'high' | 'max';

/** What an API model is asked for; undefined means no thinking. */
export function apiEffort(e: Effort): ApiEffort | undefined {
	return e === 'off' ? undefined : e === 'auto' ? 'high' : e;
}

/** Anthropic thinking budget. Always below max_tokens, which has to hold the answer too. */
export function anthropicBudget(e: ApiEffort | undefined, maxTokens: number): number {
	const want = e === 'low' ? 2_048 : e === 'medium' ? 8_000 : e === 'max' ? 31_000 : 16_000;
	return Math.max(1_024, Math.min(want, maxTokens - 1_024));
}

/** OpenAI style reasoning_effort; providers stop at high. */
export function openaiEffort(e: ApiEffort | undefined): 'low' | 'medium' | 'high' {
	return e === 'low' || e === 'medium' ? e : 'high';
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

/** CLIs that take an effort level from us. */
export const EFFORT_CLIS: readonly string[] = ['claude-code', 'codex'];
