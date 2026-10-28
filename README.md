<p align="center">
  <img src="resources/linux/code.png" width="112" alt="Open Cursor icon">
</p>

<h1 align="center">Open Cursor</h1>

<p align="center">An AI code editor you own. Bring your own keys, your own local models, or the agent subscription you already pay for.</p>

---

Open Cursor is a fork of Code - OSS (the MIT core of VS Code) with an agent, Tab completion and inline editing built in. It works the way Cursor does, so your hands already know it: Cmd+K edits in place, Cmd+L opens the agent with your selection, Tab finishes your line. There is no Open Cursor account, no server between you and the model, and no telemetry.

## What it does

**Agent.** Chat in the side panel that reads your code, searches it, edits files and runs commands. Four modes: Agent, Plan, Debug and Ask. Every edit lands as a reviewable diff with Keep and Undo per change, per file, or all at once. Every message is a checkpoint you can restore.

**Tab.** Multi line completions as you type, from any model that can fill in the middle (Codestral, DeepSeek, any Ollama coder model) or a fast chat model.

**Cmd+K.** Select code, describe the change, watch the diff stream into the file. Accept with Cmd+Enter, reject with Cmd+Backspace, or type a follow up. Cmd+K in the terminal turns a sentence into a command. VS Code's Cmd+K chords still work: press the second key while the prompt box is empty.

**Context.** @ files, folders, symbols, git changes, lints, terminal output, docs, the web and past chats. Paste images. Rules in `.open-cursor/rules`, `AGENTS.md` and `CLAUDE.md`. Custom slash commands in `.open-cursor/commands`. A local semantic index of your codebase, with a keyword fallback when you have no embedding model.

**MCP.** Any MCP server over stdio or HTTP.

## Bring your own model

| How | Examples |
|---|---|
| API key | Anthropic, OpenAI, Google Gemini, OpenRouter, DeepSeek, xAI, Mistral, Groq |
| Local | Ollama, LM Studio, any OpenAI compatible URL |
| Your subscription | Claude Code, Codex CLI, Gemini CLI |

Keys are stored in your OS keychain. Environment variables such as `ANTHROPIC_API_KEY` work with no setup.

The subscription option runs the CLI you are already signed in to, headless, inside Open Cursor. You get Open Cursor's chat, diff review and checkpoints; the CLI does the thinking on your existing plan. Pick "Claude Code · Sonnet" in the model menu and that is it.

## Coming from Cursor

Open Cursor reads `.cursor/rules`, `.cursor/commands`, `.cursorrules` and both `mcp.json` locations, so a Cursor project works on day one. Keybindings match.

## Build

Requires Node 24 (see `.nvmrc`) and Xcode command line tools.

```sh
npm ci
npm run compile
./scripts/code.sh                                # run from source
./scripts/open-cursor/package-mac.sh arm64       # Open Cursor.app + DMG in ../open-cursor-dist
```

The AI features live in `extensions/open-cursor` (TypeScript, React webviews) and `src/vs/workbench/contrib/openCursor` (the Cmd+K box and inline diff). `docs/open-cursor/ARCHITECTURE.md` explains how they fit together.

## License

MIT. Open Cursor is built on [Code - OSS](https://github.com/microsoft/vscode) by Microsoft, also MIT. The upstream README is kept at `docs/UPSTREAM_README.md`.
