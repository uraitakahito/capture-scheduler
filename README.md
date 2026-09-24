# capture-scheduler

Runs [capture-ledger](https://github.com/uraitakahito/capture-ledger)'s crawls on
[Windmill](https://www.windmill.dev/). capture-ledger hands each crawl over one level at a time;
a flow here groups that level's URLs by host, checks robots.txt, has
[BrowserHive](https://github.com/uraitakahito/browserhive) capture them over HTTP, and reports
back. A Windmill schedule also starts a crawl every day at 04:00 — the on-time part is Windmill's
own scheduler; this repository holds its settings and the scripts it runs.

This repository contains **no URLs**. What to capture, how far and how politely is
capture-ledger's decision; this one decides when to start and how to carry each level out.

## Documentation

Everything — bringing the stack up, how the crawl stays polite, what Windmill's
Community Edition silently does not enforce, and how the tests are split — lives
on the docs site:

- **English** — <https://uraitakahito.github.io/capture-scheduler/>
- **日本語** — <https://uraitakahito.github.io/capture-scheduler/ja/>

## Related Projects

- [capture-ledger](https://github.com/uraitakahito/capture-ledger) — decides what to capture and how far, records what came back, and decides whether a crawl has another level. It hands each level to this repository's flow and no longer talks to BrowserHive itself.
- [BrowserHive](https://github.com/uraitakahito/browserhive) — the web-capture server; the flow here is what calls it.

## License

Windmill itself is AGPLv3. Running it internally is unconstrained; redistributing
it as part of a product means complying with AGPLv3 or buying a commercial
licence.
