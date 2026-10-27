# Cursor 3.26.16 - feature inventory and built-in extensions

Source of truth: the installed app at `/Applications/Cursor.app` (Cursor 3.26.16, VS Code base 1.128.0, Electron). Everything below was read from shipped artifacts (workbench bundle `out/vs/workbench/workbench.desktop.main.js`, `nls.messages.json`, `product.json`, `extensions/cursor-*`, `extensions/theme-cursor`). Descriptions are in our own words. Where a value is inferred rather than read, it is marked (inferred).

Note on the product shape: the bundle ships two renderer builds, `workbench.desktop.main.js` (classic editor window) and `workbench.glass.main.js` ("Glass" = the Agents window, a chat-first layout; context key `isGlass`). A user setting/storage key `cursor/unifiedAppLayout` selects `agent` or `editor` layout (enum `JF.Agent="agent"`, `JF.Editor="editor"`). Open Cursor only needs to rebuild the editor-window behaviour plus an agent-first layout preset.

## 1. Feature inventory ranked by centrality

| Rank | Feature | One-line behaviour | Spec file |
|---|---|---|---|
| 1 | Agent chat ("Composer", unified chat) | Right-hand chat pane. Modes Agent / Ask / Plan / Debug (+ Triage, Spec, Multitask, custom). Streams model output, runs tools, edits files. | 04, 06 |
| 2 | Tab (inline next-edit completion) | Ghost-text multi-line completions and "jump to next edit" suggestions accepted with Tab. Server model ("cpp"). | 05 |
| 3 | Cmd+K inline edit (Quick Edit) | Prompt bar anchored in the editor at the selection; streams a diff back; accept/reject. Same shortcut in terminal generates a shell command. | 05 |
| 4 | Edit review (inline diffs) | Agent edits land in the buffer as inline diffs with Keep/Undo per hunk, per file and all, plus next/previous change/file navigation. | 04, 02 |
| 5 | Context system (@ mentions) | `@Files & Folders`, `@Code`, `@Git/Commits/PR/Diff`, `@Past Chats`, `@Terminals`, `@Browser`, images, docs, web, rules. | 04 |
| 6 | Rules / AGENTS.md / skills / commands / hooks | Project instruction files loaded into the agent context; slash commands from `.cursor/commands`; lifecycle hooks. | 04 |
| 7 | Codebase indexing and semantic search | Merkle-tree sync of a repo to an embedding service, plus a local indexed grep ("instant grep"). | 00 (cursor-retrieval) |
| 8 | MCP | Config in `mcp.json`, stdio and http/sse servers, OAuth, per-tool approval, allowlists. | 04 |
| 9 | Auto-run and approvals | Ask-every-time / allowlist / sandboxed / smart auto / run-everything (YOLO) modes for shell, MCP, fetch, read. | 04 |
| 10 | Checkpoints and restore | Each user turn can be restored to the file state before it; fork chat from a message. | 04 |
| 11 | Subagents / parallel agents | `Task` tool with typed subagents (explore, shell, browser-use, computer-use, debug, custom). Triage and Multitask modes. | 04 |
| 12 | Background / Cloud agents | Remote VM workspace (remote authority `background-composer`), environment.json, PRs, Slack. | 04 |
| 13 | Worktrees | Agent runs in Cursor-managed `git worktree` under `.cursor/worktrees`, with cleanup limits. | 04, 03 |
| 14 | Browser tool + embedded browser tab | Agent-controlled in-app browser (CDP), screenshots, snapshots, origin allowlist. | 04 |
| 15 | Computer use | Desktop/VM mouse-keyboard-screenshot actions (cloud VM mostly). | 04 |
| 16 | Agent Review (Bugbot) | Reviews working tree/commit/branch diff for issues; runs on commit if enabled. | 04 |
| 17 | Plugins / marketplace | Bundles of rules, skills, subagents, commands, MCP servers, hooks installable from a marketplace. | 04 |
| 18 | Voice input | Dictation in chat (`composer.toggleVoiceDictation`, Cmd+Shift+Space), voice mode settings. | 03 |
| 19 | Git AI helpers | Generate commit message (SCM input box button), branch name, PR descriptions. | 00 |
| 20 | Memories / knowledge base | Server-stored knowledge items and agent memories (`KnowledgeBase*` RPCs; tool `KNOWLEDGE_BASE`). | 04 |
| 21 | Cursor Blame, canvases, image/video generation | Secondary features (blame panes, canvas files, `GenerateImage`/`GenerateVideo` tools). | 04 |

## 2. Backend surface (what a rebuild must replace)

Cursor's closed backend is spoken over Connect/protobuf (`aiserver.v1.*`, `agent.v1.*`). The client itself documents which features hit the server (a "private inference" table). Replace each with your own model gateway:

| Feature key | RPCs (names only) |
|---|---|
| tab | `AiService/StreamCpp`, `CppAppend`, `FileSyncService/FSUploadFile`, `FSSyncFile` |
| cmdk | `CmdKService/StreamCmdK`, `StreamTerminalCmdK`, `RerankCmdKContext`, `RerankTerminalCmdKContext` |
| chat title | `AiService/NameTab` |
| commit message / branch name | `AiService/WriteGitCommitMessage`, `WriteGitBranchName` |
| agent review | `AiService/StreamBugBotAgentic` |
| codebase indexing | `RepositoryService/FastRepoInitHandshakeV2`, `SyncMerkleSubtreeV2`, `FastUpdateFileV2`, `FastRepoSyncComplete`, `EnsureIndexCreated` |
| knowledge base | `AiService/KnowledgeBaseAdd/Update/List` |
| web fetch / image / video / X search | `AiService/RunWebFetch`, `RunGenerateImage`, `RunGenerateVideo`, `RunXSearch` |
| SCM / PRs | `SCMService/*` (GetPullRequest, diff, checks, merge, auto-merge, ...) |
| sharing | `DashboardService/ShareConversation` |
| main chat | `StreamUnifiedChat` / `StreamUnifiedChatWithTools` (old) and the newer `agent.v1.AgentService` (tool calls as typed messages) |

Tab request (`StreamCppRequest`) carries: current file (path, contents, cursor position, selection, language, diagnostics, line ending, file version), diff history (strings and per-file merged histories), linter errors, extra context items, LSP contexts, parameter hints, recently viewed files, an optional "control token" (how likely the model is to return a no-op), client debounce info. Response streams `text`, `range_to_replace`, `cursor_prediction_target` (the "jump here next" target), `begin_edit/done_edit/done_stream`, confidence. Config response tunes `above_radius/below_radius` (window of lines), `global_debounce_duration_millis`, `client_debounce_duration_millis`, `is_ghost_text`, heuristics, `allows_tab_chunks`, `include_unchanged_lines`.

## 3. Built-in `cursor-*` extensions (extensions dir)

Most are bundled single files under `dist/`; their `package.json` has little `contributes`. Facts from the manifests:

| Extension | Activation | Contributes | Role |
|---|---|---|---|
| `cursor-agent-exec` | `*`, main `dist/main` | nothing declared | Executes agent tools on the user's machine: shell (with sandbox), file read/write/edit, ripgrep/glob/ls, rule + AGENTS.md loading, hook execution, MCP forwarding. Contains the rules loader (`.cursor/rules/**/*.mdc`, AGENTS.md, CLAUDE.md, .cursorrules) and hook runner. |
| `cursor-agent-host` | `*` | command `cursorAgentHost.developer.compareStoresOnce`; settings `cursorAgentHost.experimentalHostOwnedSessionStorage` (false), `cursorAgentHost.remoteInferenceRoute` (`auto`) | Hosts the agent loop/session store out of the renderer; talks to the remote inference service. |
| `cursor-agent-worker` | `onStartupFinished` | none | Background worker for agent jobs (large bundle, ~1.8 MB). |
| `cursor-always-local` | `onStartupFinished`, `onResolveRemoteAuthority:background-composer` | menu `scm/inputBox` -> `cursor.generateGitCommitMessage` when `scmProvider == git`; jsonValidation for `.cursor/environment.json` and `.cursor/permissions.json` (schemas bundled) | Local-side glue for cloud agents; commit-message button; schemas. |
| `cursor-browser-automation` | `onStartupFinished` | none (internal commands `cursor.browserView.*`, `cursor.browserAutomation.*`) | Drives the embedded browser: tools `browser_navigate/click/type/fill/fill_form/hover/drag/press_key/scroll/select_option/snapshot/take_screenshot/tabs/highlight/get_bounding_box/mouse_click_xy/cdp`, origin allowlist (`cursor.browserOriginAllowlist.*`). |
| `cursor-checkout` | `*` | none | Git checkout helpers (small, 13 KB), used for PR/branch handoff (inferred). |
| `cursor-commits` | `onStartupFinished` | none | Git history indexing ("commit notes", `cursor.general.gitGraphIndexing`). |
| `cursor-computer-use` | `onStartupFinished` | none | Computer-use tool backend (screenshots, mouse, keyboard). |
| `cursor-deeplink` | `onStartupFinished`, `onUri` | command `cursor-deeplink.debug.triggerDeeplink` | Handles `cursor://anysphere.cursor-deeplink/...` URLs. Paths found: `/prompt`, `/command` (+`/command/create`), `/rule`, `/mcp/install`, `/plugin/add`, `/plugin/install-and-prompt`, `/createchat`, `/agent`, `/background-agent`, `/background-agent/setup`, `/pr-review`, `/settings`, `/settings/plugins`, `/settings/plan-usage`, `/settings/background-composer`, `/customize`, `/customize/marketplace`, `/glass`, `/automations`, `/create-project`, `/join-project`, `/github-connect-callback`. |
| `cursor-explorer` | `onStartupFinished` | none | Explorer enhancements (small). |
| `cursor-file-service` | none | none | File system provider shim (no code activation). |
| `cursor-local-agent-runtime` | `*` | none | Local agent runtime (~5 MB), the non-cloud counterpart to the cloud runner. |
| `cursor-mcp` | `onStartupFinished`, `onUri` | none | MCP client: reads `mcp.json`, stdio/http/sse transports, OAuth (redirect `/oauth/callback`), macOS `sandbox-exec` profile for stdio servers. |
| `cursor-ndjson-ingest` | on command | commands `cursor.ndjsonIngest.start/stop/copyCurl/reassignPort/showStatus`; settings `ndjson.port` (0 = auto), `ndjson.bindAddress` (127.0.0.1) | Debug mode back-end: a loopback HTTP server at `http://127.0.0.1:<port>/ingest/<id>` that appends posted NDJSON lines to `debug-<session>.log`. The agent instruments code to POST log lines there, then reads the log. |
| `cursor-polyfills-remote` | `*` | none | Polyfills for the remote ext host. |
| `cursor-resolver`, `cursor-resolver-helper`, `cursor-socket` | `onResolveRemoteAuthority:background-composer` | resourceLabelFormatter for `vscode-remote://background-composer+*` (suffix "cloud-agent") | Remote authority resolver that opens a cloud-agent VM as a workspace. |
| `cursor-retrieval` | `onStartupFinished` | commands `cursor.grepClient.debug`, `cursor.codebaseTelemetry.*` (dev only); setting `cursor-retrieval.canAttemptGithubLogin` (true); languages `ignore` for `.cursorignore` and `.cursorindexingignore` | Codebase indexing, semantic search, instant grep, ignore files. |
| `cursor-shadow-workspace` | `onStartupFinished` | none | Hidden background window used to lint/typecheck proposed agent edits without touching the visible editor. |
| `cursor-worktree-textmate` | none | languages `worktree-typescript/tsx/javascript/jsx/python/go/...` for files matching `**/.cursor/worktrees/**`; grammars; `configurationDefaults` disabling semantic highlighting for them | Cheap syntax highlighting for files inside agent worktrees. |
| `theme-cursor` | none | 7 themes (see 01) | Cursor Dark / Light / Midnight / HC / colourblind variants. |

Standard VS Code built-ins (git, typescript, markdown, etc.) are also bundled; they are unchanged and not listed.

## 4. Command id prefixes you will see

`composer.*` (chat), `aichat.*` (legacy chat), `aipopup.action.*` (Cmd+K prompt bar), `cursorai.action.*` (misc AI actions, terminal Cmd+K), `editor.action.inlineDiffs.*` (diff review), `editor.action.inlineSuggest.*` (Tab, stock VS Code inline completion engine extended), `aiSettings.action.*` (Cursor Settings), `cursor.*` (misc), `glass.*` (Agents window), `cmdK.*`.
