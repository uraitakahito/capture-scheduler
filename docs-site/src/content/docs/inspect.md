---
title: Inspecting what was dropped
description: Two Windmill scripts that read capture-ledger's record of which links a crawl's rules followed, captured or dropped
---

A crawl's rules sort its links one by one into followed, captured only, or dropped —
and **capture-ledger** makes that call, not the flow. So a Windmill run shows the pages
that were captured and the robots.txt skips from `plan_level`, but **not the links the
rules dropped**. capture-ledger records those for every level (`crawl_decisions`), and two
scripts in this repository read that record from inside Windmill.

Neither is part of a crawl. Run them from the Windmill UI, or its API, when you want to
know; they write nothing.

| Script                    | Arguments                                         | Answers                                                |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| `f/waggle/inspect_crawl`  | `crawl` — the crawl id, or its first 8 characters | What did this crawl's rules do?                        |
| `f/waggle/inspect_domain` | `domain`, `days` (90), `action` (`skip`)          | Which crawls dropped this domain, and with which rule? |

## inspect_crawl

Shows the crawl — seeds, depth and page caps, how it ended — and then:

- **per rule**, the distinct URLs it matched, summed over levels. A rule that matched nothing is
  marked 「当たっていない」 (not hit): a rule that never fires usually says something its author
  did not mean.
- **what was dropped**, by host name: links a rule dropped, links no rule matched (dropped too),
  and pages robots.txt kept the crawl from taking.

The first 8 characters are what the dashboard and Windmill's run pages show. The script looks
them up in the newest pages of capture-ledger's crawl list; when two crawls start with the same
characters it names both and stops rather than pick one.

## inspect_domain

`domain` is a lower-case host name and also matches the subdomains under it, at a label
boundary: `ads.example.com` finds `x.ads.example.com` but not `badads.example.com`. The table
lists, newest crawl first, which crawl, which rule (or none), and how many distinct URLs. Each
crawl appears by its first 8 characters, which `inspect_crawl` takes as they are.

`action` changes the question: `capture` lists where crawls stepped outside and captured
without following, `follow` where they followed.

## Thirty days

Windmill keeps a run's details for 30 days at most in the open-source edition. Both scripts
only read capture-ledger, whose rows last as long as the crawl does, so an expired run is
answered by running the script again.

## The shape of the result

Both return Windmill's rich display `render_all` — a Markdown heading and `table-row-object`
tables — so the run page shows tables rather than JSON. The scripts are
`windmill/f/waggle/inspect_crawl.ts` and `windmill/f/waggle/inspect_domain.ts`.
