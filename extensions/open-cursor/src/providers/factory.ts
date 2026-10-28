/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Builds an adapter for a provider id. No vscode imports, so it works under plain node.
 *--------------------------------------------------------------------------------------------*/

import { AnthropicProvider } from './anthropic';
import type { BaseUrl, KeyGetter } from './http';
import { GoogleProvider } from './google';
import { OllamaProvider } from './ollama';
import { OpenAIProvider, createOpenAICompatible } from './openai';
import type { LLMProvider, ProviderId } from './types';

export interface AdapterDeps {
	getKey: KeyGetter;
	/** Omit to use the provider's public endpoint. May vary by model id. */
	baseUrl?: BaseUrl;
	/** Ollama only. */
	numCtx?: () => number;
}

export function createAdapter(id: ProviderId, d: AdapterDeps): LLMProvider {
	switch (id) {
		case 'anthropic': return new AnthropicProvider(d);
		case 'openai': return new OpenAIProvider(d);
		case 'google': return new GoogleProvider(d);
		case 'ollama': return new OllamaProvider({ baseUrl: d.baseUrl, numCtx: d.numCtx, getKey: d.getKey });
		default: return createOpenAICompatible(id, d);
	}
}
