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
  <a href="https://x.com/fsconfig"><img alt="Follow @fsconfig on X" src="https://img.shields.io/badge/follow-%40fsconfig-555?style=flat-square&logo=x&logoColor=white"></a>
</p>

<p align="center">
  <a href="https://x.com/fsconfig">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="resources/readme/made-by-dark.svg">
      <img src="resources/readme/made-by-light.svg" width="178" height="44" alt="Made by Noah, @fsconfig on X">
    </picture>
  </a>
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

| Platform | Files |
|---|---|
| macOS | `macos-arm64.dmg` (Apple Silicon), `macos-x64.dmg` (Intel) |
| Windows | `windows-x64-setup.exe` or `windows-arm64-setup.exe`, or a portable `.zip` |
| Linux | `.deb`, `.rpm` or `.tar.gz`, for x64 and arm64 |

Builds are not signed yet, so the first launch of a downloaded file needs one extra step. The install commands above skip it.

- **macOS:** open the app once, then System Settings > Privacy & Security > Open Anyway.
- **Windows:** on the SmartScreen prompt, choose More info > Run anyway.

## Features

<table>
  <tr>
    <td width="150"><b>Agent</b></td>
    <td>Reads and searches your code, edits files and runs commands. Four modes: Agent, Plan, Debug and Ask. You choose how much it may run on its own: ask every time, an allowlist, Auto (it asks before deleting, installing or going online) or full access.</td>
  </tr>
  <tr>
    <td><b>Tab</b></td>
    <td>Completions over several lines as you type, from a fill in the middle model such as Codestral or an Ollama coder model, or from a fast chat model.</td>
  </tr>
  <tr>
    <td><b>Cmd+K</b></td>
    <td>Describe a change and watch the diff stream into the file. In the terminal, a sentence becomes a command. VS Code's own Cmd+K chords still work.</td>
  </tr>
  <tr>
    <td><b>Review</b></td>
    <td>Every edit is a diff you keep or undo per hunk, per file or all at once. Every message is a checkpoint you can restore.</td>
  </tr>
  <tr>
    <td><b>Context</b></td>
    <td><code>@</code> files, folders, symbols, git changes, lints, terminal output, docs, the web and earlier chats, or paste images. A local index of your codebase powers semantic search.</td>
  </tr>
  <tr>
    <td><b>Rules and MCP</b></td>
    <td>Rules from <code>.open-cursor/rules</code>, <code>AGENTS.md</code> and <code>CLAUDE.md</code>, your own slash commands, and any MCP server. Cursor projects work as they are.</td>
  </tr>
  <tr>
    <td><b>Help</b></td>
    <td>Ask how anything in the app works and it takes you to the right setting or page. Common questions are answered instantly, without a model.</td>
  </tr>
  <tr>
    <td><b>Menu bar</b></td>
    <td>A small panel next to the clock: hand a task to the agent in any project, or jump to an open window.</td>
  </tr>
</table>

## Models

| Source | Examples |
|---|---|
| Free | OpenCode's free models with no account, installed in one click; free keys from OpenRouter, Groq, Google Gemini, NVIDIA, Z.ai, Mistral and SambaNova |
| Subscription | Claude Code, Codex CLI, Grok CLI, Gemini CLI |
| Local | Ollama, LM Studio or any OpenAI compatible server, on this computer or another on your network |
| API key | Anthropic, OpenAI, Google Gemini, OpenRouter, DeepSeek, xAI, Mistral, Groq, NVIDIA, Z.ai, SambaNova |

A subscription runs the CLI you already use in the background, so you keep OpenCursor's chat, review and checkpoints while the work counts against your plan. With a free key connected, Free (auto) moves to another free model when one hits its limit. API keys stay in your system keychain.

## Development

<details>
<summary><b>Build from source</b></summary>
<br>

You need Node 24 (see `.nvmrc`) and the usual [VS Code build prerequisites](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites).

```sh
npm ci
npm run compile
./scripts/code.sh
```

The AI extension builds on its own and is bundled into the app:

```sh
cd extensions/open-cursor
npm ci
node .esbuild.mts --watch
```

Package a macOS build with `./scripts/open-cursor/package-mac.sh arm64`. End to end scenarios that drive a real window live in `scripts/open-cursor/scenarios`; `./scripts/open-cursor/test-all.sh` runs them all.

</details>

<details>
<summary><b>Project layout</b></summary>
<br>

OpenCursor's own code is small and sits beside the upstream tree.

```
extensions/open-cursor/               the AI extension
  src/agent/                          chat, agent loop, modes, tools
  src/providers/                      model providers
  src/cliAgents/                      Claude Code, Codex, Grok, Gemini and OpenCode adapters
  src/help/                           Help mode: manual, instant answers, in app links
  src/tab/  src/inline/               Tab and Cmd+K
  src/edits/                          review and checkpoints
  src/context/  src/indexing/         @ mentions, rules, codebase index
  webview/src/                        chat and settings interfaces
src/vs/workbench/contrib/openCursor/  inline diff and the Cmd+K box
src/vs/code/electron-main/            menu bar item
```

See [ARCHITECTURE.md](docs/open-cursor/ARCHITECTURE.md) for how the pieces fit together.

</details>

## Contributing

Issues and pull requests are welcome. Run `npm run typecheck` in `extensions/open-cursor` before opening one, and keep changes to upstream VS Code files small so newer Code - OSS releases merge cleanly.

## License

[MIT](LICENSE.txt). Built on [Code - OSS](https://github.com/microsoft/vscode) by Microsoft, also MIT.

Made by Noah, [@fsconfig](https://x.com/fsconfig) on X. If OpenCursor saves you time, a follow or a star helps.
