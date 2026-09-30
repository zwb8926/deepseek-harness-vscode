# Issue title

```
dsh web: every settings write is rejected with "profile reload requires the root Include entry" (reads keep working)
```

# Issue body (paste verbatim)

## What happens

`dsh web` can boot into a state where **reads work but every settings write is rejected**:

```
POST /api/settings/update
{"type":"client-request","rpcId":"…","method":"settings/update",
 "payload":{"args":{"ns":"ui-settings-general","patch":{"welcomeNoticeVersion":"2026-08-13.1"}}}}

HTTP 200
{"result":{"ok":false,"error":{"code":"settings/rejected",
  "message":"dsh: profile reload requires the root Include entry",
  "details":{"ns":"ui-settings-general"}}}}
```

User-visible effect in the Web UI: the pre-release notice's 继续 button only ever shows
*"暂时无法保存确认状态，请重试"* and can never be dismissed, and any change made in the settings
panel silently fails to persist.

Reproduced on **0.1.7-alpha.2**, **0.1.7-rc.1** and **0.2.0-rc.2**.
Windows 11 x64, node v24.14.0, home `~/.dsh` (migrated to the `profiles/web` layout).

## Where it comes from

`@deepseek-ai/dsh-app-boot/lib/index.js`:

```js
async function reconcileProfilePatches(ctx, patches, binName, requiredIds = []) {
  const entry = bootstrapIncludes.get(ctx);
  if (entry === void 0) throw new Error(`${binName}: profile reload requires the root Include entry`);
  …
}
```

and the boot path that is supposed to register it:

```js
const includeId = await ctx.loader.create(rootInclude);
const loader = ctx.get("loader");
if (loader === void 0) return void 0;      // ← returns WITHOUT registering
const entry = loader.resolve(includeId);
bootstrapIncludes.set(ctx, entry);
```

So any ctx that did not complete that bootstrap — or whose service lookup ran before the loader
was available — fails **every** later settings write, permanently, while the rest of the server is
healthy. The `loader === void 0` early return makes that state completely silent at boot.

## How to reproduce (embedding host)

The failure only appears when the server is started by an application host, not from a shell:

| # | spawn | settings/update |
|---|---|---|
| 1 | `node bin.js web --host 127.0.0.1 --port 3080 --no-open` from a VS Code / Cursor **extension host** | **rejected** |
| 2 | a second server the same host spawns (same CLI, home, cwd, env; random port) | **rejected** |
| 3 | identical command from a plain shell, same home/cwd/args | accepted |
| 4 | #3 with all `DSH_*` variables and `NODE_OPTIONS` removed from the environment | accepted |
| 5 | #3 with a brand-new home, a copy of the real home, and the real home | accepted |
| 6 | #3 with a minimal `PATH`, and with the node directory removed from `PATH` | accepted |
| 7 | #3 writing immediately after the ready line, and in a concurrent burst with workspace calls | accepted |
| 8 | #3 with stdin ignored instead of piped | accepted |

Rows 1–2 differ from 3–8 only in **which process spawned them**; the shell in row 3 is itself a
descendant of the same host, so it carries the host's environment. That is as far as we could
narrow it from outside the host.

## Suggested fixes (any one)

1. Register the root Include entry on every ctx that can service a settings write (or resolve it
   through the root ctx), so a valid boot cannot end up unable to reconcile patches.
2. Turn the `loader === void 0` early return into a hard, early error — the failure should surface
   at boot, not at the first settings write.
3. Give the write path a recovery: re-create the include, or return an actionable error instead of
   `settings/rejected` with an internal loader term. The UI's only copy today is "please retry",
   which can never succeed.

## Evidence

Full reproduction matrix, log excerpts and the probe scripts used for rows 1–8:
`https://github.com/zwb8926/deepseek-harness-vscode/blob/HEAD/docs/upstream-profile-reload.md`
(the embedding side of this report; happy to attach logs separately).

# Command to file it (after `winget install --id GitHub.cli` + `gh auth login`)

```powershell
gh issue create --repo deepseek-ai/deepseek-harness `
  --title "dsh web: every settings write is rejected with `"profile reload requires the root Include entry`" (reads keep working)" `
  --body-file docs/upstream-issue-body.md
```
