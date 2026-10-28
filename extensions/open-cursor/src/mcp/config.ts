/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Pure MCP config helpers (no vscode import): parsing, merging, interpolation, tool naming.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';

export interface StdioServerConfig {
	readonly command: string;
	readonly args?: string[];
	readonly env?: Record<string, string>;
	readonly cwd?: string;
	readonly disabled?: boolean;
}
export interface HttpServerConfig {
	readonly url: string;
	readonly headers?: Record<string, string>;
	readonly disabled?: boolean;
}
export type ServerConfig = StdioServerConfig | HttpServerConfig;

export interface ResolvedServer {
	readonly name: string;
	readonly config: ServerConfig;
	readonly source: string;
}

export function isHttp(c: ServerConfig): c is HttpServerConfig {
	return typeof (c as HttpServerConfig).url === 'string';
}

/** Parse one mcp.json text. Tolerates comments and trailing commas. Returns [] on invalid content. */
/** Remove // and /* *\/ comments outside strings, and trailing commas. */
export function stripJsonc(text: string): string {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') { j += text[j] === '\\' ? 2 : 1; }
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') { i++; }
		} else if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end === -1 ? text.length : end + 2;
		} else {
			out += c;
			i++;
		}
	}
	return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parseConfig(text: string): { name: string; config: ServerConfig }[] {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		try {
			json = JSON.parse(stripJsonc(text));
		} catch {
			return [];
		}
	}
	const servers = (json as { mcpServers?: unknown } | null)?.mcpServers;
	if (!servers || typeof servers !== 'object') {
		return [];
	}
	const out: { name: string; config: ServerConfig }[] = [];
	for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
		if (!raw || typeof raw !== 'object') { continue; }
		const r = raw as Record<string, unknown>;
		const disabled = r.disabled === true;
		const strMap = (v: unknown): Record<string, string> | undefined => {
			if (!v || typeof v !== 'object') { return undefined; }
			const m: Record<string, string> = {};
			for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
				if (val !== undefined && val !== null) { m[k] = String(val); }
			}
			return m;
		};
		if (typeof r.url === 'string') {
			out.push({ name, config: { url: r.url, headers: strMap(r.headers), disabled } });
		} else if (typeof r.command === 'string') {
			const args = Array.isArray(r.args) ? r.args.map(String) : undefined;
			out.push({ name, config: { command: r.command, args, env: strMap(r.env), cwd: typeof r.cwd === 'string' ? r.cwd : undefined, disabled } });
		}
	}
	return out;
}

/** Later layers win by server name. `layers` are in merge order (lowest priority first). */
export function mergeLayers(layers: readonly { source: string; text: string }[]): ResolvedServer[] {
	const byName = new Map<string, ResolvedServer>();
	for (const layer of layers) {
		for (const { name, config } of parseConfig(layer.text)) {
			byName.set(name, { name, config, source: layer.source });
		}
	}
	return [...byName.values()];
}

export interface InterpolationVars {
	readonly workspaceFolder?: string;
	readonly home: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export function interpolate(value: string, vars: InterpolationVars): string {
	return value
		.replace(/\$\{env:([^}]+)\}/g, (_, n: string) => vars.env[n] ?? '')
		.replace(/\$\{workspaceFolder\}/g, vars.workspaceFolder ?? '')
		.replace(/\$\{workspaceFolderBasename\}/g, vars.workspaceFolder ? vars.workspaceFolder.split(/[\\/]/).pop() ?? '' : '')
		.replace(/\$\{userHome\}/g, vars.home);
}

export function interpolateConfig(c: ServerConfig, vars: InterpolationVars): ServerConfig {
	const map = (m?: Record<string, string>) => m && Object.fromEntries(Object.entries(m).map(([k, v]) => [k, interpolate(v, vars)]));
	if (isHttp(c)) {
		return { url: interpolate(c.url, vars), headers: map(c.headers), disabled: c.disabled };
	}
	return {
		command: interpolate(c.command, vars),
		args: c.args?.map(a => interpolate(a, vars)),
		env: map(c.env),
		cwd: c.cwd ? interpolate(c.cwd, vars) : undefined,
		disabled: c.disabled,
	};
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

/** `mcp_<server>_<tool>`, sanitised to [a-zA-Z0-9_-], max 64 chars (a short hash keeps truncated names unique). */
export function prefixedToolName(server: string, tool: string): string {
	const full = `mcp_${sanitize(server)}_${sanitize(tool)}`;
	if (full.length <= 64) { return full; }
	const h = createHash('sha1').update(`${server}\u0000${tool}`).digest('hex').slice(0, 6);
	return `${full.slice(0, 57)}_${h}`;
}
