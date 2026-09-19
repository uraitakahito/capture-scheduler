---
title: Schedule
description: Daily at 04:00 Asia/Tokyo, why overlap is safe, and why comments in the schedule file disappear
---

`windmill/f/waggle/daily.schedule.yaml` — **daily at 04:00 (Asia/Tokyo)**.

```yaml
script_path: f/waggle/trigger_crawl
schedule: 0 0 4 * * * # sec min hour day month weekday
timezone: Asia/Tokyo
enabled: true
```

To stop it, set `enabled: false` and run `pnpm run windmill:push`.

`trigger_crawl` posts to capture-ledger's `POST /api/crawls` with `fromTargets` — every
enabled row of `capture_targets`, at depth 0 — and then polls
`GET /api/crawls/:id` until the crawl is finished. Waiting is the point: the API
answers **202** immediately, so a job that returned there would be green even
when the capture failed. Only a throw leaves a red entry in the run history.

## Overlap is not a problem

Windmill starts the next job even if the previous one is still running. That is
fine here: capture-ledger refuses a second concurrent crawl with **409**, and
`trigger_crawl.ts` treats that as a skip and finishes green. It does not retry —
until the crawl in flight ends, every attempt gets the same answer.

So however tightly the schedule is packed, exactly one crawl is ever in flight.
The guarantee lives in capture-ledger's partial unique index, not in capture-scheduler — which is
the right place for it, because an application-side flag breaks silently the day
a second process appears.

### The nightly job and a hand-started crawl now block each other

There used to be two constraints, one per concept: a run excluded other runs, a
crawl excluded other crawls, and the two never met. Folding the run into the
crawl leaves **one** — so a crawl someone started by hand makes the 04:00 job
skip, and a nightly crawl that runs long makes a hand-started one 409.

For politeness that is the right answer: two paths pacing themselves separately
would double the rate the far end sees. The cost is that **the nightly job is
skipped more often than it used to be**, and a skip finishes green, so nothing
points at it. If 04:00 matters, keep the window clear.

## Comments in this file disappear

`wmill sync pull` rewrites `daily.schedule.yaml` from the server's state, and the
server does not store comments. Anything explaining _why_ the schedule is what it
is has to live here, on this page, not in the YAML.

That is also why `windmill/wmill.yaml` sets `includeSchedules: true`: by default
schedules are not synced at all, and **"when it runs" would be the one setting
missing from git.**
