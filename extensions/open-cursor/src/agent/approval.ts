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

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Flags that make an otherwise harmless allowlisted command run programs or write files. */
const RISKY_FLAGS = ['--pre', '--output', '--ext-diff', '--exec', '-exec'];

/** True when the segment carries a flag that can execute a program or write a file (`rg --pre sh`, `git diff --output=x`, `find -exec`). */
export function hasRiskyFlag(segment: string): boolean {
	const tokens = segment.split(' ');
	const tool = tokens[0];
	return tokens.slice(1).some(t => RISKY_FLAGS.some(f => t === f || t.startsWith(f + '=')) || ((tool === 'git' || tool === 'rg') && t === '-o'));
}

/** Drops leading `NAME=value` assignments. Only used to suggest an allow prefix, never for allowlist matching. */
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
		const seg = raw;
		// `FOO=1 cmd` can change what cmd does (LD_PRELOAD, GIT_EXTERNAL_DIFF, PATH): always ask
		if (ENV_ASSIGN.test(seg)) { return false; }
		if (/^cd(\s|$)/.test(seg)) { return true; }
		if (hasRiskyFlag(seg)) { return false; }
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
