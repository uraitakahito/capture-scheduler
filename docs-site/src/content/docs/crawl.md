---
title: Following links
description: How one crawl level runs — grouped by host, parallel across hosts, sequential within one, with the gap after completion
---

capture-ledger's `POST /api/crawls` takes seed URLs (a scheduled run starts from what its schedule
pinned) and hands capture-scheduler **one level at a time**. The flow is
`f/waggle/crawl_level`; one execution is one level.

```
plan_level           group by host, fetch robots.txt once per host
  ↓
compile_scripts      type-check the catalog's TypeScript and turn it into JavaScript (ts-compile-service)
  ↓
for-each             parallel across hosts (parallelism = host_parallelism)
  crawl_host           sequential within a host: finish → wait → next
  ↓
report_level         report to capture-ledger, receive the next level
  ↓
replay_bundle_level  ask capture-ledger to rewrite the crawl's replay bundle, which replay opens as one archive
  ↓
index_level          ask capture-ledger to index what landed in the ledger
```

`compile_scripts` is the one step that calls a service outside the stack's own
repositories: [ts-compile-service](https://github.com/uraitakahito/ts-compile-service), which
runs as the `ts-compile` service of this repo's compose. If a single script fails the type
check, the service answers 422 and the step throws — the flow drops into `fail_crawl`
and the crawl ends as `failed`, with the number of diagnostics and the first five in its reason.
The reason is cut to the ledger's limit of 2,000 characters: above it the ledger refuses the
report, and the crawl would stay `running` and block every crawl after it. A script that does
not type-check never reaches a page.

`replay_bundle_level` also runs after the report. It sends the level's `depth` to capture-ledger's
`POST /api/crawls/:id/replay-bundle`, and capture-ledger writes the crawl's **replay bundle** as a new
revision to the store, under `org/<organization>/crawls/<crawl>/r<revision>/`: a `replay.json` listing
every WACZ of the crawl so far and a `pages.json` of their pages. replay opens the `replay.json` as one
archive, so a link from a page in one WACZ leads to a page in another. Which WACZ files go in, and the
revision number, are capture-ledger's to decide; `depth` is only recorded. The step comes before
`index_level` because the replay bundle does not depend on OpenSearch — a failing index step does not
stop it.

A replay bundle is derived from what was captured and can be rebuilt
(`pnpm run replay-bundle:rebuild --crawl <id>` in capture-ledger), so **the step does not throw on
anything the ledger answers with 200**: the store refused the write (`error`), a WACZ could not be
inspected (`failed` above 0, picked up by the next replay bundle), or there was no WACZ to include yet
(`rev: null`). It writes one log line and returns. Throwing would skip the index step and make `fail_crawl` close the crawl as `failed` while its
next level may already be running. It throws only when the ledger does not answer 200 — 400 (the body),
401 (the token), 404 (no such crawl, no crawl permission for the token's name, or a capture-ledger too
old to have the endpoint), 5xx — or answers in the wrong shape.

`index_level` runs after the report, so by then capture-ledger has already closed the crawl
(or started the next level). Full-text search is a required part of capture-ledger, so
the step skips nothing: it throws when the ledger answers 404 (no such crawl, or no crawl permission
for the token's name), 503 (OpenSearch did not answer), or 202 with `failed` above 0 (an archive was
left out of the index). On the last level that leaves the crawl `succeeded` and only the Windmill run
red — `pnpm run smoke` waits for the run and reports it.

The same `ts-compile` is also published on the host at `127.0.0.1:28080`. capture-ledger runs on the host
and calls it to re-read, by line and column, the type errors of a crawl that failed, and to check proposed
fixes (the host's node cannot reach the container subnet, so the port is published on loopback). bootstrap
hands this address to capture-ledger with the other lines (`CAPTURE_LEDGER_TS_COMPILE_URL` in
`.dev/capture-ledger.env`, copied by capture-ledger's `pnpm run connect`), so nobody writes it by hand. The
flow keeps calling it by name (`u/admin/ts_compile_url`).

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

BrowserHive has no queue and no pool: `POST /captures` is one round trip, and a
server that is already capturing refuses with `429 Busy`.
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
  the page again would only write to the same store. Nor is a failure to keep the
  URL policy (`policy`, from BrowserHive v18.0.0): a page that opened a WebSocket
  matching `deny` would open it again, and the handshake cannot be stopped.
  Nor is a crash of the main page's renderer (`renderer_crashed`, from BrowserHive
  v28.0.0): usually the page ran out of memory, and it crashes in the same place again.
  A crash of a cross-site iframe only is not a failure at all: the capture answers
  `success`, and the archive says so in `completeness.crashedTargets`.

## Settings come from variables, not arguments

`crawl_host`, `report_level`, `replay_bundle_level` and `index_level` do **not** take their connection
settings as arguments. Windmill fills schema defaults **only for UI-triggered
runs**, so a webhook run gets nothing — the BrowserHive target arrived
`undefined` and the job died with "Channel target must be a string".

What does arrive as arguments is what capture-ledger decides for that crawl and always
sends: the URLs, the delay, `capture_formats` / `signing`, **`scripts`** — the
TypeScript to run inside each page — and **`variables` / `secrets`**, the per-crawl values
([the section below](#per-crawl-values--variables-and-secrets)). The ledger keeps it as written (its `sha256` is over the
TypeScript bytes); `compile_scripts` turns it into JavaScript and re-hashes it, and BrowserHive
checks the JavaScript's hash. The two hashes meet at that one step. `report_level` then carries
the JavaScript hash, with the compiler version and the host-types tag the service answered
with, back to capture-ledger (`compiled` in the level report). The ledger writes them next to
the TypeScript hash on the crawl, and refuses a later level that reports a different hash
(409). An empty script list (`scripts: []` on the crawl) is a valid level too: the service answers
200 with no scripts, the page runs nothing, and the report still carries `typescript` and
`hostTypes`. A script written on the spot (an `inline` element of `scripts`) travels the same
way: capture-ledger pins it on the crawl as `inline-<name>`, and the flow compiles and injects it
like a registered one.

`scripts` is required for the same reason `capture_formats` is. BrowserHive v11.0.0
holds no roster of its own: send nothing and nothing runs inside the page, and the
capture still succeeds and still produces an archive. A forgotten argument would be a
crawl that never scrolled, indistinguishable from one that did. This flow only carries
them — what runs, in what order, and in which of BrowserHive's two injection points
(`behavior` after load, `preload` before navigation) is decided by
capture-ledger.

```sh
pnpm run windmill:capture-ledger-token   # waggle_token / waggle_api_url /
                                 # browserhive_endpoints / browserhive_tls_ca /
                                 # ts_compile_url
```

`u/admin/ts_compile_url` is where `compile_scripts` sends the scripts (default
`http://ts-compile.capture-scheduler:8080`, the `ts-compile` service of this repo's compose;
override with `TS_COMPILE_URL`). `pnpm run doctor` checks that the worker can reach its
`/healthz`.

`u/admin/browserhive_tls_ca` is the CA certificate (PEM) for `https://` endpoints
of BrowserHive, and **an empty value means plaintext**. The variable is written even
when it is empty, on purpose: if it were simply absent, `getVariable` would throw,
and a script that reads "could not fetch it" as "no TLS wanted" turns a read
failure into a plaintext connection. There is no "TLS with the system roots"
mode — BrowserHive's TLS assumes a private CA, and needing a public certificate
would mean the server is on the public internet. The development stack is
plaintext.

Nothing else is copied from BrowserHive. `crawl_host` speaks its HTTP API
(`POST /captures` with a JSON body, since BrowserHive v12) through `fetch`, so
there is no contract file to keep in sync — until v0.22 this repo carried a copy of
BrowserHive's gRPC `.proto` as a Windmill resource, with a guard to catch it rotting.
The endpoints are therefore `http(s)://` URLs; `crawl_host` refuses the old
`host:port` form and names the variable.

## Per-crawl User-Agent

A crawl can ask for its own `User-Agent` (`userAgent` on capture-ledger's `POST /api/crawls`).
capture-ledger always sends it as `user_agent`, empty when none was asked for. **The flow carries it and
does not resolve it**: `crawl_host` passes the text to BrowserHive, which turns `{chrome}` into the browser's own
value without Headless, and leaves the key out when it is empty. `crawl_host` throws when the input does
not arrive, because a crawl that silently kept the browser's value would still succeed. `plan_level` uses it to
read robots.txt rules: text containing `BrowserHive` is matched under that name (its group first, then
`*`); otherwise under `*`. The request that fetches robots.txt does not change.

## Per-crawl values — variables and secrets

A script receives values that differ from crawl to crawl through two slots. A variable is declared and
read with [capture-scripts](https://github.com/uraitakahito/capture-scripts)' `defineParams` (from
v0.11.0). A secret is declared in the `params` of `catalog.json` and read through BrowserHive's host
object as `__bh.secrets`. Both reach the page through the host object: in the JavaScript, `defineParams`
becomes `__bh.vars`.
**The flow carries both and looks at neither.**

| Slot        | What the ledger sends                                                                                                                    | What `crawl_host` does                                                                                                     | What the records keep                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `variables` | name → value; what was asked for as `variables` on `POST /api/crawls`, pinned on the crawl                                               | puts them on the BrowserHive request as they are                                                                           | the values (`settings.variables` in the WACZ, the crawl row)                                      |
| `secrets`   | name → the path of a Windmill variable (`f/waggle_secrets/<name>`); the ledger collects them from the declarations and checks they exist | resolves each with `getVariable` and puts the values on the BrowserHive request **only**; a path outside the folder throws | the names only (`settings.secrets` in the WACZ; the crawl row keeps the path and when it was set) |

An empty slot is not sent at all (BrowserHive up to v21 refuses unknown fields with a 400). An older
ledger sends neither, so they arrive from the flow as `null`, which `crawl_host` reads as absent —
`artifact_sink` now gets the same treatment (it used to check `undefined` only and sent `null` when
the sink was left out).

### Secrets are Windmill variables

Only Windmill holds the value. A person puts it there ahead of time (`--secret` is the default for a
new variable; it is spelled out anyway):

```sh
pnpm run windmill:cli variable add '<value>' f/waggle_secrets/<name> --secret --description '<what the key is for>'
```

- The name is the one the script declared (`^[a-z][a-z0-9_]*$`). The ledger builds the path, and
  `crawl_host` throws, naming the secret, on any path outside `f/waggle_secrets/`.
- The folder `f/waggle_secrets` is owned by `windmill/f/waggle_secrets/folder.meta.yaml` and created by
  `windmill:push`. **A folder created through the API or the UI disappears on the next push** (`wmill sync
push` deletes remote folders that are absent locally). The variables inside are not synced
  (`skipVariables`), so a push neither removes nor adds them. The "シークレットのフォルダ" line of
  `pnpm run doctor` checks that the folder is there.
- A declared secret that is missing from Windmill makes the ledger refuse the crawl with a 400 naming it
  and its path, before anything starts. One that disappears mid-crawl makes `crawl_host` throw, the level
  fails, and `fail_crawl` closes the crawl.
- The value travels only in the request body from the Windmill worker to BrowserHive. The run history
  shows the path. Windmill masks whole occurrences of a secret's value in job logs as `zzp*****c3b`
  (measured on 1.806.0; substrings are not masked), but `crawl_host` never logs values in the first
  place (it logs the names). What BrowserHive does on its side — keep it out of the archive, mask it in
  its logs, and the fact that page JavaScript can read it — is in BrowserHive's docs.

A schedule's `request` has the shape of `POST /api/crawls`, so it takes `variables` too. It does not
take secrets — the ledger binds the names a script declared to the Windmill variables, on every run, so a
scheduled run and a hand-started crawl get the same values.
