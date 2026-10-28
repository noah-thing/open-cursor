/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { ToolSchema } from '../../providers/types';
import type { Services } from '../../services';
import type { ChatMode, TodoItem, ToolPart, ToolStatus } from '../../shared/protocol';

export interface ToolResult {
	/** Text sent back to the model. */
	content: string;
	isError?: boolean;
	images?: { mediaType: string; data: string }[];
	/** Shown in the collapsed body of the UI row; defaults to `content`. */
	output?: string;
	edit?: ToolPart['edit'];
}

export interface ToolContext {
	readonly services: Services;
	readonly chatId: string;
	readonly mode: ChatMode;
	readonly signal: AbortSignal;
	/** Checkpoint of the user message this turn belongs to (undefined = capture disabled). */
	readonly checkpointId?: string;
	/** Ask the user before a mutating tool touches a path outside the workspace. */
	confirmOutsideWorkspace(absPath: string, action: string): Promise<boolean>;
	getTodos(): TodoItem[];
	setTodos(todos: TodoItem[]): void;
	/** Agent requested rules (description only rules) with content, by name. */
	getAgentRules(): Promise<{ name: string; description?: string; content: string }[]>;
	/** Live output for long running tools (terminal). */
	onProgress?(output: string): void;
}

export interface ToolDef<A = any> {
	readonly schema: ToolSchema;
	/** Readonly tools may run in parallel and are allowed in ask/plan mode. */
	readonly readOnly: boolean;
	run(args: A, ctx: ToolContext): Promise<ToolResult>;
	/** One line for the UI row. `result` is set once the tool finished. */
	title(args: A, status: ToolStatus, result?: ToolResult): string;
}

export function str(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}

export function num(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
}

export function bool(v: unknown): boolean | undefined {
	return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined;
}

export function baseName(p: string | undefined): string {
	if (!p) { return ''; }
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? p;
}

export function clip(s: string, n: number): string {
	const one = s.replace(/\s+/g, ' ').trim();
	return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/** Keep head and tail of an oversized string. */
export function truncateMiddle(s: string, max: number): string {
	if (s.length <= max) { return s; }
	const head = Math.floor(max * 0.7);
	const tail = max - head;
	return `${s.slice(0, head)}\n[... ${s.length - max} characters omitted ...]\n${s.slice(s.length - tail)}`;
}
