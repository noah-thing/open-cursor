/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Messages between the Free models page and the extension host.
 *--------------------------------------------------------------------------------------------*/

export interface FreeCard {
	readonly id: string;
	readonly name: string;
	readonly signupUrl: string;
	readonly keyUrl: string;
	readonly steps: readonly string[];
	readonly models: readonly string[];
	readonly limits: string;
	readonly privacy?: { readonly tone: 'good' | 'note'; readonly text: string };
	readonly oauth?: boolean;
	readonly connected: boolean;
}

export interface OpenCodeState {
	readonly installed: boolean;
	readonly installing: boolean;
	readonly models: readonly { readonly id: string; readonly label: string }[];
}

export interface LocalPick {
	readonly tag: string;
	readonly label: string;
	readonly note: string;
	readonly sizeGB: number;
	readonly recommended: boolean;
	readonly tight: boolean;
	readonly diskOk: boolean;
	readonly installed: boolean;
	/** Share of the memory a model may use on this computer, 0 to 1. */
	readonly fill: number;
}

export interface LocalState {
	/** What was found, e.g. "Apple M4, 16 GB memory". */
	readonly hardware: string;
	readonly speed: 'fast' | 'slow';
	readonly ollama: 'missing' | 'stopped' | 'running';
	/** Installing or starting Ollama, with what it is doing now. */
	readonly busy?: string;
	readonly picks: readonly LocalPick[];
	/** Models already in Ollama that are not among the picks. */
	readonly others: readonly string[];
	readonly pulling?: { readonly tag: string; readonly pct?: number; readonly status: string };
}

export type FreeHostMessage =
	| { readonly type: 'state'; readonly cards: FreeCard[]; readonly opencode: OpenCodeState; readonly activeModel: string; readonly local?: LocalState }
	/** Scroll to a section, e.g. when opened from Run a Model on This Computer. */
	| { readonly type: 'focus'; readonly section: 'local' }
	| { readonly type: 'result'; readonly id: string; readonly ok: boolean; readonly message: string };

export type FreeWebviewMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'open'; readonly url: string }
	/** Read a key for this provider from the clipboard and connect it if it fits. */
	| { readonly type: 'paste'; readonly id: string }
	| { readonly type: 'key'; readonly id: string; readonly key: string }
	| { readonly type: 'oauth'; readonly id: string }
	| { readonly type: 'cancelOauth' }
	| { readonly type: 'disconnect'; readonly id: string }
	| { readonly type: 'installOpenCode' }
	| { readonly type: 'installOllama' }
	| { readonly type: 'startOllama' }
	| { readonly type: 'pullModel'; readonly tag: string }
	| { readonly type: 'cancelPull' }
	/** Make this model the default and open a chat with it. */
	| { readonly type: 'use'; readonly modelId: string };
