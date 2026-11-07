import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { assert, done, test } from '../../agent/test/harness';
import { NO_EMBEDDER, OPENAI_BASE, compatEmbedder, pickEmbeddingModel, resolveEmbedder, serverMessage, type EmbedEnv, type KeyedProvider, type ServerProvider } from '../embedders';

interface Seen { method: string; url: string; auth?: string; body?: any }

/** A fake model server: OpenAI-compatible /v1 routes plus Ollama's /api routes. */
async function fakeServer(opts: { models?: string[]; base64?: boolean; status?: number; ollama?: string[] } = {}) {
	const seen: Seen[] = [];
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', c => { raw += c; });
		req.on('end', () => {
			const body = raw ? JSON.parse(raw) : undefined;
			seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
			const send = (code: number, json: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
			if (opts.status) { return send(opts.status, { error: { message: 'model not found' } }); }
			if (req.url === '/v1/models') { return send(200, { object: 'list', data: (opts.models ?? []).map(id => ({ id, object: 'model' })) }); }
			if (req.url === '/v1/embeddings') {
				const vecs = (body.input as string[]).map((t, i) => [t.length, i + 1, 0]);
				const data = vecs.map((v, i) => ({
					index: i, object: 'embedding',
					embedding: opts.base64 ? Buffer.from(new Float32Array(v).buffer).toString('base64') : v,
				})).reverse();
				return send(200, { object: 'list', data, model: body.model });
			}
			if (req.url === '/api/tags' && opts.ollama) { return send(200, { models: opts.ollama.map(name => ({ name })) }); }
			if (req.url === '/api/embed' && opts.ollama) { return send(200, { embeddings: (body.input as string[]).map(() => [3, 4]) }); }
			send(404, { error: 'not found' });
		});
	});
	await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
	const port = (server.address() as AddressInfo).port;
	return { seen, root: `http://127.0.0.1:${port}`, base: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>(r => server.close(() => r())) };
}

async function closedPort(): Promise<string> {
	const s = http.createServer();
	await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
	const port = (s.address() as AddressInfo).port;
	await new Promise<void>(r => s.close(() => r()));
	return `http://127.0.0.1:${port}`;
}

async function env(o: { keys?: Partial<Record<KeyedProvider, string>>; bases?: Partial<Record<ServerProvider, string>> } = {}): Promise<EmbedEnv> {
	const dead = await closedPort();
	return {
		key: async p => o.keys?.[p],
		base: p => o.bases?.[p] ?? (p === 'ollama' ? dead : p === 'lmstudio' ? dead + '/v1' : ''),
	};
}

const signal = new AbortController().signal;
const close = (a: Float32Array, b: number[]) => a.length === b.length && b.every((x, i) => Math.abs(a[i] - x) < 1e-6);

test('custom/<model> embeds through an OpenAI-compatible server, in input order, with the key', async () => {
	const s = await fakeServer();
	try {
		const r = await resolveEmbedder(await env({ bases: { custom: s.base }, keys: { custom: 'sk-local' } }), 'custom/embeddinggemma2');
		assert.ok(r.embedder, r.problem);
		assert.strictEqual(r.embedder.remote, undefined, 'a server on this machine is local');
		const v = await r.embedder.embed(['abc', 'abcdef'], 'doc', signal);
		const post = s.seen.find(x => x.url === '/v1/embeddings')!;
		assert.strictEqual(post.body.model, 'embeddinggemma2');
		assert.strictEqual(post.auth, 'Bearer sk-local');
		assert.deepStrictEqual(post.body.input, ['abc', 'abcdef']);
		assert.ok(close(v[0], [3 / Math.hypot(3, 1), 1 / Math.hypot(3, 1), 0]), 'first vector belongs to the first input');
		assert.ok(close(v[1], [6 / Math.hypot(6, 2), 2 / Math.hypot(6, 2), 0]));
	} finally { await s.close(); }
});

test('auto finds the embedding model on the custom server when nothing else is there', async () => {
	const s = await fakeServer({ models: ['llama-3.1-8b', 'embeddinggemma2', 'qwen3-coder'] });
	try {
		const r = await resolveEmbedder(await env({ bases: { custom: s.base } }), 'auto');
		assert.ok(r.embedder, r.problem);
		assert.ok(r.embedder.id.startsWith('custom/embeddinggemma2@'));
		assert.strictEqual(s.seen[0].auth, undefined, 'no key, no header');
	} finally { await s.close(); }
});

test('"custom" alone picks the server\'s embedding model', async () => {
	const s = await fakeServer({ models: ['chat-model', 'text-embedding-nomic-embed-text-v1.5'] });
	try {
		const r = await resolveEmbedder(await env({ bases: { custom: s.base } }), 'custom');
		assert.ok(r.embedder?.id.startsWith('custom/text-embedding-nomic-embed-text-v1.5@'));
	} finally { await s.close(); }
});

test('auto explains a custom server with no embedding model, without calling it an error', async () => {
	const s = await fakeServer({ models: ['chat-only'] });
	try {
		const r = await resolveEmbedder(await env({ bases: { custom: s.base } }), 'auto');
		assert.strictEqual(r.embedder, undefined);
		assert.strictEqual(r.isError, false);
		assert.match(r.problem!, /lists no model that looks like an embedding model/);
		assert.match(r.problem!, /custom\/<model id>/);
	} finally { await s.close(); }
});

test('auto with nothing configured says how to set one up', async () => {
	const r = await resolveEmbedder(await env(), 'auto');
	assert.strictEqual(r.embedder, undefined);
	assert.strictEqual(r.problem, NO_EMBEDDER);
	assert.strictEqual(r.isError, false);
});

test('explicit choices that cannot work are errors with a fix', async () => {
	const e = await env();
	const custom = await resolveEmbedder(e, 'custom/embeddinggemma2');
	assert.ok(custom.isError && /openCursor\.providers\.custom\.baseUrl/.test(custom.problem!));
	const openai = await resolveEmbedder(e, 'openai/text-embedding-3-small');
	assert.ok(openai.isError && /No OpenAI key/.test(openai.problem!));
	const ollama = await resolveEmbedder(e, 'ollama/nomic-embed-text');
	assert.ok(ollama.isError && /Ollama is not answering/.test(ollama.problem!));
	const unknown = await resolveEmbedder(e, 'foo/bar');
	assert.ok(unknown.isError && /Unknown embedding provider "foo"/.test(unknown.problem!));
});

test('server errors and unreachable servers read as plain messages', async () => {
	const s = await fakeServer({ status: 404 });
	try {
		const r = await resolveEmbedder(await env({ bases: { custom: s.base } }), 'custom/missing');
		await assert.rejects(r.embedder!.embed(['x'], 'doc', signal), /^Error: Embedding request to 127\.0\.0\.1:\d+ failed \(404\): model not found\. The server may not support \/embeddings, or the model name is wrong\.$/);
	} finally { await s.close(); }
	const dead = compatEmbedder({ provider: 'custom', base: (await closedPort()) + '/v1', model: 'm' });
	await assert.rejects(dead.embed(['x'], 'doc', signal), /Could not reach the embedding server at 127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
});

test('base64 embeddings are decoded', async () => {
	const s = await fakeServer({ base64: true });
	try {
		const [v] = await compatEmbedder({ provider: 'custom', base: s.base, model: 'm' }).embed(['abcd'], 'doc', signal);
		assert.ok(close(v, [4 / Math.hypot(4, 1), 1 / Math.hypot(4, 1), 0]));
	} finally { await s.close(); }
});

test('OpenAI honours the base URL override', async () => {
	const s = await fakeServer();
	try {
		const r = await resolveEmbedder(await env({ keys: { openai: 'sk' }, bases: { openai: s.base } }), 'auto');
		await r.embedder!.embed(['x'], 'query', signal);
		assert.ok(s.seen.some(x => x.url === '/v1/embeddings' && x.auth === 'Bearer sk'));
		assert.ok(r.embedder!.id.endsWith('@' + s.base));
	} finally { await s.close(); }
});

test('Ollama native embeddings', async () => {
	const s = await fakeServer({ ollama: ['llama3:8b', 'nomic-embed-text:latest'] });
	try {
		const r = await resolveEmbedder(await env({ bases: { ollama: s.root } }), 'auto');
		assert.strictEqual(r.embedder?.id, 'ollama/nomic-embed-text:latest');
		const [v] = await r.embedder!.embed(['x'], 'query', signal);
		assert.ok(close(v, [0.6, 0.8]));
		assert.strictEqual(s.seen.find(x => x.url === '/api/embed')!.body.input[0], 'search_query: x');
	} finally { await s.close(); }
});

test('only servers off this computer and network count as remote', () => {
	assert.deepStrictEqual(compatEmbedder({ provider: 'openai', base: OPENAI_BASE, model: 'm', key: 'k' }).remote, { key: 'openai', label: 'OpenAI' });
	assert.strictEqual(compatEmbedder({ provider: 'openai', base: OPENAI_BASE, model: 'm', key: 'k' }).id, 'openai/m');
	assert.deepStrictEqual(compatEmbedder({ provider: 'custom', base: 'https://llm.example.com/v1', model: 'm' }).remote, { key: 'custom@llm.example.com', label: 'llm.example.com' });
	for (const base of ['http://localhost:8000/v1', 'http://192.168.1.20:8080/v1', 'http://gpu-box.local:8000/v1', 'http://10.0.0.5/v1']) {
		assert.strictEqual(compatEmbedder({ provider: 'custom', base, model: 'm' }).remote, undefined, base);
	}
});

test('error bodies are reduced to their message', () => {
	assert.strictEqual(serverMessage('{"error":{"message":"model not found","type":"invalid_request_error"}}'), 'model not found');
	assert.strictEqual(serverMessage('{"error":"bad input"}'), 'bad input');
	assert.strictEqual(serverMessage('{"detail":"Not Found"}'), 'Not Found');
	assert.strictEqual(serverMessage('<html>\n  Bad Gateway\n</html>'), '<html> Bad Gateway </html>');
	assert.strictEqual(serverMessage('x'.repeat(400)).length, 301);
});

test('embedding model names are recognised', () => {
	assert.strictEqual(pickEmbeddingModel(['gpt-oss', 'embeddinggemma2']), 'embeddinggemma2');
	assert.strictEqual(pickEmbeddingModel(['bge-m3', 'nomic-embed-text:v1.5']), 'nomic-embed-text:v1.5');
	assert.strictEqual(pickEmbeddingModel(['BAAI/bge-small-en-v1.5']), 'BAAI/bge-small-en-v1.5');
	assert.strictEqual(pickEmbeddingModel(['llama3', 'qwen3']), undefined);
});

void done('embedders');
