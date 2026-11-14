---
title: Testing
description: Unit tests that need nothing, end-to-end tests that need the whole stack, and why both layers are required
---

```sh
pnpm run test        # unit tests, no stack, a few seconds
pnpm run test:e2e    # end-to-end tests, need the stack
pnpm run check       # every check to run before pushing (the list is package.json's check)
```

`pretest:e2e` runs doctor with `--e2e` first and names what is missing — the checks of
[the quickstart's "Check it"](/quickstart/#check-it-take-one-capture), plus capture-fixtures, no
scheduled run in progress, and the crawl permission for `e2e`, the local IdP (identity provider) user the test signs in as (`pnpm run idp:grant --user e2e` in capture-ledger). It checks not just that things are up but that a crawl can run to the end — miss any of
these and a crawl fails only at its level report, staying `running`. Full-text search is part of
that: capture-ledger does not start without OpenSearch (`CAPTURE_LEDGER_OPENSEARCH_URL`, which its
`dev:up` writes). OpenSearch can still stop, or be recreated without its index, while the API runs;
doctor's `search route` searches with a token from the flow's app client and says so. It lives outside vitest
deliberately: vitest prints "No test files found, exiting with code 1" whenever a global setup
throws, and no message written inside can survive that.

The endpoints can be overridden through environment variables (`E2E_WAGGLE_URL`,
`E2E_FIXTURES_URL`, `E2E_FIXTURES_HOST_URL`, `E2E_SUBJECT`, `E2E_LEDGER_DIR`; the defaults are at the top
of `test/e2e/helpers/stack.ts` and `crawl-level.e2e.test.ts`). The tests get their tokens from
capture-ledger's `pnpm run --silent idp:token --user e2e --org acme`, and the test that drives the
ledger's CLI runs there too, so they assume a capture-ledger checkout at `../capture-ledger`. When
running from a git worktree, pass `E2E_LEDGER_DIR=<capture-ledger checkout>` (without it the tests fail
with `spawnSync pnpm ENOENT`). doctor's check reads `CAPTURE_LEDGER_DIR` for the same place.

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

The scripts import `windmill-client`, and `plan_level.ts` alone also imports
`robots-parser`. Both are dev dependencies, so the scripts import into vitest directly. IO is stubbed:
`vi.stubGlobal("fetch", …)` and `vi.mock("windmill-client", …)`.

One unit test reads `flow.yaml` itself (`crawl-level-flow.test.ts`): every argument of `crawl_host` (its
`.script.yaml` schema) must be carried by an `input_transforms` entry, and `secret_archive` must come from the
flow's input. It sees the shape only — whether Windmill delivers the value is still the e2e's question.
`crawl-host-main.test.ts` calls `crawl_host`'s `main` itself, with `windmill-client` and `fetch` stubbed, to see
that what the flow hands it (`secret_archive`) reaches the BrowserHive request.

`captureHost` is exported from `crawl_host.ts` so the pacing loop can be driven
with a fake endpoint — `captureHost` takes the BrowserHive endpoints (`Endpoint`) as an
argument, and `Endpoint.capture` only returns an answer (`Answer`), so the fake is
a plain object holding a name (`target`) and one function. Its `retry` argument — how long to wait when every BrowserHive
is busy — exists so tests run on **real timers at millisecond scale**; fake
timers were tried against capture-style sleeps elsewhere in this workspace and
cost a round trip.

## The end-to-end tests start real crawls

Each test starts a crawl through capture-ledger's API — **not** Windmill's run endpoint —
because the point is to carry the arguments capture-ledger actually sends:
`crawl_id`, `depth`, `frontier`, `per_host_delay_ms`, `host_parallelism`,
`capture_formats`, `signing`, `scripts`, `variables`, `secrets`, `secret_archive`, `user_agent`, and `artifact_sink` where
capture-ledger serves the sink. **`respect_robots` is not among them.**

The first one asserts five things:

1. **capture-fixtures never received `/links/hidden`**, which its robots.txt disallows. The
   verdict comes from the _other end's_ request log, because the ledger can only
   say what it recorded.
2. the crawl succeeded and captured at least one page
3. after the last level's run has finished, `GET /api/search?q=hub` returns a hit from one of this
   crawl's archives. The test waits for the run, not just for `succeeded`: the ledger marks the crawl
   `succeeded` at the level report, before the flow's replay bundle and index steps run, so a search
   right at `succeeded` can come before the indexing. Hits are narrowed to this crawl's archives, so an
   earlier crawl of the same page does not pass the check
4. the ledger points at a replay bundle of the crawl (`replayBundle` in `GET /api/crawls/:id`): no
   `error`, a revision of 1 or more, the key `org/acme/crawls/<crawl>/r<revision>/replay.json`, and at least
   as many page rows as the crawl has archives. A green run does not show this — the replay bundle
   step does not throw when the ledger answers 200 with a failure, so that one failure cannot stop the crawl
5. if capture-ledger serves the sink — an unauthenticated `PUT /api/sink/…` answers
   401 rather than 404 — every archive of the crawl has an `objectKey` under
   `org/acme/<YYYY-MM>/`. A flat key means the sink was never handed out and
   BrowserHive wrote into its own bucket. That is what happened from capture-ledger
   #226 until it was fixed, and such a crawl passes the first four.

Breaking `?? true` in `plan_level.ts` and deploying turns **both** the unit test
and the e2e red, and the e2e shows capture-fixtures receiving the forbidden page. That pair
was checked once on purpose: if only one layer goes red, the other is watching
something it thinks it is watching and is not.

### What runs inside the page

Most of the rest look at the scripts a crawl runs in the page, again from capture-fixtures' request
log, which counts every request by its full URL, query string included.

- **Registered scripts run, and only when asked.** Named, autofetch requests
  `/assets/hero-2x.svg`, which a 1280px browser at DPR 1 never asks for itself. Two controls go to
  the same page: one sends `scripts: []`, the other no `scripts`, leaving the choice to the ledger's
  defaults, which leave out autofetch (from capture-scripts v0.5.0). Nobody requests it in either.
- **A script that does not type-check fails the level at compile**, with the number of
  diagnostics and the first five in the crawl's `error`: once through the ledger (its CLI adds and removes a broken script),
  once as an inline script.
- **An inline script runs in the order it was asked for.** It fetches
  `/plain-html?inline=<token>&state=<document.readyState>`, which leaves a mark in the log:
  `loading` when it ran before navigation, `complete` after load.
- **The same inline script asked again as `preload` runs before navigation.** Both crawls send the
  same source, so the second one hits ts-compile-service's cache. A cache that remembered whole
  answers handed back the first crawl's `behavior`, and the mark said `complete`; that is how
  ts-compile-service v0.2.2 and earlier behave, and this test is red against them.
- **However many type errors a script has, the crawl closes as `failed` and blocks nothing.** The
  inline script raises hundreds of diagnostics. The test checks that `error` names the count and
  stays within the ledger's 2,000 characters, and that the next crawl is accepted. Up to v0.24.2
  the reason carried every diagnostic, the ledger refused it, and the crawl stayed `running`.
- **A per-crawl variable reaches the page.** The value sent as `variables` on `POST /api/crawls` is
  read by an inline script through `defineParams` and fetched as
  `/plain-html?var=<value>`. The same value appears in the ledger's `GET /api/crawls/:id` under
  `variables` and in the `datapackage.json` of the capture's WACZ under
  `browserhive:capture.settings.variables`. That WACZ conforms to the
  [BrowserHive WACZ Profile](https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.25.0/)
  (a BrowserHive WACZ).
- **A required variable left out is refused before the crawl starts.** `400 missing variables` with
  `BH0001` in `diagnostics`; no crawl row is created and capture-fixtures receives nothing. A value that
  does not fit the declaration (an empty string for `.min(1)`) is `400 invalid variables`.
- **A secret reaches the page and leaves no trace in the records.** The test puts a random value in
  `f/waggle_secrets/e2e_probe`; the inline script sends only the length of `__bh.secrets.e2e_probe`
  as `/plain-html?len=<length>`. The value itself is in none of the WACZ members, the ledger's
  answers, or the arguments of the Windmill runs; `settings.secrets` carries the name only. The
  control is a capture that sends the same value as a variable — the same search finds it in that
  WACZ.
- **A hidden secret sent over the network leaves no trace in the BrowserHive WACZ** (BrowserHive
  v29.0.0). The inline script sends the value as `/echo/text?v=<value>`, and capture-fixtures sends it
  back in HTML. The value is random, has characters that change under `%`, HTML and JSON encoding, and
  carries a random 12-character hex nonce. The witness is the request log: the nonce shows the value
  reached the site. Neither the value's spellings nor the nonce is in any member of the BrowserHive
  WACZ (hex survives every encoding, so a form the list of spellings missed is still caught); the
  ledger's `archive` is `null`, `settings.secretArchive` is `{}`, and the
  [BrowserHive WARC](https://uraitakahito.github.io/browserhive-warc-spec/1.4.0/) has
  `BrowserHive-Redacted` and `/echo/text?v=***`.
- **A secret declared `keep` travels ledger → flow → crawl_host → BrowserHive and stays in the WARC as it
  was** — the control for the one above. Same sending, with `archive: "keep"` in the declaration: the ledger's
  `archive` is `"keep"`, the crawl_host step's run arguments carry `secret_archive`, `settings.secretArchive`
  names it, and the nonce is found in the WARC. A flow that forgets to carry `secret_archive` turns only this
  test red.
- **A required secret missing from Windmill is refused by the ledger with a 400 that names it, and
  no crawl row is created.**
- **Zod in a script works on a page with a strict CSP** (`zod.e2e.test.ts`). The seed is
  capture-fixtures' `/csp/strict`, whose `script-src 'self'` forbids eval and reports violations to
  `/csp/report`. An inline script defines a `z.object` synchronously, calls `parse` after an `await`,
  then fetches `/plain-html?zod=<mark>`. The mark arrives and `/csp/report` is hit 0 times. The control
  is a script on the same page that calls `new Function` after an `await`, and its report does arrive.
  The control waits too because during the synchronous part of `page.evaluate`, CDP allows eval and
  the CSP is not consulted.
- **BrowserHive waits for a script that reads Zod to finish.** After a script that awaits 1.5 seconds,
  N in the page log's `script … finished after N ms` is at least 1,500. JavaScript wrapped in a
  function loses the Promise as its completion value and looks finished within milliseconds.
- **The JavaScript that ran stays on record.** The `source` in the BrowserHive WACZ's
  `behaviors/custom.jsonl` has `// zod <version> (MIT)` and no `import`.
- **A value of the wrong shape leaves the crawl succeeded and names the field.** With `safeParse` and
  `__bh.log.error`, the crawl succeeds and the page log's error line has the field's name.
- **An `import` in a form that is not accepted fails the crawl at compile**: `import { z as zod }`
  ends failed with `BH0003` in `error`.

### Scheduled runs

The clock is in capture-ledger ([Schedules](https://uraitakahito.github.io/capture-ledger/schedules/));
this repository only runs the levels it is handed. So `schedule.e2e.test.ts` looks end to end: it makes a
schedule with `POST /api/schedules` and asks for one run with `POST /api/schedules/:id/run` (run now).
The run goes through the real flow, the page is captured, and the crawl's row names the schedule. The
same file pauses, resumes and deletes a schedule, and checks that the ledger refuses an unreadable cron,
a cron that runs too often, and a name already in use.

**No test waits for a scheduled run.** doctor checks once, before any test: with `--e2e`, its 定期の回
(scheduled run) line is ✗ while one is running. Once the e2e is going, the latest crawl is always recent,
so the tick holds due runs back for quiet (10 minutes by default).

## What is not covered

A run that starts on its due time does not go through the e2e: it waits for quiet, so the test uses run
now, which does not. The tick's choices are left to capture-ledger's unit tests and its
`schedules-smoke`.

Run now does not wait for quiet during an e2e either. Press it on another schedule and a run can start
between two tests, and the test after it gets 409.
