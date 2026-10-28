// Bundles and runs a test entry with esbuild (plain node, no vscode). Usage:
//   node test/run.mjs            replay fixtures (default)
//   node test/run.mjs live ...   one real turn, see live.ts
import { build } from 'esbuild';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [first, ...rest] = process.argv.slice(2);
const live = first === 'live';
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cli-test-'));
const entry = path.join(here, live ? 'live.ts' : 'replay.ts');
const outfile = path.join(out, 'entry.js');
await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'error' });
await build({ entryPoints: [path.join(here, '..', 'permissionServer.ts')], outfile: path.join(out, 'permissionServer.js'), bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'error' });
const r = spawnSync(process.execPath, [outfile, ...(live ? rest : [])], { stdio: 'inherit', env: { ...process.env, OC_DIST: out, FIXTURES: path.join(here, 'fixtures') } });
fs.rmSync(out, { recursive: true, force: true });
process.exit(r.status ?? 1);
