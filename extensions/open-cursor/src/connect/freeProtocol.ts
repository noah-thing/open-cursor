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

export type FreeHostMessage =
	| { readonly type: 'state'; readonly cards: FreeCard[]; readonly opencode: OpenCodeState; readonly activeModel: string }
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
	/** Make this model the default and open a chat with it. */
	| { readonly type: 'use'; readonly modelId: string };
