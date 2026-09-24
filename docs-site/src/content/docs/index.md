---
title: capture-scheduler
description: Runs capture-ledger's crawls on Windmill — has BrowserHive capture them one level at a time, and starts one every day at 04:00
---

capture-scheduler runs [capture-ledger](https://uraitakahito.github.io/capture-ledger/)'s crawls
**on [Windmill](https://www.windmill.dev/)**. It has two jobs.

- **Capture** — capture-ledger hands a crawl over one level at a time, through a webhook. The flow
  groups that level's URLs by host, checks robots.txt, has BrowserHive capture them over HTTP, and
  returns what it found. Crawls it did not start run here too. **The flow in this repository is the
  only thing that calls BrowserHive** — capture-ledger no longer talks to it.
- **Start** — every day at 04:00 it asks capture-ledger for a crawl seeded from the enabled rows of
  `capture_targets` (`POST /api/crawls`) and watches it to the end.

The on-time part is **Windmill's schedule** itself; this repository holds its settings
(`daily.schedule.yaml`) and the script it starts. Most of what is here is on the capturing side.

## The boundary

|                               |                                                                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **capture-ledger decides**    | what (`capture_targets` or seed URLs), how far (depth, scope, limits), how politely (the policy values) and in which formats; it records what happened and decides whether there is another level                                  |
| **capture-scheduler decides** | when to start (the schedule) and how to carry a level out (grouping by host, capping parallelism at the number of BrowserHive endpoints, one page at a time per host with a pause after each, robots.txt, picking a free endpoint) |

So this repository contains **no URLs**. The targets and the policy values arrive from capture-ledger.

That split is worth keeping. A scheduler that also knows what to capture becomes
a second place to look when the wrong thing is captured — and the two places
disagree eventually. The exception is robots.txt: the flow drops the pages it forbids, and reports
each of them back to capture-ledger with the reason, so the ledger still has the record.

## Capturing, one level at a time

capture-ledger hands over **one level at a time** and capture-scheduler returns what it found;
whether there is another level is capture-ledger's call. See [Following links](/crawl/).

That path is where the interesting constraints are, because it is the one that
touches someone else's server repeatedly.

## Starting: the nightly crawl

The nightly job asks capture-ledger for a crawl seeded from every enabled
row of `capture_targets` (`fromTargets`), at depth 0 — the list is captured, its
links are not followed. See [Schedule](/schedule/).

There used to be a second thing, a _run_: the same set of targets, submitted all
at once. A run was a depth-0 crawl without the pacing, so it was folded into the
crawl and `POST /api/runs` is gone. The nightly capture now waits between pages
of the same host, like every other crawl.

## Where things are

| I want to…                            | Page                         |
| ------------------------------------- | ---------------------------- |
| bring the stack up for the first time | [Quickstart](/quickstart/)   |
| understand the crawl flow             | [Following links](/crawl/)   |
| change when the nightly job runs      | [Schedule](/schedule/)       |
| know what Windmill CE silently skips  | [Windmill CE](/windmill-ce/) |
| run or extend the tests               | [Testing](/testing/)         |
| push a change back to Windmill        | [Development](/development/) |
