/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  How to install and sign in to each agent CLI. Shared by the settings page and the chat's
 *  start screen, which runs these commands in a terminal for the user.
 *--------------------------------------------------------------------------------------------*/

export interface CliHint {
	/** Shell command that installs the CLI. */
	readonly install: string;
	/** One sentence telling the user how to sign in. */
	readonly login: string;
	/** Shell command that starts the sign-in flow. */
	readonly loginCommand: string;
}

export const CLI_HINTS: Readonly<Record<string, CliHint>> = {
	'claude-code': { install: 'npm install -g @anthropic-ai/claude-code', login: 'Run `claude` once in a terminal and sign in with your Claude account.', loginCommand: 'claude' },
	codex: { install: 'npm install -g @openai/codex', login: 'Run `codex login` in a terminal and sign in with ChatGPT.', loginCommand: 'codex login' },
	grok: { install: 'curl -fsSL https://x.ai/cli/install.sh | bash', login: 'Run `grok login` in a terminal and sign in with your Grok account.', loginCommand: 'grok login' },
	'gemini-cli': { install: 'npm install -g @google/gemini-cli', login: 'Run `gemini` once in a terminal and sign in with Google.', loginCommand: 'gemini' },
};

export function cliHint(id: string): CliHint {
	return CLI_HINTS[id] ?? { install: '', login: 'Sign in with this CLI in a terminal.', loginCommand: '' };
}
