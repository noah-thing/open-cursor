/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  MCP client manager: Cursor-compatible mcp.json files, stdio + streamable HTTP/SSE servers,
 *  lazy start, hot reload, namespaced tools.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { IMcpManager, McpServerState } from '../services';
import type { ToolSchema } from '../providers/types';
import { interpolateConfig, isHttp, mergeLayers, prefixedToolName, type ResolvedServer, type ServerConfig } from './config';

const DISABLED_KEY = 'openCursor.mcp.enabledOverrides';
const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 10 * 60_000;

interface McpTool {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

interface Running {
	name: string;
	resolved: ResolvedServer;
	sig: string;
	status: McpServerState['status'];
	error?: string;
	transport: McpServerState['transport'];
	client?: Client;
	tools: McpTool[];
	/** Resolves when the first connect attempt finished (ready, error or disabled). */
	started?: Promise<void>;
	generation: number;
}

function configFiles(): { source: string; file: string }[] {
	const home = os.homedir();
	const files = [
		path.join(home, '.cursor', 'mcp.json'),
		path.join(home, '.open-cursor', 'mcp.json'),
	];
	for (const f of vscode.workspace.workspaceFolders ?? []) {
		files.push(path.join(f.uri.fsPath, '.cursor', 'mcp.json'), path.join(f.uri.fsPath, '.open-cursor', 'mcp.json'));
	}
	return files.map(file => ({ source: file, file }));
}

let loginPath: Promise<string | undefined> | undefined;
/** macOS GUI apps lack the user's shell PATH; ask a login shell once. */
function resolveLoginPath(): Promise<string | undefined> {
	loginPath ??= new Promise(resolve => {
		if (process.platform === 'win32') { return resolve(undefined); }
		const shell = process.env.SHELL || ['/bin/zsh', '/bin/bash', '/bin/sh'].find(f => fs.existsSync(f)) || '/bin/sh';
		try {
			execFile(shell, ['-ilc', 'echo __OC_PATH__${PATH}__OC_PATH__'], { timeout: 3000, env: process.env }, (err, stdout) => {
				const m = /__OC_PATH__(.*?)__OC_PATH__/s.exec(String(stdout ?? ''));
				resolve(!err || m ? m?.[1]?.trim() || undefined : undefined);
			});
		} catch {
			resolve(undefined);
		}
	});
	return loginPath;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
		p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
	});
}

function headerFetch(headers: Record<string, string> | undefined): typeof fetch | undefined {
	if (!headers || !Object.keys(headers).length) { return undefined; }
	return (input, init) => {
		const h = new Headers(init?.headers);
		for (const [k, v] of Object.entries(headers)) { h.set(k, v); }
		return fetch(input, { ...init, headers: h });
	};
}

export function createMcpManager(ctx: vscode.ExtensionContext): IMcpManager {
	const onDidChange = new vscode.EventEmitter<void>();
	const servers = new Map<string, Running>();
	let toolIndex = new Map<string, { server: Running; tool: McpTool }>();
	let started = false; // true once anything asked for tools; reloads then keep servers running
	let generation = 0;
	let disposed = false;

	const overrides = (): Record<string, boolean> => ctx.globalState.get<Record<string, boolean>>(DISABLED_KEY) ?? {};
	const isEnabled = (r: ResolvedServer) => overrides()[r.name] ?? !(r.config.disabled === true);

	function fire(): void {
		rebuildToolIndex();
		onDidChange.fire();
	}

	function rebuildToolIndex(): void {
		const idx = new Map<string, { server: Running; tool: McpTool }>();
		for (const s of servers.values()) {
			if (s.status !== 'ready') { continue; }
			for (const tool of s.tools) {
				let name = prefixedToolName(s.name, tool.name);
				while (idx.has(name)) { name = prefixedToolName(s.name, tool.name + '_' + idx.size); }
				idx.set(name, { server: s, tool });
			}
		}
		toolIndex = idx;
	}

	function readResolved(): ResolvedServer[] {
		const layers = configFiles().map(({ source, file }) => {
			let text = '';
			try { text = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
			return { source, text };
		});
		const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const vars = { workspaceFolder: wf, home: os.homedir(), env: process.env };
		return mergeLayers(layers).map(r => ({ ...r, config: interpolateConfig(r.config, vars) }));
	}

	async function connect(cfg: ServerConfig): Promise<{ client: Client; transport: McpServerState['transport'] }> {
		const mk = () => new Client({ name: 'open-cursor', version: '0.1.0' }, { capabilities: {} });
		if (!isHttp(cfg)) {
			const lp = await resolveLoginPath();
			const env: Record<string, string> = {};
			for (const [k, v] of Object.entries(process.env)) { if (typeof v === 'string') { env[k] = v; } }
			if (lp) { env.PATH = lp; }
			Object.assign(env, cfg.env);
			const transport = new StdioClientTransport({
				command: cfg.command,
				args: cfg.args ?? [],
				env,
				cwd: cfg.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
				stderr: 'pipe',
			});
			transport.stderr?.on('data', () => undefined); // drain so the child never blocks
			const client = mk();
			await withTimeout(client.connect(transport as Transport), CONNECT_TIMEOUT_MS, 'connect');
			return { client, transport: 'stdio' };
		}
		const url = new URL(cfg.url);
		const f = headerFetch(cfg.headers);
		try {
			const client = mk();
			await withTimeout(client.connect(new StreamableHTTPClientTransport(url, { fetch: f }) as Transport), CONNECT_TIMEOUT_MS, 'connect');
			return { client, transport: 'http' };
		} catch (first) {
			try {
				const client = mk();
				await withTimeout(client.connect(new SSEClientTransport(url, { fetch: f }) as Transport), CONNECT_TIMEOUT_MS, 'connect');
				return { client, transport: 'sse' };
			} catch {
				throw first;
			}
		}
	}

	async function refreshTools(s: Running): Promise<void> {
		if (!s.client) { return; }
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		do {
			const res = await s.client.listTools(cursor ? { cursor } : undefined);
			for (const t of res.tools) {
				tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> });
			}
			cursor = res.nextCursor;
		} while (cursor);
		s.tools = tools;
	}

	function startServer(s: Running): Promise<void> {
		if (s.started) { return s.started; }
		s.status = 'starting';
		const gen = s.generation;
		s.started = (async () => {
			try {
				const { client, transport } = await connect(s.resolved.config);
				if (gen !== s.generation || disposed) {
					await client.close().catch(() => undefined);
					return;
				}
				s.client = client;
				s.transport = transport;
				client.onclose = () => {
					if (s.client === client && s.status === 'ready') {
						s.status = 'error';
						s.error = 'Server connection closed';
						s.client = undefined;
						s.tools = [];
						s.started = undefined;
						fire();
					}
				};
				client.onerror = () => undefined;
				client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
					try { await refreshTools(s); fire(); } catch { /* keep old list */ }
				});
				await refreshTools(s);
				s.status = 'ready';
				s.error = undefined;
			} catch (e) {
				if (gen !== s.generation) { return; }
				s.status = 'error';
				s.error = e instanceof Error ? e.message : String(e);
				s.tools = [];
			}
			fire();
		})();
		fire();
		return s.started;
	}

	async function stopServer(s: Running): Promise<void> {
		s.generation++;
		const c = s.client;
		s.client = undefined;
		s.tools = [];
		s.started = undefined;
		if (c) { await c.close().catch(() => undefined); }
	}

	/** Diff the config against running servers: keep unchanged ones, restart changed, drop removed. */
	async function sync(): Promise<void> {
		const resolved = readResolved();
		const seen = new Set<string>();
		for (const r of resolved) {
			seen.add(r.name);
			const sig = JSON.stringify(r.config) + '|' + r.source;
			const enabled = isEnabled(r);
			let s = servers.get(r.name);
			if (s && s.sig !== sig) {
				await stopServer(s);
				servers.delete(r.name);
				s = undefined;
			}
			if (!s) {
				s = { name: r.name, resolved: r, sig, status: enabled ? 'starting' : 'disabled', transport: isHttp(r.config) ? 'http' : 'stdio', tools: [], generation: generation++ };
				if (!enabled) { s.status = 'disabled'; }
				servers.set(r.name, s);
			} else if (!enabled && s.status !== 'disabled') {
				await stopServer(s);
				s.status = 'disabled';
				s.error = undefined;
			} else if (enabled && s.status === 'disabled') {
				s.status = 'starting';
			}
			if (started && enabled && !s.started) { void startServer(s); }
		}
		for (const [name, s] of [...servers]) {
			if (!seen.has(name)) {
				await stopServer(s);
				servers.delete(name);
			}
		}
		fire();
	}

	let syncing: Promise<void> | undefined;
	const syncOnce = (): Promise<void> => {
		syncing = (syncing ?? Promise.resolve()).then(sync).catch(e => console.error('[open-cursor] mcp sync failed', e));
		return syncing;
	};

	function ensureStarted(): void {
		if (started) { return; }
		started = true;
		for (const s of servers.values()) {
			if (s.status !== 'disabled') { void startServer(s); }
		}
	}

	// ---- IMcpManager -----------------------------------------------------------------------
	function getServers(): McpServerState[] {
		return [...servers.values()].map(s => ({
			name: s.name,
			status: s.status,
			error: s.error,
			toolCount: s.tools.length,
			source: s.resolved.source,
			transport: s.transport,
		}));
	}

	function getTools(): ToolSchema[] {
		ensureStarted();
		return [...toolIndex].map(([name, { server, tool }]) => ({
			name,
			description: `[MCP ${server.name}] ${tool.description ?? tool.name}`,
			parameters: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
		}));
	}

	async function callTool(prefixedName: string, args: unknown, signal: AbortSignal) {
		await syncing;
		ensureStarted();
		let entry = toolIndex.get(prefixedName);
		if (!entry) {
			// Servers may still be connecting on the first call.
			await Promise.all([...servers.values()].map(s => s.started).filter(Boolean));
			entry = toolIndex.get(prefixedName);
		}
		if (!entry || !entry.server.client) {
			return { content: `MCP tool not available: ${prefixedName}`, isError: true };
		}
		try {
			const res = await entry.server.client.callTool(
				{ name: entry.tool.name, arguments: (args && typeof args === 'object' ? args : {}) as Record<string, unknown> },
				undefined,
				{ signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
			);
			const texts: string[] = [];
			const images: { mediaType: string; data: string }[] = [];
			const parts = Array.isArray((res as { content?: unknown }).content) ? (res as { content: Record<string, any>[] }).content : [];
			for (const p of parts) {
				if (p.type === 'text') { texts.push(String(p.text)); }
				else if (p.type === 'image') { images.push({ mediaType: String(p.mimeType), data: String(p.data) }); }
				else if (p.type === 'resource' && p.resource) {
					if (typeof p.resource.text === 'string') { texts.push(p.resource.text); }
					else if (typeof p.resource.blob === 'string' && String(p.resource.mimeType ?? '').startsWith('image/')) {
						images.push({ mediaType: String(p.resource.mimeType), data: p.resource.blob });
					} else { texts.push(`[resource ${p.resource.uri ?? ''}]`); }
				} else if (p.type === 'resource_link') { texts.push(`[resource ${p.uri ?? ''}]`); }
			}
			const structured = (res as { structuredContent?: unknown }).structuredContent;
			if (!texts.length && !images.length && structured !== undefined) { texts.push(JSON.stringify(structured)); }
			return { content: texts.join('\n'), isError: (res as { isError?: boolean }).isError === true, ...(images.length ? { images } : {}) };
		} catch (e) {
			return { content: e instanceof Error ? e.message : String(e), isError: true };
		}
	}

	async function setEnabled(name: string, enabled: boolean): Promise<void> {
		await ctx.globalState.update(DISABLED_KEY, { ...overrides(), [name]: enabled });
		await syncOnce();
	}

	async function reload(): Promise<void> {
		for (const s of servers.values()) { await stopServer(s); }
		servers.clear();
		await syncOnce();
	}

	async function openConfig(scope: 'user' | 'workspace'): Promise<void> {
		let file: string;
		if (scope === 'user') {
			file = path.join(os.homedir(), '.open-cursor', 'mcp.json');
		} else {
			const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!wf) {
				void vscode.window.showWarningMessage('Open a folder to create a workspace MCP config.');
				return;
			}
			const own = path.join(wf, '.open-cursor', 'mcp.json');
			const cursorFile = path.join(wf, '.cursor', 'mcp.json');
			file = !fs.existsSync(own) && fs.existsSync(cursorFile) ? cursorFile : own;
		}
		if (!fs.existsSync(file)) {
			await fs.promises.mkdir(path.dirname(file), { recursive: true });
			await fs.promises.writeFile(file, JSON.stringify({ mcpServers: {} }, null, 2) + '\n', 'utf8');
		}
		await vscode.window.showTextDocument(vscode.Uri.file(file));
	}

	// ---- wiring ----------------------------------------------------------------------------
	let reloadTimer: ReturnType<typeof setTimeout> | undefined;
	const scheduleSync = () => {
		clearTimeout(reloadTimer);
		reloadTimer = setTimeout(() => void syncOnce(), 500);
	};
	const watchers = configFiles().map(({ file }) => {
		const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
		w.onDidChange(scheduleSync);
		w.onDidCreate(scheduleSync);
		w.onDidDelete(scheduleSync);
		return w;
	});

	const warmup = setTimeout(() => ensureStarted(), 3000);
	void syncOnce();

	ctx.subscriptions.push(
		onDidChange,
		...watchers,
		vscode.workspace.onDidChangeWorkspaceFolders(scheduleSync),
		vscode.commands.registerCommand('openCursor.mcp.reload', () => reload()),
		vscode.commands.registerCommand('openCursor.mcp.openUserConfig', () => openConfig('user')),
		vscode.commands.registerCommand('openCursor.mcp.openWorkspaceConfig', () => openConfig('workspace')),
		{
			dispose() {
				disposed = true;
				clearTimeout(warmup);
				clearTimeout(reloadTimer);
				for (const s of servers.values()) { void stopServer(s); }
			},
		},
	);

	return { onDidChange: onDidChange.event, getServers, getTools, callTool, setEnabled, reload, openConfig };
}
