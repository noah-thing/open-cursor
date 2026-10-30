/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Terminal command approval policy. Pure.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import { posix } from 'path';

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
	'yarn test', 'yarn lint', 'yarn build', 'tsc', 'node --version', 'python --version', 'python3 --version',
	'cargo check', 'cargo test', 'cargo build', 'cargo clippy', 'go build', 'go test', 'go vet', 'pytest', 'python -m pytest', 'python3 -m pytest', 'make test', 'make build',
	// Windows: the same read only look around, in cmd and PowerShell
	'dir', 'type', 'where', 'findstr', 'Get-ChildItem', 'Get-Content', 'Get-Location', 'Get-Item', 'Select-String', 'Test-Path',
	'Select-Object', 'Sort-Object', 'Measure-Object', 'Format-Table', 'Format-List', 'Out-String',
];

export const DEFAULT_DENYLIST = [
	'rm -rf /', 'rm -rf ~', 'rm -rf *', 'rm -rf .', 'sudo ', 'mkfs', 'dd if=', ':(){', '> /dev/sd', 'chmod -R 777 /', 'git push --force', 'git push -f', 'git reset --hard', 'git clean -f', 'DROP TABLE', 'DROP DATABASE', '| sh', '| bash', '| zsh', 'shutdown', 'reboot',
];

/** In Auto these ask even when the agent says they are safe: they delete, publish, reach other machines or run downloaded code. */
export const CAREFUL = [
	'rm', 'rmdir', 'mv', 'xargs', 'dd', 'chmod', 'chown', 'kill', 'pkill', 'killall', 'truncate', 'shred',
	'git push', 'git reset', 'git clean', 'git checkout', 'git restore', 'git rebase', 'git stash drop', 'git branch -D', 'git tag -d',
	'git fetch', 'git pull', 'git clone', 'git submodule', 'npm exec', 'npm x', 'npm create', 'npm init', 'pnpm exec', 'pnpm create', 'yarn create', 'yarn dlx', 'bun x', 'bun create', 'deno run', 'deno install',
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
	/** Absolute paths of the open project folders: an absolute path inside one does not leave the project. */
	readonly roots?: readonly string[];
}

function collapse(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/** Splits a command line on shell control operators. Returns undefined when it holds constructs we cannot reason about. */
export function splitSegments(cmd: string): string[] | undefined {
	if (/\$\(|`|<\(|>\(/.test(cmd)) { return undefined; }
	// zsh's $'...' quoting hides a quote from the scan below, and Windows line separators end a statement
	if (/\$'/.test(cmd) || /[\r\u0085\u2028\u2029]/.test(cmd)) { return undefined; }
	// Outside quotes, ( ) and { } run commands of their own: PowerShell evaluates `Get-Content (Remove-Item x)`
	// and `@(...)`, script blocks run with &, POSIX shells start subshells. A command that looks allowed
	// could hide another one there, so such a command is never read as allowed.
	const unquoted = cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
	if (/[(){}]/.test(unquoted)) { return undefined; }
	if (/<<|\bsource\b|\beval\b/.test(cmd)) { return undefined; }
	// redirection to a file (allow 2>&1, >/dev/null, &>/dev/null); a > inside quotes is text, not a redirect
	const safeRedir = /\d*>&\d+(?![\w./-])|&?>\s*\/dev\/null(?![\w./-])|2>\s*\/dev\/null(?![\w./-])/g;
	if (/>/.test(unquoted.replace(safeRedir, ''))) { return undefined; }
	const noSafeRedir = cmd.replace(safeRedir, '');
	return noSafeRedir.split(/&&|\|\||;|\||&|\n/).map(collapse).filter(Boolean);
}

export function matchesPrefix(segment: string, entry: string): boolean {
	const e = collapse(entry);
	if (!e) { return false; }
	return segment === e || segment.startsWith(e + ' ');
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Flags that make an otherwise harmless allowlisted command run programs or write files. */
const RISKY_FLAGS = ['--pre', '--output', '--ext-diff', '--exec', '-exec', '-execdir', '-ok', '--hostname-bin', '-vettool', '-toolexec', '--script-shell', '--exec-path', '--upload-pack', '--receive-pack', '--config', '--rcfile', '--init-file'];

/** True when the segment carries a flag that can execute a program or write a file (`rg --pre sh`, `git diff --output=x`, `find -exec`, `go vet -vettool=x`). */
export function hasRiskyFlag(segment: string): boolean {
	const tokens = segment.split(' ');
	const tool = programOf(segment);
	return tokens.slice(1).some(t => {
		const bare = t.replace(/['"]/g, '');
		return RISKY_FLAGS.some(f => bare === f || bare.startsWith(f + '='))
			|| ((tool === 'git' || tool === 'rg' || tool === 'tree' || tool === 'file') && bare === '-o')
			// `make test SHELL=./x.sh` or `make CC=./x`: a variable on make's command line can name any program
			|| (tool === 'make' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(bare));
	});
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
	return agentSaysAsk !== false || isCareful(cmd, policy.roots);
}

/** Programs that run another command given as their arguments: what they run is what counts. */
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'setsid', 'stdbuf', 'unbuffer', 'caffeinate', 'watch', 'script', 'start', 'call', 'invoke-command', 'icm', 'start-job', 'invoke-item', 'ii', '&', '.']);
/** Interpreters: with inline code (-c, -e, --eval, -Command) they can do anything at all. */
const INTERPRETERS = /^(bash|sh|zsh|dash|ksh|fish|csh|tcsh|cmd|cmd\.exe|powershell|powershell\.exe|pwsh|python[\d.]*|py|node|nodejs|deno|bun|perl|ruby|php|lua|tclsh|osascript|wscript|cscript|mshta|rundll32|regsvr32)$/;
const INLINE_CODE = /^(-c|-e|-x|-p|-command|-encodedcommand|-enc|-ec|--eval|--print|\/c|\/k)$/i;
/** Environment variables a command line may set without changing which program runs or what it loads. */
const SAFE_ENV = /^(CI|NODE_ENV|PORT|HOST|DEBUG|TZ|LANG|LC_ALL|LC_CTYPE|FORCE_COLOR|NO_COLOR|TERM|COLUMNS|RUST_BACKTRACE|RUST_LOG|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|GOFLAGS_NONE|VERBOSE|LOG_LEVEL)=\S*$/;
/** cmd.exe programs whose arguments start with / as switches, not paths (`dir /s`, `findstr /i`). */
const SLASH_SWITCH_PROGRAMS = new Set(['dir', 'type', 'findstr', 'where', 'cmd', 'cmd.exe', 'tree', 'more', 'find', 'attrib', 'sort', 'fc', 'comp', 'tasklist', 'systeminfo', 'ver', 'echo']);
/** Programs whose quoted arguments are patterns or text, not paths (`grep "/api/users" src`). */
const PATTERN_PROGRAMS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'findstr', 'select-string', 'sls', 'git', 'echo', 'printf', 'sed', 'awk', 'jq']);

/** Drops leading assignments of SAFE_ENV variables (`CI=true npm test` reads as `npm test`); undefined when another one is set. */
export function stripSafeEnv(segment: string): string | undefined {
	const tokens = segment.split(' ');
	let i = 0;
	while (i < tokens.length && ENV_ASSIGN.test(tokens[i])) {
		if (!SAFE_ENV.test(tokens[i])) { return undefined; }
		i++;
	}
	return tokens.slice(i).join(' ');
}

/** The program a segment runs, as the shell would see it: quotes and escapes removed, folders dropped (`c''url`, `/usr/bin/curl`). */
export function programOf(segment: string): string {
	const first = segment.trim().split(/\s+/)[0] ?? '';
	const bare = first.replace(/['"\\^]/g, '');
	return (bare.split(/[\/\\]/).pop() ?? bare).toLowerCase();
}

/**
 * A token that names a place outside the project: `../x` (also `src/../../x`), `~/x` or `~user`, an absolute
 * path outside `roots`, a drive, a network share, or a variable that expands to a path ($HOME, %USERPROFILE%).
 * `--opt=/path` is read for its value. Quotes and escapes are removed first, as the shell would.
 */
function leavesProject(token: string, roots: readonly string[] = []): boolean {
	let t = token.replace(/['"]/g, '').replace(/\\(?=\/)/g, '');
	const eq = t.startsWith('-') ? t.indexOf('=') : -1;
	if (eq > 0) { t = t.slice(eq + 1); }
	if (!t || t === '/dev/null' || t === 'nul' || t === '$null') { return false; }
	// a variable that names a place: the review cannot see where it points
	if (/\$\{?(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMPDIR|TEMP|TMP|PWD|OLDPWD|XDG_[A-Z_]+)\b|\$env:|%[A-Za-z_]+%/i.test(t)) { return true; }
	if (/^\\\\/.test(t) || /^~[A-Za-z]/.test(t)) { return true; }
	if (t === '~' || /^~[\/\\]/.test(t)) { t = os.homedir() + t.slice(1); }
	const norm = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	if (!/^(\/|[a-z]:[\/\\])/i.test(t)) {
		// relative: climbing above the folder it starts in leaves the project
		const n = posix.normalize(t.replace(/\\/g, '/'));
		return n === '..' || n.startsWith('../');
	}
	// an absolute path into the open project is where the agent works anyway
	const p = norm(t);
	if (p.split('/').includes('..')) { return true; }
	return !roots.some(r => { const root = norm(r); return !!root && (p === root || p.startsWith(root + '/')); });
}

/** The arguments of a segment that could be paths: Windows switches and quoted search patterns are not. */
function pathArgs(segment: string): string[] {
	const tokens = segment.split(' ').slice(1);
	const program = programOf(segment);
	return tokens.filter(t => {
		if (SLASH_SWITCH_PROGRAMS.has(program) && /^\/[a-z?]{1,3}(:\S*)?$/i.test(t)) { return false; }
		if (PATTERN_PROGRAMS.has(program) && /^['"]/.test(t)) { return false; }
		return true;
	});
}

/** `git -C <dir>` names the folder git works in: it counts like a path argument. */
function gitDirs(segment: string): string[] {
	return [...segment.matchAll(/(?:^|\s)-C\s+("[^"]*"|'[^']*'|\S+)/g)].map(m => m[1]);
}

/** The command deletes, installs, publishes, goes online, or is something we cannot read: Auto always asks for it. */
export function isCareful(cmd: string, roots: readonly string[] = []): boolean {
	const segments = splitSegments(cmd);
	if (!segments || segments.length === 0) { return true; }
	return segments.some(raw => {
		const safe = stripSafeEnv(raw);
		if (safe === undefined) { return true; }
		const leavesGit = gitDirs(raw).some(d => leavesProject(d, roots));
		const seg = stripGitGlobals(safe).toLowerCase();
		const tokens = seg.split(' ');
		const program = programOf(seg);
		// what the shell runs is the bare program name: `c''url` and `/usr/bin/curl` are curl
		const normal = [program, ...tokens.slice(1)].join(' ');
		const wrapped = WRAPPERS.has(program);
		const inline = INTERPRETERS.test(program) && (tokens.slice(1).some(t => INLINE_CODE.test(t.replace(/['"]/g, ''))) || (program === 'php' && tokens.includes('-r')));
		// an interpreter given no script (`cat x |sh`, `curl x | python -`) reads its program from its input
		const args = tokens.slice(1);
		const piped = INTERPRETERS.test(program) && args.every(t => t.startsWith('-')) && !args.some(t => /^--?(version|v|help|h)$/i.test(t));
		// a path that leaves the project is beyond what the review can undo
		const leaves = pathArgs(seg).some(t => leavesProject(t, roots)) || leavesGit;
		return hasRiskyFlag(seg) || wrapped || inline || piped || CAREFUL.some(c => matchesPrefix(seg, c) || matchesPrefix(normal, c))
			|| /^(sudo|su|doas|runas)\b/.test(program) || /\s-delete\b/.test(seg) || leaves;
	});
}

/** Every segment of the command is on the allowlist or was allowed this session. */
function listed(cmd: string, policy: ApprovalPolicy): boolean {
	const segments = splitSegments(cmd);
	if (!segments || segments.length === 0) { return false; }
	return segments.every(raw => {
		// `FOO=1 cmd` can change what cmd does (LD_PRELOAD, GIT_EXTERNAL_DIFF, PATH): only harmless names pass
		const safe = stripSafeEnv(raw);
		if (safe === undefined || !safe) { return false; }
		if (gitDirs(safe).some(d => leavesProject(d, policy.roots))) { return false; }
		const seg = stripGitGlobals(safe);
		// `cd ~/.ssh && cat id_rsa`: a cd out of the project makes the next command read outside it
		if (/^cd(\s|$)/.test(seg)) { return !pathArgs(seg).some(t => leavesProject(t, policy.roots)); }
		if (hasRiskyFlag(seg)) { return false; }
		// `cat ~/.ssh/id_rsa` or a network share: an allowed reader pointed outside the project still asks
		if (pathArgs(seg).some(t => leavesProject(t, policy.roots))) { return false; }
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
