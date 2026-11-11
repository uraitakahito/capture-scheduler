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
submodules and `.env`, `stack:up`, the database, the two OpenFGA ids) and check that the stack is up.
Its `pnpm run dev:up` does §3 onwards in one go, so §1 and §2 are the only ones you have to type.

**Do not skip the scripts in §4.** BrowserHive holds no roster of its own, so an empty `scripts`
table means a crawl runs nothing inside the page — no scrolling, no lazy loading — and still
produces a successful archive. The スクリプト (scripts) check in `doctor` below says so.

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H 'authorization: Bearer dev-key' http://127.0.0.1:8090/stores
# 200 means it is up. 000 means it is not → cd ../capture-ledger && pnpm run stack:up
```

`dev-key` is the development OpenFGA's default key. With the stack down, `idp:grant` below stops
with "OpenFGA (http://localhost:8090) に届きません" (OpenFGA is not reachable).

Every code block below starts with a `cd` that says which repo it runs in (this assumes both repos
are cloned side by side under the same parent directory, and you are at the root of one of them). Run a
capture-scheduler command inside capture-ledger and pnpm only says `Missing script`.

:::tip[All of it at once: one command in capture-ledger]
`pnpm run dev:up` over in capture-ledger runs the bring-up steps in order, **including the ones on this
page** (`pnpm run dev:up --dry-run` there prints the list). What it runs there are **this repo's own
commands**, and **no file of this repo's is written from over there** (the lines for capture-ledger are
fetched by its own `pnpm run connect`).

```sh
cd ../capture-ledger && pnpm run dev:up
```

This page is the capture-scheduler half of those steps, done one at a time.
:::

## Bring it up

```sh
cd ../capture-scheduler
sudo container system dns create capture-scheduler   # once per machine
./setup.sh
container-compose up -d
pnpm install

pnpm run windmill:bootstrap   # creates the workspace and a token, and writes two files (below)
pnpm run windmill:push        # upload the scripts and the flow
```

**There is nothing to paste any more.** bootstrap writes two files, both inside this repo:

| File                      | What is in it                                               |
| ------------------------- | ----------------------------------------------------------- |
| `.env.local`              | `WINDMILL_TOKEN`, read by this repo's own scripts           |
| `.dev/capture-ledger.env` | the lines for capture-ledger. **The other side reads them** |

Changing capture-ledger's settings is the job of a command you run **there**:

```sh
cd ../capture-ledger
pnpm run connect              # reads the lines above into capture-ledger's .env.local
```

These are the lines, and **each one is needed** (the table says what stops without it):

```dotenv title="capture-scheduler/.dev/capture-ledger.env"
CAPTURE_LEDGER_CRAWL_WEBHOOK_URL=http://127.0.0.1:8000/api/w/crawler/jobs/run/f/f/waggle/crawl_level
CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=<the token bootstrap created>
CAPTURE_LEDGER_API_HOST=0.0.0.0
CAPTURE_LEDGER_TS_COMPILE_URL=http://127.0.0.1:28080
```

| Line                                           | Why                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `…_CRAWL_WEBHOOK_URL`, `…_CRAWL_WEBHOOK_TOKEN` | Where crawls are sent to Windmill. Without them `/api/crawls` does not exist (`404`)                                                                                                                                                             |
| `CAPTURE_LEDGER_API_HOST=0.0.0.0`              | Level reports come from a container, and an API listening on `127.0.0.1` never receives them                                                                                                                                                     |
| `CAPTURE_LEDGER_TS_COMPILE_URL`                | Where capture-ledger, on the host, asks ts-compile-service (published on `127.0.0.1:28080`) to re-read a failed crawl's type errors and to check a proposed fix. With the Claude key set and this missing, capture-ledger's API refuses to start |

The flow identifies itself with a JWT, so the API also needs `CAPTURE_LEDGER_OIDC_ISSUER` and
`CAPTURE_LEDGER_OIDC_CLIENT_IDS`. They are not in this file: capture-ledger's `pnpm run idp:bootstrap`
(below) writes them, because the pool ID the local IdP (identity provider) gives is part of the
issuer. Without them the
API trusts dev headers, and the flow's level reports get `401`.

bootstrap creates a new token every time you run it (the earlier ones stay valid), so **run `connect`
again whenever you run bootstrap again** — the handoff file is rewritten with the new token, and
without fetching it capture-ledger keeps the old one. The old token still works, so this does not
break: it looks like "I changed it and nothing changed".

Once `connect` has run, set up the local IdP on the capture-ledger side and **restart the API**.

The production IdP is Amazon Cognito. Locally, [Floci](https://github.com/floci-io/floci), a
Cognito emulator, stands in for it. It runs in capture-ledger's stack as the compose service `idp`
(`127.0.0.1:4566`; `http://idp.capture-ledger:4566` from containers). `idp:bootstrap` creates the pool,
the app clients and your user in it. One of the app clients is `windmill`: the flow gets its tokens
with that client's ID and secret. `idp:bootstrap` writes the issuer lines above into capture-ledger's
`.env.local`, and the client's settings into a handoff file, `.dev/idp.env`, for
[Hand over the key](#hand-over-the-key) below.

**Stop the API you started in §6 of capture-ledger's quickstart (`Ctrl-C`)** and run the same
command again — this is not a second instance. The API reads its settings **once, at
startup**, so a process left running never sees the lines above. Trying to run both
fails anyway: the second one exits with
`EADDRINUSE: address already in use 0.0.0.0:7070`. **When you cannot tell what is still
running**, capture-ledger's `pnpm run dev:status` prints the pid and start time and
`pnpm run dev:down` stops it — the API is not a container, so
`container-compose down` leaves it alone.

```sh
cd ../capture-ledger
pnpm run idp:bootstrap   # the pool, app clients and your user; writes .env.local and .dev/idp.env
pnpm run api             # stop the one from §6 first, then use the same command
```

Floci keeps its pool **in memory**. When its container is recreated (by `stack:up`, for example),
the pool is gone, and the issuer, the client IDs and the secret all change. Then run
`pnpm run dev:up --from idp` in capture-ledger: it sets the IdP up again and redoes what follows it
(the API restart, the grant and the key handoff below).

The **last line** of the API's startup log says whether the lines took:

```text
Archive API listening on 0.0.0.0:7070 — identity: JWT (http://127.0.0.1:4566/us-east-1_example); crawl level reports: ready
```

With `blocked`, the warnings above it name the missing lines (from capture-ledger v0.44.0).

Windmill opens at `http://127.0.0.1:8000`.

### Hand over the key

Put what the Windmill flow gets its token with, and the address it calls, into Windmill's
variables:

```sh
cd ../capture-scheduler
pnpm run windmill:capture-ledger-token   # the flow's app client, the API address as a container sees it, and the ts-compile-service address
```

It reads capture-ledger's `.dev/idp.env` (from `../capture-ledger`; give another path as the
argument, or set `CAPTURE_LEDGER_DIR`), checks that it can get a token with the `windmill` app
client, and writes the secret variable `u/admin/ledger_client`. It stores the client, not a token.
It also deletes `u/admin/waggle_token`, the long-lived token earlier versions stored.

The API address (`u/admin/waggle_api_url`) comes from the gateway of the `default` network
(`container network inspect default`) unless `CAPTURE_LEDGER_API_URL` is set. It changes when the
network is recreated; re-run `windmill:capture-ledger-token` then. When Floci's pool is recreated,
`dev:up --from idp` re-runs it for you ([How the token gets there](#how-the-token-gets-there)).

Names a script declares as `kind: secret` in the `params` of its `catalog.json` are placed by a
person in Windmill variables `f/waggle_secrets/<name>` (how: "Secrets are Windmill variables" on
[Following links](/crawl/)). The folder `f/waggle_secrets` is created by `windmill:push`. A crawl
that uses such a script is refused by the ledger with a 400 naming the missing variable.

### Let windmill start crawls

Windmill calls capture-ledger as the app client `windmill`. A token got with client credentials
names the app client: its `sub` is the client ID Floci generated, not a name. Such a machine token
carries no organizations, so capture-ledger takes the ones where that `sub` may start crawls (here
`acme`). Each time the flow starts a crawl, reports a level, has the replay bundle written, hands over
the index, or closes a crawl, capture-ledger asks OpenFGA "may this client start crawls for acme?" and
answers 404 when it may not. Even a crawl you start by hand reports its levels as the windmill client.

```
pnpm run idp:grant      (you, once per pool)
    │ reads the client ID from .dev/idp.env, then writes
    ▼
OpenFGA   user:<windmill client ID>  submitter  organization:acme
    ▲
    │ asks: is user:<windmill client ID> can_submit on organization:acme?
    │       (on every start, level report, replay bundle, index, and close)
capture-ledger API   ◄── Windmill (a client credentials token: sub = the client ID, no groups)
    │
    └─ 202 when the tuple is there; otherwise 404 {"error":"not found"}
```

Write that permission (on the capture-ledger side; again whenever Floci's pool is recreated, since
the client ID changes with it):

```sh
cd ../capture-ledger
pnpm run idp:grant
# <client ID> は acme のクロールを始められます (書いた: user:<client ID> submitter organization:acme)
#   = "<client ID> may start crawls for acme (wrote: …)"
```

`idp:grant` also grants your own user (the one `idp:bootstrap` made), so you can start and see
crawls with `idp:token`. `fga:revoke` takes a grant back. Whether it took is what the `can_submit`
line of `doctor` below tells you; when something is missing, it prints the command to type.

## Check it: take one capture

```sh
cd ../capture-scheduler
pnpm run doctor   # runs the checks in order; all ✓ means a crawl is set up to run to the end
pnpm run smoke    # captures a capture-fixtures page once; "撮れた" (captured) once the WACZ comes back and search finds it
```

By default smoke captures a marked page of [capture-fixtures](https://github.com/uraitakahito/capture-fixtures)
in the capture-ledger stack (`http://capture-fixtures.capture-ledger:8080/marked/page/smoke?tag=<tag>`).
The tag is new on every run and the page writes it into its title and text, so searching the ledger for
the tag finds this run's archive and nothing older. Example names such as `example.com` are not used:
their answers differ by network (a router may answer `127.0.0.1`).
`dev:up` does not start capture-fixtures, so start it before smoke:

```sh
cd ../capture-ledger
pnpm run stack:up --profile capture-fixtures capture-fixtures
```

If the name was looked up before it was started, it may not resolve for about a minute after the
start (the DNS remembers the "no such name" answer).

**doctor** asks, for each heading of this page, whether that step is done — by asking the things
the step created. It goes past "is it up": whether the scripts match the repo, whether a schedule is
left in Windmill (the clock is in capture-ledger, and an old checkout's `windmill:push` can bring one
back), whether a token got with the flow's own app client may start crawls, whether the API and
BrowserHive are reachable from inside the worker. A ✗ says what to fix and which section of this
page the step lives in. Checks that depend on a ✗ do not run and only say "先に … を" (… first) — one thing to
fix means one ✗.

```
立ち上げる
  ✓ windmill            http://127.0.0.1:8000/api/version
  …
  ✗ capture-ledger api  http://127.0.0.1:7070/healthz
  ✗ idp                 変数 u/admin/ledger_client の iss の discovery (手元は capture-ledger の Floci)
  ・crawl route         先に capture-ledger api を
  ・replay-bundle route 先に capture-ledger api を
  ・jwt                 先に capture-ledger api・idp を
  ・search route        先に capture-ledger api・idp を

直すもの (2):
  capture-ledger api —— capture-ledger の API が答えない → cd ../capture-ledger && pnpm run api
    手順: https://uraitakahito.github.io/capture-scheduler/ja/quickstart/#立ち上げる
  …
```

**smoke** captures one page, and only when doctor is all ✓. It takes the production path —
asks capture-ledger's `POST /api/crawls` with a token from the flow's own app client, lets the Windmill flow capture,
waits for the level report — then fetches the archive the ledger recorded through a signed URL
and checks that it starts with `PK` (a WACZ is a zip). The ledger marks the crawl `succeeded` at the
level report, before the flow's replay bundle and index steps run, so smoke then waits for the level's
run to finish. It checks the replay bundle step's answer (written, no WACZ left uninspected) — the step
does not throw on those failures, so a green run does not prove it — and reads the `replay.json` of the
replay bundle the ledger points to through replayweb-server's `/wacz/` (`127.0.0.1:8899`, the capture-ledger
stack's replayweb-server), checking that this archive is among its `resources`. Then it checks the index step's
answer (no archive left out, at least one indexed). Last, it searches the
ledger for the tag and checks that this archive's hits are at the stages the WACZ's page list
predicts: the snapshot stages when the page list has snapshot entries, otherwise the one entry of the
document (`page`):

```
点検     doctor の … 本とも ✓
始める   POST /api/crawls → 202  crawl 545e912c-…  http://capture-fixtures.capture-ledger:8080/marked/page/smoke?tag=smokemh5k2x1fq3
待つ     running
run      http://127.0.0.1:8000/run/01a0ba19-…?workspace=crawler
終わり   succeeded (max_depth) —— 撮ったページ 1・6 秒
取り出す archive 928d640f-… の先頭が PK (WACZ = zip)
合本     r1 を書いた —— 頁 3・WACZ 1 本。replayweb-server の /wacz/org/acme/crawls/545e912c-…/r1/replay.json にこの回の archive が在る
索引     載せたアーカイブ 1 本・載らなかった 0 本・索引の件数 2
検索     「smokemh5k2x1fq3」で archive 928d640f-… の after-load・after-behaviors が当たる (ページ一覧から予想した時点と同じ)
撮れた   http://capture-fixtures.capture-ledger:8080/marked/page/smoke?tag=smokemh5k2x1fq3
```

**When it fails**, smoke names the step that failed and how to fix it (the `原因` cause and
`直す` fix lines). Fix that and run smoke again. It closes the crawl it started — on failure, on
timeout, on Ctrl-C — so the next run is never blocked by a 409. To follow it in Windmill, open the
`run` URL smoke prints ([Windmill UI: "Digging into failures"](/windmill-ui/#digging-into-failures--a-real-one)).

```sh
cd ../capture-scheduler
pnpm run smoke http://capture-fixtures.capture-ledger:8080/links/hub   # capture a different URL (search is not checked: no known word)
pnpm run smoke --timeout 300          # how long to wait (seconds, default 180)
pnpm run smoke --no-doctor            # skip the checks (re-running right after a fix)
pnpm run smoke --close-running        # on 409, close the running crawl first, then capture
```

smoke needs capture-ledger v0.43.0 or later (that is when the ledger started returning the last
level's run and why pages failed).

### From symptom to fix

Every row was produced for real and checked (2026-09-19).

| What you see                                                                                                                                         | Meaning                                                                                                            | Fix                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| doctor: スクリプト ✗ / smoke: 400 `no scripts are registered`                                                                                        | the ledger has no scripts, or none that run by default (all disabled) — a crawl that names none is refused         | in capture-ledger: `pnpm run scripts import .upstream/capture-scripts`; if all are disabled, `pnpm run scripts enable <id>` |
| doctor: windmill ✗, and the checks below say "先に windmill を"                                                                                      | Windmill is down                                                                                                   | `container-compose up -d` (in this repo)                                                                                    |
| doctor: push ✗ "repo と中身が違う"                                                                                                                   | a script was changed but not pushed (or was edited in the Windmill UI)                                             | `pnpm run windmill:push` (`windmill:diff` to just look)                                                                     |
| doctor: worker→browserhive ✗ "名前が引けない" ("3 秒で答えない" for a few seconds right after the stop) / smoke: `[cap] BrowserHive に届きません: …` | a BrowserHive container is stopped (a stopped container loses its DNS name too)                                    | `pnpm run stack:up` in capture-ledger                                                                                       |
| doctor: host→ts-compile ✗ "http://127.0.0.1:28080 に届かない"                                                                                        | ts-compile has no port on the host (the compose gained `ports:` but the container was not recreated) or it is down | run `container-compose up -d ts-compile` in this repo                                                                       |
| smoke: `failed` with 0 pages, cause `… net::ERR_NAME_NOT_RESOLVED …`                                                                                 | the URL's host does not resolve                                                                                    | check the URL; if it is right, whether BrowserHive's containers can resolve outside names                                   |
| doctor: can_submit ✗ "… の組織が無い" or "… のクロールの許可が無い" / smoke: `… /pages → 404`                                                        | the windmill app client may not start crawls                                                                       | `pnpm run idp:grant` in capture-ledger                                                                                      |
| doctor: can_submit ✗ "トークンが通らない" / smoke: `… /pages → 401`                                                                                  | Floci's pool was recreated, and the API or Windmill's variable still has the old one                               | `pnpm run dev:up --from idp` in capture-ledger                                                                              |
| doctor: jwt ✗ "ヘッダで名乗る設定で動いている" (the startup log's last line says `crawl level reports: blocked`)                                     | capture-ledger's API does not accept JWTs (`CAPTURE_LEDGER_OIDC_ISSUER` is not in effect)                          | `pnpm run dev:up --from idp` in capture-ledger (`idp:bootstrap` writes the lines, then the API restarts)                    |
| doctor: container→api ✗ "API が 127.0.0.1 で待っている" / smoke: `Unable to connect`                                                                 | level reports cannot reach the API from a container (`CAPTURE_LEDGER_API_HOST=0.0.0.0` is not in effect)           | run `pnpm run connect` in capture-ledger and restart the API                                                                |
| smoke: 409 "走行中のクロールがある: …"                                                                                                               | an earlier crawl is still `running`                                                                                | wait for it, or `pnpm run smoke --close-running`                                                                            |

## How the token gets there

```
host                                   │ container
  capture-ledger idp:bootstrap         │
      │ writes .dev/idp.env            │
      ▼                                │
  windmill:capture-ledger-token ───────┼──► secret variable u/admin/ledger_client
                                       │    (client ID, secret, token URL, scope)
                                       │            │
                                       │            ▼
                                       │    each flow step ── client credentials ──► Floci
                                       │            │ ◄── access token
                                       │            ▼
  capture-api 0.0.0.0:7070  ◄──────────┼── report_level.ts and the other steps
```

**No token is stored.** A Cognito access token lasts at most one day, so the variable holds the
`windmill` app client instead. Each step that calls capture-ledger gets a fresh token with client
credentials, an M2M (machine-to-machine) grant: `ledgerToken`, at the top of
`windmill/f/waggle/report_level.ts` and the other scripts that call capture-ledger. A machine left
running has no token to run out.

**The variable is the flow's credential.** Whoever holds the client ID and secret can act as the
flow, which is why the variable is a secret. Locally that is not a boundary: Floci's admin API lets
anything that reaches it, the containers on capture-ledger's network included, create users and get
tokens (capture-ledger's
[The dev IdP](https://uraitakahito.github.io/capture-ledger/development-environment/#the-dev-idp-floci)).

**When Floci's pool is recreated, run `pnpm run dev:up --from idp` in capture-ledger.** Floci keeps
the pool in memory, so recreating its container loses it: the issuer, the client ID and the secret
all change. Old tokens stop verifying, the variable names a client that no longer exists, and the
grant belongs to the old client ID. `dev:up --from idp` rewrites capture-ledger's `.env.local`,
restarts the API, grants the new client and re-runs `windmill:capture-ledger-token`. The error
messages in `report_level.ts` say so, because this is easy to hit and hard to guess.

## Viewing in the picker (paste a token)

With `CAPTURE_LEDGER_OIDC_ISSUER` set, capture-ledger accepts **only** JWTs. The browser picker at
`http://127.0.0.1:7070/` follows suit and shows a token field in place of the two name fields (from
capture-ledger v0.45.0). Leave the API's settings as they are and paste a token:

```sh
cd ../capture-ledger
pnpm run --silent idp:token | pbcopy   # your user from idp:bootstrap, in acme
open http://127.0.0.1:7070/
```

Paste it into the トークン (Token) field and press 読み込む (Load). When the line above the list says
you are viewing as your `sub` (the ID Floci gave your user; `idp:token` prints it) in `acme`, the API
has accepted the token. A token lasts one hour, and after Floci's pool is recreated, older tokens stop
working — when the picker says 401 — このトークンは通らない…
("this token does not get through"), get a new one with the same command and paste it. How to use
the screen is in capture-ledger's
[Browsing archives](https://uraitakahito.github.io/capture-ledger/picker/).

JWT winning over the dev header is deliberate on capture-ledger's side: when both are configured, it
must not fall back to the weaker one. **Do not comment out `CAPTURE_LEDGER_OIDC_ISSUER` for the
picker** — an API without it refuses the flow's level reports with 401, and a running crawl stays
`running` and blocks every later start with 409. How to clear it is in capture-ledger's quickstart,
["When every crawl gets 409"](https://uraitakahito.github.io/capture-ledger/quickstart/#when-every-crawl-gets-409).
