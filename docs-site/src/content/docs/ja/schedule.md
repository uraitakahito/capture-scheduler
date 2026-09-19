---
title: いつ走るか
description: 毎日 04:00 Asia/Tokyo、重なっても安全な理由、このファイルのコメントが消える理由
---

`windmill/f/waggle/daily.schedule.yaml` —— **毎日 04:00 (Asia/Tokyo)**。

```yaml
script_path: f/waggle/trigger_crawl
schedule: 0 0 4 * * * # 秒 分 時 日 月 曜
timezone: Asia/Tokyo
enabled: true
```

止めたいときは `enabled: false` にして `pnpm run windmill:push`。

`trigger_crawl` は capture-ledger の `POST /api/crawls` を `fromTargets` で叩き
（`capture_targets` の有効な行が種、深さは 0）、`GET /api/crawls/:id` を
**終わるまで**見に行く。待つことに意味がある —— API は **202** を返して即座に
戻るので、そこで終わりにすると取り込みが失敗しても job は緑になる。実行履歴に
赤を残せるのは、ここで throw したときだけ。

## 重なりは気にしなくてよい

Windmill は前の job が走っていても次を起こす。それで構わない —— capture-ledger が走行中の
2 本目を **409** で拒み、`trigger_crawl.ts` はそれを「見送り」として緑で終える。
再試行はしない —— 走っている 1 本が終わるまで、何度投げても同じ答えが返るだけ。

つまり時刻がどれだけ詰まっていても、走るのは常に 1 本。この保証は capture-scheduler ではなく
**capture-ledger の部分 unique index** が持っている。そこが正しい置き場所で、アプリ側の
フラグで守ると、プロセスが増えた日に黙って破れる。

### 日次と手で起こしたクロールは塞ぎ合う

以前は制約が概念ごとに 2 つあった —— 実行は実行だけを、クロールはクロールだけを
締め出していて、互いには当たらなかった。実行をクロールに畳んだので制約は **1 つ**に
なり、手で起こしたクロールが走っていれば 04:00 の job は見送られ、日次が長引けば
手で起こしたほうが 409 になる。

礼儀の観点ではそれが正しい —— 2 つの経路が別々に間隔を測れば、相手から見た頻度は
黙って倍になる。代償は **日次が見送られる回数が増える**こと。見送りは緑で終わるので、
何も指し示してくれない。04:00 に取りたいなら、その時間帯は空けておくこと。

## このファイルのコメントは消える

`wmill sync pull` は `daily.schedule.yaml` をサーバの状態から書き直し、サーバは
コメントを保存しない。**なぜこの時刻なのか**は YAML ではなく、このページに書くこと。

`windmill/wmill.yaml` が `includeSchedules: true` にしてあるのも同じ話。既定では
schedule は同期されず、**「いつ走るか」だけが git から漏れる**ことになる。
