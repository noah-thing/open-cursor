# Chat webview dev harness

Runs the real chat React app in a plain browser against a scripted fake host (`mock.ts`).

## Build

From `extensions/open-cursor`:

```sh
npx esbuild webview/src/chat/main.tsx --bundle --format=iife --target=es2022 --jsx=automatic \
  --define:process.env.NODE_ENV='"development"' --outfile=webview/dev/out/chat.js
npx esbuild webview/dev/mock.ts --bundle --format=iife --target=es2022 --outfile=webview/dev/out/mock.js
```

The first command also writes `webview/dev/out/chat.css`. Add `--watch` to either command while iterating.

## Open

`webview/dev/chat.html` straight from disk (file://). Query parameters:

| Param | Values | Default |
|---|---|---|
| `scenario` | `static` (finished tools, command awaiting approval, todos, pending edits), `done` (turn finished), `stream` (live scripted turn), `plan` (plan mode with Build), `empty`, `history` | `static` |
| `theme` | `dark` (Cursor Dark colours), `light` | `dark` |
| `w` | panel width in px | `400` |

The harness defines the `--vscode-*` variables itself; inside VS Code the real ones apply.
`mock.ts` also answers `@` mention searches, slash commands, approvals, queueing, stop, new chat and open chat.

## Settings page

```sh
npx esbuild webview/src/settings/main.tsx --bundle --format=iife --target=es2022 --jsx=automatic \
  --define:process.env.NODE_ENV='"development"' --outfile=webview/dev/out/settings-mock-app.js
npx esbuild webview/dev/settings-mock.ts --bundle --format=iife --target=es2022 --outfile=webview/dev/out/settings-mock.js
```

Open `webview/dev/settings.html?section=models&theme=light&w=980` (`section` is one of general, models, subscriptions, tab, rules, commands, mcp, indexing; add `&verify=1` to see verify results). 
Browsers block `file://` in some automation tools. `cd webview/dev && python3 -m http.server 8471` works everywhere.
