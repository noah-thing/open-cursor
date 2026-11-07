/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { normalizeBase } from '../providers/http';
import { ENV_KEYS } from '../providers/catalog';
import { resolveEmbedder as resolve, type EmbedEnv, type Resolution } from './embedders';

export type { Embedder, Resolution } from './embedders';

const OLLAMA_DEFAULT = 'http://localhost:11434';

/** The same keys and server addresses the chat providers use (see providers/registry.ts). */
function editorEnv(ctx: vscode.ExtensionContext): EmbedEnv {
	const setting = (key: string) => vscode.workspace.getConfiguration('openCursor').get<string>(key, '').trim();
	return {
		async key(provider) {
			const stored = (await ctx.secrets.get(`openCursor.key.${provider}`))?.trim();
			if (stored) { return stored; }
			for (const name of ENV_KEYS[provider] ?? []) {
				const v = process.env[name]?.trim();
				if (v) { return v; }
			}
			return undefined;
		},
		base(provider) {
			switch (provider) {
				case 'openai': {
					const v = setting('providers.openai.baseUrl') || process.env.OPENAI_BASE_URL?.trim() || '';
					return v ? normalizeBase(v) : '';
				}
				case 'ollama': {
					let v = setting('providers.ollama.baseUrl');
					const env = process.env.OLLAMA_HOST?.trim();
					if ((!v || v.replace(/\/+$/, '') === OLLAMA_DEFAULT) && env) { v = env; }
					return normalizeBase(v || OLLAMA_DEFAULT, { stripV1: true });
				}
				case 'lmstudio':
					return normalizeBase(setting('providers.lmstudio.baseUrl') || 'http://localhost:1234/v1', { v1: true });
				case 'custom': {
					const v = setting('providers.custom.baseUrl');
					return v ? normalizeBase(v, { v1: true }) : '';
				}
			}
		},
	};
}

/** `setting` is `auto`, `provider` or `provider/model` (openai | google | ollama | lmstudio | custom). */
export function resolveEmbedder(ctx: vscode.ExtensionContext, setting: string): Promise<Resolution> {
	return resolve(editorEnv(ctx), setting);
}
