---
title: Windmill CE
description: What the Community Edition accepts, stores, displays — and silently does not do
---

Several Windmill features are **Enterprise-only in a way that is not visible from
the UI**: the setting is accepted, stored, read back, and displayed correctly.
Only the enforcement is missing.

Everything on this page was measured against the version this repository pins.

## Per-key concurrency limits do nothing

The real implementation is in `windmill-queue/jobs_ee.rs`. The OSS build compiles
a stub whose `update_concurrency_counter` returns `Ok((true, None))` —
unconditionally allowed. Settings are both saved and read back
(`get_tag_and_concurrency` works), so the UI shows the limit and the gate passes
everything through.

**This is why politeness here is expressed as loop structure instead** — see
[Following links](/crawl/). Worker groups are also Enterprise-only.

What _does_ work is the for-loop's `parallel` / `parallelism`: that is
implemented in `worker_flow.rs` in the OSS build, via the `suspend` column on
`v2_job_queue`.

## `stop_after_if` did not stop a while loop

A minimal flow with `stop_after_if` **ran 643 iterations** before it was killed
by hand. No mechanism that limits load on someone else's server is built on top
of a loop that can do that; `crawl_level` runs exactly one level and capture-ledger
decides whether there is another.

## Schema defaults are UI-only

A flow's input schema can declare `default: true`. That default is applied for
**UI-initiated runs only**. A webhook or API run receives nothing.

Measured — triggering `crawl_level` with only its required arguments:

```
crawl_id          = '00000000-…'
depth             = 0
host_parallelism  = (not passed)     ← schema says default: 4
per_host_delay_ms = (not passed)
respect_robots    = (not passed)     ← schema says default: true
```

Two consequences worth stating plainly:

1. **Scripts must not rely on schema defaults.** `crawl_host` reads its settings
   from Windmill variables for exactly this reason — an argument that arrives
   `undefined` produced "Channel target must be a string".
2. **An absent argument arrives as JSON `null`, not `undefined`.** TypeScript
   default parameters only fire for `undefined`, so `null` passes straight
   through. `respect_robots` did this: robots.txt was never read, a disallowed
   page was captured, and **the crawl reported success**. The `?? true` in
   `plan_level.ts` is the only thing preventing it.

## `wmill lint` catches nothing useful

`wmill lint` validates flow YAML. Three deliberate breakages, all reported
`✅ Lint passed`:

| broken                                           | result |
| ------------------------------------------------ | ------ |
| argument renamed `crawl_id` → `crawlId`          | passed |
| `path:` pointing at a script that does not exist | passed |
| a nonsense key added to a step                   | passed |

It is not a substitute for the [tests](/testing/).

## The flow test UI hides this class of bug

Windmill's flow editor can run a flow, run one step, or run up to a step. It is
useful while writing a flow. It is **not** a guard:

- there is no CLI, so it cannot run in CI or assert anything
- it runs from the UI, so **schema defaults are applied** — which means the
  `respect_robots` bug above shows green there and broken in production
- "restart from step" is Cloud/Enterprise only

## `sync push` and `sync pull` both delete

- `wmill sync push` deletes remote items that are absent locally. It has deleted a flow that was created through the API.
- `wmill sync pull` deletes local files absent remotely. It has deleted three uncommitted scripts.

Commit before syncing, and push before pulling. `pnpm run windmill:diff` is
`sync push --dry-run` and shows what would change.

## Variables have a size limit

Somewhere between 10,000 and 20,000 bytes. Measured when this repo still carried
BrowserHive's 16,315-byte `.proto` (until v0.22): it did not fit and lived in a
**resource** instead. Nothing this size is stored any more.

## Schedule error handlers are Enterprise-only

A failed nightly run leaves a red entry in the run history and notifies nobody.
See the limits in [Development](/development/).
