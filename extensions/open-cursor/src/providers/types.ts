/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

export type ProviderId =
	| 'anthropic'
	| 'openai'
	| 'google'
	| 'openrouter'
	| 'deepseek'
	| 'xai'
	| 'mistral'
	| 'groq'
	| 'nvidia'
	| 'zai'
	| 'sambanova'
	| 'ollama'
	| 'lmstudio'
	| 'custom'
	/** The Free (auto) router: whichever connected free model still has quota. */
	| 'free';

export interface ModelInfo {
	/** Globally unique id used everywhere in OpenCursor: `${provider}/${model}` e.g. `anthropic/claude-sonnet-5-5`. */
	readonly id: string;
	readonly provider: ProviderId;
	/** The id the provider's API expects. */
	readonly model: string;
	readonly label: string;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	readonly supportsTools: boolean;
	readonly supportsImages: boolean;
	readonly supportsThinking: boolean;
	/** True if this model can do fill-in-the-middle completion (used by Tab). */
	readonly supportsFim?: boolean;
	/** Added by the user in settings rather than shipped or discovered. */
	readonly custom?: boolean;
}

export type LLMContent =
	| { type: 'text'; text: string }
	| { type: 'image'; mediaType: string; data: string /* base64, no data: prefix */ }
	| { type: 'tool_use'; id: string; name: string; input: unknown }
	| { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean; images?: { mediaType: string; data: string }[] }
	| { type: 'thinking'; text: string; signature?: string };

export interface LLMMessage {
	readonly role: 'user' | 'assistant';
	readonly content: LLMContent[];
}

export interface ToolSchema {
	readonly name: string;
	readonly description: string;
	/** JSON Schema object. */
	readonly parameters: Record<string, unknown>;
}

export interface ChatRequest {
	readonly model: ModelInfo;
	readonly system: string;
	readonly messages: LLMMessage[];
	readonly tools?: ToolSchema[];
	readonly maxTokens?: number;
	readonly temperature?: number;
	/** Ask for extended thinking / reasoning when the model supports it. */
	readonly thinking?: boolean;
	readonly signal: AbortSignal;
	/** Waits on 429 before giving up; Free (auto) sets 0 to move on to the next model at once. */
	readonly retries?: number;
}

export type StreamEvent =
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'thinking_signature'; signature: string }
	/** Emitted as soon as a tool call starts, so the UI can show a row while args stream. */
	| { type: 'tool_call_start'; id: string; name: string }
	/** Raw JSON argument fragment for the tool call with this id. */
	| { type: 'tool_call_delta'; id: string; argsDelta: string }
	/** Final, parsed tool call. Always emitted once per call, after its start/deltas. */
	| { type: 'tool_call'; id: string; name: string; input: unknown }
	| { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
	| { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop' | 'error' | 'aborted' };

export interface FimRequest {
	readonly model: ModelInfo;
	readonly prefix: string;
	readonly suffix: string;
	readonly maxTokens: number;
	readonly stop?: string[];
	readonly temperature?: number;
	readonly signal: AbortSignal;
}

export class ProviderError extends Error {
	constructor(
		message: string,
		readonly provider: ProviderId,
		readonly status?: number,
		/** 'auth' = bad/missing key, 'rate' = 429, 'context' = prompt too long, 'network', 'other'. */
		readonly kind: 'auth' | 'rate' | 'context' | 'network' | 'other' = 'other',
	) {
		super(message);
	}
}

export interface LLMProvider {
	readonly id: ProviderId;
	readonly label: string;
	/** Streams one model turn. Must throw ProviderError for HTTP/auth failures and stop cleanly on abort. */
	stream(req: ChatRequest): AsyncIterable<StreamEvent>;
	/** Fill-in-the-middle completion text stream, for Tab. Optional. */
	fim?(req: FimRequest): AsyncIterable<string>;
	/** Discover models from the provider API (needs a key for hosted providers). */
	listModels?(signal?: AbortSignal): Promise<ModelInfo[]>;
	/** Cheap call used by Settings "Verify" buttons. */
	verify?(signal?: AbortSignal): Promise<{ ok: boolean; message: string }>;
}
