---
title: Testing
description: 61 unit tests that need nothing, one end-to-end test that needs the whole stack, and why both layers are required
---

```sh
pnpm run test        # 61 unit tests, no stack, a few seconds
pnpm run test:e2e    # 1 end-to-end test, needs the stack
pnpm run check       # audit, format, env, typecheck, unit tests, CI parity, docs site
```

`pretest:e2e` runs `scripts/check-stack.ts` first and names **everything**
missing at once. It lives outside vitest deliberately: vitest prints
"No test files found, exiting with code 1" whenever a global setup throws, and no
message written inside can survive that.

## Why both layers

The defects this repository actually produced fall into two groups that **do not
overlap**:

| defect                                             | unit | e2e |
| -------------------------------------------------- | ---- | --- |
| `respect_robots` arrived `null`, robots never read | ○    | ○   |
| level-boundary gap collapsed 3000 ms → **521 ms**  | ○    | △   |
| `content-type` on a bodyless POST → 400            | ○    | ○   |
| `hostParallelism` in camelCase arrived `null`      | ✗    | ○   |
| schema defaults not applied on webhook runs        | ✗    | ○   |

The bottom two are invisible to unit tests **by definition**: arguments are
passed by `flow.yaml`, not by TypeScript. Pick one layer and half of the holes
stay open.

## The unit tests need nothing

`windmill-client` is already a dev dependency and `plan_level.ts` imports only
`robots-parser`, so the scripts import into vitest directly. IO is stubbed:
`vi.stubGlobal("fetch", …)` and `vi.mock("windmill-client", …)`.

`captureHost` is exported from `crawl_host.ts` so the pacing loop can be driven
with a fake client — `call()` only does `client[method](req, cb)`, so the fake is
a plain object. Its `retry` argument — how long to wait when every BrowserHive
is busy — exists so tests run on **real timers at millisecond scale**; fake
timers were tried against capture-style sleeps elsewhere in this workspace and
cost a round trip.

## The end-to-end test starts a real crawl

One test, about 40 seconds. It goes through capture-ledger's API — **not** Windmill's
run endpoint — because the point is to carry the arguments capture-ledger actually sends:
`crawl_id`, `depth`, `frontier`, `per_host_delay_ms`, `host_parallelism`,
`capture_formats`, `signing`. **`respect_robots` is not among them.**

It asserts three things:

1. **capture-fixtures never received `/links/hidden`**, which its robots.txt disallows. The
   verdict comes from the _other end's_ request log, because the ledger can only
   say what it recorded.
2. the crawl succeeded and captured at least one page
3. `GET /api/search?q=hub` returns a hit — so the indexing step completed inside
   the flow

Breaking `?? true` in `plan_level.ts` and deploying turns **both** the unit test
and the e2e red, and the e2e shows capture-fixtures receiving the forbidden page. That pair
was checked once on purpose: if only one layer goes red, the other is watching
something it thinks it is watching and is not.

## The nightly loop refuses to guess

`trigger_crawl.ts` is the only thing that decides whether the nightly capture
succeeded, and the e2e does not touch it — that test posts its own seed to
capture-ledger, so the trigger script is never in the picture. It used to have no
coverage at all, because `POLL_INTERVAL_MS` was a 15-second constant and the
sleep happens _before_ the first poll — one test, fifteen seconds.

It now takes `poll_interval_ms` as an argument — the same trick as
`crawl_host`'s busy wait — so the loop runs on real timers at millisecond scale.

The guard worth knowing about is this one:

```ts
if (crawl.state !== "succeeded") throw new Error(`知らない状態「…」`);
```

Without it, a state the script does not recognise falls through **both**
comparisons and returns `succeeded` with counts of zero. That is exactly what a
renamed field looks like — and it happened once, for real: capture-ledger's
`runs.status` became `runs.state`, and the pre-rename script was pointed at the
post-rename API to watch this fire. It threw, naming the likely cause, instead of
reporting a green nightly run that never ran. `runs` has since been folded into
`crawls`; the guard moved with it, unchanged, and now reads `crawl.state`.

Nothing else protects the shape of that response: capture-ledger has no serializer
schema, and this side does a bare `as CrawlState` cast.

## What is not covered

The e2e seeds its crawl with a URL, so nothing exercises `fromTargets` — the path
that turns `capture_targets` into seeds, which is the one the nightly job takes.
That path through capture-ledger is covered only by unit tests on both sides.
