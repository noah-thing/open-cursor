# 02 - Cursor-specific commands and keybindings

Source: keybinding registrations in `workbench.desktop.main.js` (Action2 `keybinding:` blocks, `kbOpts`, `registerCommandAndKeybindingRule`). "Mod" = Cmd on macOS, Ctrl on Windows/Linux (VS Code `CtrlCmd`). "Ctrl" = the physical Control key (VS Code `WinCtrl`). `weight` is the keybinding priority (VS Code default for workbench commands is 200; higher wins when two bindings match). Bindings below use the macOS rendering unless noted.

## 1. How Cursor resolves the Cmd+K chord conflict

VS Code uses `Mod+K` as the leader of ~80 chord shortcuts (`Mod+K Mod+S` keyboard shortcuts, `Mod+K Mod+C` comment, `Mod+K Mod+0` fold all, `Mod+K Z` zen, ...). Cursor needs `Mod+K` as its own single-key shortcut. What the bundle does:

1. A virtual command **`workbench.action.keychord.leader`** ("Keychord leader keybinding", `when: false`, only exists so its binding can be edited). Its default binding is **`Ctrl+M` on Windows/Linux and `Cmd+R` on macOS**.
2. Every built-in chord that VS Code starts with `Mod+K` was rewritten in the source to start with that leader instead: the code builds them as `chord(LEADER, Mod+X)`, with the macOS variant `chord(Cmd+R, Mod+X)`. Examples verified: fold-toggle `editor.toggleFold` = leader then `Mod+L`; `workbench.action.showHover` stays `Mod+K Mod+I`; terminal `focusHover` = leader then `Mod+I`; `workbench.action.showAllEditors` = leader then `Mod+P`. A few chords still start with `Mod+K` where the context makes it unambiguous (e.g. `notebook.cell.changeLanguage` = `Mod+K M` in notebook cells, `workbench.action.showHover` = `Mod+K Mod+I` when not editorFocus conflicts).
3. A migration class listens to keybinding changes: if the user rebinds `workbench.action.keychord.leader`, it rewrites every user keybinding that used the old leader as prefix to the new prefix (via `replacePrefixAndGetUserSettingsLabel`). A one-time storage flag guards the initial migration.
4. The single-key `Mod+K` is registered with weight **1401** (and 1402 in the focused prompt bar), well above the default 200, and only when the editor has focus (`editorFocus`), so it wins over any leftover chord prefix. In the terminal it is weight 10200 (beats `workbench.action.terminal.clear`, which is `Mod+K` on macOS at weight 201). In the Debug Console `Mod+K` stays "clear".
5. User-facing: Keyboard Shortcuts editor shows the leader as a normal editable command.

Implementation hint for Open Cursor: add one command `workbench.action.keychord.leader` and a build-time search/replace of all `KeyMod.CtrlCmd | KeyCode.KeyK` chord first-parts to `chord(LEADER, ...)`; then register single-key `Mod+K` at high weight.

## 2. Chat / Agent (Composer)

| Keybinding | Command id | Title | `when` / notes | Weight |
|---|---|---|---|---|
| Mod+L | `aichat.newchataction` | Open Chat | `!isGlass`. Runs `composer.startComposerPrompt2`: focus chat input; if there is an editor selection it is attached as context (also adds selection to an already-open chat). Command variants `editor.action.addSymbolToChat` / `editor.action.addSymbolToNewChat` map onto `aichat.newchataction` / `composer.newAgentChat`. | 500 |
| Mod+I | `composer.startComposerPrompt` | Open Chat (f1) | Always; same open/focus behaviour as Mod+L (the former Composer shortcut). | 1600 |
| Mod+Shift+L, Mod+Shift+I | `composer.newAgentChat` | Open New Agent Chat | New chat in the current location; in Glass window executes `glass.newAgent`. | 1600 |
| Mod+T or Mod+N | `composer.createNewComposerTab` | New Chat Tab | Two bindings with separate `when` (chat focused vs chat-as-editor etc.). | 600 |
| Mod+W | `composer.closeComposerTab` | Close Tab | chat focused (or focusedView matches chat container) and editor text not focused | 500 |
| Mod+[ / Mod+] | `composer.previousChatTab` / `composer.nextChatTab` | Previous / Next chat tab | `composerFocused && !editorTextFocus` | 200 |
| Alt+Mod+Left / Alt+Mod+Right | `composer.selectPreviousComposer` / `composer.selectNextComposer` | Select Previous / Next Chat | `(composerFocused \|\| agentsPaneFocused) && !editorTextFocus` | 410 |
| Alt+Mod+Left / Right | `composer.selectPreviousSubComposerTab` / `...NextSubComposerTab` | sub tabs | `composerFocused` | 200 |
| Mod+. (also Alt+Mod+. and Shift+Tab) | `composer.openModeMenu` | Open chat mode menu | chat focused / chat-as-editor active / `chatModeMenuFocused`; not editor text focus, not terminal | 600 |
| Mod+/ (also Alt+Mod+/) | `composer.openModelToggle` | Open model toggle (model picker) | `composerFocused && !editorTextFocus`. On Windows only Ctrl+/ | 200 |
| Shift+Mod+/ (mac, linux) ; Alt+Ctrl+/ then Shift+Ctrl+/ (win) | `composer.cycleModelParameter` | Cycle model parameter (e.g. thinking/effort level) | `composerFocused && !editorTextFocus` | 201 |
| Alt+Mod+P | `composer.openAddContextMenu` | Open add context menu (the "@"/plus menu) | `composerFocused && !editorTextFocus` | 200 |
| Mod+D | `composer.toggleChatAsEditor` | Toggle open as editor (move the chat into an editor tab and back) | `composerFocused && !editorTextFocus` | 600 |
| Mod+F | `composer.find.focus` | Find in Chat | `composerFocused` and find widget not open; then Enter/F3 next, Shift+Enter/Shift+F3 previous, Esc `composer.find.hide` | 200 |
| Alt+Mod+' | `composer.showComposerHistory` | chat history picker | always | 500 |
| Mod+' | (`ASg` command) | clears/starts input in empty chat | `composerFocused` | 600 |
| Mod+Y (Mod+Shift+Y on Windows) | `aichat.newfollowupaction` | Focus Chat Followup | focus the follow-up box | 410 |
| Mod+Shift+Backspace | `composer.cancelComposerStep` | Cancel Chat (stop generation) | chat focused / chat container focused | 600 |
| Ctrl+C (mac only, input focused) | `composer.cancelComposerStepInputFocused` | Cancel Chat (Input Focused) | same when; on other OS same as above | 600 |
| Mod+Enter | `composer.acceptComposerStep` | Accept pending agent pane action | chat focused and no "second variant" pending; Alt+Mod+Enter when that variant is pending | 600 |
| Enter | `composer.approvePendingShellToolDecision` | Approve pending shell tool (run) | `!isGlass && composerShellToolPendingKeybindingsActive` | 600 |
| Shift+Enter | `composer.approvePendingShellToolDecisionAllowlist` | Approve and add to allowlist | `composerShellToolAllowlistShortcutActive` | 600 |
| Escape | `composer.skipPendingShellToolDecision` | Skip pending shell tool | `composerShellToolPendingKeybindingsActive` | 600 |
| Shift+Backspace | `composer.cancelTerminalToolCall` | Cancel Terminal Tool Call (kill a running agent command) | chat focused | 600 |
| Mod+Shift+Enter | `composer.triggerCreateWorktreeButton` | Create Worktree / Submit | `composerFocused` | 600 |
| Mod+Shift+Space | `composer.toggleVoiceDictation` | voice dictation toggle | `!isGlass && !terminalFocus`; Esc cancels (`composer.cancelVoiceDictation`) while recording | 201 |
| Mod+Shift+D | `composer.fixerrormessage` | Fix lint error with AI | on a problem/diagnostic hover | 1400 |
| Mod+Alt+Tab | `workbench.action.openAgentLayoutQuickMenu` / Switch Layout | switch between layout presets | global | 200 |
| Ctrl+Tab / Ctrl+Shift+Tab (mac), Mod+Tab (win/linux) | `workbench.action.quickOpenPreviousRecentlyUsedAgent`, `...LeastRecentlyUsedAgent` | agent switcher (MRU) | `agentsPaneFocused \|\| composerFocused` | |
| Ctrl+Shift+S (mac), Mod+Shift+/ (win/linux) | toggle the unified (agents) sidebar; when the agents pane is focused it hides it, otherwise reveals/focuses it (command class id not recovered) | global | | |
| Mod+Shift+, | `cursor.openVSCodeSettingsFromMenu` | Open VS Code Settings | no editor focus | 200 |
| Mod+Shift+0 | `aiSettings.usingOpenAIKey.toggle` | toggle own OpenAI key (opens popup if none) | | 401 |
| Mod+F in Cursor Settings | `aiSettings.action.focusSearch` | | | 401 |

Unbound-by-default (registered, no default key found in the bundle): `composer.cycleMode`, `composer.cycleModel`, `composer.openComposer`, `composer.focusComposer`, `composer.createNewWithPrevContext`, `composer.duplicateChat` (Fork Chat), `composer.renameChat`, `composer.shareChat`, `composer.exportChatAsMd`, `composer.clearComposerTabs`, `composer.closeOtherComposerTabs`, `composer.addfilestocomposer`, `composer.addfilestonnewcomposer`, `composer.addsymbolstocomposer`, `composer.addsymbolstonewcomposer`, `composer.resolveAllConflictsInChat`, `composer.resumeCurrentChat`, `composer.openAsPane`, `composer.toggleChatAsEditor`, `composer.queue.interrupt|steer|moveToNewChat`, `chat.openCursorSettings`. These appear in tooltips (a list of command ids whose current keybinding is shown on hover) so users can bind them.

## 3. Cmd+K inline edit (prompt bar) - see 05 for UX

| Keybinding | Command id | `when` | Weight |
|---|---|---|---|
| Mod+K | `aipopup.action.modal.generate` args `{invocationType:"new"}` (title "Open Edit (Command K)") | `editorFocus` (or edit-context bar) | 1401 |
| Mod+Shift+K | same command, args `{invocationType:"toggle"}` | `editorFocus` | 1401 |
| Mod+K or Mod+Shift+K | `editor.action.inlineDiffs.focusEditor` | prompt bar exists and is focused: returns focus to the editor pane (so K toggles focus between bar and code) | 1402 |
| Mod+L | `composer.sendToAgent` ("Turn Cmd+K to Composer") | prompt bar focused: converts the quick edit into an Agent chat with the same prompt/selection | 600 |
| Mod+/ (also Alt+Mod+/) | prompt-bar model toggle (`triggerModelToggle`) | prompt bar focused | 200 |
| Escape | prompt-bar close/reject (class id `aipopup.action.closePromptBar`; handler cancels generation and removes the bar and diff) | when a bar is present | 2105 |
| Escape (editor focused, bar exists but not focused) | closes the bar unless setting `cmdKEscapeFocusesEditorOnDiff` (dev) is on | `editorHasPromptBar && !editorPromptBarFocused && editorTextFocus` | 100 |
| Mod+Shift+Backspace | `editor.action.inlineDiffs.cancelEdits` (cancel generation) | | 600 |
| Mod+Enter | `editor.action.inlineDiffs.acceptAll` (accept the generated diff; also submits in the bar) | | 500 |
| Ctrl-less: `aipopup.action.nextPromptBar` ("Next Prompt Bar") | cycle between multiple bars | | |
| `aipopup.action.cmdKRemoveFollowup`, `aipopup.action.focusEdit`, `aipopup.action.insertEditSelection` | internal/palette | | |

## 4. Diff review (inline diffs)

| Keybinding | Command id | Meaning | Weight |
|---|---|---|---|
| Mod+Enter | `editor.action.inlineDiffs.acceptAll` | Accept all edits in the file | 500 |
| Mod+Shift+Backspace | `editor.action.inlineDiffs.rejectAll` | Reject all edits in the file | 500 |
| Mod+Shift+Backspace (with shift as separate key spec) | `editor.action.inlineDiffs.rejectAllAcrossAllEditors` | Reject everywhere | 500 |
| Mod+Y (Mod+Shift+Y on Windows) | `editor.action.inlineDiffs.acceptPartialEdit` | Accept the hunk under the cursor | 500 |
| Mod+N | `editor.action.inlineDiffs.rejectPartialEdit` | Reject the hunk under the cursor | 500 |
| Alt+J / Alt+K | `editor.action.inlineDiffs.nextChange` / `previousChange` | Go to next / previous hunk | 100 |
| Alt+L / Alt+H | `editor.action.inlineDiffs.nextDiffFile` / `previousDiffFile` | Go to next / previous changed file (jumps editors among files that have pending agent diffs, excluding worktree composers) | 1100 |
| Mod+Shift+Backspace | `editor.action.inlineDiffs.cancelEdits` | Cancel in-flight edits | 600 |
| (none) | `editor.action.inlineDiffs.viewAllChanges`, `submitFix` | | |
| Mod+Enter in chat | `composer.acceptComposerStep` | accept in chat review bar | 600 |

Review UI buttons use these labels: "Keep All"/"Undo All" (file-level, shortcuts shown on the button), "Keep"/"Undo" per hunk, "Confirm" when undo needs confirmation, breadcrumb bar actions "Keep all changes" and "Review Next File". Setting "Jump to Next Diff on Accept" (Mod+Y).

## 5. Tab (inline suggestions)

Cursor reuses VS Code's inline suggestion engine and adds a second kind "inline edit" (next-edit suggestions that live in a preview/arrow).

| Keybinding | Command id | `when` | Weight |
|---|---|---|---|
| Tab | `editor.action.inlineSuggest.commit` | `(inlineSuggestionVisible && !tabMovesFocus && !suggestWidgetVisible && !hoverFocused && inlineSuggestionHasIndentationLessThanTabSize) \|\| (inlineEditVisible && !tabMovesFocus ...)` | 200 |
| Tab | `editor.action.inlineSuggest.jump` | `inlineEditVisible && !tabMovesFocus && !suggestVisible && !hoverFocused && tabShouldJumpToInlineEdit` ("Jump to next inline edit") | 201 |
| Tab | commit within the inline-edits preview editor | `inInlineEditsPreviewEditor` | |
| Mod+Right | `editor.action.inlineSuggest.acceptNextWord` | writable and suggestion visible. Partial accept; with Cursor Tab also gated by setting `cursor.cpp.enablePartialAccepts` (default false) | |
| Alt+] / Alt+[ | `editor.action.inlineSuggest.showNext` / `showPrevious` | cycle alternative suggestions | |
| Escape | hide suggestion / close inline-edit preview (`Shift+Escape` secondary) | `inInlineEditsPreviewEditor` | |
| Alt+\ | `editor.action.inlineSuggest.trigger` (stock VS Code) | | |

Tab priority rule: when a suggestion is visible and the suggest widget (IntelliSense) is not, Tab accepts the suggestion; if the visible item is a next-edit pointer (not at the cursor) Tab jumps to it; a second Tab accepts it.

## 6. Terminal Cmd+K

| Keybinding | Command id | `when` | Weight |
|---|---|---|---|
| Mod+K | `cursorai.action.generateInTerminal` | `terminalFocus \|\| terminalPromptBarVisible` | 10200 |
| Escape | `cursorai.action.hideGenerateInTerminal` | terminal focus and bar visible | 10200 |
| Mod+Backspace | `cursorai.action.cancelGenerateInTerminal` | bar can cancel (generating) | 10200 |
| Mod+Backspace | `cursorai.action.rejectGenerateInTerminal` | bar can reject (has result) | 10201 |
| Mod+Enter | `cursorai.action.acceptGenerateInTerminal` ("Accept Generated Command": insert command into the shell without running) | bar visible | 10200 |
| Mod+Enter | `cursorai.action.acceptAndRunGenerateInTerminal` ("Accept & Run Generated Command") | same key; higher weight 10201, takes precedence when its precondition holds | 10201 |

## 7. Browser tab (embedded browser)

`Mod+T` new tab (`workbench.action.newBrowserTab`), `Mod+R` reload (`workbench.action.reloadBrowserTab`), `Mod+L` focus URL bar (`workbench.action.focusBrowserLocationBar`), all `when: activeEditor == browser editor`, weight 500-600. `workbench.action.openBrowserEditor` opens it. Canvas preview: `Mod+Enter` = `cursor.canvas.openVisibleInlinePreview`.

## 8. Other binding changes versus stock VS Code (macOS)

- `Mod+E` quick-open alt: Cursor binds `Mod+E` to a "recent/agents" quick pick when not Glass (`TSg`), in addition to `Mod+P`.
- `Mod+Alt+B` toggles the auxiliary bar (chat), `Mod+B` primary sidebar, `Mod+J` panel, `Mod+Alt+E`, `Mod+Alt+U`, `Mod+Alt+J` extra layout/agent toggles in the non-Glass window.
- Debug-backend switchers `debug.switchTo<Env>Backend` use `Ctrl+Shift+Alt+<digit>` (internal).
- `Mod+Shift+R` (`composer`-related command with `STt` context): "refresh/reopen" on background agent chat (inferred).

## 9. Gaps / not found

- Cursor Settings opener: command `aiSettings.action.open` (optional argument = page id, e.g. `"mcp"`; per-page commands `aiSettings.action.open.<page>` titled "Cursor Settings: <page>"). No default key was found in the registrations; Cursor's public docs describe `Mod+Shift+J` for it, and stock VS Code binds `Mod+Shift+J` to Search "toggle query details", so treat the Cursor binding as unverified from the bundle.
- `composer.cycleMode` / `composer.cycleModel` have no default binding in the bundle (Shift+Tab is a secondary binding of `composer.openModeMenu`). Model picker open/cycle keys are Mod+/ (open) and Shift+Mod+/ (cycle parameter).
- On Windows the "Y" bindings are shifted (`Ctrl+Shift+Y`) because `Ctrl+Y` is Redo; the platform flag in the source is a boolean named `ea` (inferred to be isWindows).
