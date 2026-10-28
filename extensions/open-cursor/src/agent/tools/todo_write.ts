/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { TodoItem } from '../../shared/protocol';
import type { ToolDef } from './types';

interface Args { todos?: { id?: string; content?: string; status?: string }[]; merge?: boolean }

const STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;

export function mergeTodos(current: readonly TodoItem[], incoming: readonly TodoItem[], merge: boolean): TodoItem[] {
	if (!merge) { return incoming.slice(); }
	const byId = new Map(incoming.map(t => [t.id, t]));
	const out = current.map(t => byId.get(t.id) ?? t);
	for (const t of incoming) {
		if (!current.some(c => c.id === t.id)) { out.push(t); }
	}
	return out;
}

export const todoWrite: ToolDef<Args> = {
	readOnly: true, // changes only the chat's task list, never the workspace
	schema: {
		name: 'todo_write',
		description: 'Create and update a task list for multi-step work (3+ steps). Keep exactly one task in_progress; mark tasks completed as soon as they are done. Skip it for simple requests.',
		parameters: {
			type: 'object',
			properties: {
				todos: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							content: { type: 'string' },
							status: { type: 'string', enum: [...STATUSES] },
						},
						required: ['id', 'content', 'status'],
					},
				},
				merge: { type: 'boolean', description: 'true: update/add by id and keep the others. false: replace the whole list.' },
			},
			required: ['todos', 'merge'],
		},
	},
	async run(args, ctx) {
		if (!Array.isArray(args.todos)) { return { content: 'todos must be an array.', isError: true }; }
		const incoming: TodoItem[] = [];
		args.todos.forEach((t, i) => {
			const status = (STATUSES as readonly string[]).includes(t.status ?? '') ? (t.status as TodoItem['status']) : 'pending';
			if (typeof t.content === 'string' && t.content.trim()) {
				incoming.push({ id: t.id ? String(t.id) : String(i + 1), content: t.content.trim(), status });
			}
		});
		const next = mergeTodos(ctx.getTodos(), incoming, args.merge === true);
		ctx.setTodos(next);
		const done = next.filter(t => t.status === 'completed').length;
		return { content: `Todo list updated (${done}/${next.length} completed).`, output: `${done}/${next.length}` };
	},
	title(_args, status, r) {
		return status === 'done' ? `Updated todos${r?.output ? ` · ${r.output}` : ''}` : 'Updating todos';
	},
};
