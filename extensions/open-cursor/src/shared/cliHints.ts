/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  How to install and sign in to each agent CLI. Shared by the settings page and the chat's
 *  start screen, which runs these commands in a terminal for the user.
 *--------------------------------------------------------------------------------------------*/

export interface CliHint {
	/** Shell command that installs the CLI (sh on macOS and Linux). */
	readonly install: string;
	/** The same for PowerShell on Windows, when it differs. */
	readonly installWindows?: string;
	/** One sentence telling the user how to sign in. */
	readonly login: string;
	/** Shell command that starts the sign-in flow. */
	readonly loginCommand: string;
}

/** npm when Node.js is there, Homebrew otherwise, and a clear line instead of an error when neither is. */
function viaNpmOrBrew(pkg: string, formula: string, label: string): string {
	return `if command -v npm >/dev/null 2>&1; then npm install -g ${pkg}; elif command -v brew >/dev/null 2>&1; then brew install ${formula}; else echo "${label} installs with Node.js (nodejs.org) or Homebrew (brew.sh). Install one of them, then press Install again."; fi`;
}

function viaNpm(pkg: string, label: string): string {
	return `if (Get-Command npm -ErrorAction SilentlyContinue) { npm install -g ${pkg} } else { Write-Host "${label} installs with Node.js. Get it from nodejs.org, then press Install again." }`;
}

export const CLI_HINTS: Readonly<Record<string, CliHint>> = {
	'claude-code': { install: 'curl -fsSL https://claude.ai/install.sh | bash', installWindows: 'irm https://claude.ai/install.ps1 | iex', login: 'Run `claude` once in a terminal and sign in with your Claude account.', loginCommand: 'claude' },
	codex: { install: viaNpmOrBrew('@openai/codex', 'codex', 'Codex'), installWindows: viaNpm('@openai/codex', 'Codex'), login: 'Run `codex login` in a terminal and sign in with ChatGPT.', loginCommand: 'codex login' },
	grok: { install: 'curl -fsSL https://x.ai/cli/install.sh | bash', login: 'Run `grok login` in a terminal and sign in with your Grok account.', loginCommand: 'grok login' },
	'gemini-cli': { install: viaNpmOrBrew('@google/gemini-cli', 'gemini-cli', 'Gemini CLI'), installWindows: viaNpm('@google/gemini-cli', 'Gemini CLI'), login: 'Run `gemini` once in a terminal and sign in with Google.', loginCommand: 'gemini' },
	opencode: { install: 'curl -fsSL https://opencode.ai/v2/install | bash', login: 'The free models need no sign in. To use your own provider, run `opencode auth login` in a terminal.', loginCommand: 'opencode auth login' },
};

export function cliHint(id: string): CliHint {
	return CLI_HINTS[id] ?? { install: '', login: 'Sign in with this CLI in a terminal.', loginCommand: '' };
}
