# 01 - Default layout and visual system

Sources: `extensions/theme-cursor/themes/*.json`, `out/vs/workbench/workbench.desktop.main.js` (layout presets, configuration defaults). CSS-level metrics (chat fonts, radii, spacing, motion) are in `01b_css_metrics.md`; screenshots in `shots/`. Colour values below are exact theme values.

## 1. Default theme and variants

Defaults (enum `dO`): dark = `Cursor Dark`, light = `Cursor Light`, HC dark = `Default High Contrast`, icon theme `vs-seti`, product icon theme `Default`. Theme files: `cursor-dark`, `cursor-dark-midnight`, `cursor-dark-hc`, `cursor-dark-colorblind`, `cursor-light`, `cursor-light-hc`, `cursor-light-colorblind`. Cursor Dark is authored by "Anysphere" (v0.0.3), 252 workbench colours, 227 token rules.

Design character: near-black neutral greys (not blue-tinted), a single warm-off-white foreground, translucent white overlays (alpha steps `#F0F0F0` + 0x0A/11/13/1E/26/30/5C/99/BD) for every border, hover and selection. Accent is a muted nord-like blue/cyan, not a saturated brand colour.

## 2. Cursor Dark palette (workbench)

Foreground "tiers" are all `#F0F0F0` at different alpha: 100% (`F0F0F0`), 74% (`BD`), 60% (`99`), 36% (`5C`), borders 7% (`13`), hover 7% (`11`), active/selected 12% (`1E`), focus 15% (`26`), strong selection 19% (`30`).

| Role | Key | Value |
|---|---|---|
| Editor background | `editor.background` | `#181818` |
| Editor foreground | `editor.foreground` / `foreground` | `#F0F0F0` |
| Sidebar bg | `sideBar.background` | `#141414` |
| Activity bar bg | `activityBar.background` | `#141414` (fg `#F0F0F0BD`) |
| Panel bg (terminal, output) | `panel.background` | `#141414` |
| Title bar bg | `titleBar.activeBackground` | `#141414` (fg `#F0F0F084`; inactive fg `#F0F0F099`) |
| Status bar bg | `statusBar.background` | `#141414` (fg `#F0F0F099`) |
| Tab bar bg / inactive tab | `editorGroupHeader.tabsBackground`, `tab.inactiveBackground` | `#141414` |
| Active tab | `tab.activeBackground` | `#181818` (same as editor, no top border: `tab.activeBorderTop #F0F0F000`) |
| Inactive tab fg | `tab.inactiveForeground` | `#F0F0F05C` |
| Breadcrumb bg | `breadcrumb.background` | `#181818` |
| Borders (all) | `sideBar.border`, `panel.border`, `editorGroup.border`, `tab.border`, `titleBar.border`, `statusBar.border`, `dropdown.border`, `input.border` | `#F0F0F013` (7% white) |
| Focus ring | `focusBorder` | `#F0F0F026` |
| Hover widget / menus / notifications / suggest / quick input bg | `editorHoverWidget.background`, `menu.background`, `notifications.background`, `editorSuggestWidget.background`, `editorWidget.background` | `#141414` |
| Dropdown bg | `dropdown.background` | `#181818` |
| Input bg | `input.background` | `#F0F0F00A` (4% white over parent) |
| Input fg / placeholder | `input.foreground`, `input.placeholderForeground` | `#F0F0F0` / `#F0F0F099` |
| Primary button | `button.background` / fg / hover | `#81A1C1` / `#191c22` / `#87A6C4` |
| Secondary button | `button.secondaryBackground` / fg / hover | `#626262` / `#F0F0F0` / `#818181` |
| Accent (links, badges, find, list highlight, git untracked, progress info) | `badge.background`, `activityBarBadge.background`, `list.highlightForeground`, `gitDecoration.untrackedResourceForeground` | `#88C0D0` (badge text `#141414`) |
| Link | `textLink.foreground` / active | `#81A1C1` / `#87A6C4` |
| Selection (editor) | `editor.selectionBackground` | `#40404099` (inactive `#40404077`, highlight `#404040CC`) |
| Current line | `editor.lineHighlightBackground` | `#262626` |
| List hover / active / inactive selection | `list.hoverBackground` etc. | `#F0F0F011` / `#F0F0F01E` / `#F0F0F011` |
| Suggest selected row | `editorSuggestWidget.selectedBackground` | `#343434` |
| Cursor | `editorCursor.foreground` | `#F0F0F0` |
| Line numbers | `editorLineNumber.foreground` / active | `#F0F0F05C` / `#F0F0F0` |
| Indent guides | `editorIndentGuide.background1` / active | `#F0F0F013` / `#F0F0F030` |
| Scrollbar slider | `scrollbarSlider.background` / hover | `#F0F0F011` / `#F0F0F01E` |
| Diff inserted line / text | `diffEditor.insertedLineBackground` / `insertedTextBackground` | `#3FA26633` / `#3FA26622` (green `#3FA266`) |
| Diff removed line / text | `diffEditor.removedLineBackground` / `removedTextBackground` | `#B8004933` / `#B8004922` (crimson `#B80049`) |
| Gutter added / modified / deleted | `editorGutter.*Background` | `#3FA266` / `#D2943E` / `#E34671` |
| Git decorations | added `#70B489`, deleted `#FC6B83`, modified `#F1B467`, ignored `#F0F0F099` |
| Error / warning | `errorForeground`/`editorError.foreground`, `editorWarning.foreground` | `#E34671` / `#F1B467` |
| Charts | green `#3FA266`, red `#E34671`, yellow `#F1B467` |
| Merge conflict current/incoming | | `#88C0D04D` / `#3FA2664D` (headers `66`) |
| Peek view title bg | `peekViewTitle.background` | `#242424`; result selection `#343434` |
| Progress bar | `progressBar.background` | `#3FA266` |
| Terminal ANSI | black `#242424`, red `#FC6B83`, green `#3FA266`, yellow `#D2943E`, blue `#81A1C1`, magenta `#B48EAD`, cyan `#88C0D0`, white `#F0F0F0`; bright: black `#F0F0F099`, red `#FC6B83`, green `#70B489`, yellow `#F1B467`, blue `#87A6C4`, magenta `#B48EAD`, cyan `#88C0D0`, white `#FFFFFF` |

Hierarchy to reproduce: chrome (sidebar, activity, title, status, panel, tab strip) = `#141414`; editor surface = `#181818` (slightly lighter, so the editor reads as the "page"); hover/selection by white alpha overlays only.

## 3. Syntax token colours (Cursor Dark)

default text `#d6d6dd`; keywords/storage `#82d2ce`; functions `#efb080`; types/classes `#efb080` (support.class `#87c3ff`); strings `#e394dc`; numbers `#ebc88d`; attribute names, imports operator, constants `#aaa0fa`; comments italic `#F0F0F099`; punctuation tags `#A4A4A4`; python self `#efb080`; diff inserted text `#e394dc`; directive/binary strings `#a8cc7c`; yellow-orange `#f8c762` for generic types/regex quantifiers; semantic: enumMember/variable.defaultLibrary `#d6d6dd`, constants `#82D2CE`.

## 4. Other shipped variants (key values)

| Key | Midnight | Light | HC Dark |
|---|---|---|---|
| editor bg | `#1e2127` | `#FCFCFC` | `#0A0A0A` |
| sidebar/panel/activity/title/status bg | `#191c22` | `#F3F3F3` | `#0A0A0A` |
| foreground | `#7b88a1` | `#141414` | `#F0F0F0` |
| borders | `#ffffff0d` | `#14141414` | `#F0F0F01a` |
| input bg | `#272c3655` | `#FCFCFC` | `#2A2A2A55` |
| button bg | `#88c0d0` (fg `#191c22`) | `#2778C1` (fg `#FCFCFC`) | `#434C5E` (fg `#ECEFF4`) |
| link | `#8fbcbb` | `#0064B0` | n/a |
| selection | `#434c5e99` | `#14141414` | `#40404099` |
| line highlight | `#434c5e33` | `#EAEAEA` | `#434C5E44` |
| diff inserted / removed line | n/a | `#00AF6624` / `#FF617B38` | n/a |
| focus border | transparent | `#14141433` | transparent |

## 5. Default workbench layout

Two layout presets exist (id `default-agent`, `default-editor`) plus `default-zen` and `default-browser` (list `Zha` + built-ins). Each is a set of booleans for the five parts the layout service knows: **unified sidebar** (`workbench.parts.unifiedsidebar`, the Agents/chat-list rail), **sidebar** (classic Explorer/Search/Git side bar), **editor area**, **auxiliary bar** (the chat pane, `workbench.parts.auxiliarybar`), **panel** (terminal/output).

| Preset | agentsVisible (unified sidebar) | chatVisible (aux bar) | editorsVisible | panelVisible | sidebarVisible (classic) | sidebarLocation | panelMaximized |
|---|---|---|---|---|---|---|---|
| `default-agent` | true | true | true | false | false | left | false |
| `default-editor` | false | true | true | false | true | `right` as stored (see note) | false |
| `default-zen` | false | false | true | false | false | left | false |
| `default-browser` | false | true | true | false | false | left | false |

Note: the stored string `right` for `default-editor` is derived through an inverted position test (`getSideBarPosition()===0 ? "right" : "left"`); VS Code's own default `workbench.sideBar.location` is `left` (registered default `left`), and that is what ships in the classic editor layout. Treat the classic layout as VS Code's: Explorer on the left, editor centre, chat on the right.

Key facts:
- The chat/agent pane lives in the **auxiliary bar (secondary side bar) on the right** in the editor layout; in the agent layout the chat is the dominant centre/right region and the unified sidebar on the left lists agents/chats.
- Panel (terminal) hidden by default; toggled with the usual VS Code shortcuts (`Cmd+J`), chat toggle `Cmd+Alt+B` (aux bar), sidebar `Cmd+B`.
- Layout persisted under storage keys `cursor/editorLayout.{sidebarVisible,sidebarWidth,panelVisible,panelWidth,panelHeight,editorWidth,auxiliaryBarVisible,auxiliaryBarWidth,statusBarVisible}` and `cursor/agentLayout.{sidebarLocation,sidebarLocationAgentOverride,sidebarVisible,sidebarWidth,panelVisible,panelWidth,panelHeight,editorVisible,editorWidth,auxiliaryBarVisible,auxiliaryBarWidth,statusBarVisible,quickMenu.customLayouts,quickMenu.lastSelectedLayoutId}`. Quick switcher command: `Switch Layout` (`Cmd+Alt+Tab`), `workbench.action.openAgentLayoutQuickMenu`.
- Settings page option "Window Layout: switch between Agent and Editor default layouts", "Title Bar: show title bar in agent layout", "Status Bar: show status bar", "Auto-Hide Editor When Empty: when all editors are closed hide the editor area and maximize chat".
- Activity bar: setting `workbench.activityBar.location` default `default`; `workbench.activityBar.orientation` default `horizontal` (VS Code 1.128 behaviour). Title bar style default `classic` on macOS (`window.titleBarStyle`), custom title bar with the menu moved into it on Windows/Linux.
- Chat pane view container id: `workbench.panel.composerChatViewPane`; context keys `composerFocused`, `agentsPaneFocused`, `isGlass`, `chatModeMenuFocused`.
- Chat max content width default `cursor.chatMaxWidth` = 840 px; chat text scale base 12 px x {0.85, 1, 1.15, 1.3} (Small/Default/Large/Extra Large).

## 6. Fonts

Editor font: VS Code defaults (the product does not override `editor.fontFamily` in the registered configuration). Chat UI uses the system UI font stack with the 12 px base from `cursor.composer.textSizeScale`; see `01b_css_metrics.md` for the exact stacks, radii and spacing discovered in the CSS bundle. A bundled icon font named `cursor` (glyph set used by `cursorIcon` chars) supplies the product icons.

## 7. Colour usage rules worth copying

1. Never use a solid colour for borders, hovers or selections: take the foreground and vary alpha.
2. Accent (`#88C0D0` / `#81A1C1`) appears only in links, badges, find matches, focus-adjacent highlights and the primary button; everything else is neutral.
3. Diff colours are green `#3FA266` and crimson `#B80049` at 20% (text) and 13% (line) alpha; setting `cursor.cmdk.useThemedDiffBackground2` (default true) makes Cmd+K diffs use theme colours instead of fixed ones.
4. Errors use a pink-red (`#E34671`/`#FC6B83`), warnings amber (`#F1B467`/`#D2943E`).
