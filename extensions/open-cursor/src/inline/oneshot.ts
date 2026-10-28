/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Shared helper for single-turn text generation (terminal Cmd+K, commit messages).
 *--------------------------------------------------------------------------------------------*/

import type { Services } from '../services';
import type { ModelInfo } from '../providers/types';

export async function collectText(
	services: Services, model: ModelInfo, system: string, user: string, signal: AbortSignal,
	opts: { maxTokens?: number; temperature?: number; onText?: (soFar: string) => void } = {},
): Promise<string> {
	let out = '';
	for await (const ev of services.registry.stream({
		model, system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
		maxTokens: opts.maxTokens ?? 1024, temperature: opts.temperature ?? 0.2, thinking: false, signal,
	})) {
		if (ev.type === 'text') {
			out += ev.text;
			opts.onText?.(out);
		}
	}
	return out;
}

/** Resolve a usable chat-capable model: explicit id, else the inline default, else chat default. */
export function pickInlineModel(services: Services, modelId?: string): ModelInfo | undefined {
	if (modelId && !modelId.startsWith('cli:')) {
		const m = services.registry.getModel(modelId);
		if (m) { return m; }
	}
	return services.registry.getDefaultModel('inline') ?? services.registry.getDefaultModel('chat');
}
