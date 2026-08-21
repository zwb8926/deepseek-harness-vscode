# DSH for VSCode

Embed [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) inside VS Code.

The extension **starts and manages the `dsh web` server itself** and opens the
complete web GUI — chat, sessions, tool calls, trajectory, approvals, settings —
**as an editor tab, Claude-style**: click the DSH (DeepSeek whale) icon in the
activity bar and the chat opens beside your code; the sidebar only holds a
small launcher with server controls.

## Features

- **Claude-like layout** — the whale icon in the activity bar opens the chat
  UI in the editor area (not in the sidebar); the sidebar shows a compact
  launcher (status + start/stop/restart/reload/logs) and closes automatically.
- **Always-visible entry points** — the DSH whale icon, the status bar item,
  and command palette commands; the extension activates at startup and
  auto-starts (or adopts) the server when `dsh.autoStart` is on.
- **Embedded server** — on first use the extension locates an existing `dsh`
  installation (bundled `node_modules`, PATH, global npm) and, if none is found
  and npm is available, auto-installs `@deepseek-ai/dsh` into the extension
  storage (one-time). The `dsh web` process is spawned as a child process and
  supervised (unexpected exit → bounded automatic restarts when enabled).
- **Adopt an existing server** — if a dsh web server is already listening on
  `dsh.port` (e.g. your own `dsh web` on 3080), the extension connects to it
  instead of starting a second process.
- **Full chat UI in a webview** — the panel embeds the real dsh SPA (iframe,
  same-origin), so every feature of the web GUI works: conversations, tool
  calls, approval prompts, model selection, settings, plugins.
- **Controls** — command palette and status bar: open chat, start / stop /
  restart the server, reload the panel, show logs, open in your browser.
- **Reuses your DSH_HOME** — by default the embedded server uses the same data
  directory as your CLI (`~/.dsh`), so credentials, settings, profiles and
  session history are shared.

## Commands

| Command | Description |
| --- | --- |
| `DSH: Open Chat Panel` | Open the embedded GUI as an editor tab beside your code |
| `DSH: Open in Browser` | Open the running GUI in your default browser |
| `DSH: Start Server` | Start (or adopt) the dsh web server |
| `DSH: Stop Server` | Stop the owned server (adopted servers are left untouched) |
| `DSH: Restart Server` | Stop and start again |
| `DSH: Reload Chat Panel` | Reload the embedded GUI |
| `DSH: Show Logs` | Open the output channel with the server log |

The **DSH** whale icon in the activity bar opens the chat as an editor tab and
closes the sidebar; the status bar item shows the server state and opens the
chat on click.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `dsh.port` | `3080` | Port for the embedded server. `0` = OS-assigned. If a dsh server already listens here, it is adopted. |
| `dsh.home` | `""` | `DSH_HOME` override. Empty = system default (`~/.dsh`). |
| `dsh.cliPath` | `""` | Absolute path to the dsh CLI (`…/@deepseek-ai/dsh/lib/bin.js`) or a `dsh` command on PATH. |
| `dsh.autoStart` | `true` | Start/adopt the server when the chat panel is opened. |
| `dsh.autoRestart` | `true` | Restart once after an unexpected exit. |
| `dsh.autoInstall` | `true` | Auto-install `@deepseek-ai/dsh` into the extension storage if not found. |
| `dsh.extraArgs` | `[]` | Extra arguments forwarded to `dsh web`. |
| `dsh.workspaceRoot` | `""` | Working directory of the dsh process. Empty = first workspace folder / home. |

## How it works

```
VS Code extension host                     dsh child process
┌────────────────────────────┐  spawn      ┌─────────────────────────────┐
│ DshManager                 │ ──────────► │ node …/dsh/lib/bin.js web   │
│  · resolve CLI             │  stdout     │   --host 127.0.0.1 --port N │
│  · parse "dsh web: URL"    │ ◄────────── │                             │
│  · health check            │             └─────────────────────────────┘
│ ChatPanel (webview)        │   iframe
│  └─ http://127.0.0.1:PORT  │ ──────────►  the dsh SPA, same-origin:
└────────────────────────────┘             /api RPC + WS pass the
                                            browser-trust fence
```

The panel's iframe is a genuine `http://127.0.0.1:<port>` page, so all of its
`/api` requests and WebSocket streams are same-origin and pass the dsh
DNS-rebinding/cross-site fence. The extension never re-implements the client
protocol — the entire official web UI runs as-is.

## Development

```bash
npm install            # dev deps: typescript, @types/vscode, vsce
npm run compile        # tsc → out/
```

Run the extension:

- **F5** in VS Code (uses `.vscode/launch.json`, Extension Development Host), or
  ```bash
  code --extensionDevelopmentPath=D:\dswork\dsh\deepseek-harness-vscode
  ```

Headless smoke test (exercises the full spawn → URL → HTTP wire → stop
pipeline without VS Code):

```bash
npm run smoke
# or point it at an existing dsh install:
node out/smoke.js --cli "C:\path\to\node_modules\@deepseek-ai\dsh\lib\bin.js"
```

Package:

```bash
npm run package        # produces DSH-for-VSCode-1.0.0.vsix
```

## Notes & limitations

- The embedded server binds `127.0.0.1` only (the safe default; `--host 0.0.0.0`
  is intentionally rejected by dsh).
- Running the embedded server alongside your own `dsh web` on the same
  `DSH_HOME` shares the same data directory. Use a separate `dsh.home` if you
  want isolated instances.
- v1 embeds the GUI through an iframe; if a future VS Code version restricts
  webview iframes, use `DSH: Open in Browser` as the fallback.
