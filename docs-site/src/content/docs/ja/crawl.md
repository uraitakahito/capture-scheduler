---
title: リンクを辿る
description: 1 段の流れ —— ホストで束ね、ホスト間は並列、ホスト内は逐次、間隔は完了の後
---

capture-ledger の `POST /api/crawls` が種を受け取り（URL の配列か、`capture_targets` の
有効な行を種にする `fromTargets`）、**1 段ずつ** flow に投げる。flow は
`f/waggle/crawl_level` で、1 回の実行が 1 段。

```
plan_level       ホストで束ね、robots.txt を 1 ホスト 1 回引く
  ↓
compile_scripts  目録の TypeScript を型検査して JavaScript にする（ts-compile-service）
  ↓
for-each         ホストごとに並列（parallelism = host_parallelism）
  crawl_host       1 ホスト内は逐次。完了 → 間隔 → 次
  ↓
report_level     capture-ledger に報告し、次の段があるかを受け取る
  ↓
index_level      台帳に載ったぶんを索引に載せるよう capture-ledger に頼む
```

`compile_scripts` は、この flow で唯一、スタックの外のサービスを呼ぶ段 ——
[ts-compile-service](https://github.com/uraitakahito/ts-compile-service) で、この repo の
compose の `ts-compile` として動く。1 本でも型が通らなければサービスは 422 を返し、段が投げる。
flow は `fail_crawl` へ落ち、クロールは診断を reason に載せて `failed` で終わる。型が通らない
スクリプトはページに届かない。

**繰り返すのは capture-ledger。** この flow は 1 段で終わる。Windmill の while ループに
繰り返しを持たせようとしたが、`stop_after_if` を付けた最小の flow が
**643 回まで回り続けた**。相手のサーバに負荷をかけない仕組みを、暴走しうるループの
上には載せない。上限の判定は capture-ledger 側にあり、単体試験が付いている。

## 礼儀はループの形で守る

**Windmill CE の per-key concurrency limit は使えない** —— 無言で素通しになる理由は
[Windmill CE](/windmill-ce/) に。代わりに効くのは for-loop の `parallelism` なので、
礼儀を**ループの構造として**表す:

- **ホスト間** の同時数 = for-loop の `parallelism`
- **ホスト内** は `crawl_host` が逐次に回し、**完了の後**に間隔を空ける
- **段の境目** は capture-ledger が「そのホストを最後に触り終えた時刻」を渡し、残りを待たせる

### 間隔は完了の後。投入の前ではない

細部に見えて、そうではないところ。

取り込みにかかる時間は前もって分からない —— 2 秒で終わるページも 2 分かかるページも
ある。だから投入から測った間隔は相手が感じる間隔と無関係で、前の取り込みが終わった
直後に次が届きうる。**投入側の間隔は相手のサーバに届かない。**

間隔が意味を持つのは、「前のページが終わってから、次を投げるまで」に置いたときだけ:

```ts file="windmill/f/waggle/crawl_host.ts#pacing"

```

### 3 つ目は後から足した

無いと、間隔は段の**中**では効き、段の**境目**で消える。3000ms 設定に対して、実測で
**521ms** まで詰まった。

残りを計算するのは `plan_level`。robots.txt は両方向に効く —— 相手がより長い値を
言っているなら、相手が勝つ:

```ts file="windmill/f/waggle/plan_level.ts#delay"

```

`Math.min` ではなく `Math.max`。**相手が言っている値をこちらの都合で縮めない。**
`test/plan-level.test.ts` に両側の試験があるのは、「robots があれば常に robots を採る」
実装が片側の試験を通ってしまうから。

## BrowserHive は browser 1 台に口 1 つ

BrowserHive (v9) は queue も pool も持たない。`Capture` は 1 往復で、走行中の server は
`RESOURCE_EXHAUSTED` で断る。だから空いている server を選ぶのは `crawl_host` の仕事 ——
`u/admin/browserhive_endpoints` の一覧を順に試し、busy なら次へ、届かない口はその
呼び出しの間は飛ばし、全部 busy なら 0.5〜1.5 秒待ってもう一周する。1 つも届かない
ときだけ `ServerUnavailable` を投げ、段ごと失敗させる。

帰結が 2 つ:

- **`host_parallelism` は口の数で頭打ち。** `plan_level` が
  `parallelism = max(1, min(host_parallelism, 口の数))` を返し、for-loop はそれを使う。
  browser より多くのホストを並列にしても、busy を引いて待つホストが増えるだけ。
- **再試行はこちらに移った。** BrowserHive は server 側で再試行しなくなった —— あちらで
  再試行すると、ここで測っている間隔を素通りする。一過性の失敗（`connection` /
  `timeout` / `internal`）はもう一度だけ試す。そのホストへの他のアクセスと同じ間隔を
  空けてから。書き込み先の失敗（`artifact_sink`）は試し直さない —— 壊れているのは
  保管庫で、ページを撮り直しても同じ保管庫に書くだけ。

## 設定は変数から読む

`crawl_host` と `report_level` と `index_level` は接続先を**引数では受けない**。
Windmill は schema の既定値を **UI からの実行にしか埋めない**ので、webhook で
起こすと何も届かない —— BrowserHive の宛先が undefined で
「Channel target must be a string」になった。

引数で届くのは、そのクロールについて capture-ledger が決めて**必ず送る**もの —— URL と
間隔、`capture_formats` / `signing`、そして **`scripts`**（ページの中で走らせる TypeScript）。
目録が持つのは書いたままの TS で、`sha256` はそのバイト列に打たれている。`compile_scripts` が
JS にして hash を打ち直し、BrowserHive は JS の hash を照合する。2 つの hash はその 1 段で継がれる。
`report_level` はその JS の hash を、サービスが名乗った compiler の版と受け皿の型の tag と一緒に
capture-ledger へ運ぶ（段の報告の `compiled`）。台帳はそれをクロールの TS の hash の隣に書き、
後の段が違う hash を報告すれば 409 で断る。目録が空のクロール（`scriptIds: []`）も 1 段として通る。
サービスは 200 で scripts 無しを返し、ページでは何も走らず、報告には typescript と hostTypes が付く。

`scripts` を必須にしてあるのは `capture_formats` と同じ理由。BrowserHive v11.0.0 は
走らせるものの顔ぶれを持たないので、送らなければページの中では何も走らず、**それでも
取り込みは成功してアーカイブも出る**。渡し忘れは「一度もスクロールしなかったクロール」に
なり、した側と見分けが付かない。この flow は運ぶだけで、何を・どの順で・どちらの口
（読み込み後の `behavior` か、遷移前の `preload` か）で走らせるかは capture-ledger の
目録が決める。

```sh
pnpm run windmill:capture-ledger-token   # waggle_token / waggle_api_url /
                                 # browserhive_endpoints / browserhive_tls_ca /
                                 # ts_compile_url
pnpm run windmill:push-proto     # browserhive の proto (resource)
```

`u/admin/ts_compile_url` は `compile_scripts` が目録を送る宛先（既定は
`http://ts-compile.capture-scheduler:8080`、この repo の compose の `ts-compile`。
`TS_COMPILE_URL` で変えられる）。`pnpm run doctor` が worker からその `/healthz` に届くかを見る。

`u/admin/browserhive_tls_ca` は browserhive への gRPC を TLS にするときの CA 証明書
（PEM）で、**空文字は「平文」**。空でも変数そのものは必ず作る —— 変数を作らない形に
すると `getVariable` が落ち、script 側で「読めなかった」を「TLS は要らない」と扱った
瞬間、読み取りの失敗が黙って平文に落ちる経路になる。「システムの root で TLS」は
用意していない。browserhive の TLS は私設 CA を前提にしたもので、公開の証明書が要る
というのは server が公開インターネット上に在るという意味になるが、そうではない。
開発のスタックは平文。

proto が **resource** で変数でないのは、変数の上限（10,000〜20,000 バイトの間）を
16,315 バイトの proto が超えるため。`pnpm run proto:check` が capture-ledger の写しとの差分を
見る —— 手で写した契約は黙って腐るので、番人を置く。
