---
title: 開発
description: git と Windmill の往復、意図的に範囲外にしていること、ライセンス
---

## 変更のしかた

Windmill の UI で触った結果は、必ず git に戻すこと。

```sh
pnpm run windmill:diff   # UI と git の差を見る (push はしない)
pnpm run windmill:pull   # UI の変更を git に取り込む
pnpm run windmill:push   # git を正として UI に反映する
```

**両方向とも削除する。** `push` はローカルに無い remote の項目を、`pull` は remote に
無いローカルのファイルを消す。同期の前にコミットし、pull の前に push すること ——
[Windmill CE](/windmill-ce/) に実例がある。

`windmill/wmill.yaml` は `includeSchedules: true` にしてある。秘密は同期しない
（`skipSecrets`）。`u/admin/waggle_token` は `scripts/capture-ledger-token.ts` が API 経由で入れる。

## スクリーンショットを撮り直す

[管理画面](/windmill-ui/) の PNG は `scripts/docs-shots.ts` の生成物。手で撮った絵は
無い。UI が変わったら（＝ `docker-compose.yml` の Windmill の pin を上げたら）撮り直す。
`check-doc-refs` が「compose の pin と `shots-manifest.json` の版が食い違っていたら落とす」
ので、忘れても CI が止める。

```sh
# 1. スタックを上げ、run 履歴を作る（下の 3 種が要る。無いと script が止まる）
./setup.sh && container-compose up -d -b   # + capture-ledger 側の API / issuer
#    - crawl_level の成功が 1 本
#    - crawl_host の失敗（browserhive_proto が無い状態で 1 本）
#    - report_level の失敗（何らかの失敗が 1 本）
# 2. 撮る（Chromium は初回だけ手で取得。puppeteer は docs 撮影専用）
./node_modules/.bin/puppeteer browsers install chrome
pnpm run docs:shots
```

`puppeteer` を消すときは `package.json` の `//devDependencies` の註も消すこと。

## どこに何があるか

| path                                           | 何か                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `windmill/f/waggle/*.ts`                       | Windmill が Bun で動かす script                                                  |
| `windmill/f/waggle/crawl_level.flow/flow.yaml` | クロール 1 段を回す flow                                                         |
| `windmill/f/waggle/daily.schedule.yaml`        | 日次のクロールが起きる時刻                                                       |
| `test/`                                        | 単体試験。**`windmill/f/` の下には置かないこと** —— `sync push` が配備してしまう |
| `scripts/*.ts`                                 | host 側の道具（bootstrap、トークン、点検）                                       |
| `.env.local`                                   | **道具が書く**（`WINDMILL_TOKEN`）。git は無視する                               |
| `.dev/capture-ledger.env`                      | capture-ledger に渡す 4 行。**読むのは向こうの `pnpm run connect`**              |

環境変数を足すのは 3 点契約で、`scripts/check-env.ts` が両方向に検査する:
`.env.example`、`scripts/env.ts` の名前の一覧、そしてリテラル文字列での読み取り。

### 設定のファイルは 2 枚ある

実行系の script は `.env` と `.env.local` を**この順で** node に渡す
（`--env-file-if-exists` を 2 つ）。**後に渡したほうが勝つ**ので、同じ名前が両方に
在れば `.env.local` の値が効く。

分けてあるのは持ち主が違うから。`.env` は人が書く値、`.env.local` は
**走らせてみないと決まらない値**（Windmill の token）。道具が人の書いた行を
並べ替えたり消したりすると、次に何が起きたのか追えなくなる。

**書くのは自分の repo だけ、跨ぐときは読むだけ。** `windmill:bootstrap` は
capture-scheduler で打つコマンドなので、capture-ledger には書きに行かない ——
渡したい 4 行は `.dev/capture-ledger.env` に置き、取りに行くのは向こうの
`pnpm run connect`。打った repo の外が変わるのは、打った人の予想に反する。

古い `.env.local` を疑うときは、**両方を作り直す**のがいちばん速い:
`pnpm run windmill:bootstrap` を打ち直し、capture-ledger で `pnpm run connect`。
どちらも何度打ってもよい（token は増えるが、古いものも使えるまま残る）。

## 範囲外

1. **失敗しても誰にも知らせない。** schedule の error handler は Windmill の Enterprise
   機能。失敗は実行履歴に赤で残るだけで、見に行くまで気づかない。
2. **本番構成は決めていない。** Apple Container は開発用。

## ライセンス

Windmill 自体は AGPLv3。社内で自分たちのために動かすぶんには制約にならないが、
Windmill を製品の一部として外部に再提供するなら、AGPLv3 に従うか商用ライセンスが要る。
