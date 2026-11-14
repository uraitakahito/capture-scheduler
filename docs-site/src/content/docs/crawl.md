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
replay_bundle_level  ask capture-ledger to rewrite the crawl's replay bundle, which replayweb-server and capture-player open as one archive
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

## Level keys

capture-ledger picks a **level key** (the Windmill job id) for each level and passes it as the
webhook's `?job_id=` and as the flow argument `level_key` (CAPTURE-180). The flow hands it back
unchanged.

- **`report_level`** puts it in the level report's `Idempotency-Key`. capture-ledger answers a
  second report of the same level with the first answer, and adds neither counts nor a second next
  level. So the report step **retries five times, 30 seconds apart** (two and a half minutes). If a
  dropped response or a restarting capture-ledger failed the whole level, a level that was captured
  would close as `failed`. A 409 while capture-ledger is still handling the report (a 2-minute lease)
  is thrown too, and waited out here. The lease is shorter than the retries, so a report that
  capture-ledger dropped half-way can be taken over.
- **`fail_crawl`** (the failure_module) sends the failed level's `depth` and `levelKey`.
  capture-ledger closes only for the newest level's key and answers `{"closed": false}` otherwise, so
  a flow that failed in the replay bundle or index step after its report, or an older level's flow
  run again by hand, does not close a crawl that is capturing its next level. On a 5xx or no
  connection it tries three times inside the step, 5 seconds apart (whether a `retry` on the
  failure_module works is not checked, so it is not relied on).
- The same level report arrives twice after the report step's retries, when the flow is run again
  by hand with the same arguments, and when Windmill reruns a job whose worker stopped. Windmill's
  "restart from this step" (`jobs/restart`) is not available in the Community Edition (enterprise
  version only; checked on 2026-11-12).

A report from an older flow that does not carry `level_key` is refused with 400 by a capture-ledger
that requires level keys. Upgrade the flow and capture-ledger together.

`replay_bundle_level` also runs after the report. It sends the level's `depth` to capture-ledger's
`POST /api/crawls/:id/replay-bundle`, and capture-ledger writes the crawl's **replay bundle** as a new
revision to the store, under `org/<organization>/crawls/<crawl>/r<revision>/`: a `replay.json` listing
every WACZ of the crawl so far and a `pages.json` of their pages. replayweb-server and capture-player open the
`replay.json` as one archive, so a link from a page in one WACZ leads to a page in another. Which WACZ files go in, and the
revision number, are capture-ledger's to decide; `depth` is only recorded. The step comes before
`index_level` because the replay bundle does not depend on OpenSearch — a failing index step does not
stop it.

A replay bundle is derived from what was captured and can be rebuilt
(`pnpm run replay-bundle:rebuild --crawl <id>` in capture-ledger), so **the step does not throw on
anything the ledger answers with 200**: the store refused the write (`error`), a WACZ could not be
inspected (`failed` above 0, picked up by the next replay bundle), or there was no WACZ to include yet
(`rev: null`). It writes one log line and returns. Throwing would skip the index step and make `fail_crawl` close the crawl as `failed` (if its
next level is already running, capture-ledger does not close it: the failure is not the newest level's; see "Level keys" below). It throws only when the ledger does not answer 200 — 400 (the body),
401 (the token), 404 (no such crawl, no crawl permission for the token's `sub`, or a capture-ledger too
old to have the endpoint), 5xx — or answers in the wrong shape.

`index_level` runs after the report, so by then capture-ledger has already closed the crawl
(or started the next level). Full-text search is a required part of capture-ledger, so
the step skips nothing: it throws when the ledger answers 404 (no such crawl, or no crawl permission
for the token's `sub`), 503 (OpenSearch did not answer), or 202 with `failed` above 0 (an archive was
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
busy it waits half a second to a second and a half and goes round again. When
none of them is reachable it throws `ServerUnavailable`.

**Only the host's first page fails the whole level.** When `crawl_host` throws,
the flow retries that step twice, 30 seconds apart (three runs in all), and a
retry captures the host again from its first page. Throwing after a capture
would send the site a second request for the same page, and the earlier
artifact would stay in the store without ever being reported. So if BrowserHive
becomes unreachable after the first page, it returns what it captured and marks
the rest `failed` with "BrowserHive に届かない (撮り直さない)" (unreachable, not
captured again). If BrowserHive is still down, the next level's first page
fails the level. The retry also applies when it throws over a missing argument or
because it cannot read the variables, the secrets or the endpoint list (all of
these happen before any capture).

**Unreachable does not mean the request never arrived.** A connection that
drops after it was made, before the answer, also counts as unreachable, and the
same page is captured again on the next endpoint. If the first endpoint had
finished, the site sees a second request (a deadline is not passed on to the
next endpoint).

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
TypeScript to run inside each page — **`variables` / `secrets` / `secret_archive`**, the per-crawl values
([the section below](#per-crawl-values--variables-and-secrets)), and **`record_random`**, whether BrowserHive records the
random values the page's JavaScript receives ([Per-crawl random recording](#per-crawl-random-recording)). The ledger keeps it as written (its `sha256` is over the
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
capture still succeeds and still produces an archive. The one script this flow can add is BrowserHive's own: with
`record_random`, BrowserHive puts its recorder into the page before the page's JavaScript, and the values the page
receives are left unchanged. A forgotten argument would be a
crawl that never scrolled, indistinguishable from one that did. This flow only carries
them — what runs, in what order, and in which of BrowserHive's two injection points
(`behavior` after load, `preload` before navigation) is decided by
capture-ledger.

```sh
pnpm run windmill:capture-ledger-token   # ledger_client / waggle_api_url /
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

## Per-crawl random recording

A crawl can ask BrowserHive to record the values the page's JavaScript receives from `Math.random`,
`crypto.getRandomValues` and `crypto.randomUUID` (`recordRandom` in BrowserHive v31.1.0). capture-ledger always sends
it as `record_random`, `false` when none was asked for. **The flow only carries it**: `crawl_host` puts
`recordRandom: true` in the request when it is true and leaves the key out when it is false — BrowserHive before
v31.1.0 refuses a field it does not know with 400. `crawl_host` throws when the input is not a boolean (`null`
included), because a crawl that silently recorded nothing would still succeed. When asked, BrowserHive writes the values
to `random/values.jsonl` in the BrowserHive WACZ and summarises them in `browserhive:capture.random` of
`datapackage.json` (`recorded: true`); otherwise `recorded` is `false` with `skipped: "not-requested"` and there is no
`random/` entry ([BrowserHive WACZ Profile 1.26.0](https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.26.0/#random)).
BrowserHive refuses `recordRandom` without `captureFormats.wacz` (400), since the values go only into the WACZ.

## Per-crawl values — variables and secrets

A script receives values that differ from crawl to crawl through two slots. A variable is declared and
read with [capture-scripts](https://github.com/uraitakahito/capture-scripts)' `defineParams` (from
v0.11.0). A secret is declared in the `params` of `catalog.json` and read through BrowserHive's host
object as `__bh.secrets`. Both reach the page through the host object: in the JavaScript, `defineParams`
becomes `__bh.vars`.
**The flow carries both and looks at neither.**

| Slot             | What the ledger sends                                                                                                                    | What `crawl_host` does                                                                                                     | What the records keep                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `variables`      | name → value; what was asked for as `variables` on `POST /api/crawls`, pinned on the crawl                                               | puts them on the BrowserHive request as they are                                                                           | the values (`browserhive:capture.settings.variables` in the [BrowserHive WACZ](https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.25.0/), the crawl row)                           |
| `secrets`        | name → the path of a Windmill variable (`f/waggle_secrets/<name>`); the ledger collects them from the declarations and checks they exist | resolves each with `getVariable` and puts the values on the BrowserHive request **only**; a path outside the folder throws | the names only (`browserhive:capture.settings.secrets` in the BrowserHive WACZ; the crawl row keeps the path and when it was set)                                                               |
| `secret_archive` | name → `"keep"` for each secret whose value stays in the WARC (the declaration's `archive: "keep"`); `{}` when none                      | puts it on the request as `secretArchive`, **keeping only names it resolved in `secrets`**                                 | which secrets stayed (`browserhive:capture.settings.secretArchive`); every other secret's value is `***` in the [BrowserHive WARC](https://uraitakahito.github.io/browserhive-warc-spec/1.4.0/) |

An empty slot is not sent at all (BrowserHive up to v21 refuses unknown fields with a 400). An older
ledger sends none of them, so they arrive from the flow as `null`, which `crawl_host` reads as absent —
`artifact_sink` now gets the same treatment (it used to check `undefined` only and sent `null` when
the sink was left out). A missing `secret_archive` therefore hides every secret, the safe side. In the
other direction, an older flow without the `secret_archive` input does not reject the argument: Windmill
does not check arguments against the flow's schema by default (the ledger's `lastFinishedAt` on each
`frontier` item has always reached `plan_level` without being in it), and nothing passes it on, so the values
are hidden there too.

**BrowserHive hides a secret's value in the WARC** (from v29.0.0): what a script sends and what the site
sends back become `***`, unless `secretArchive` names the secret. `crawl_host` keeps a name in `secretArchive`
only when it is in the `secrets` it built, because BrowserHive refuses a name that `secrets` lacks with a 400,
and that would fail every capture of the crawl, not one page. The ledger already sends only the names it
pinned on the crawl; the check is repeated here. BrowserHive also refuses a hidden value shorter than 8
characters and a URL to capture that contains one, so such a crawl fails page by page with BrowserHive's
400 (the ledger cannot see the values).

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
  place (it logs the names, and which of them stay in the WARC). What BrowserHive does on its side — hide
  it in the WARC unless kept, mask it in its logs, and the fact that page JavaScript can read it — is in
  BrowserHive's docs.

A schedule's `request` has the shape of `POST /api/crawls`, so it takes `variables` too. It does not
take secrets — the ledger binds the names a script declared to the Windmill variables, on every run, so a
scheduled run and a hand-started crawl get the same values.
