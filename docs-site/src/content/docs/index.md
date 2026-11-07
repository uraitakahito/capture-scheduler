---
title: capture-scheduler
description: Runs capture-ledger's crawls on Windmill — has BrowserHive capture them one level at a time
---

capture-scheduler runs [capture-ledger](https://uraitakahito.github.io/capture-ledger/)'s crawls
**on [Windmill](https://www.windmill.dev/)**. capture-ledger hands a crawl over one level at a time,
through a webhook. The flow groups that level's URLs by host, checks robots.txt, has BrowserHive
capture them over HTTP, and returns what it found. **The flow in this repository is the only thing
that calls BrowserHive** — capture-ledger no longer talks to it.

When to start is capture-ledger's too: the clock for scheduled crawls runs inside its API process,
and this repository holds no schedule.

## The boundary

|                               |                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **capture-ledger decides**    | what (seed URLs), when (schedules), how far (depth, rules, limits), how politely (the policy values) and in which formats; it records what happened and decides whether there is another level    |
| **capture-scheduler decides** | how to carry a level out (grouping by host, capping parallelism at the number of BrowserHive endpoints, one page at a time per host with a pause after each, robots.txt, picking a free endpoint) |

So this repository contains **no URLs**. The URLs and the policy values arrive from capture-ledger.

That split is worth keeping. A runner that also knows what to capture becomes
a second place to look when the wrong thing is captured — and the two places
disagree eventually. The exception is robots.txt: the flow drops the pages it forbids, and reports
each of them back to capture-ledger with the reason, so the ledger still has the record.

## Capturing, one level at a time

capture-ledger hands over **one level at a time** and capture-scheduler returns what it found;
whether there is another level is capture-ledger's call. See [Following links](/crawl/).

That path is where the interesting constraints are, because it is the one that
touches someone else's server repeatedly.

## Starting: capture-ledger's clock

This repository starts nothing on its own. A schedule is a row in capture-ledger's table
`crawl_schedules`, and a tick inside its API process starts a crawl when one is due. Schedules are
made on the 新しいクロール (New crawl) view of
[capture-workbench](https://github.com/uraitakahito/capture-workbench) or with `POST /api/schedules`,
and operated from its 定期実行 (Schedules) tab. See capture-ledger's
[Schedules](https://uraitakahito.github.io/capture-ledger/schedules/).

A scheduled run reaches this repository like any other crawl: the same webhook, the same flow, the
same gap between pages of a host.

To take one capture by hand, use the 新しいクロール (New crawl) view or `pnpm run smoke`.

## Where things are

| I want to…                            | Page                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| bring the stack up for the first time | [Quickstart](/quickstart/)                                                              |
| understand the crawl flow             | [Following links](/crawl/)                                                              |
| change when crawls run                | [Schedules in capture-ledger](https://uraitakahito.github.io/capture-ledger/schedules/) |
| know what Windmill CE silently skips  | [Windmill CE](/windmill-ce/)                                                            |
| run or extend the tests               | [Testing](/testing/)                                                                    |
| push a change back to Windmill        | [Development](/development/)                                                            |
