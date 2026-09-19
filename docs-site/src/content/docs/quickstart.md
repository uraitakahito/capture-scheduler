---
title: Quickstart
description: Bring up Windmill, hand it a token for capture-ledger, and open the UI
---

## Before you start: capture-ledger's stack is running

Windmill uses two parts of capture-ledger's stack. `fga:grant` below writes a permission into its
OpenFGA ("windmill may start crawls for acme"), and crawls call its BrowserHive to take the pages.
Before you start, finish §1–§5 of capture-ledger's
[Quickstart](https://uraitakahito.github.io/capture-ledger/quickstart/) (the DNS domain, the
submodules and `.env`, `stack:up`, the database, the two OpenFGA ids) and check that the stack is up:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H 'authorization: Bearer dev-key' http://127.0.0.1:8090/stores
# 200 means it is up. 000 means it is not → cd ../capture-ledger && pnpm run stack:up
```

`dev-key` is the development OpenFGA's default key. With the stack down, `fga:grant` below stops
with "OpenFGA (http://localhost:8090) に届きません" (OpenFGA is not reachable).

## Bring it up

```sh
sudo container system dns create capture-scheduler   # once per machine
./setup.sh
container-compose up -d
pnpm install

pnpm run windmill:bootstrap   # creates the workspace and a token; paste the output in two places:
                              #   WINDMILL_TOKEN=…           → this repo's .env
                              #   the CAPTURE_LEDGER_CRAWL_WEBHOOK_URL / _TOKEN lines
                              #                              → capture-ledger's .env
pnpm run windmill:push        # upload the scripts, the flow and the schedule
pnpm run windmill:push-proto  # upload BrowserHive's proto (crawl_host reads it; push does not include it)
```

If you bootstrapped earlier, the webhook URL is
`http://127.0.0.1:8000/api/w/crawler/jobs/run/f/f/waggle/crawl_level` and the token is the same
value as `WINDMILL_TOKEN` in this repo's `.env`.

On the capture-ledger side, in another terminal. Add four lines to its `.env` first —
**miss any one and no crawl runs to the end**:

```sh
cd ../capture-ledger
# in .env:
#   CAPTURE_LEDGER_CRAWL_WEBHOOK_URL=…                the two lines bootstrap printed
#   CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=…              (without them /api/crawls does not exist)
#   CAPTURE_LEDGER_API_HOST=0.0.0.0                   level reports come from a container
#   CAPTURE_LEDGER_OIDC_ISSUER=http://127.0.0.1:9099  the flow identifies itself with a JWT
pnpm run oidc:issuer                         # keep it running
pnpm run api                                 # restart it if running (settings are read at startup)
pnpm run fga:grant submitter windmill acme   # let windmill start crawls for acme (without it: 404)
```

Back here, hand over the key and check the connection:

```sh
pnpm run windmill:capture-ledger-token   # the token, and the API address as a container sees it
pnpm run check:connection                # every line ✓ means connected
```

The API address (`u/admin/waggle_api_url`) comes from the gateway of the `default` network
(`container network inspect default`) unless `CAPTURE_LEDGER_API_URL` is set. It changes when the
network is recreated; re-run `windmill:capture-ledger-token` then. Whichever line of
`check:connection` shows ✗ names what is missing ([Testing](/testing/)).

Windmill opens at `http://127.0.0.1:8000`.

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

## The picker returns 401

Setting `CAPTURE_LEDGER_OIDC_ISSUER` makes capture-ledger accept **only** JWTs, which means the
browser picker at `http://127.0.0.1:7070/` starts returning 401.

That precedence is deliberate on capture-ledger's side: when both are configured, it
must not fall back to the weaker one. So this is not a bug to work around here.

Use one at a time. To use the picker, comment out `CAPTURE_LEDGER_OIDC_ISSUER` in
capture-ledger's `.env`. **Nothing makes both work at once** — that would mean changing
capture-ledger's identity design, which is a separate question.

**Do not switch while a crawl is running.** The flow reports each level with a Bearer token, so an
API without JWTs answers 401; that crawl stays `running` and blocks every later start with 409.
How to clear it is in capture-ledger's quickstart,
["When every crawl gets 409"](https://uraitakahito.github.io/capture-ledger/quickstart/#when-every-crawl-gets-409).
