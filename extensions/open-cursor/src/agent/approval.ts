/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Terminal command approval policy. Pure.
 *--------------------------------------------------------------------------------------------*/

/**
 * ask: every command waits. allowlist: listed commands run, the rest wait. auto: listed commands run,
 * and the agent marks which of the rest need the user (CAREFUL commands always do). always: nothing waits.
 * The denylist asks in every policy.
 */
export type AutoRun = 'ask' | 'allowlist' | 'auto' | 'always';

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

/** In Auto these ask even when the agent says they are safe: they delete, publish, reach other machines or run downloaded code. */
export const CAREFUL = [
	'rm', 'rmdir', 'mv', 'xargs', 'dd', 'chmod', 'chown', 'kill', 'pkill', 'killall', 'truncate', 'shred',
	'git push', 'git reset', 'git clean', 'git checkout', 'git restore', 'git rebase', 'git stash drop', 'git branch -D', 'git tag -d',
	'curl', 'wget', 'ssh', 'scp', 'rsync', 'ftp', 'nc', 'telnet',
	'npx', 'bunx', 'pnpx', 'pnpm dlx', 'yarn dlx', 'uvx', 'pipx',
	'npm install', 'npm i', 'npm ci', 'npm uninstall', 'npm update', 'pnpm add', 'pnpm install', 'pnpm i', 'pnpm remove', 'pnpm update', 'yarn add', 'yarn install', 'yarn remove',
	'bun add', 'bun install', 'bun remove', 'pip', 'pip3', 'python -m pip', 'python3 -m pip', 'uv add', 'uv pip', 'uv sync', 'poetry add', 'poetry install',
	'cargo add', 'cargo install', 'go install', 'go get', 'gem install', 'bundle install', 'composer require', 'composer install',
	'npm publish', 'pnpm publish', 'yarn publish', 'cargo publish', 'twine', 'gh', 'vercel', 'netlify', 'firebase', 'fly', 'heroku', 'docker', 'kubectl', 'terraform',
	'brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'zypper', 'snap', 'flatpak', 'winget', 'choco', 'scoop', 'launchctl', 'systemctl', 'service', 'crontab', 'defaults write', 'security', 'osascript',
	// Windows: cmd and PowerShell (matched without case)
	'del', 'erase', 'rd', 'move', 'ren', 'format', 'reg', 'sc', 'schtasks', 'taskkill', 'icacls', 'takeown', 'cmd', 'powershell', 'pwsh',
	'remove-item', 'ri', 'move-item', 'mi', 'rename-item', 'clear-content', 'set-content', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'invoke-expression', 'iex',
	'start-process', 'stop-process', 'set-executionpolicy', 'set-itemproperty', 'new-itemproperty', 'remove-itemproperty', 'install-module', 'install-package',
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

/**
 * `git -C <dir> diff` and `git --no-pager log` match allowlist entries as `git diff` / `git log`.
 * Only these two options are dropped: `-c key=value` can point git at another program, so it still asks.
 */
export function stripGitGlobals(segment: string): string {
	if (!segment.startsWith('git ')) { return segment; }
	let s = segment;
	for (;;) {
		const next = s.replace(/^git (?:-C (?:"[^"]*"|'[^']*'|\S+)|--no-pager) /, 'git ');
		if (next === s) { return s; }
		s = next;
	}
}

/**
 * True when the command should wait for the user. `agentSaysAsk` is the agent's own
 * `requires_approval` for this command; only Auto reads it, and a missing answer counts as asking.
 */
export function needsApproval(cmd: string, policy: ApprovalPolicy, agentSaysAsk?: boolean): boolean {
	if (isDenied(cmd, policy.denylist)) { return true; }
	if (policy.autoRun === 'always') { return false; }
	if (policy.autoRun === 'ask') { return true; }
	if (policy.autoRun === 'auto') { return autoNeedsApproval(cmd, policy, agentSaysAsk); }
	return !listed(cmd, policy);
}

/** Auto: the allowlist runs; otherwise the agent decides, except for the CAREFUL commands and anything we cannot read. */
function autoNeedsApproval(cmd: string, policy: ApprovalPolicy, agentSaysAsk: boolean | undefined): boolean {
	if (listed(cmd, policy)) { return false; }
	return agentSaysAsk !== false || isCareful(cmd);
}

/** The command deletes, installs, publishes, goes online, or is something we cannot read: Auto always asks for it. */
export function isCareful(cmd: string): boolean {
	const segments = splitSegments(cmd);
	if (!segments || segments.length === 0) { return true; }
	return segments.some(raw => {
		const seg = stripGitGlobals(stripLeading(raw)).toLowerCase();
		// a path that leaves the project (`../x`, `..\\x`, `~/x`) is beyond what the review can undo
		const leaves = seg.split(' ').slice(1).some(t => /^['"]?(\.\.([\/\\]|$)|~([\/\\]|$))/.test(t));
		return ENV_ASSIGN.test(raw) || hasRiskyFlag(seg) || CAREFUL.some(c => matchesPrefix(seg, c)) || /^(sudo|su|doas)\b/.test(seg) || /\s-delete\b/.test(seg) || leaves;
	});
}

/** Every segment of the command is on the allowlist or was allowed this session. */
function listed(cmd: string, policy: ApprovalPolicy): boolean {
	const segments = splitSegments(cmd);
	if (!segments || segments.length === 0) { return false; }
	return segments.every(raw => {
		const seg = stripGitGlobals(raw);
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
