/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { clip, str, truncateMiddle, type ToolDef } from './types';
import { msg } from './fsutil';

interface Args { query?: string; target_directories?: string[] }

export const codebaseSearch: ToolDef<Args> = {
	readOnly: true,
	schema: {
		name: 'codebase_search',
		description: 'Semantic search over the codebase: describe what you are looking for in natural language ("where is the retry logic for failed uploads"). Returns the most relevant code chunks. Use grep for exact strings.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'A complete question or description, not a single keyword.' },
				target_directories: { type: 'array', items: { type: 'string' }, description: 'Optional directories to restrict the search to.' },
			},
			required: ['query'],
		},
	},
	async run(args, ctx) {
		const query = str(args.query);
		if (!query) { return { content: 'Missing required argument: query', isError: true }; }
		try {
			const dirs = Array.isArray(args.target_directories) ? args.target_directories.filter(d => typeof d === 'string' && d) : [];
			const includeGlob = dirs.length ? (dirs.length === 1 ? `${dirs[0].replace(/\/$/, '')}/**` : `{${dirs.map(d => d.replace(/\/$/, '') + '/**').join(',')}}`) : undefined;
			const results = await ctx.services.index.search(query, { limit: 10, includeGlob, signal: ctx.signal });
			if (!results.length) { return { content: 'No results. Try grep or glob_file_search.', output: '0 results' }; }
			const out = results.map(r => `${r.path}:${r.startLine}-${r.endLine}\n${truncateMiddle(r.text, 1800)}`).join('\n\n---\n\n');
			return { content: out, output: `${results.length} results` };
		} catch (e) {
			return { content: `Codebase search failed: ${msg(e)}`, isError: true };
		}
	},
	title(args, status, r) {
		const q = clip(args.query ?? '', 50);
		return status === 'done' ? `Searched codebase \`${q}\`${r?.output ? ` · ${r.output}` : ''}` : `Searching codebase \`${q}\``;
	},
};
