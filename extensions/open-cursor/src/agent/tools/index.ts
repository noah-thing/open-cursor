/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Tool registry: built-in tools plus MCP tools, filtered by chat mode.
 *--------------------------------------------------------------------------------------------*/

import type { ToolSchema } from '../../providers/types';
import type { Services } from '../../services';
import type { ChatMode } from '../../shared/protocol';
import { clip } from './types';
import type { ToolDef } from './types';
import { codebaseSearch } from './codebase_search';
import { deleteFile } from './delete_file';
import { editFile } from './edit_file';
import { fetchRules } from './fetch_rules';
import { fetchUrl } from './fetch_url';
import { globFileSearch } from './glob_file_search';
import { grep } from './grep';
import { listDir } from './list_dir';
import { readFile } from './read_file';
import { readLints } from './read_lints';
import { runTerminalCmd } from './run_terminal_cmd';
import { todoWrite } from './todo_write';
import { writeFile } from './write_file';

export type { ToolContext, ToolDef, ToolResult } from './types';

export const BUILTIN_TOOLS: readonly ToolDef[] = [
	readFile, listDir, globFileSearch, grep, codebaseSearch, editFile, writeFile, deleteFile,
	runTerminalCmd, readLints, todoWrite, fetchUrl, fetchRules,
];

export const MCP_PREFIX = 'mcp_';

function mcpTool(schema: ToolSchema, services: Services): ToolDef {
	return {
		schema,
		readOnly: false,
		async run(args, ctx) {
			try {
				const r = await services.mcp.callTool(schema.name, args, ctx.signal);
				return { content: r.content || (r.isError ? 'The tool failed without a message.' : '(no output)'), isError: r.isError || undefined, images: r.images };
			} catch (e) {
				return { content: `MCP tool failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
			}
		},
		title(_args, status) {
			const name = schema.name.replace(/^mcp_/, '').replace(/_/g, ' ');
			return status === 'done' ? `Ran ${clip(name, 50)}` : `Running ${clip(name, 50)}`;
		},
	};
}

export interface ToolSet {
	readonly byName: Map<string, ToolDef>;
	readonly schemas: ToolSchema[];
}

/** Tools available for a mode. ask/plan get read-only tools only; MCP tools need agent or debug mode. */
export function getToolSet(mode: ChatMode, services: Services): ToolSet {
	const byName = new Map<string, ToolDef>();
	const readOnlyMode = mode === 'ask' || mode === 'plan';
	for (const t of BUILTIN_TOOLS) {
		if (readOnlyMode && !t.readOnly) { continue; }
		if (mode === 'ask' && t.schema.name === 'todo_write') { continue; }
		byName.set(t.schema.name, t);
	}
	if (!readOnlyMode) {
		try {
			for (const s of services.mcp.getTools()) {
				if (!byName.has(s.name)) { byName.set(s.name, mcpTool(s, services)); }
			}
		} catch {
			// MCP manager not ready: run without MCP tools
		}
	}
	return { byName, schemas: [...byName.values()].map(t => t.schema) };
}
