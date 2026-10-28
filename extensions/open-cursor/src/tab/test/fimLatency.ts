/* Real FIM latency against Ollama (qwen2.5-coder). Run on the machine that hosts Ollama:
   npx esbuild src/tab/test/fimLatency.ts --bundle --platform=node --outfile=/tmp/fimLatency.js && node /tmp/fimLatency.js [model] [debounceMs] */
import { buildHeader, extractWindow, indentOf, postProcess } from '../logic';

const MODEL = process.argv[2] ?? 'qwen2.5-coder:7b';
const DEBOUNCE = Number(process.argv[3] ?? 75);
const BASE = process.env.OLLAMA ?? 'http://localhost:11434';

const FILE = `import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Config { port: number; host: string; roots: string[] }

const DEFAULTS: Config = { port: 8080, host: '127.0.0.1', roots: [] };

export function loadConfig(dir: string): Config {
	const raw = readFileSync(join(dir, 'config.json'), 'utf8');
	const parsed = JSON.parse(raw) as Partial<Config>;
	return { ...DEFAULTS, ...parsed };
}

export function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

export class Counter {
	private counts = new Map<string, number>();
	add(key: string, by = 1): void {
		this.counts.set(key, (this.counts.get(key) ?? 0) + by);
	}
	top(n: number): [string, number][] {
		<CURSOR>
	}
	total(): number {
		let sum = 0;
		for (const v of this.counts.values()) { sum += v; }
		return sum;
	}
}
`;
const PY = `from dataclasses import dataclass
import re


@dataclass
class Token:
    kind: str
    text: str


def tokenize(src: str) -> list[Token]:
    out = []
    for m in re.finditer(r"\\d+|[A-Za-z_]\\w*|\\S", src):
        text = m.group()
        kind = "num" if text.isdigit() else "name" if text[0].isalpha() else "op"
        <CURSOR>
    return out


def parse_args(argv):
    <CURSOR>
`;
const GO = `package main

import (
	"fmt"
	"net/http"
)

type Server struct{ mux *http.ServeMux }

func NewServer() *Server {
	s := &Server{mux: http.NewServeMux()}
	s.mux.HandleFunc("/health", s.health)
	return s
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	<CURSOR>
}
`;
const MID = `function render(items) {
  const list = document.querySelector('#list');
  list.innerHTML = items.map(i => \`<li>\${i.name}<CURSOR></li>\`).join('');
}
`;

interface Case { name: string; lang: string; src: string; at: number }
const cases: Case[] = [];
for (const [name, lang, src] of [['ts-method-body', 'typescript', FILE], ['py-loop', 'python', PY], ['go-handler', 'go', GO], ['js-midline', 'javascript', MID]] as const) {
	const marks = [...src.matchAll(/<CURSOR>/g)].map(m => m.index!);
	marks.forEach((_, i) => {
		const idx = marks[i];
		const stripped = src.split('<CURSOR>').map((part, k, a) => k < a.length - 1 ? part + (k === i ? '\u0000' : '') : part).join('');
		const at = stripped.indexOf('\u0000');
		cases.push({ name: `${name}#${i}`, lang, src: stripped.replace('\u0000', ''), at });
		void idx;
	});
}

async function run(c: Case): Promise<{ ttft: number; total: number; text: string }> {
	const t0 = performance.now();
	const win = extractWindow(c.src, c.at);
	const header = buildHeader('src/' + c.name, c.lang, []);
	const prefix = header + win.prefix;
	const lineStart = c.src.lastIndexOf('\n', c.at - 1) + 1;
	const lineEndIdx = c.src.indexOf('\n', c.at);
	const line = c.src.slice(lineStart, lineEndIdx < 0 ? undefined : lineEndIdx);
	const linePrefix = c.src.slice(lineStart, c.at);
	const lineSuffix = line.slice(linePrefix.length);
	await new Promise(r => setTimeout(r, DEBOUNCE));
	const ac = new AbortController();
	const res = await fetch(`${BASE}/api/generate`, {
		method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			model: MODEL, prompt: `<|fim_prefix|>${prefix}<|fim_suffix|>${win.suffix}<|fim_middle|>`, raw: true, stream: true,
			options: { num_predict: 240, temperature: 0.1, stop: ['\n\n\n', '<|endoftext|>', '<|fim_pad|>', '<|file_sep|>'] },
		}),
	});
	const reader = res.body!.getReader();
	const dec = new TextDecoder();
	let buf = ''; let raw = ''; let ttft = -1;
	const post = (final: boolean) => postProcess(raw, { linePrefix, suffix: c.src.slice(c.at), maxLines: 10, baseIndent: indentOf(line), midLine: lineSuffix.trim() !== '', final });
	outer: for (;;) {
		const { done, value } = await reader.read();
		if (done) { break; }
		buf += dec.decode(value, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const l = buf.slice(0, nl); buf = buf.slice(nl + 1);
			if (!l.trim()) { continue; }
			const j = JSON.parse(l) as { response?: string; done?: boolean };
			if (j.response) {
				if (ttft < 0) { ttft = performance.now() - t0; }
				raw += j.response;
				if (post(false).stopped) { ac.abort(); break outer; }
			}
			if (j.done) { break outer; }
		}
	}
	return { ttft, total: performance.now() - t0, text: post(true).text };
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

(async () => {
	console.log(`model=${MODEL} debounce=${DEBOUNCE}ms cases=${cases.length}`);
	await run(cases[0]).catch(e => { console.error('warmup failed', e); process.exit(1); });
	const totals: number[] = []; const ttfts: number[] = [];
	for (let round = 0; round < 3; round++) {
		for (const c of cases) {
			const r = await run(c);
			totals.push(r.total); ttfts.push(r.ttft);
			if (round === 0) { console.log(`--- ${c.name}: ttft=${Math.round(r.ttft)}ms total=${Math.round(r.total)}ms\n${r.text}`); }
		}
	}
	console.log(`\nN=${totals.length}  ttft p50=${Math.round(pct(ttfts, 0.5))}ms p95=${Math.round(pct(ttfts, 0.95))}ms  total p50=${Math.round(pct(totals, 0.5))}ms p95=${Math.round(pct(totals, 0.95))}ms`);
})();
