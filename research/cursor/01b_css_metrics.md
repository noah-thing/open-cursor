# 01b CSS metrics appendix (Cursor 3.26.16)

Sources: `out/vs/workbench/workbench.desktop.main.css` (classic workbench + shared), `workbench.glass.main.css` (the "Agents / Glass" window, which carries the atomic `glass-*`, `ui-*` and `cursor-ui-*` classes), and the cursor-dark theme JSON. Token values marked RUNTIME were read from `getComputedStyle(document.body)` in a throwaway-profile launch (signed-out Agents window, dark). Everything else was read statically. Values are described, not copied as source.

Note on "atomic" classes: most Glass chrome is styled by hashed single-purpose classes (`glass-1043rbw` etc.) that just bind one property to a token. They carry no meaning on their own, so the table lists the TOKEN and the semantic class that consumes it. Rebuild with your own class names and the tokens below.

## 1. Token scale (RUNTIME, dark)

| Token | Value | Notes |
|---|---|---|
| `--cursor-font-size-xs / sm / base / lg` | 11 / 12 / 13 / 15 px | Classic fallbacks in rules: base 12px, lg 14px. Glass body class `glass-typography-refresh` bumps them. |
| `--cursor-line-height-xs / sm / base / lg` | 14 / 16 / 18 / 22 px (rule file) ; 24 px for lg observed live | Conversation line height falls back to lg. |
| `--cursor-font-family-mono` | ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace | |
| `--cursor-font-family-sans` | not set on body; consumers fall back to `--vscode-font-family`. Body resolves to system stack: -apple-system, system-ui, Segoe UI, sans-serif | |
| `--cursor-font-weight-*` | normal/regular 400, medium 500, semibold 600, bold 700 | names exist: normal, regular, medium, semibold, bold |
| `--cursor-radius-xs/sm/base/lg/xl` | 2 / 4 / 6 / 8 / 12 px | |
| `--cursor-radius-2xl/3xl/4xl/full` | 14 / 16 / 18 / 9999 px | 2xl is the prompt input radius |
| `--cursor-spacing-1/2/3/4` | 4 / 8 / 12 / 16 px | half steps: 0-25, 0-5, 0-75, 1-5 (6px), 2-5 (10px), 3-5, 5 (20px) ... up to 18 |
| `--cursor-height-xs / sm` | 20 / 24 px | control heights |
| `--cursor-duration-fast / normal` | 100 / 150 ms | |
| `--cursor-easing-default / out / in-out` | ease / ease-out / ease-in-out | |
| Button (ui-button, sign in) | height 32, radius 8, font 15 | measured live |

## 2. Colour tokens (RUNTIME resolved, dark Glass)

Palette is OKLCH, neutral greys with alpha mixes of one off-white ink (oklch 0.955).

| Token | Resolved |
|---|---|
| `--cursor-bg-chrome` | oklch(0.191 0 0) (about #141414) |
| `--cursor-bg-editor / elevated / input / sidebar` | oklch(0.209 0 0) (about #181818) |
| `--cursor-bg-card` | ink 6% over transparent |
| `--cursor-bg-tertiary / secondary` | ink 8% / 14% |
| `--cursor-text-primary` | oklch(0.955 0 0) (about #F0F0F0) |
| `--cursor-text-secondary / tertiary` | ink 74% / 60% |
| `--cursor-stroke-primary / secondary / tertiary` | ink 20% / 12% / 8% |
| `--cursor-accent` (= `--cursor-bg-accent`) | oklch(0.681 0.131 252.6) (about #81A1C1 Nord blue; matches theme button.background) |
| `--cursor-bg-green-secondary` (Ask mode) | green oklch(0.638 0.129 153.7) at 12% |
| `--cursor-bg-yellow-secondary` (Plan mode) | amber oklch(0.811 0.118 71.3) at 12% |
| `--cursor-bg-red-secondary` (Debug mode) | rose oklch(0.712 0.177 12.7) at 12% |
| `--cursor-bg-git-added-primary / removed-primary` | oklch(0.713 0.094 155.4) / oklch(0.712 0.177 12.7) |
| Shadows | `--cursor-box-shadow-sm`: 0 2px 8px black 20% x 60%. `-lg`: inset 0 0 4px white 5%, 0 0 3px black, 0 16px 24px black 30%. Base/xl: 1px ring from widget border + short blur. Workbench shadow: 0 0 8px 2px widget shadow 40%. |

Families exist for blue, cyan, green, magenta, orange, purple, red, yellow each as `--cursor-bg-*-{primary,secondary,tertiary}`, `--cursor-icon-*`, `--cursor-text-*`, `--cursor-stroke-*`; plus git states (added, modified, removed, untracked) with primary..quaternary and hover tiers.

## 3. Cursor Dark theme (cursor-dark-color-theme.json, 252 colour keys)

| Key | Value |
|---|---|
| editor.background | #181818 |
| sideBar / activityBar / titleBar / statusBar / panel / editorWidget background | #141414 |
| tab.activeBackground | #181818 |
| input.background | #F0F0F00A (ink 4%) |
| foreground | #F0F0F0 |
| focusBorder | #F0F0F026 (ink 15%) |
| button.background / textLink.foreground | #81A1C1 |
| badge.background | #88C0D0 |
| list.hoverBackground / activeSelectionBackground | #F0F0F011 / #F0F0F01E |
| editor.lineHighlightBackground | #262626 |
| diff inserted / removed text bg | #3FA26622 / #B8004922 |

## 4. Chat layout metrics (Glass + classic)

| Property | Value | Source selector / var |
|---|---|---|
| Transcript max width | 840 px (setting `cursor.chatMaxWidth`, default 840) | `--composer-max-width`; `.composer-bar[data-composer-location=bar]` centers with auto margins |
| Chat text size | `--conversation-text-font-size` = font-size-lg (14 classic, 15 live Glass); setting `cursor.composer.textSizeScale` enum 0.85, 1, 1.15, 1.3 (described as relative to 12px base) | `.composer-human-message-content` |
| Conversation line height | 22 px | `--conversation-line-height` |
| Tool row font size | = font-size-lg | `--conversation-tool-font-size` |
| Tray font size (todo / queue) | font-size-base | `--conversation-tray-font-size` |
| Block gap between transcript items | 16 px | `--conversation-block-gap` |
| Block inset | classic 11 px; Glass -10 px (blocks bleed past text edge) | `--conversation-block-inset` |
| Text inset | classic 11 px; Glass 0 | `--conversation-text-inset` |
| Heading after-gap / list before / after / item gap | 4 / 8 / 18 / 8 px | `--conversation-*-gap` |
| Embedded block before-gap | 12 px | |
| Surface radius | 12 px (radius-xl) | `--conversation-surface-border-radius` |
| User message bubble | bg input-background (ink 4%), 1px border stroke-secondary, radius 12, min width 150, `align-self:flex-end`, transitions bg + border 100ms ease-in-out. Hover: bg mixes 4% toward editor bg, border goes to stroke-primary. | `.composer-human-message:not(.standalone-glass)` |
| User bubble content padding | 8 px block, 10 px inline (12 px when the bubble holds the prompt input editor) ; inner gap 6 px | `--composer-human-message-content-padding-*` |
| User bubble left gutter | `max(32px, clamp(0, (100% - 480px) * 0.4, 20%))` | `--conversation-opposed-inset-human` |
| Glass bubble | blurred 10px, bg = elevated mixed 96% with white, shadow 0 1px 2px black 5%, no transition | `.ui-prompt-input__container` in glass mode |
| Hover action on user message | absolutely positioned bottom-right, opacity 0 -> 1, 100ms ease-in-out | `.human-message-action-slot` |
| Tool call card (chrome=card) | bg editor, 1px border `--card-border-color`, radius 12, paint containment; padding 8 y / 10 x, inner gap 6 (flat density) ; standard density gap 0, padding 0 | `.composer-tool-call-block-card[data-chrome=card]` |
| Tool call wrapper | inline padding = block inset | `.composer-tool-call-block-wrapper` |
| Collapsible content gap | transcript row gap (spacing-2 = 8 px) | `--ui-collapsible-content-gap` |
| Collapsed step group opacity | markdown inside collapsed group is 0.5 | `.ui-step-group-collapsible .markdown-root.markdown-normalized` |
| Markdown headings (agent transcript) | h1 1.428em, h2/h3 1.214em (base 14) | `.agent-transcript-row-markdown .markdown-root` |
| Links in transcript | `--cursor-text-link` | |
| Prompt input radius | 14 px (radius-2xl) | `--prompt-input-border-radius` |
| Prompt input shadow | 0.5px inset stroke + 1px ring in the design accent (about 40% mix) + card drop shadow | `--prompt-input-container-shadow` |
| Prompt input section gap | 8 or 12 px | `--prompt-input-section-gap` |
| Prompt input border default / hover / focus | stroke-tertiary / stroke-secondary / stroke-secondary on focus-within | glass overrides |
| Drag-over ring | 2px, accent-ish rgba(129,161,193,0.2) | `[data-dragging=true]` |
| Media grid in edit input | gap 8, padding 12 12 0 | `.ui-prompt-input-media-grid` |
| Pills outer container with image/video | fixed 36 px tall | `.composer-pills-outer-container` |
| Edit banner above input | radius 6 6 0 0, bg input mixed 20% focusBorder | `.composer-input-edit-banner` |
| Bottom overscroll / insets | custom props `--composer-messages-top-inset`, `-bottom-inset`, `-bottom-overscroll` (scroll fade bottom inset 38 px) | `--agent-panel-scroll-fade-transparent-bottom-inset` |
| Follow-up area inline padding | 16 px | `--agent-panel-followup-padding-inline` |
| Gap above composer overlay | 6 px | `--agent-conversation-composer-top-overlay-gap` |
| Composer pair gap | 16 px | `--composer-pair-container-gap` |
| Sticky title bar | sticky top 0, z 120, centered, gap 12, bottom pad 4; text max width 840, left pad 14; actions gap 4, right pad 14 | `.composer-sticky-title*` |
| Tab label max width | 200 px | `--composer-tab-label-max-width` |
| Queue / background job list | column, gap 1, inline pad 4; item icon 14x14, secondary icon colour; actions fade in on hover (100ms) | `.composer-toolbar-queue-item-list`, `-background-job-item*` |
| Context usage indicator | radius 4, padding 0 4; hover raises tertiary text to primary | `.composer-context-usage-indicator`, tray slot right aligned |
| Turn runtime indicator | 20 px tall, radius 4, 11px text tertiary colour, gap 4, inline padding 4 | `.composer-turn-runtime-indicator` |
| Inline diff nav | radius 4, gap 2, padding 2 6, bg secondary at 67% | `.inline-diff-nav` |
| File list rows / icons | gap 1; icon 16x16 | `.composer-file-list*` |
| Thinking hover tooltip | bg elevated, 1px stroke-secondary, radius 8, font base, line height base, padding 6 8, max width 420 when it holds selections | `.composer-thinking-hover-tooltip` |
| Typeahead (@ menu) item | 12px, radius 2, text margin 6, line 18, icons 10px, secondary text right aligned RTL-ellipsis | `.typeahead-popover` |
| Warning popup | bg dropdown mixed 97% white, 1px stroke-secondary, shadow 0 0 8 2 widget-shadow 80% | `.composer-warning-popup` |
| Model picker locked menu | min 272, max 300 wide, padding 0 | `.ui-model-picker__menu--locked` |

## 5. Editor chrome / Glass chrome

| Property | Value | Source |
|---|---|---|
| Chrome bar height | 40 px (44 in a variant) | `--glass-chrome-bar-height` |
| Chrome bar padding | start 12, end 8 (10 variant) | `--glass-chrome-bar-padding-inline-*` |
| Chrome control gap | 1 px (spacing-0-25) or 6 px | `--glass-chrome-control-gap` |
| Hairline | 1 px | `--glass-chrome-hairline-width`, tiling sash same |
| Focus ring | 1 px, `--cursor-stroke-focus-ring` | `--glass-focus-ring-*` |
| Panel (island) shadow | none / `cursor-box-shadow-sm`; overlay 0 25px 50px -12px black 25% | `--glass-panel-shadow`, `--glass-panel-overlay-shadow` |
| Panel radius | window corner radius minus ring width | `--glass-panel-radius` |
| Inactive agent tile opacity | 0.8 / 0.96 / 1 | `--glass-agent-panel-inactive-tile-opacity` |
| Sidebar group gap | 16 px; group label 13/18, padding start 9 (2.25 step) end 4 | `--ui-sidebar-*` |
| Sidebar item inset / row stack gap | 6 / 2 px | |
| Sidebar hover actions width | 60 px; footer fade 8 px; tab fade 4 px; title edge inset 8 | `--agent-*` |
| Stack rail icon height | 14 px, marks 5 px | `--glass-stack-rail-*` |
| Monaco-style editor in agent layout | line numbers become text-primary on active line | `.agent-layout .monaco-editor` |

Body classes seen live: `glass-typography-refresh`, `cursor-dark`, `vs-dark`, `cursor-glass-os-vibrancy-on`, `cursor-glass-font-smoothing-antialiased`, `file-icons-enabled`, `unifiedsidebarhidden`; attribute `data-cursor-glass-mode=true` switches many rules to Glass behaviour.

## 6. Motion

| Name | Definition | Where |
|---|---|---|
| Standard hover transition | 100 ms ease-in-out on bg / border / opacity | bubble, action slots, toolbar item actions, section header label (opacity .8 -> 1) |
| Token durations | 100 ms fast, 150 ms normal, easing ease/ease-out/ease-in-out | `--cursor-duration-*` |
| Title fallback fade | opacity .5, 200 ms ease-in-out | `.composer-animated-title__text--fallback` |
| `fadeInSlideUp` | opacity 0 -> 1, translateY 4px -> 0 | questionnaire toolbar, entering rows |
| `fade-in` / `fadein` / `fadeOut` | opacity ramps | transcript rows (`cloud-no-entry-animations` disables them) |
| `text-shimmer` | background-position 200% -> -200% on a gradient clipped to text | "Thinking" / in-progress verbs |
| `ellipsis-dot` | content cycles ".", "..", "..." (25% steps) | generation pill |
| `blink` | 49% on / 51% off | caret blink |
| `composer-action-notification-fade-in` | opacity 0 -> 1, disabled under prefers-reduced-motion | action notifications |
| `ui-icon-morph-in` | opacity 0 -> 1 with scale .94 -> 1 | icon swaps (send to stop) |
| `cursor-icon-spin`, `codicon-spin` | 360 deg linear spinners | busy icons |
| Modal scale in/out + backdrop in/out | `cloud-mcp-modal-*`; backing is 20% black | modals |
| Spinner | ring variant, size sm | send button busy state |

## 7. Settings relevant to chat appearance (defaults)

| Key | Default | Meaning |
|---|---|---|
| `cursor.composer.textSizeScale` | 1 (0.85, 1, 1.15, 1.3) | chat text scale |
| `cursor.composer.planTextSizeScale` | default (or the scale options) | plan view scale |
| `cursor.composer.conversationDensity` | compact-all-grouped (Glass) | options: compact-all-grouped, compact-ungrouped, detailed |
| `cursor.composer.editorConversationDensity` | detailed (classic editor) | same options |
| `cursor.chatMaxWidth` | 840 | px |
| `cursor.composer.queueMessageDefaultBehavior` | queue | sending while streaming; other options exist (steer / interrupt) |
| `cursor.composer.queueManualSendBehavior2` | interrupt | options interrupt, steer when "Send now" pressed from queue |
| `cursor.composer.usageSummaryDisplay` | auto | auto, always, never |
| `cursor.composer.showEmptyStateTips` | true | rotating tips on empty screen |
| `cursor.composer.codeBlockWordWrap`, `shouldChimeAfterChatFinishes`, `customChimeSoundPath`, `subagentModel`, `cmdPFilePicker2` | - | |
| `workbench.activityBar.orientation` / `.location` | left (orientation default) | |
| Layout storage keys | `cursor/editorLayout.{sidebar,auxiliaryBar,panel}{Visible,Width,Height}`, `editorWidth`, `statusBarVisible`; `cursor/agentLayout.*` same set plus `editorVisible`, `sidebarLocation`, `quickMenu.customLayouts`, `quickMenu.lastSelectedLayoutId` | |
