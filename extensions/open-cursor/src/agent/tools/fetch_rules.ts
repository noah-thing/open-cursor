/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { ToolDef } from './types';

interface Args { names?: string[] }

export const fetchRules: ToolDef<Args> = {
	readOnly: true,
	schema: {
		name: 'fetch_rules',
		description: 'Load the full text of project rules listed as "agent requested" in the system prompt, by name. Call it when a rule description matches the task.',
		parameters: {
			type: 'object',
			properties: { names: { type: 'array', items: { type: 'string' }, description: 'Rule names.' } },
			required: ['names'],
		},
	},
	async run(args, ctx) {
		const names = Array.isArray(args.names) ? args.names.map(String) : [];
		const rules = await ctx.getAgentRules();
		const found = names.map(n => rules.find(r => r.name === n)).filter((r): r is NonNullable<typeof r> => !!r);
		const missing = names.filter(n => !rules.some(r => r.name === n));
		const parts = found.map(r => `## Rule: ${r.name}\n${r.content}`);
		if (missing.length) { parts.push(`Unknown rules: ${missing.join(', ')}. Available: ${rules.map(r => r.name).join(', ') || 'none'}.`); }
		return { content: parts.join('\n\n') || 'No rules requested.', isError: !found.length && names.length > 0 };
	},
	title(args, status) {
		const n = (args.names ?? []).join(', ');
		return status === 'done' ? `Loaded rules ${n}` : `Loading rules ${n}`;
	},
};
