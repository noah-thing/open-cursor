// Runs every *.test.ts here: bundles with esbuild, executes with node. Usage: node src/agent/test/run.mjs
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = import.meta.dirname;
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-agent-test-'));
let failed = 0;
for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.test.ts'))) {
	const outfile = path.join(out, f.replace(/\.ts$/, '.cjs'));
	esbuild.buildSync({ entryPoints: [path.join(dir, f)], bundle: true, platform: 'node', format: 'cjs', outfile, external: ['vscode'], logLevel: 'error' });
	const r = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
	if (r.status !== 0) { failed++; console.error(`FAILED ${f}`); }
}
fs.rmSync(out, { recursive: true, force: true });
if (failed) { process.exit(1); }
console.log('all test files passed');
