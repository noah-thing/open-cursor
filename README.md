<p align="center">
  <img src="resources/readme/icon.png" width="128" alt="OpenCursor">
</p>

<h1 align="center">OpenCursor</h1>

<p align="center">
  An AI code editor that runs on your own model, key or subscription.<br>
  No account and no proxy server in between.
</p>

<p align="center">
  <a href="https://github.com/noah-thing/open-cursor/releases"><img alt="Release" src="https://img.shields.io/github/v/release/noah-thing/open-cursor?include_prereleases&style=flat-square&color=555"></a>
  <a href="LICENSE.txt"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-555?style=flat-square"></a>
</p>

OpenCursor is a fork of [Code - OSS](https://github.com/microsoft/vscode) with an agent, Tab completion and inline editing built in. It is laid out the way Cursor is, so the habits carry over: Cmd+K edits in place, Cmd+L sends your selection to the agent, Tab finishes the line. Your VS Code extensions, themes and settings work as they always did.

What sets it apart is who you pay. Point it at an API key, a model running on your machine, or the Claude Code, Codex, Grok or Gemini CLI you are already signed in to. Requests go straight from your computer to that provider.

## Quick setup

**macOS and Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/noah-thing/open-cursor/main/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/noah-thing/open-cursor/main/install.ps1 | iex
```

The script picks the build for your system and processor from the latest release and installs it: the app in Applications on macOS, the `.deb` or `.rpm` on Linux (or a portable copy in `~/.local` when neither fits), the per user setup on Windows. Set `OPENCURSOR_VERSION=v0.1.0` to install a specific release.

Then open OpenCursor and pick a model on the start screen: a subscription you are signed in to, a local model, or an API key.

## Download

Prefer to install by hand? Grab the latest build from [Releases](https://github.com/noah-thing/open-cursor/releases).

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `OpenCursor-<version>-macos-arm64.dmg` |
| Windows | `OpenCursor-<version>-windows-x64-setup.exe`, or the portable `.zip` |
| Linux | `.deb` |

Builds are not signed yet. On macOS, right click the app and choose Open the first time.

## Features

**Agent**
- Chat in the side panel that reads and searches your code, edits files and runs commands.
- Four modes: Agent, Plan, Debug and Ask. Ask is read only. Plan ends with a plan you can build.
- Commands wait for approval unless you allow them (ask, allowlist or always).

**Tab**
- Multi line completions as you type, from any fill in the middle model (Codestral, DeepSeek, Ollama coder models) or a fast chat model.

**Cmd+K**
- Select code, describe the change and watch the diff stream into the file. Cmd+Enter accepts, Cmd+Backspace rejects, or type a follow up.
- In the terminal, Cmd+K turns a sentence into a command and leaves it unexecuted.
- VS Code's own Cmd+K chords still work: press the second key while the prompt is empty.

**Review and checkpoints**
- Every edit is a diff you can Keep or Undo per hunk, per file or all at once.
- Every message is a checkpoint you can restore.

**Context**
- `@` files, folders, symbols, git changes, lints, terminal output, docs, the web and earlier chats. Paste images.
- A local index of your codebase for semantic search, with a keyword fallback when you have no embedding model.

**Menu bar**
- A small panel next to the clock: hand a task to the agent in any project, or jump to an open window or recent folder.

**Rules, commands and MCP**
- Rules from `.open-cursor/rules`, `AGENTS.md` and `CLAUDE.md`. Slash commands from `.open-cursor/commands`.
- Any MCP server over stdio or HTTP.
- Cursor projects work as they are: `.cursor/rules`, `.cursor/commands`, `.cursorrules` and both `mcp.json` locations are read.

## Models

| Source | Examples |
|---|---|
| API key | Anthropic, OpenAI, Google Gemini, OpenRouter, DeepSeek, xAI, Mistral, Groq |
| Local | Ollama, LM Studio or any OpenAI compatible server, on this computer or another one on your network |
| Subscription | Claude Code, Codex CLI, Grok CLI, Gemini CLI |

Keys are kept in your OS keychain, and variables like `ANTHROPIC_API_KEY` are picked up as they are. The subscription option runs the CLI you already use, headless, so you keep OpenCursor's chat, diff review and checkpoints while the CLI does the work on your plan.

## Build from source

You need Node 24 (see `.nvmrc`), plus the usual [VS Code build prerequisites](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites) for your platform.

```sh
npm ci
npm run compile
./scripts/code.sh
```

The AI extension is built separately and bundled into the app:

```sh
cd extensions/open-cursor
npm ci
node .esbuild.mts          # add --watch while developing
npm run typecheck
```

To package a release build on macOS:

```sh
./scripts/open-cursor/package-mac.sh arm64    # OpenCursor.app and a DMG in ../open-cursor-dist
```

End to end scenarios that drive a real window with Playwright live in `scripts/open-cursor/scenarios`; run one with `node scripts/open-cursor/drive.mjs scripts/open-cursor/scenarios/smoke.mjs`.

## Project layout

OpenCursor's own code is small and sits beside the upstream tree.

```
extensions/open-cursor/            the AI extension (TypeScript, React webviews)
  src/agent/                       chat controller, agent loop, modes, tools
  src/providers/                   Anthropic, OpenAI, Google and Ollama clients
  src/cliAgents/                   Claude Code, Codex, Gemini and Grok CLI adapters
  src/tab/  src/inline/            Tab completion and Cmd+K
  src/edits/                       pending edits, hunks, checkpoints
  src/context/  src/indexing/      @ mentions, rules, codebase index
  src/mcp/                         MCP client
  webview/src/                     chat and settings UIs
src/vs/workbench/contrib/openCursor/   inline diff and the Cmd+K box
src/vs/code/electron-main/             menu bar item
extensions/theme-open-cursor/          default themes
scripts/open-cursor/                   packaging and end to end scripts
docs/open-cursor/ARCHITECTURE.md       how the pieces fit together
```

## Contributing

Issues and pull requests are welcome. Before opening one, run `npm run typecheck` in `extensions/open-cursor`. Read [ARCHITECTURE.md](docs/open-cursor/ARCHITECTURE.md) first if you are touching the bridge between the extension and the workbench. Changes to the upstream VS Code files should stay small so merging newer Code - OSS releases stays easy.

## License

[MIT](LICENSE.txt). OpenCursor is built on [Code - OSS](https://github.com/microsoft/vscode) by Microsoft, also MIT. The upstream README is kept at [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md).
