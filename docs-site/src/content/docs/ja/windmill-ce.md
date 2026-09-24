---
title: Windmill CE
description: Community Edition が受け取り、保存し、表示して —— そして黙ってやらないこと
---

Windmill のいくつかの機能は **UI からは見分けが付かない形で Enterprise 限定**。
設定は受け取られ、保存され、読み戻され、正しく表示される。**強制だけが無い。**

このページの内容は、この repo が固定している版に対して全部実測したもの。

## per-key concurrency limit は何もしない

本物の実装は `windmill-queue/jobs_ee.rs` にある。OSS ビルドが積むのはスタブで、
`update_concurrency_counter` が無条件に `Ok((true, None))` を返す —— 常に許可。
設定は保存も読み取りもされる（`get_tag_and_concurrency` は動く）ので、
**UI では上限が効いて見え、ゲートだけが素通しになる**。

**だから礼儀をループの構造で表している** —— [リンクを辿る](/crawl/) を見ること。
worker groups も Enterprise 限定。

効くのは for-loop の `parallel` / `parallelism`。こちらは OSS ビルドの
`worker_flow.rs` が `v2_job_queue` の `suspend` 列で実装している。

## `stop_after_if` は while ループを止めなかった

`stop_after_if` を付けた最小の flow が、手で止めるまで **643 回回り続けた**。
他人のサーバへの負荷を抑える仕組みを、そんなことをしうるループの上には載せない。
`crawl_level` はきっちり 1 段で終わり、次があるかは capture-ledger が決める。

## schema の既定値は UI 限定

flow の入力 schema には `default: true` を書ける。それが埋まるのは
**UI からの実行だけ**。webhook や API からの実行には何も届かない。

実測 —— `crawl_level` を必須の引数だけで起こしたとき:

```
crawl_id          = '00000000-…'
depth             = 0
host_parallelism  = (渡されていない)     ← schema には default: 4
per_host_delay_ms = (渡されていない)
respect_robots    = (渡されていない)     ← schema には default: true
```

はっきり書いておくべき帰結が 2 つ。

1. **script は schema の既定値に頼ってはいけない。** `crawl_host` が設定を Windmill の
   変数から読むのはこのため —— 引数が `undefined` で届いて
   「Channel target must be a string」になった。
2. **渡されなかった引数は JSON の `null` として届く。`undefined` ではない。**
   TypeScript の既定引数が効くのは `undefined` のときだけなので、`null` は素通りする。
   `respect_robots` がこれをやった: robots.txt が一度も読まれず、禁じられたページが
   取り込まれ、**クロールは成功として終わった**。防いでいるのは `plan_level.ts` の
   `?? true` **だけ**。

## `wmill lint` は役に立つものを何も捕まえない

`wmill lint` は flow の YAML を検証する。意図的に 3 つ壊して、全部
`✅ Lint passed`:

| 壊した場所                      | 結果   |
| ------------------------------- | ------ |
| 引数名を `crawl_id` → `crawlId` | 通った |
| `path:` を存在しない script に  | 通った |
| step にでたらめな鍵を追加       | 通った |

[試験](/testing/) の代わりにはならない。

## flow test の UI は、この種のバグを隠す

Windmill の flow エディタは flow 全体・1 step・途中まで、を実行できる。書いている
最中には役に立つ。だが**守りにはならない**:

- **CLI が無い**ので CI で回せず、プログラムから検査もできない
- **UI からの実行なので schema の既定値が埋まる** —— つまり上の `respect_robots` の
  バグは、そこでは緑で、本番では壊れている
- 「ここから再実行」は Cloud / Enterprise 限定

## `sync push` も `sync pull` も削除する

- `wmill sync push` はローカルに無い remote の項目を削除する。API 経由で作った flow を実際に消した。
- `wmill sync pull` は remote に無いローカルのファイルを削除する。未コミットの script を 3 本消した。

同期の前にコミットし、pull の前に push すること。`pnpm run windmill:diff` は
`sync push --dry-run` で、何が変わるかを見せる。

## 変数には大きさの上限がある

10,000〜20,000 バイトのどこか。この repo が BrowserHive の `.proto`（16,315 バイト）を
持っていた頃（v0.22 まで）に測った —— 入らないので **resource** に置いていた。
いまはその大きさのものを置いていない。

## schedule の error handler は Enterprise 限定

日次の実行が失敗しても、実行履歴に赤が残るだけで誰にも知らせない。
[開発](/development/) の範囲外の項を見ること。
