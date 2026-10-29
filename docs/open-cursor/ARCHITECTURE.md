# Architecture

OpenCursor is a fork of Code - OSS 1.143.1. Nearly everything it adds lives in one built-in extension, `extensions/open-cursor`. A small workbench contribution in core (`src/vs/workbench/contrib/openCursor/`) covers the two things an extension cannot draw: the Cmd+K prompt box inside the editor, and inline diff rendering (removed lines as view zones, Keep and Undo per hunk).

Models come from the user: API keys, local servers (Ollama, LM Studio, any OpenAI compatible URL), or an installed agent CLI running on the user's own subscription (Claude Code, Codex, Grok, Gemini CLI, or the free OpenCode). There is no OpenCursor backend.

## Extension layout

| Path | Entry point |
|---|---|
| `src/shared/protocol.ts` | webview and host messages, the chat data model |
| `src/providers/types.ts` | canonical LLM request and stream types |
| `src/services.ts` | service interfaces and the `Services` bag |
| `src/providers/` | `createProviderRegistry(ctx)` in `registry.ts` |
| `src/context/` | `createContextService(ctx)` in `service.ts` |
| `src/agent/` | `createChatController(ctx, services)` in `chatController.ts` |
| `src/edits/` | `createPendingEdits(ctx)`, `createCheckpoints(ctx)` |
| `src/mcp/` | `createMcpManager(ctx)` |
| `src/indexing/` | `createCodebaseIndex(ctx, registry)` |
| `src/cliAgents/` | `createCliAgents(ctx)` in `index.ts` |
| `src/tab/`, `src/inline/`, `src/terminal/`, `src/scm/` | `registerTab`, `registerInlineEdit`, `registerTerminalCmdK`, `registerCommitMessage` |
| `src/settings/`, `webview/src/` | `registerSettings`, plus the chat and settings React apps |
| `src/extension.ts` | wires the above together |

`package.json` `contributes` is generated. Each module writes `contrib/<module>.json` with any of `commands`, `keybindings`, `configuration` (one object with `title` and `properties`), `menus`, `viewsContainers` and `views`, and `scripts/merge-contrib.mjs` merges them. Do not edit `contributes` by hand.

Settings live under `openCursor.*`. User level rules, commands and MCP config live in `~/.open-cursor/`. For Cursor users, OpenCursor also reads `~/.cursor/mcp.json`, `.cursor/mcp.json`, `.cursor/rules/*.mdc`, `.cursor/commands/*.md`, `.cursorrules`, `AGENTS.md` and `CLAUDE.md`. Its own files under `.open-cursor/` win on conflicts.

## Bridge between core and the extension

Everything crosses as commands. If a core command is missing (the extension running in stock VS Code, say), the extension falls back to decorations and CodeLens.

Core provides:

- `_openCursor.diff.set(uri, hunks, { fileIndex, fileCount })` renders the pending hunks of a file and replaces any earlier state for that uri. `PendingHunk` is defined in `services.ts`.
- `_openCursor.diff.clear(uri)`
- `_openCursor.inline.status(sessionId, 'generating' | 'done' | 'error', message?)`

The extension provides:

- `openCursor.diff.acceptHunk(uri, hunkId)` and `rejectHunk(uri, hunkId)`
- `openCursor.diff.acceptFile(uri)`, `rejectFile(uri)`, `acceptAll()`, `rejectAll()`
- `openCursor.diff.nextFile()` and `prevFile()`
- `openCursor.inline.submit({ sessionId, uri, selection, prompt, modelId? })` streams the edit into the document as pending hunks of source `inline` and reports through `_openCursor.inline.status`. `selection` is `{ startLine, startCol, endLine, endCol }`, all 0 based. A second submit with the same `sessionId` is a follow up that refines the previous result.
- `openCursor.inline.accept(sessionId)` and `reject(sessionId)`
- `openCursor.models.list()` and `openCursor.models.getDefault(purpose)`

## Chat view

The webview view `openCursor.chat` sits in the `openCursor` view container, contributed to the secondary sidebar. The host sends full `chat` snapshots, throttled to about 30 per second while streaming. The webview is a React 19 app styled only with VS Code theme variables and a few OpenCursor tokens, so every theme works.

## Agent

The native loop (`src/agent/loop.ts`) builds the system prompt from the mode, rules and context, passes tools as JSON schema, streams the model, runs the tool calls (in parallel when they only read), feeds the results back, and repeats until the model stops calling tools, the user stops it, or it reaches 50 iterations.

Whether a command runs without asking follows `openCursor.agent.autoRun`: `ask` asks for every mutating command, `allowlist` runs commands matching `openCursor.agent.commandAllowlist` and asks for the rest, `always` never asks. File edits never ask; they land as pending edits the user can Keep or Undo.

Tools: `read_file`, `list_dir`, `glob_file_search`, `grep`, `codebase_search`, `edit_file` (exact string replace), `write_file`, `delete_file`, `run_terminal_cmd`, `read_lints`, `todo_write`, `fetch_url`, `web_search` (only when a search backend is configured), and whatever MCP servers add. Ask mode is read only. Plan mode is read only and ends with a plan the user can build.

CLI agents (model ids shaped `cli:<agent>/<model>`) skip the native loop. The chat controller hands the turn to `ICliAgents.runTurn`, which streams into the same message parts and edit review.

## Conventions

- TypeScript in strict mode, tabs for indentation, and the license header used in `src/providers/types.ts`.
- Provider calls use `fetch` with hand written SSE parsing. No provider SDKs.
- Do the work lazily, debounce I/O, and take a cancellation signal (`AbortSignal` or `CancellationToken`) wherever something can run long. No polling loops. Use prompt caching where the provider supports it.
- Check types with `npm run typecheck`; build with `node .esbuild.mts` (`--dev` or `--watch` while iterating).
