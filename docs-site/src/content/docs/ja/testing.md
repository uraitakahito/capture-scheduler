---
title: 試験
description: 何も要らない単体 61 件と、スタック一式が要る e2e 1 件。なぜ両方要るのか
---

```sh
pnpm run test        # 単体 61 件。スタック不要、数秒
pnpm run test:e2e    # e2e 1 件。スタックが要る
pnpm run check       # audit / format / env / typecheck / 単体 / CI との一致 / docs サイト
```

`pretest:e2e` が先に `scripts/check-stack.ts` を走らせ、足りないものを**全部まとめて**
名指しする。vitest の外に置いてあるのは意図的 —— global setup が throw すると vitest は
必ず「No test files found, exiting with code 1」を先に出し、中に書いたどんなメッセージも
その後ろに隠れるため。

## なぜ二層とも要るのか

この repo が実際に出した不具合は、**重ならない 2 つの層**に分かれる。

| 不具合                                                | 単体 | e2e |
| ----------------------------------------------------- | ---- | --- |
| `respect_robots` が `null` で robots が読まれなかった | ○    | ○   |
| 段の境目で間隔が 3000ms → **521ms** に潰れた          | ○    | △   |
| 本文の無い POST に `content-type` を付けて 400        | ○    | ○   |
| `hostParallelism` が camelCase で `null` になった     | ✗    | ○   |
| schema の既定値が webhook 実行では効かない            | ✗    | ○   |

下 2 つは*定義上*単体には見えない —— 引数を渡すのは `flow.yaml` であって TypeScript
ではないから。片方だけを選ぶと、穴の半分がそのまま残る。

## 単体は何も要らない

`windmill-client` は既に devDependency で、`plan_level.ts` が import するのは
`robots-parser` だけ。だから script はそのまま vitest に読み込める。IO は差し替える:
`vi.stubGlobal("fetch", …)` と `vi.mock("windmill-client", …)`。

`captureHost` を `crawl_host.ts` から export してあるのは、間隔のループを偽の client で
回すため —— `call()` は `client[method](req, cb)` を呼ぶだけなので、偽物はただの
オブジェクトで足りる。`retry`（全 BrowserHive が busy のときの待ち幅）を引数にして
あるのは、**実タイマーの ms スケール**で書くため。fake timer は、この workspace の
別の場所で capture 系の sleep に対して試して一往復溶かしている。

## e2e は本物のクロールを 1 本起こす

1 件、約 40 秒。Windmill の実行の口ではなく **capture-ledger の API** を通す —— 目的が
「capture-ledger が実際に送る引数」を運ぶことだから: `crawl_id` / `depth` / `frontier` /
`per_host_delay_ms` / `host_parallelism` / `capture_formats` / `signing` の 7 つで、
**`respect_robots` は入っていない**。

見ているのは 3 つ:

1. **capture-fixtures が `/links/hidden` を一度も受け取っていない**こと。robots.txt が禁じている
   ページで、判定は**相手のリクエストログ**から採る —— 台帳は「記録したこと」しか
   言わない。
2. クロールが成功し、1 ページ以上取り込んでいること
3. `GET /api/search?q=hub` がヒットを返すこと —— 索引の step まで flow の中で
   終わっている証拠

`plan_level.ts` の `?? true` を消して配備すると、**単体と e2e が両方赤くなり**、
e2e のほうは capture-fixtures が禁じられたページを受け取ったことを示す。この対は一度わざと
確かめてある: 片方しか赤くならないなら、もう片方は見ているつもりで見ていない。

## 日次のループは推測しない

`trigger_crawl.ts` は**日次の取り込みの成否を決めている唯一の場所**で、e2e は
そこを触らない —— あちらは自分で種を capture-ledger に投げるので、この script を通らない。
以前は覆いが 1 つも無かった —— `POLL_INTERVAL_MS` が 15 秒の定数で、しかも sleep が
最初の問い合わせより**前**に入るため、試験 1 本が 15 秒かかったから。

いまは `poll_interval_ms` を引数で受ける。`crawl_host` の busy 待ちと同じ手で、
実タイマーの ms スケールで回せる。

知っておくべき砦はこれ:

```ts
if (crawl.state !== "succeeded") throw new Error(`知らない状態「…」`);
```

これが無いと、script が知らない状態は **2 つの比較を素通りして** `succeeded` を
件数 0 で返す。**名前がずれたときの見え方がまさにこれ** —— そして実際に一度起きた:
capture-ledger の `runs.status` が `runs.state` になったとき、改名前の script を改名後の
API に当てて、ここが発火することを確かめた。走らなかった実行を緑と報告する代わりに、
原因の見当まで添えて落ちた。その後 `runs` は `crawls` に畳まれたが、砦はそのまま
移り、いまは `crawl.state` を見ている。

線の形を守っているものは他に無い —— capture-ledger 側に response schema は無く、こちらは
`as CrawlState` の素のキャスト。

## 覆えていないもの

e2e はクロールの種を URL で渡すので、**`fromTargets`**（`capture_targets` を種に
する道 —— 日次が通るのはこちら）はどこでも回っていない。capture-ledger 側のその経路は、
両側の単体試験でしか触れていない。
