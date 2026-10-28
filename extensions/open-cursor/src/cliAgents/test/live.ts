/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Manual live run of one real turn against an installed CLI (spends tokens). Not part of the
 *  replay test. Usage: node test/run.mjs live <claude-code|codex|grok|gemini-cli> <cwd> <model> <mode> <autoRun> <prompt>
 *  Set CAPTURE=<file> to save the raw event stream as a fixture.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { runClaude } from '../claude';
import { runCodex } from '../codex';
import { cliEnv, resolveBinary } from '../detect';
import { runGemini } from '../gemini';
import { runGrok } from '../grok';
import type { AutoRun, CliAgentId, TurnHost } from '../types';
import type { ChatMode } from '../../shared/protocol';

async function main(): Promise<void> {
	const [agent, cwd, model, mode, autoRun, ...rest] = process.argv.slice(2) as [CliAgentId, string, string, ChatMode, AutoRun, ...string[]];
	const prompt = rest.join(' ');
	const binary = await resolveBinary(agent, { enabled: true, paths: {} });
	if (!binary) {
		throw new Error('binary not found');
	}
	const capture = process.env.CAPTURE ? fs.createWriteStream(process.env.CAPTURE) : undefined;
	const approve = process.env.APPROVE ?? 'run';
	const host: TurnHost = {
		text: d => process.stdout.write(d),
		thinking: d => process.stdout.write(`\x1b[2m${d}\x1b[0m`),
		toolStart: p => console.log(`\n[tool+] ${p.status} ${p.name}: ${p.title}`),
		toolUpdate: p => console.log(`[tool~] ${p.status} ${p.title}${p.edit ? ` edit=${JSON.stringify(p.edit)}` : ''}${p.output ? ` out=${JSON.stringify(p.output.slice(0, 80))}` : ''}`),
		requestApproval: async p => {
			console.log(`[approval] ${p.title} -> ${approve}`);
			return approve as 'run' | 'skip' | 'allowAlways';
		},
		fileOriginal: (p, c) => console.log(`[original] ${p} ${c === undefined ? '(new)' : JSON.stringify(c.slice(0, 40))}`),
		fileChanged: p => console.log(`[changed] ${p}`),
		usage: u => console.log(`[usage] ${JSON.stringify(u)}`),
		uri: p => 'file://' + p,
	};
	const run = agent === 'claude-code' ? runClaude : agent === 'codex' ? runCodex : agent === 'grok' ? runGrok : runGemini;
	const res = await run({
		binary,
		model,
		mode,
		prompt,
		cwd,
		sessionId: process.env.SESSION,
		autoRun,
		commandAllowlist: ['echo'],
		extraArgs: [],
		env: await cliEnv(binary),
		signal: new AbortController().signal,
		host,
		rawLog: l => capture?.write(l + '\n'),
		permissionServerPath: path.join(process.env.OC_DIST ?? '', 'permissionServer.js'),
	});
	capture?.end();
	console.log('\n[result]', JSON.stringify(res));
}
void main();
