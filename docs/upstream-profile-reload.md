# Upstream report draft: settings writes rejected — "profile reload requires the root Include entry"

> **To file it:** the paste-ready issue (title + body + the `gh` command) is in
> [`upstream-issue-body.md`](upstream-issue-body.md). This file is the long form — the full
> reproduction matrix and the reasoning behind each row.

A minimal, evidence-backed report for the dsh repository
(`https://github.com/deepseek-ai/deepseek-harness`, package `@deepseek-ai/dsh`).
Observed while embedding `dsh web` in a VS Code / Cursor extension. Everything
below was measured; the reproduction matrix at the end lists what was ruled out.

## Summary

`dsh web` can boot into a state where **reads work but every settings write is
rejected**:

```
POST /api/settings/update
{ "type": "client-request", "rpcId": "…", "method": "settings/update",
  "payload": { "args": { "ns": "ui-settings-general",
                         "patch": { "welcomeNoticeVersion": "2026-08-13.1" } } } }

HTTP 200
{ "result": { "ok": false,
              "error": { "code": "settings/rejected",
                         "message": "dsh: profile reload requires the root Include entry",
                         "details": { "ns": "ui-settings-general" } } } }
```

Visible user impact in the embedded GUI: the pre-release notice's **继续** button
only shows *"暂时无法保存确认状态，请重试"* and can never be dismissed, and any
change made in the settings panel silently fails to persist (no error surface
other than the modal's retry copy).

Versions: `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.2.0-rc.2` (all three reproduce).
Platform: Windows 11 x64, node v24.14.0.

## Where it comes from

`@deepseek-ai/dsh-app-boot/lib/index.js` (`reconcileProfilePatches`):

```js
async function reconcileProfilePatches(ctx, patches, binName, requiredIds = []) {
  const entry = bootstrapIncludes.get(ctx);
  if (entry === void 0) throw new Error(`${binName}: profile reload requires the root Include entry`);
  …
}
```

`bootstrapIncludes` is a `WeakMap` populated only by the boot path that creates
the root Include entry:

```js
const includeId = await ctx.loader.create(rootInclude);
const loader = ctx.get("loader");
if (loader === void 0) return void 0;      // ← returns WITHOUT registering
const entry = loader.resolve(includeId);
bootstrapIncludes.set(ctx, entry);
```

So any ctx that did not complete that exact bootstrap (or whose service lookup
happened too early, or that is not the ctx the settings write ends up on) will
fail **every** later settings write, forever, while the rest of the server works
normally. Note the `loader === void 0` early return: it silently skips the
registration that the reconcile path later requires.

## What makes this hard to diagnose from a host application

The failure is invisible except through the wire error, and it is not
reproducible outside the embedding host:

| # | Configuration | settings/update |
|---|---|---|
| 1 | server spawned by the host application (VS Code/Cursor extension host, `node bin.js web --host 127.0.0.1 --port 3080 --no-open`) | **rejected** |
| 2 | a *second* server the same host spawns (same CLI, home, cwd, environment, random port) | **rejected** |
| 3 | identical spawn from a plain shell (same CLI, same home, same cwd `…\st-ppt`, same args, `DSH_HOME` set or unset) | accepted |
| 4 | #3 with every `DSH_*` variable and `NODE_OPTIONS` stripped | accepted |
| 5 | #3 with a brand-new home, a copy of the real home, and the real home | accepted |
| 6 | #3 against the repository tree's dsh and the installed extension's tree (same version) | accepted |
| 7 | #3 with a minimal `PATH`, and with the node directory removed from `PATH` | accepted |
| 8 | #3 writing immediately (race with boot) and in a concurrent burst with workspace calls | accepted |
| 9 | #3 with stdin ignored instead of piped, and with `windowsHide` | accepted |

Rows 1–2 vs 3–9 differ only in **which process did the spawning**; the shell in
row 3 is itself a descendant of the same extension host, so its environment is
the host's environment (verified: it carries `CURSOR_EXTENSION_HOST_ROLE`,
`VSCODE_IPC_HOOK`, …). That is why the report stops at "the embedding host's
process context" — it is the only remaining variable we can see.

## What would help (any one of these)

1. **Register the include on every ctx that can service a settings write**, or
   look it up through the root ctx instead of the calling ctx, so a valid boot
   can never end up in this state.
2. If the state is genuinely unreachable-by-design, make `loader === void 0`
   a hard, early error instead of a silent `return` — the failure would then
   surface at boot rather than at the first settings write.
3. Give the write path a recovery: if the include is missing, re-create it (or
   report `settings/unavailable` with an actionable message) instead of
   `settings/rejected` with an internal loader term. The GUI's only user-facing
   copy is "please retry", which loops forever.

## Evidence available on request

* full extension-host log for a boot that rejected the first write, including
  the exact child command line and environment;
* the sibling-probe output proving two independent servers spawned by the same
  host both reject while a shell-spawned one accepts;
* the reproduction scripts (the matrix above is automated in this repository's
  `scripts/verify/`, suite `notice`, plus the ad-hoc probes used for rows 3–9).
