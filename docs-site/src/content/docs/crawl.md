---
title: Following links
description: How one crawl level runs — grouped by host, parallel across hosts, sequential within one, with the gap after completion
---

capture-ledger's `POST /api/crawls` takes seed URLs — or `fromTargets`, the enabled rows
of `capture_targets` — and hands capture-scheduler **one level at a time**. The flow is
`f/waggle/crawl_level`; one execution is one level.

```
plan_level       group by host, fetch robots.txt once per host
  ↓
compile_scripts  type-check the catalog's TypeScript and turn it into JavaScript (ts-compile-service)
  ↓
for-each         parallel across hosts (parallelism = host_parallelism)
  crawl_host       sequential within a host: finish → wait → next
  ↓
report_level     report to capture-ledger, receive the next level
  ↓
index_level      ask capture-ledger to index what landed in the ledger
```

`compile_scripts` is the one step that calls a service outside the stack's own
repositories: [ts-compile-service](https://github.com/uraitakahito/ts-compile-service), which
runs as the `ts-compile` service of this repo's compose. If a single script fails the type
check, the service answers 422 and the step throws — the flow drops into `fail_crawl`
and the crawl ends as `failed`, with the diagnostics in its reason. A script that does
not type-check never reaches a page.

**capture-ledger does the repeating.** This flow ends after one level. Putting the loop
in Windmill was tried: a minimal flow with `stop_after_if` **ran 643 iterations
without stopping**. A mechanism for not overloading someone else's server does
not belong on top of a loop that can run away. The stopping conditions live in
capture-ledger and have unit tests.

## Politeness is enforced by the shape of the loop

**Windmill CE's per-key concurrency limit cannot be used** — see
[Windmill CE](/windmill-ce/) for why it silently passes everything through. What
does work is the for-loop's `parallelism`, so politeness is expressed as loop
structure:

- **across hosts** — the for-loop's `parallelism`
- **within a host** — `crawl_host` runs sequentially and waits _after_ each completion
- **across levels** — capture-ledger passes the time it last finished touching that host, and `plan_level` subtracts it

### The gap goes after completion, not before submission

This is the part that looks like a detail and is not.

How long a capture takes is not known up front — one page is two seconds, the
next is two minutes. So a gap measured from the submission says nothing about
the gap the other server feels: the next request can land the moment the
previous capture ends. **A gap on the submitting side never reaches the other
server.**

The gap only becomes real when it sits between one page finishing and the next
being submitted:

```ts file="windmill/f/waggle/crawl_host.ts#pacing"

```

### The third rule was added later

Without it, the gap held _within_ a level and vanished _between_ levels. Measured
against a 3000 ms setting, the boundary collapsed to **521 ms**.

`plan_level` computes what remains, and takes robots.txt seriously in both
directions — if the site asks for longer, the site wins:

```ts file="windmill/f/waggle/plan_level.ts#delay"

```

Note `Math.max`, not `Math.min`. **We do not shorten what the other side asked
for.** The two-sided test in `test/plan-level.test.ts` exists because an
implementation that simply always used robots' value passes a one-sided test.

## One BrowserHive holds one browser

BrowserHive (v9) has no queue and no pool: a `Capture` call is one round trip,
and a server that is already capturing refuses with `RESOURCE_EXHAUSTED`.
Picking a free server is therefore `crawl_host`'s job. It reads the list from
`u/admin/browserhive_endpoints`, tries them in turn — a busy one means "next",
an unreachable one is skipped for the rest of that call — and when every one is
busy it waits half a second to a second and a half and goes round again. Only
when none of them is reachable does it throw `ServerUnavailable`, which fails
the level.

Two consequences:

- **`host_parallelism` is capped by the number of endpoints.** `plan_level`
  returns `parallelism = max(1, min(host_parallelism, endpoints))` and the
  for-loop uses that. More parallel hosts than browsers would only mean more
  hosts waiting on `busy`.
- **Retries live here now.** BrowserHive no longer retries on the server side —
  a retry there would bypass the gap measured here. A capture that fails with a
  transient error (`connection`, `timeout`, `internal`) is tried once more,
  after the same gap as any other request to that host. A failure to store the
  artifacts (`artifact_sink`) is not — what is broken is the store, and capturing
  the page again would only write to the same store.

## Settings come from variables, not arguments

`crawl_host`, `report_level` and `index_level` do **not** take their connection
settings as arguments. Windmill fills schema defaults **only for UI-triggered
runs**, so a webhook run gets nothing — the BrowserHive target arrived
`undefined` and the job died with "Channel target must be a string".

What does arrive as arguments is what capture-ledger decides for that crawl and always
sends: the URLs, the delay, `capture_formats` / `signing`, and **`scripts`** — the
TypeScript to run inside each page. The catalog keeps it as written (its `sha256` is over the
TypeScript bytes); `compile_scripts` turns it into JavaScript and re-hashes it, and BrowserHive
checks the JavaScript's hash. The two hashes meet at that one step. `report_level` then carries
the JavaScript hash, with the compiler version and the host-types tag the service answered
with, back to capture-ledger (`compiled` in the level report). The ledger writes them next to
the TypeScript hash on the crawl, and refuses a later level that reports a different hash
(409). An empty catalog (`scriptIds: []` on the crawl) is a valid level too: the service answers
200 with no scripts, the page runs nothing, and the report still carries `typescript` and
`hostTypes`.

`scripts` is required for the same reason `capture_formats` is. BrowserHive v11.0.0
holds no roster of its own: send nothing and nothing runs inside the page, and the
capture still succeeds and still produces an archive. A forgotten argument would be a
crawl that never scrolled, indistinguishable from one that did. This flow only carries
them — what runs, in what order, and in which of BrowserHive's two injection points
(`behavior` after load, `preload` before navigation) is decided by capture-ledger's
catalog.

```sh
pnpm run windmill:capture-ledger-token   # waggle_token / waggle_api_url /
                                 # browserhive_endpoints / browserhive_tls_ca /
                                 # ts_compile_url
pnpm run windmill:push-proto     # BrowserHive's proto (a resource)
```

`u/admin/ts_compile_url` is where `compile_scripts` sends the catalog (default
`http://ts-compile.capture-scheduler:8080`, the `ts-compile` service of this repo's compose;
override with `TS_COMPILE_URL`). `pnpm run doctor` checks that the worker can reach its
`/healthz`.

`u/admin/browserhive_tls_ca` is the CA certificate (PEM) for the gRPC leg to
BrowserHive, and **an empty value means plaintext**. The variable is written even
when it is empty, on purpose: if it were simply absent, `getVariable` would throw,
and a script that reads "could not fetch it" as "no TLS wanted" turns a read
failure into a plaintext connection. There is no "TLS with the system roots"
mode — BrowserHive's TLS assumes a private CA, and needing a public certificate
would mean the server is on the public internet. The development stack is
plaintext.

The proto is a **resource** rather than a variable because it is 16,315 bytes and
the variable limit sits between 10,000 and 20,000. `pnpm run proto:check` diffs it
against capture-ledger's copy — a contract copied by hand rots silently, so it gets a
guard.
