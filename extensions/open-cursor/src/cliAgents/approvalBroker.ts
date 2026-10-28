/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Extension side of the permission channel: listens on a private unix socket, receives the
 *  requests that dist/permissionServer.js relays from Claude Code, and answers them.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { LineSplitter, parseJson, rec, str } from './util';

export interface ApprovalRequest {
	readonly toolName: string;
	readonly input: Record<string, unknown>;
	readonly toolUseId?: string;
}
export type ApprovalDecision =
	| { behavior: 'allow'; updatedInput?: Record<string, unknown> }
	| { behavior: 'deny'; message: string; interrupt?: boolean };

export class ApprovalBroker {
	readonly socketPath: string;
	readonly token: string;
	private readonly server: net.Server;
	private readonly sockets = new Set<net.Socket>();

	private constructor(socketPath: string, token: string, handler: (r: ApprovalRequest) => Promise<ApprovalDecision>) {
		this.socketPath = socketPath;
		this.token = token;
		this.server = net.createServer(sock => {
			this.sockets.add(sock);
			sock.setEncoding('utf8');
			let authed = false;
			const lines = new LineSplitter(line => {
				const msg = parseJson(line);
				if (!msg) {
					return;
				}
				if (!authed) {
					if (str(msg.hello) === this.token) {
						authed = true;
					} else {
						sock.destroy();
					}
					return;
				}
				const id = msg.id;
				const req: ApprovalRequest = { toolName: str(msg.tool_name) ?? '', input: rec(msg.input) ?? {}, toolUseId: str(msg.tool_use_id) };
				handler(req).then(
					d => sock.writable && sock.write(JSON.stringify({ id, ...d }) + '\n'),
					e => sock.writable && sock.write(JSON.stringify({ id, behavior: 'deny', message: 'Approval failed: ' + String(e) }) + '\n'),
				);
			});
			sock.on('data', (d: string) => lines.push(d));
			sock.on('close', () => this.sockets.delete(sock));
			sock.on('error', () => undefined);
		});
	}

	static async start(handler: (r: ApprovalRequest) => Promise<ApprovalDecision>): Promise<ApprovalBroker> {
		const id = crypto.randomBytes(6).toString('hex');
		const p = process.platform === 'win32' ? `\\\\.\\pipe\\oc-perm-${id}` : path.join(os.tmpdir(), `oc-perm-${id}.sock`);
		const b = new ApprovalBroker(p, crypto.randomBytes(16).toString('hex'), handler);
		await new Promise<void>((resolve, reject) => {
			b.server.once('error', reject);
			b.server.listen(p, () => {
				b.server.off('error', reject);
				resolve();
			});
		});
		if (process.platform !== 'win32') {
			try {
				fs.chmodSync(p, 0o600);
			} catch {
				/* best effort */
			}
		}
		return b;
	}

	close(): void {
		for (const s of this.sockets) {
			s.destroy();
		}
		this.server.close();
		if (process.platform !== 'win32') {
			try {
				fs.unlinkSync(this.socketPath);
			} catch {
				/* already gone */
			}
		}
	}
}
