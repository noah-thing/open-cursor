# Open Cursor architecture

Open Cursor is a fork of Code-OSS 1.143.1 (MIT). All AI features live in one built-in extension,
`extensions/open-cursor`, plus a small workbench contribution in core
(`src/vs/workbench/contrib/openCursor/`) for the two things an extension cannot draw: the Cmd+K
prompt box inside the editor and inline diff rendering (deleted lines as view zones, per-hunk Keep/Undo).

Model access is bring-your-own: API keys (Anthropic, OpenAI, Google, OpenRouter, DeepSeek, xAI,
Mistral, Groq), local servers (Ollama, LM Studio, any OpenAI-compatible URL), and installed agent CLIs
running on the user's own subscription (Claude Code, Codex, Gemini CLI). No Open Cursor backend,
no telemetry, no account.

## Machines

- Full fork + builds: Mac mini `~/open-cursor` (git, private GitHub `noah-thing/open-cursor`). Node
  24.18 at `~/.local/node-v24.18.0-darwin-arm64/bin` (`source ~/oc-env.sh`).
- Extension development: MacBook `~/open-cursor-dev/extensions/open-cursor` is the source of truth
  for the extension; `scripts/sync-ext.sh` rsyncs it into the mini fork. Never edit the extension
  copy on the mini.

## Extension layout (`extensions/open-cursor`)

| Path | Owner | Exports |
|---|---|---|
| `src/shared/protocol.ts` | lead | webview <-> host messages, chat data model. Do not change shapes without the lead. |
| `src/providers/types.ts` | lead | canonical LLM types |
| `src/services.ts` | lead | service interfaces + `Services` bag |
| `src/providers/*` | providers | `createProviderRegistry(ctx): IProviderRegistry` in `registry.ts` |
| `src/agent/*`, `src/context/*` | agent | `createContextService(ctx)` in `context/service.ts`; `createChatController(ctx, services)` in `agent/chatController.ts` |
| `src/edits/*`, `src/mcp/*`, `src/indexing/*` | edits | `createPendingEdits(ctx)`, `createCheckpoints(ctx)`, `createMcpManager(ctx)`, `createCodebaseIndex(ctx, registry)` |
| `src/cliAgents/*` | cli | `createCliAgents(ctx): ICliAgents` in `cliAgents/index.ts` |
| `src/tab/*`, `src/inline/*`, `src/terminal/*`, `src/scm/*` | tab | `registerTab(ctx, services)`, `registerInlineEdit(ctx, services)`, `registerTerminalCmdK(ctx, services)`, `registerCommitMessage(ctx, services)` |
| `webview/src/chat/*`, `webview/src/settings/*`, `src/settings/*` | ui | chat React app; settings React app; `registerSettings(ctx, services)` |
| `src/extension.ts` | lead | wiring |

`package.json` `contributes` is generated: each module writes `contrib/<module>.json` (an object with
any of `commands`, `keybindings`, `configuration` (one object with `title` + `properties`), `menus`,
`viewsContainers`, `views`), and `scripts/merge-contrib.mjs` merges them. Never edit
`contributes` in package.json by hand.

Settings namespace: `openCursor.*`. User data dir for rules/commands/mcp: `~/.open-cursor/`.
Compatibility (a feature, so Cursor users can switch with zero setup): also read `~/.cursor/mcp.json`,
`.cursor/mcp.json`, `.cursor/rules/*.mdc`, `.cursor/commands/*.md`, `.cursorrules`, `AGENTS.md`,
`CLAUDE.md`. Open Cursor's own equivalents live under `.open-cursor/` and win on conflicts.

## Core bridge (workbench contribution <-> extension), all via commands

Core provides (extension calls with `vscode.commands.executeCommand`; if the command is missing, e.g.
running in stock VS Code, the extension falls back to decorations + CodeLens):

- `_openCursor.diff.set(uri: string, hunks: PendingHunk[], meta: { fileIndex: number; fileCount: number })`
  render pending hunks for that file (replaces previous state for the uri). `PendingHunk` is in services.ts.
- `_openCursor.diff.clear(uri: string)`
- `_openCursor.inline.status(sessionId: string, state: 'generating' | 'done' | 'error', message?: string)`

Extension provides (core calls these):

- `openCursor.diff.acceptHunk(uri: string, hunkId: string)`, `openCursor.diff.rejectHunk(uri, hunkId)`
- `openCursor.diff.acceptFile(uri)`, `openCursor.diff.rejectFile(uri)`, `openCursor.diff.acceptAll()`, `openCursor.diff.rejectAll()`
- `openCursor.diff.nextFile()`, `openCursor.diff.prevFile()`
- `openCursor.inline.submit({ sessionId, uri, selection: { startLine, startCol, endLine, endCol } /* 0-based */, prompt, modelId? }) => Promise<void>`
  streams the edit into the document as pending hunks of source `inline` and reports via `_openCursor.inline.status`.
  A second submit with the same sessionId is a follow-up that refines the previous result.
- `openCursor.inline.accept(sessionId)`, `openCursor.inline.reject(sessionId)`
- `openCursor.models.list() => ModelOption[]`, `openCursor.models.getDefault(purpose) => string`

## Chat view

Webview view `openCursor.chat` in a view container `openCursor` contributed to `secondarySidebar`.
The host sends full `chat` snapshots (throttled ~30 fps while streaming). The webview is a React 19 app
styled only with VS Code theme CSS variables plus a few Open Cursor tokens, so every theme works.

## Agent

Native loop (`src/agent/loop.ts`): system prompt per mode + rules + context, tools as JSON schema,
stream model, execute tool calls (parallel when read-only), feed results back, repeat until no tool
calls, user stops, or 50 iterations. Approval policy from `openCursor.agent.autoRun`:
`ask` (every mutating command asks), `allowlist` (commands matching `openCursor.agent.commandAllowlist`
run, others ask), `always`. File edits never ask; they land as pending edits the user can Keep/Undo.

Tools (our names): `read_file`, `list_dir`, `glob_file_search`, `grep`, `codebase_search`,
`edit_file` (exact string replace), `write_file`, `delete_file`, `run_terminal_cmd`, `read_lints`,
`todo_write`, `fetch_url`, `web_search` (only when a search backend is configured), plus MCP tools.
Ask mode is read-only; Plan mode is read-only and ends by writing a plan the user can Build.

CLI agents (`cli:<agent>/<model>` model ids) bypass the native loop: the chat controller hands the
turn to `ICliAgents.runTurn`, which streams into the same UI parts and edit review.

## Rules for every contributor

- TypeScript strict. No new npm dependencies without the lead; installed: react 19, react-dom,
  marked 15, highlight.js 11, @modelcontextprotocol/sdk, diff, minimatch 10, plus node built-ins.
- Use `fetch` (Node 22+ in the extension host) and hand-written SSE parsing; no provider SDKs.
- Efficiency matters: lazy work, debounced I/O, cancellation everywhere (AbortSignal /
  CancellationToken), no polling loops, prompt caching where providers support it.
- Typecheck your own files: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep 'src/<yourdir>'`
  (others may be mid-edit). Build: `node .esbuild.mts --dev`.
- Write in the style of the code around you; tabs for indentation; the license header used in
  `src/providers/types.ts`.
