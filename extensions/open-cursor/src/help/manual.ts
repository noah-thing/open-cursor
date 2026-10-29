/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  The user manual Help answers from. Keep it in step with the app: every place named here
 *  must exist, and every link must be in the target catalog (the unit test checks the links).
 *  On macOS the modifier is Cmd; on Windows and Linux it is Ctrl.
 *--------------------------------------------------------------------------------------------*/

export const MANUAL = `# OpenCursor manual

OpenCursor is a code editor built on VS Code (Code OSS) with an AI agent built in. Everything from VS Code works: extensions, themes, settings, keybindings, the terminal, git. On top of that come the chat agent, Tab completion, inline edit (Cmd+K), review of every AI change, checkpoints, rules, MCP tools, and a menu bar panel.

## The chat
- Open or focus it: Cmd+L (also Cmd+I). Toggle the chat sidebar: Cmd+Alt+B. With text selected in the editor, Cmd+L adds the selection to the chat; Cmd+Shift+L adds it to a new chat.
- New chat: the + button in the chat header, or Cmd+T / Cmd+N while the chat is focused. Several chats open as tabs at the top of the chat.
- Past chats: the clock button in the chat header, or Cmd+Alt+'. Rename or delete from that list. [Past chats](opencursor:past-chats)
- Stop a running answer: the stop button in the box, or Cmd+Shift+Backspace.
- While the agent works you can type a follow up; it waits in a queue and is sent when the turn ends.
- Edit a message you sent: click it, or press Up in an empty box to edit the last one. Sending the edit can restore the code to how it was at that message.
- Checkpoints: every message you send is a checkpoint. Hover a message and choose Restore to put your files back to that moment.
- The status line under a running answer says what the agent is doing (Thinking, Exploring, Editing a file, Running a command, Waiting for your approval) and how long it has run. Each step taken shows as a small mark.
- Chat appearance: Settings > General has the chat font size, Show thinking and Send with Cmd+Enter.

## Modes
Pick the mode with the chip at the bottom left of the box, or Cmd+. to cycle. The default for new chats is in Settings > General.
- Agent: reads, edits and runs code, keeps a todo list, checks its own work. The default.
- Plan: read only. Researches and writes a step by step plan with a todo list, then you press Build and Agent mode carries it out.
- Debug: reproduces a bug, tests hypotheses with temporary logging, fixes the cause, then removes its logging.
- Ask: read only. Answers questions about your code with clickable file references.
- Help: this conversation. It explains the app and opens the right place; it never changes anything.

## Models
The model chip next to the mode chip picks the model for this chat. Models come from three kinds of sources:
- Subscriptions: run an AI coding CLI you already pay for (Claude Code, Codex, Grok, Gemini CLI) or the free OpenCode. OpenCursor keeps its own chat, review and checkpoints; the CLI does the thinking, and the use counts against that plan. Install or sign in from the start screen of a new chat (Subscriptions tab) or Settings > Subscriptions. [Subscriptions](opencursor:settings/subscriptions)
- Local: Ollama, LM Studio or any OpenAI compatible server, on this computer or another one on the network. Set the address on the start screen (Local tab) or Settings > Models.
- API keys: Anthropic, OpenAI, Google Gemini, OpenRouter, DeepSeek, xAI, Mistral, Groq, NVIDIA, Z.ai, SambaNova, or a custom OpenAI compatible endpoint. Paste a key on the start screen (API keys tab) or in Settings > Models > Providers. Keys are stored in the system keychain and checked with the provider before use. [Models settings](opencursor:settings/models)
- First time setup is easiest on the start screen of a new chat: the Connect panel with tabs Subscriptions, Local and API keys. [Connect a model](opencursor:connect)
- Default models: Settings > Models > Defaults has the model for new chats, for inline edit (Cmd+K) and for Tab completion.
- Turn individual models on or off in Settings > Models > Available models. Add any model id by hand under Custom models.
- Switch model by typing /model name in the box.

## Free models
Free models are on their own page, also reachable with the "Get Free Models" command. [Free models](opencursor:free-models)
- OpenCode: free models with no account and no key. Get OpenCode installs it in one click; then press Use on a model. Some free models may use prompts to improve the model.
- Free keys, about a minute each: OpenRouter (Connect with OpenRouter signs in through the browser, no key to copy), NVIDIA, Z.ai, Groq, Google Gemini, Mistral, SambaNova. Each card has Open the key page, the steps, and Paste key (reads the key from the clipboard and checks it).
- Free (auto): appears once a free key is connected. It uses whichever free model has room and moves on when one hits its limit. When OpenCode's free quota runs out mid task, the chat continues on Free (auto) by itself.
- Models that cost nothing carry a Free tag in the model menu.
- Run a model on this computer (local models, offline, private): the Free models page has a section On this computer. It reads the memory and graphics card, lists the models that fit with the best fit first, and Install does everything in one click: installs Ollama if needed, downloads the model and switches the chat to it. Also the "Run a Model on This Computer" command, and On this computer in the Free part of the model menu. [Run a model on this computer](opencursor:free-models/local)

## Reviewing changes
Agent edits land as pending changes, never silently. Changed lines show inline in the editor and a review bar appears above the chat box.
- Keep or undo one change: Cmd+Y / Cmd+N with the cursor in it.
- Keep or undo the whole file: Cmd+Enter / Cmd+Backspace. Undo every change: Cmd+Shift+Backspace.
- Move between changes: Alt+J / Alt+K, between files: Alt+L / Alt+H.
- The review bar also has Keep all and Undo all, and opens each file's diff.

## Terminal commands
The agent asks before running a shell command unless allowed. The shield chip next to the model chip (Agent and Debug modes) picks the level, the same setting as Settings > General > Terminal commands > Auto-run:
- Ask every time: every command waits for approval.
- Allowlist: commands starting with listed words run; the rest ask. The default.
- Auto: safe commands run; the agent asks before anything that deletes, installs, publishes or goes online.
- Full access: every command and MCP tool runs without asking.
The Denylist always asks. File edits never ask in any level. Claude Code follows every level. Codex, Gemini CLI, Grok and OpenCode cannot stop to ask, so below Full access a command that needs approval is refused instead. Codex runs no commands in Ask; in Allowlist and Auto its commands run in a sandbox limited to the project, offline. [General settings](opencursor:settings/general)

## Context
- Type @ in the box to attach files, folders, code symbols, git changes, lint errors, terminal output, docs, a web page, a rule or an earlier chat. Paste or drop images.
- The active file is offered as a suggested pill above the box.
- Add files from the explorer with right click > Add to Chat, and terminal output with Add Terminal Selection to Chat.
- Codebase search uses a local index of the workspace: Settings > Indexing turns it on, sets the embedding model and rebuilds it. Without an embedding model it falls back to keyword search. [Indexing](opencursor:settings/indexing)

## Slash commands
Type / in the box. Built in: /new, /clear, /summarize (compress a long chat), /plan, /ask, /agent, /debug, /model name, /rules. Your own commands are markdown files whose text becomes the prompt; create and edit them in Settings > Commands. [Commands](opencursor:settings/commands)

## Rules
Standing instructions the agent reads every turn. Settings > Rules has User rules (free text for every project) and project rules. Rules in .open-cursor/rules, .cursor/rules, AGENTS.md, CLAUDE.md and .cursorrules are picked up as they are. [Rules](opencursor:settings/rules)

## Tools and MCP
MCP servers add tools to the agent (Agent and Debug modes). Settings > Tools and MCP lists servers with on and off switches and a reload. Configs come from the user mcp.json, the project's .cursor/mcp.json and ~/.cursor/mcp.json. [Tools and MCP](opencursor:settings/mcp) [User MCP config](opencursor:mcp-config/user)

## Tab completion
Suggestions over several lines as you type; press Tab to accept, Escape to dismiss. Settings > Tab turns it on or off and sets the model and the delay. Fill in the middle models (Codestral, DeepSeek, a local Qwen coder) are fastest. "Toggle Tab Completion" in the command palette switches it quickly. [Tab settings](opencursor:settings/tab)

## Inline edit (Cmd+K)
Select code (or put the cursor on a line), press Cmd+K, describe the change, and the diff streams into the file to keep or undo. In the terminal, Cmd+K turns a sentence into a shell command. VS Code's own Cmd+K chords still work. The model for it is in Settings > Models > Defaults.

## Source control
The sparkle button in the Source Control view writes a commit message from your staged changes. [Source Control](opencursor:view/source-control)

## Menu bar (macOS) and tray
A small OpenCursor icon next to the clock opens a panel: hand a task to the agent in any recent project, or jump to an open window. On Windows and Linux it lives in the system tray.

## Moving from Cursor or VS Code
The import brings settings, keybindings and extensions over from Cursor or VS Code. It asks before changing anything and offers a reload. Cursor rules and MCP configs work without importing. [Import](opencursor:import)

## The editor itself
- Settings: OpenCursor settings with Cmd+Shift+J or the gear in the chat header. Editor settings with Cmd+, (font, font size, tab size, word wrap, format on save, auto save, minimap). [Editor settings](opencursor:editor-settings)
- Look: color theme picker and file icon theme picker. [Color themes](opencursor:color-theme)
- Keyboard shortcuts: view and change any binding. [Keyboard shortcuts](opencursor:shortcuts)
- Command palette: Cmd+Shift+P runs any command by name. Quick open a file: Cmd+P.
- Extensions: Cmd+Shift+X, from Open VSX. [Extensions](opencursor:extensions)
- Views: Explorer (Cmd+Shift+E), Search (Cmd+Shift+F), Source Control (Ctrl+Shift+G), Run and Debug (Cmd+Shift+D), Terminal (Ctrl+backtick), Problems (Cmd+Shift+M).
- Open a project: File > Open Folder, or the start screen when no folder is open. [Open a folder](opencursor:open-folder)

## Updates
OpenCursor checks GitHub for a new version at startup and every six hours. When one is out, a notice offers Update: it downloads the version for your system, checks it, and installs it when you restart (Restart now, or the Restart to update item in the status bar). Run "Check for Updates" from the command palette to check right away. Linux packages ask for your password once. Portable Windows copies get the download page instead. Turn the automatic check off with the openCursor.update.mode setting.

## Reporting a problem
Tell Help what went wrong. If it is a bug, Help offers a Report on GitHub link: it opens a new GitHub issue with your description from the Help chat and the app details (version, system, mode, kind of model) filled in. API keys and code are never included. Read it, add anything missing, and press Submit. [Report on GitHub](opencursor:report-issue)

## Privacy
API keys stay in the system keychain and only go to the provider they belong to. Code is sent only to the model you chose for that chat. Subscriptions run on your own CLI login. Local models never leave your network.
Once a day OpenCursor sends an anonymous install count: a random ID made on this computer, the version and the OS, nothing else. Turn it off in Settings > General > Privacy (Anonymous install count). [General settings](opencursor:settings/general)

## When something does not work
- "No model" or nothing happens on send: connect a model (Connect panel, Free models page, or Settings > Models).
- A key is rejected: check it on the provider's key page and paste it again in Settings > Models; the check button says why.
- A subscription CLI is not found: Settings > Subscriptions > Detect again, or install it from the start screen. Its path can be set with the openCursor.cli.paths setting.
- Free model limit reached: connect another free key, or use Free (auto) so it moves on by itself.
- Tab suggests nothing: Settings > Tab, check it is on and a model is set; "Show Tab Log" in the command palette shows what happened.
`;
