/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Terminal command approval policy. Pure.
 *--------------------------------------------------------------------------------------------*/

export type AutoRun = 'ask' | 'allowlist' | 'always';

export const DEFAULT_ALLOWLIST = [
	'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'which', 'whoami', 'date', 'tree', 'grep', 'rg', 'file', 'stat', 'du', 'df', 'basename', 'dirname',
	'git status', 'git diff', 'git log', 'git show', 'git branch --list', 'git rev-parse', 'git remote -v', 'git blame',
	'npm test', 'npm run test', 'npm run lint', 'npm run build', 'npm run typecheck', 'npm ls', 'npm outdated',
	'pnpm test', 'pnpm run test', 'pnpm lint', 'pnpm build', 'pnpm typecheck', 'pnpm ls',
	'yarn test', 'yarn lint', 'yarn build', 'npx tsc', 'tsc', 'node --version', 'python --version', 'python3 --version',
	'cargo check', 'cargo test', 'cargo build', 'cargo clippy', 'go build', 'go test', 'go vet', 'pytest', 'python -m pytest', 'python3 -m pytest', 'make test', 'make build',
];

export const DEFAULT_DENYLIST = [
	'rm -rf /', 'rm -rf ~', 'rm -rf *', 'rm -rf .', 'sudo ', 'mkfs', 'dd if=', ':(){', '> /dev/sd', 'chmod -R 777 /', 'git push --force', 'git push -f', 'git reset --hard', 'git clean -f', 'DROP TABLE', 'DROP DATABASE', '| sh', '| bash', '| zsh', 'shutdown', 'reboot',
];

export interface ApprovalPolicy {
	readonly autoRun: AutoRun;
	readonly allowlist: readonly string[];
	readonly denylist: readonly string[];
	/** Command prefixes the user approved with "always allow" this session. */
	readonly sessionAllow?: ReadonlySet<string>;
}

function collapse(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/** Splits a command line on shell control operators. Returns undefined when it holds constructs we cannot reason about. */
export function splitSegments(cmd: string): string[] | undefined {
	if (/\$\(|`|<\(|>\(/.test(cmd)) { return undefined; }
	if (/<<|\bsource\b|\beval\b/.test(cmd)) { return undefined; }
	// redirection to a file (allow 2>&1, >/dev/null, &>/dev/null)
	const noSafeRedir = cmd.replace(/\d*>&\d+|&?>\s*\/dev\/null|2>\s*\/dev\/null/g, '');
	if (/>/.test(noSafeRedir)) { return undefined; }
	return noSafeRedir.split(/&&|\|\||;|\||&|\n/).map(collapse).filter(Boolean);
}

export function matchesPrefix(segment: string, entry: string): boolean {
	const e = collapse(entry);
	if (!e) { return false; }
	return segment === e || segment.startsWith(e + ' ');
}

/** Env assignments (`FOO=1 cmd`) and `cd dir &&` do not change what the segment runs. */
function stripLeading(segment: string): string {
	let s = segment;
	while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(s)) { s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, ''); }
	return s;
}

export function isDenied(cmd: string, denylist: readonly string[]): boolean {
	const c = collapse(cmd);
	return denylist.some(d => {
		const e = collapse(d);
		return !!e && (c.includes(e) || (d.endsWith(' ') && (c + ' ').includes(d)));
	});
}

/** True when the command should wait for the user. */
export function needsApproval(cmd: string, policy: ApprovalPolicy): boolean {
	if (isDenied(cmd, policy.denylist)) { return true; }
	if (policy.autoRun === 'always') { return false; }
	if (policy.autoRun === 'ask') { return true; }
	const segments = splitSegments(cmd);
	if (!segments || segments.length === 0) { return true; }
	return !segments.every(raw => {
		const seg = stripLeading(raw);
		if (/^cd(\s|$)/.test(seg)) { return true; }
		return policy.allowlist.some(a => matchesPrefix(seg, a)) || [...(policy.sessionAllow ?? [])].some(a => matchesPrefix(seg, a));
	});
}

/** Prefix suggested for "always allow": the first one or two words, `git status` style. */
export function suggestAllowPrefix(cmd: string): string {
	const segments = splitSegments(cmd);
	const first = stripLeading(segments?.[0] ?? collapse(cmd));
	const words = first.split(' ');
	const subcommandTools = new Set(['git', 'npm', 'pnpm', 'yarn', 'cargo', 'go', 'docker', 'kubectl', 'npx', 'make', 'python', 'python3']);
	return subcommandTools.has(words[0]) && words[1] && !words[1].startsWith('-') ? `${words[0]} ${words[1]}` : words[0];
}
