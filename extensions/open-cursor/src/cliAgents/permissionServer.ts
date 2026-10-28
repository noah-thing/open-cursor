/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Tiny stdio MCP server exposing one tool, `approve`, used as Claude Code's
 *  `--permission-prompt-tool mcp__oc__approve`. Claude Code calls it for every tool use that needs
 *  permission; we relay the request to the extension over a local socket (JSON lines) and return
 *  the extension's decision. Standalone: bundled to dist/permissionServer.js, no imports from the
 *  extension, only node built-ins.
 *
 *  Env: OC_PERM_SOCKET (unix socket / named pipe path), OC_PERM_TOKEN (shared secret).
 *--------------------------------------------------------------------------------------------*/

import * as net from 'net';
import * as readline from 'readline';

type Json = Record<string, unknown>;

const socketPath = process.env.OC_PERM_SOCKET ?? '';
const token = process.env.OC_PERM_TOKEN ?? '';

let sock: net.Socket | undefined;
let nextId = 1;
const pending = new Map<number, (r: Json) => void>();

function send(msg: Json): void {
	process.stdout.write(JSON.stringify(msg) + '\n');
}

function connect(): Promise<net.Socket> {
	if (sock && !sock.destroyed) {
		return Promise.resolve(sock);
	}
	return new Promise((resolve, reject) => {
		const s = net.createConnection(socketPath);
		s.setEncoding('utf8');
		s.once('error', reject);
		s.once('connect', () => {
			s.off('error', reject);
			s.write(JSON.stringify({ hello: token }) + '\n');
			const rl = readline.createInterface({ input: s });
			rl.on('line', line => {
				try {
					const r = JSON.parse(line) as Json;
					const cb = pending.get(r.id as number);
					if (cb) {
						pending.delete(r.id as number);
						cb(r);
					}
				} catch {
					/* ignore garbage */
				}
			});
			s.on('close', () => {
				for (const [id, cb] of pending) {
					cb({ id, behavior: 'deny', message: 'OpenCursor approval channel closed.' });
				}
				pending.clear();
				sock = undefined;
			});
			s.on('error', () => undefined);
			sock = s;
			resolve(s);
		});
	});
}

async function ask(args: Json): Promise<Json> {
	try {
		const s = await connect();
		const id = nextId++;
		return await new Promise<Json>(resolve => {
			pending.set(id, resolve);
			s.write(JSON.stringify({ id, tool_name: args.tool_name, input: args.input ?? {}, tool_use_id: args.tool_use_id }) + '\n');
		});
	} catch {
		return { behavior: 'deny', message: 'OpenCursor approval channel is unavailable.' };
	}
}

async function handle(msg: Json): Promise<void> {
	const id = msg.id as number | string | undefined;
	const method = msg.method as string | undefined;
	if (method === undefined || id === undefined) {
		return; // notification or response
	}
	switch (method) {
		case 'initialize': {
			const p = (msg.params ?? {}) as Json;
			send({ jsonrpc: '2.0', id, result: { protocolVersion: p.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'oc', version: '1.0.0' } } });
			return;
		}
		case 'ping':
			send({ jsonrpc: '2.0', id, result: {} });
			return;
		case 'tools/list':
			send({
				jsonrpc: '2.0',
				id,
				result: {
					tools: [
						{
							name: 'approve',
							description: 'Ask the OpenCursor user to approve a tool use.',
							inputSchema: {
								type: 'object',
								properties: { tool_name: { type: 'string' }, input: { type: 'object', additionalProperties: true }, tool_use_id: { type: 'string' } },
								required: ['tool_name', 'input'],
							},
						},
					],
				},
			});
			return;
		case 'tools/call': {
			const p = (msg.params ?? {}) as Json;
			const a = (p.arguments ?? {}) as Json;
			const r = await ask(a);
			// The permission prompt tool contract: a JSON text block of {behavior, updatedInput | message}.
			const decision =
				r.behavior === 'allow'
					? { behavior: 'allow', updatedInput: r.updatedInput ?? a.input ?? {} }
					: { behavior: 'deny', message: typeof r.message === 'string' ? r.message : 'Denied by the user.', ...(r.interrupt ? { interrupt: true } : {}) };
			send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
			return;
		}
		default:
			send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
	}
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
	if (!line.trim()) {
		return;
	}
	try {
		void handle(JSON.parse(line) as Json);
	} catch {
		/* ignore */
	}
});
rl.on('close', () => process.exit(0));
