/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Checkpoints: before-contents of every file the agent touched, per user message, stored as
 *  content-addressed blobs under the extension storage dir. Restore rewinds files to the earliest
 *  captured state across the target checkpoint and every later one.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import type { ICheckpoints } from '../services';
import { planRestore, type CheckpointRecord } from './checkpointLogic';
import { deleteOnDisk, writeDocument } from './fileOps';

export interface CheckpointOptions {
	/** Called before files are rewritten so pending review state for them can be dropped. */
	onRestore?(uris: vscode.Uri[]): void;
}

interface Rec {
	id: string;
	messageId: string;
	seq: number;
	files: Record<string, string | null>;
}

export function createCheckpoints(ctx: vscode.ExtensionContext, options: CheckpointOptions = {}): ICheckpoints {
	const root = vscode.Uri.joinPath(ctx.storageUri ?? ctx.globalStorageUri, 'checkpoints');
	const blobsDir = vscode.Uri.joinPath(root, 'blobs');
	const chats = new Map<string, Rec[]>();
	const writtenBlobs = new Set<string>();
	let io: Promise<unknown> = Promise.resolve();
	let seqCounter = Date.now();

	const queue = (fn: () => Promise<void>): void => {
		io = io.then(fn).catch(e => console.error('[open-cursor] checkpoint write failed', e));
	};
	const chatDir = (chatId: string) => vscode.Uri.joinPath(root, safe(chatId));
	const recUri = (chatId: string, id: string) => vscode.Uri.joinPath(chatDir(chatId), `${safe(id)}.json`);
	const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
	const find = (id: string): { chatId: string; rec: Rec } | undefined => {
		for (const [chatId, recs] of chats) {
			const rec = recs.find(r => r.id === id);
			if (rec) { return { chatId, rec }; }
		}
		return undefined;
	};

	function saveRec(chatId: string, rec: Rec): void {
		queue(async () => {
			await vscode.workspace.fs.createDirectory(chatDir(chatId));
			await vscode.workspace.fs.writeFile(recUri(chatId, rec.id), Buffer.from(JSON.stringify(rec), 'utf8'));
		});
	}

	function saveBlob(hash: string, content: string): void {
		if (writtenBlobs.has(hash)) { return; }
		writtenBlobs.add(hash);
		queue(async () => {
			await vscode.workspace.fs.createDirectory(blobsDir);
			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(blobsDir, hash), Buffer.from(content, 'utf8'));
		});
	}

	async function load(chatId: string): Promise<Rec[]> {
		const recs = chats.get(chatId) ?? [];
		try {
			for (const [name, type] of await vscode.workspace.fs.readDirectory(chatDir(chatId))) {
				if (type !== vscode.FileType.File || !name.endsWith('.json')) { continue; }
				try {
					const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(chatDir(chatId), name));
					const rec = JSON.parse(Buffer.from(raw).toString('utf8')) as Rec;
					if (!recs.some(r => r.id === rec.id)) { recs.push(rec); }
				} catch { /* corrupt record, skip */ }
			}
		} catch { /* no such chat */ }
		recs.sort((a, b) => a.seq - b.seq);
		chats.set(chatId, recs);
		return recs;
	}

	function begin(chatId: string, messageId: string): string {
		const rec: Rec = { id: randomUUID(), messageId, seq: ++seqCounter, files: {} };
		const recs = chats.get(chatId);
		// Older on-disk records are merged lazily in `restore`; seq is monotonic by time so ordering holds.
		if (recs) { recs.push(rec); } else { chats.set(chatId, [rec]); }
		saveRec(chatId, rec);
		return rec.id;
	}

	function capture(checkpointId: string, uri: vscode.Uri, contentBefore: string | undefined): void {
		const hit = find(checkpointId);
		if (!hit) { return; }
		const key = uri.toString();
		if (key in hit.rec.files) { return; } // first capture within a checkpoint wins
		if (contentBefore === undefined) {
			hit.rec.files[key] = null;
		} else {
			const hash = createHash('sha1').update(contentBefore, 'utf8').digest('hex');
			hit.rec.files[key] = hash;
			saveBlob(hash, contentBefore);
		}
		saveRec(hit.chatId, hit.rec);
	}

	async function restore(chatId: string, checkpointId: string): Promise<{ files: number }> {
		await io;
		let recs = chats.get(chatId);
		if (!recs || !recs.some(r => r.id === checkpointId)) {
			recs = await load(chatId);
		}
		const plan = planRestore(recs as CheckpointRecord[], checkpointId);
		if (!plan) { return { files: 0 }; }
		const uris = [...plan.keys()].map(k => vscode.Uri.parse(k));
		options.onRestore?.(uris);
		let count = 0;
		for (const [key, hash] of plan) {
			const uri = vscode.Uri.parse(key);
			try {
				if (hash === null) {
					await deleteOnDisk(uri);
				} else {
					const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(blobsDir, hash));
					await writeDocument(uri, Buffer.from(raw).toString('utf8'));
				}
				count++;
			} catch (e) {
				console.error('[open-cursor] checkpoint restore failed for', key, e);
			}
		}
		// Later checkpoints have been undone; the target stays so it can be restored again.
		const idx = recs.findIndex(r => r.id === checkpointId);
		const dropped = recs.splice(idx + 1);
		queue(async () => {
			for (const r of dropped) {
				try { await vscode.workspace.fs.delete(recUri(chatId, r.id)); } catch { /* gone */ }
			}
		});
		return { files: count };
	}

	function dispose(chatId: string): void {
		chats.delete(chatId);
		queue(async () => {
			try { await vscode.workspace.fs.delete(chatDir(chatId), { recursive: true }); } catch { /* gone */ }
		});
	}

	return { begin, capture, restore, dispose };
}
