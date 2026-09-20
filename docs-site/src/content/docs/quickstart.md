---
title: Quickstart
description: Bring up Windmill and take your first capture
---

## Before you start: capture-ledger's stack is running

Windmill uses two parts of capture-ledger's stack. [Let windmill start crawls](#let-windmill-start-crawls)
below writes a permission into its OpenFGA ("windmill may start crawls for acme"), and crawls call
its BrowserHive to take the pages.
Before you start, finish §1–§5 of capture-ledger's
[Quickstart](https://uraitakahito.github.io/capture-ledger/quickstart/) (the DNS domain, the
submodules and `.env`, `stack:up`, the database, the two OpenFGA ids) and check that the stack is up:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H 'authorization: Bearer dev-key' http://127.0.0.1:8090/stores
# 200 means it is up. 000 means it is not → cd ~/projects/crawler/capture-ledger && pnpm run stack:up
```

`dev-key` is the development OpenFGA's default key. With the stack down, `fga:grant` below stops
with "OpenFGA (http://localhost:8090) に届きません" (OpenFGA is not reachable).

Every code block below starts with a `cd` that says which repo it runs in (this assumes both repos
are cloned side by side under `~/projects/crawler/`; adjust if yours live elsewhere). Run a
capture-scheduler command inside capture-ledger and pnpm only says `Missing script`.

## Bring it up

```sh
cd ~/projects/crawler/capture-scheduler
sudo container system dns create capture-scheduler   # once per machine
./setup.sh
container-compose up -d
pnpm install

pnpm run windmill:bootstrap   # creates the workspace and a token, and prints lines for two places (below)
pnpm run windmill:push        # upload the scripts, the flow and the schedule
pnpm run windmill:push-proto  # upload BrowserHive's proto (crawl_host reads it; push does not include it)
```

Paste bootstrap's output in two places. `WINDMILL_TOKEN=…` goes into this repo's `.env`. The four
lines after it go, as they are, **at the end of** capture-ledger's `.env` (a later line wins over an
earlier one with the same name). **Miss any of the four and no crawl runs to the end**:

```dotenv title="capture-ledger/.env (at the end)"
# the four lines capture-scheduler's pnpm run windmill:bootstrap printed
CAPTURE_LEDGER_CRAWL_WEBHOOK_URL=http://127.0.0.1:8000/api/w/crawler/jobs/run/f/f/waggle/crawl_level
CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=<the value bootstrap printed>
CAPTURE_LEDGER_API_HOST=0.0.0.0
CAPTURE_LEDGER_OIDC_ISSUER=http://127.0.0.1:9099
```

| Line                                           | Why                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `…_CRAWL_WEBHOOK_URL`, `…_CRAWL_WEBHOOK_TOKEN` | Where crawls are sent to Windmill. Without them `/api/crawls` does not exist (`404`)                |
| `CAPTURE_LEDGER_API_HOST=0.0.0.0`              | Level reports come from a container, and an API listening on `127.0.0.1` never receives them        |
| `CAPTURE_LEDGER_OIDC_ISSUER`                   | The flow identifies itself with a JWT. Without it the API trusts dev headers, and reports get `401` |

bootstrap creates a new token every time you run it (the earlier ones stay valid). To skip running it
again, put the same value as `WINDMILL_TOKEN` in this repo's `.env` where it says
`<the value bootstrap printed>`.

Then start the issuer on the capture-ledger side and restart the API:

```sh
cd ~/projects/crawler/capture-ledger
pnpm run oidc:issuer   # keep it running
pnpm run api           # in another terminal; restart it if running (settings are read once, at startup)
```

The **last line** of the API's startup log says whether the four lines took:

```text
Archive API listening on 0.0.0.0:7070 — identity: JWT (http://127.0.0.1:9099); crawl level reports: ready
```

With `blocked`, the warnings above it name the missing lines (from capture-ledger v0.44.0).

Windmill opens at `http://127.0.0.1:8000`.

### Hand over the key

Put the token the Windmill flow calls capture-ledger with, and the address it calls, into
Windmill's variables:

```sh
cd ~/projects/crawler/capture-scheduler
pnpm run windmill:capture-ledger-token   # the token, and the API address as a container sees it
```

The API address (`u/admin/waggle_api_url`) comes from the gateway of the `default` network
(`container network inspect default`) unless `CAPTURE_LEDGER_API_URL` is set. It changes when the
network is recreated; re-run `windmill:capture-ledger-token` then. Do the same after restarting the
issuer ([How the token gets there](#how-the-token-gets-there)).

### Let windmill start crawls

Windmill calls capture-ledger under the name `windmill` (the token's `sub`; organization `acme`).
Each time it starts a crawl, reports a level, hands over the index, or closes a crawl,
capture-ledger asks OpenFGA "may windmill start crawls for acme?" and answers 404 when it may not.
Even a crawl you start by hand reports its levels under the name windmill.

```
pnpm run fga:grant submitter windmill acme      (you, once)
    │ writes
    ▼
OpenFGA   user:windmill  submitter  organization:acme
    ▲
    │ asks: is user:windmill can_submit on organization:acme?
    │       (on every start, level report, index, and close)
capture-ledger API   ◄── Windmill (a token with sub=windmill, orgs=[acme])
    │
    └─ 202 when the tuple is there; otherwise 404 {"error":"not found"}
```

Write that permission (on the capture-ledger side, once; `fga:revoke` takes it back):

```sh
cd ~/projects/crawler/capture-ledger
pnpm run fga:grant submitter windmill acme
# windmill は acme のクロールを起こせます (書いた: user:windmill submitter organization:acme)
#   = "windmill may start crawls for acme (wrote: …)"
```

If you changed `CAPTURE_LEDGER_SUBJECT` / `_ORGANIZATIONS`, use those names. Whether it took is
what the `can_submit` line of `doctor` below tells you; when something is missing, it prints the
command to type, with the names capture-ledger actually saw.

## Check it: take one capture

```sh
cd ~/projects/crawler/capture-scheduler
pnpm run doctor   # 14 checks; all ✓ means a crawl is set up to run to the end
pnpm run smoke    # captures https://example.com/ once; "撮れた" (captured) once the WACZ comes back
```

**doctor** asks, for each heading of this page, whether that step is done — by asking the things
the step created. It goes past "is it up": whether the scripts match the repo, whether the proto
is stale, whether the token Windmill holds may start crawls, whether the API and BrowserHive are
reachable from inside the worker. A ✗ says what to fix and which section of this page the step
lives in. Checks that depend on a ✗ do not run and only say "先に … を" (… first) — one thing to
fix means one ✗.

```
立ち上げる
  ✓ windmill            http://127.0.0.1:8000/api/version
  …
  ✗ capture-ledger api  http://127.0.0.1:7070/healthz
  ✗ oidc issuer         http://127.0.0.1:9099/.well-known/openid-configuration
  ・crawl route         先に capture-ledger api を
  ・jwt                 先に capture-ledger api・oidc issuer を

直すもの (2):
  capture-ledger api —— capture-ledger の API が答えない → cd ../capture-ledger && pnpm run api
    手順: https://uraitakahito.github.io/capture-scheduler/ja/quickstart/#立ち上げる
  …
```

**smoke** captures one page, and only when doctor is all ✓. It takes the production path —
asks capture-ledger's `POST /api/crawls` with the flow's own token, lets the Windmill flow capture,
waits for the level report — then fetches the archive the ledger recorded through a signed URL
and checks that it starts with `PK` (a WACZ is a zip):

```
点検     doctor の 14 本とも ✓
起こす   POST /api/crawls → 202  crawl 545e912c-…  https://example.com/
待つ     running
run      http://127.0.0.1:8000/run/01a0ba19-…?workspace=crawler
終わり   succeeded (max_depth) —— 撮ったページ 1・6 秒
取り出す archive 928d640f-… の先頭が PK (WACZ = zip)
撮れた   https://example.com/
```

**When it fails**, smoke names the step that failed and how to fix it (the `原因` cause and
`直す` fix lines). Fix that and run smoke again. It closes the crawl it started — on failure, on
timeout, on Ctrl-C — so the next run is never blocked by a 409. To follow it in Windmill, open the
`run` URL smoke prints ([Windmill UI: "Digging into failures"](/windmill-ui/#digging-into-failures--two-real-ones)).

```sh
cd ~/projects/crawler/capture-scheduler
pnpm run smoke https://example.org/   # capture a different URL
pnpm run smoke --timeout 300          # how long to wait (seconds, default 180)
pnpm run smoke --no-doctor            # skip the checks (re-running right after a fix)
pnpm run smoke --close-running        # on 409, close the running crawl first, then capture
```

smoke needs capture-ledger v0.43.0 or later (that is when the ledger started returning the last
level's run and why pages failed).

### From symptom to fix

Every row was produced for real and checked (2026-09-19).

| What you see                                                                                                                                         | Meaning                                                                                                  | Fix                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| doctor: windmill ✗, and the checks below say "先に windmill を"                                                                                      | Windmill is down                                                                                         | `container-compose up -d` (in this repo)                                                  |
| doctor: proto ✗ "Windmill に proto が無い" / smoke: `[cap] Resource not found at u/admin/browserhive_proto …`                                        | the proto was never uploaded                                                                             | `pnpm run windmill:push-proto`                                                            |
| doctor: proto ✗ "repo の capture.proto と違う"                                                                                                       | BrowserHive was upgraded and the proto re-fetched, but Windmill's copy is stale                          | `pnpm run windmill:push-proto`                                                            |
| doctor: push ✗ "repo と中身が違う"                                                                                                                   | a script was changed but not pushed (or was edited in the Windmill UI)                                   | `pnpm run windmill:push` (`windmill:diff` to just look)                                   |
| doctor: worker→browserhive ✗ "名前が引けない" ("3 秒で答えない" for a few seconds right after the stop) / smoke: `[cap] BrowserHive に届きません: …` | a BrowserHive container is stopped (a stopped container loses its DNS name too)                          | `pnpm run stack:up` in capture-ledger                                                     |
| smoke: `succeeded` with 0 pages, cause `… net::ERR_NAME_NOT_RESOLVED …`                                                                              | the URL's host does not resolve                                                                          | check the URL; if it is right, whether BrowserHive's containers can resolve outside names |
| doctor: can_submit ✗ "… のクロールの許可が無い" / smoke: `… /pages → 404`                                                                            | windmill may not start crawls                                                                            | `pnpm run fga:grant submitter windmill acme` in capture-ledger                            |
| doctor: can_submit ✗ "トークンが通らない" / smoke: `… /pages → 401`                                                                                  | the issuer was restarted and Windmill's token is stale                                                   | `pnpm run windmill:capture-ledger-token`                                                  |
| doctor: jwt ✗ "ヘッダで名乗る設定で動いている" (the startup log's last line says `crawl level reports: blocked`)                                     | capture-ledger's API does not accept JWTs (`CAPTURE_LEDGER_OIDC_ISSUER` is not in effect)                | paste bootstrap's four lines at the end of capture-ledger's `.env` and restart the API    |
| doctor: container→api ✗ "API が 127.0.0.1 で待っている" / smoke: `Unable to connect`                                                                 | level reports cannot reach the API from a container (`CAPTURE_LEDGER_API_HOST=0.0.0.0` is not in effect) | paste bootstrap's four lines at the end of capture-ledger's `.env` and restart the API    |
| smoke: 409 "走行中のクロールがある: …"                                                                                                               | an earlier crawl is still `running`                                                                      | wait for it, or `pnpm run smoke --close-running`                                          |

## How the token gets there

```
host                                   │ container
  dev issuer 127.0.0.1:9099            │
      │ POST /token                    │
      ▼                                │
  windmill:capture-ledger-token ───────────────┼──► secret variable u/admin/waggle_token
                                       │            │
  capture-api 0.0.0.0:7070  ◄───────────┼── trigger_crawl.ts
```

**Keep the dev issuer on loopback.** It mints a token for whoever asks, under
whatever name they ask for. Put it somewhere a container can reach and everyone
on the bridge can claim to be `windmill` — and so use the crawl permission that `fga:grant`
gave to windmill alone, which undoes the point of using JWTs at all.

The power to mint keys stays on the host. What crosses the boundary is **one
finished token**.

**Re-run `pnpm run windmill:capture-ledger-token` after restarting the issuer.** It
generates its keys in memory on every start (deliberately), so the old token
starts returning 401. The error messages in `report_level.ts` and
`trigger_crawl.ts` say so, because this is easy to hit and hard to guess.

The API does not need a restart. The key's name (kid) changes along with the key, so the API
refetches the keys as soon as it sees one new token (from capture-ledger v0.42.1; before that the
kid was fixed and the API kept the old key for up to ten minutes, rejecting new tokens). For 30
seconds right after the issuer restarts, new tokens may still be refused — the jwt line of
`doctor` says so.

## Viewing in the picker (paste a token)

With `CAPTURE_LEDGER_OIDC_ISSUER` set, capture-ledger accepts **only** JWTs. The browser picker at
`http://127.0.0.1:7070/` follows suit and shows a token field in place of the two name fields (from
capture-ledger v0.45.0). Leave the API's settings as they are and paste a token:

```sh
cd ~/projects/crawler/capture-ledger
pnpm run --silent oidc:token --subject "$(whoami)" --org acme | pbcopy
open http://127.0.0.1:7070/
```

Paste it into the トークン (Token) field and press 読み込む (Load). When the line above the list says
you are viewing as your name in `acme`, the API has accepted the token. A token lasts one hour, and
after the issuer restarts, older tokens stop working once the API has fetched the new key — when
the picker says 401 — このトークンは通らない…
("this token does not get through"), get a new one with the same command and paste it. How to use
the screen is in capture-ledger's
[Browsing archives](https://uraitakahito.github.io/capture-ledger/picker/).

JWT winning over the dev header is deliberate on capture-ledger's side: when both are configured, it
must not fall back to the weaker one. **Do not comment out `CAPTURE_LEDGER_OIDC_ISSUER` for the
picker** — an API without it refuses the flow's level reports with 401, and a running crawl stays
`running` and blocks every later start with 409. How to clear it is in capture-ledger's quickstart,
["When every crawl gets 409"](https://uraitakahito.github.io/capture-ledger/quickstart/#when-every-crawl-gets-409).
