/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Instant answers for the questions Help hears most. Written by hand from the manual, so they
 *  are exact and need no model. Matching is deliberately strict: anything long, about a problem,
 *  or not clearly one topic goes to the model instead. Pure.
 *--------------------------------------------------------------------------------------------*/

import type { HelpAction } from './targets';

export interface InstantAnswer {
	readonly id: string;
	readonly text: string;
	/** Opened right away, like the model's open_in_app. */
	readonly open?: HelpAction;
}

interface Intent extends InstantAnswer {
	/** Every pattern must match. */
	readonly all: readonly RegExp[];
	/** None may match. */
	readonly not?: readonly RegExp[];
}

// Order matters: the first intent that matches wins, so the narrower ones come first.
const INTENTS: readonly Intent[] = [
	{
		id: 'free',
		all: [/\bfree\b|\bno cost\b|\bwithout paying\b|\bcost nothing\b/],
		text: 'The **Free models** page has everything that costs nothing. **OpenCode** runs free models with no account: press **Get OpenCode** to install it in one click, then **Use** on a model. For more room, each free key (OpenRouter, Groq, Google Gemini, NVIDIA, Z.ai, Mistral, SambaNova) takes about a minute: **Open the key page**, follow the steps, then **Paste key**. Once one is connected, **Free (auto)** moves on to another free model when one hits its limit.',
		open: { target: 'free-models' },
	},
	{
		id: 'import',
		all: [/\b(import|migrate|bring|move|transfer|switch(ing)?)\b/, /\b(cursor|vs ?code|visual studio code)\b/],
		text: 'The import brings your settings, keybindings and extensions over from Cursor or VS Code. It asks before changing anything and offers a reload at the end. Cursor rules (`.cursor/rules`) and MCP configs already work without importing.\n\n[Import from Cursor or VS Code](opencursor:import)',
	},
	{
		id: 'subscription',
		all: [/\b(subscriptions?|chatgpt|claude code|codex|claude (pro|max)|plus plan|pro plan|gemini cli|grok cli|my plan)\b/],
		text: 'Yes. OpenCursor runs the AI coding tool from the plan you already pay for (Claude Code, Codex, Grok or Gemini CLI), so the work counts against that plan and no API key is needed. In **Settings > Subscriptions**, each one you have installed shows up; sign in to it once and its models appear in the model menu. A new chat\'s start screen has the same list under **Subscriptions**, with Install and Sign in buttons.',
		open: { target: 'settings', arg: 'subscriptions' },
	},
	{
		id: 'local',
		all: [/\b(ollama|lm ?studio|local models?|locally|offline|on my (own )?(computer|machine))\b/],
		text: 'Open **Run a model on this computer** (on the Free models page, or On this computer in the model menu). It checks your memory and graphics card, lists the models that fit with the best fit first, and **Install** does the rest in one click: it installs Ollama if needed, downloads the model and switches the chat to it. LM Studio and any OpenAI compatible server work too: start the server and its models appear in the model menu, or set its address in **Settings > Models**.',
		open: { target: 'free-models', arg: 'local' },
	},
	{
		id: 'api-key',
		all: [/\b(api|apis|api ?keys?|keys?|tokens?|providers?)\b/],
		not: [/\b(shortcuts?|keyboard|keybindings?|hot ?keys?)\b/],
		text: 'Open **Settings > Models** and paste the key into your provider\'s row under **Providers** (Anthropic, OpenAI, Google Gemini, OpenRouter and more). It is checked with the provider right away and stored in your system keychain, and that provider\'s models then show up in the model menu. You can also paste a key on a new chat\'s start screen, in the **API keys** tab.',
		open: { target: 'settings', arg: 'models' },
	},
	{
		id: 'change-model',
		all: [/\b(change|switch|pick|choose|select|set|default)\b.*\bmodels?\b|\bwhich model\b/],
		text: 'Pick the model for a chat with the model chip at the bottom of the chat box, next to the mode. To change the model new chats start with, use **Settings > Models > Defaults**, where you can also set the models for inline edit (Cmd+K) and Tab completion. You can also type `/model` and a name in the box.',
		open: { target: 'settings', arg: 'models' },
	},
	{
		id: 'modes',
		all: [/\b(modes|agent mode|plan mode|debug mode|ask mode)\b|\b(agent|plan|debug|ask)\b.*\b(agent|plan|debug|ask)\b/],
		not: [/\b(dark|light|help|zen|focus) mode\b/],
		text: 'Pick the mode with the chip at the bottom left of the chat box, or press **Cmd+.** to cycle.\n\n- **Agent** reads, edits and runs code, keeps a todo list and checks its own work.\n- **Plan** is read only: it researches and writes a step by step plan, then you press **Build** and Agent carries it out.\n- **Debug** reproduces a bug, tests ideas with temporary logging, fixes the cause, then removes the logging.\n- **Ask** is read only and answers questions about your code with clickable file references.\n\nThe mode new chats start in is in **Settings > General**.',
	},
	{
		id: 'undo',
		all: [/\b(undo|revert|reject|roll ?back|restore|take back|discard|checkpoints?)\b/],
		text: 'The agent\'s edits stay pending until you keep them. Use **Undo all** in the review bar above the chat box, or undo one file with **Cmd+Backspace** and one change with **Cmd+N** while the cursor is in it. To go back further, hover a message you sent and choose **Restore**: every message is a checkpoint, and restoring puts your files back to that moment.',
	},
	{
		id: 'icon-theme',
		all: [/\b(file )?icons?\b/, /\b(theme|style|look|change)\b/],
		text: 'The file icon theme picker lists the installed icon sets. Move through it to preview each one and press Enter to keep it.',
		open: { target: 'icon-theme' },
	},
	{
		id: 'theme',
		all: [/\b(themes?|dark mode|light mode|colou?r scheme|colou?rs?|appearance)\b/],
		text: 'The color theme picker is open. Move through the list to preview each theme and press Enter to keep one. More themes are in the Extensions view: search for "theme".',
		open: { target: 'color-theme' },
	},
	{
		id: 'chat-font',
		all: [/\bchat\b/, /\b(font|text)\b/, /\b(size|bigger|smaller|larger)\b/],
		text: 'The chat has its own text size: **Settings > General > Chat font size**. Code blocks in the chat follow the editor font.',
		open: { target: 'settings', arg: 'general' },
	},
	{
		id: 'font',
		all: [/\b(font|text|zoom)\b/, /\b(size|bigger|smaller|larger|zoom|family)\b/],
		text: 'Set **Editor: Font Size** (and Font Family just below it) in the editor settings. To make the whole window bigger or smaller instead, press **Cmd+=** or **Cmd+-**, and **Cmd+0** to reset.',
		open: { target: 'editor-settings', arg: 'editor.fontSize' },
	},
	{
		id: 'shortcuts',
		all: [/\b(shortcuts?|keybindings?|hot ?keys?|key ?binds?|keyboard)\b/],
		text: 'The keyboard shortcuts editor lists every command with its key. Type a command or a key to filter, and double click a row to change its binding. The ones to know: **Cmd+L** opens the chat, **Cmd+K** edits code inline, **Cmd+Shift+J** opens OpenCursor settings, **Cmd+Shift+P** runs any command.',
		open: { target: 'shortcuts' },
	},
	{
		id: 'mcp',
		all: [/\b(mcp|model context protocol|tool servers?)\b/],
		text: 'MCP servers add tools to the agent in Agent and Debug modes. **Settings > Tools and MCP** lists your servers with on and off switches and a reload button. Configs are read from your user `mcp.json`, the project\'s `.cursor/mcp.json` and `~/.cursor/mcp.json`, so Cursor setups work as they are.',
		open: { target: 'settings', arg: 'mcp' },
	},
	{
		id: 'rules',
		all: [/\b(rules?|agents\.md|claude\.md|cursorrules|instructions?)\b/],
		text: '**Settings > Rules** has **User rules**, free text the agent follows in every project, and your project\'s rules. Rule files in `.open-cursor/rules`, `.cursor/rules`, `AGENTS.md`, `CLAUDE.md` and `.cursorrules` are picked up as they are.',
		open: { target: 'settings', arg: 'rules' },
	},
	{
		id: 'tab',
		all: [/\b(tab completions?|autocomplete|auto-complete|auto complete|completions?|inline suggestions?|suggestions as i type)\b/],
		text: 'Tab suggests code over several lines as you type: press **Tab** to accept, **Escape** to dismiss. **Settings > Tab** turns it on or off and sets its model and delay. Fill in the middle models (Codestral, DeepSeek, a local Qwen coder) are the fastest.',
		open: { target: 'settings', arg: 'tab' },
	},
	{
		id: 'autorun',
		all: [/\b(auto-?run|allowlist|denylist|approv(e|al)|ask(s|ing)? before|permissions?|full access|yolo)\b/],
		text: 'The shield next to the model in the chat box sets when the agent may run a command without asking:\n\n- **Ask every time**: every command waits for you.\n- **Allowlist**: commands on your allowlist run, the rest ask.\n- **Auto**: safe commands run; it asks before deleting, installing or going online.\n- **Full access**: every command and tool runs without asking.\n\nThe same setting, with the allowlist and the **Denylist** (always asks), is in **Settings > General > Terminal commands**. File edits never ask; they land as changes you keep or undo.',
		open: { target: 'settings', arg: 'general' },
	},
	{
		id: 'index',
		all: [/\b(index(ing)?|codebase search|semantic search|embeddings?)\b/],
		text: '**Settings > Indexing** turns the local codebase index on or off, sets the embedding model, and rebuilds or clears it. Without an embedding model, codebase search falls back to keyword search.',
		open: { target: 'settings', arg: 'indexing' },
	},
	{
		id: 'update',
		all: [/\b(update|updates|updating|upgrade|new version|latest version)\b/],
		not: [/\b(extensions?|plugins?|settings?|models?)\b/],
		text: 'OpenCursor checks for a new version at startup and every six hours, and offers it with an **Update** button. It downloads and checks the new version, and installs it when you restart. To check right away, run **Check for Updates** from the command palette (Cmd+Shift+P).',
	},
	{
		id: 'extensions',
		all: [/\b(extensions?|plugins?|marketplace|add-?ons?)\b/],
		text: 'The Extensions view searches Open VSX: type a name, then **Install**. Extensions made for VS Code work here too.',
		open: { target: 'extensions' },
	},
];

/** Questions about something going wrong need the model's judgment, not a canned page. */
const PROBLEM = /\b(why|not|n't|cant|wont|error|errors|broken|fails?|failed|failing|stuck|bug|crash(es|ed)?|slow|problem|issue|wrong|missing|disappeared)\b/;

function normalize(q: string): string {
	return q.toLowerCase().replace(/[’']/g, '\'').replace(/[^\w\s.'+-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A hand written answer when the question is short, about one topic and not about a problem. */
export function instantAnswer(question: string, platform: string = process.platform): InstantAnswer | undefined {
	const q = normalize(question);
	if (!q || q.split(' ').length > 14 || PROBLEM.test(q)) { return undefined; }
	for (const i of INTENTS) {
		if (i.all.every(r => r.test(q)) && !(i.not ?? []).some(r => r.test(q))) {
			return { id: i.id, text: platform === 'darwin' ? i.text : i.text.replace(/\bCmd\b/g, 'Ctrl'), open: i.open };
		}
	}
	return undefined;
}

export const INSTANT_IDS = INTENTS.map(i => i.id);
