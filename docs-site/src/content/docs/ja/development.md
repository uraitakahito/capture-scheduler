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

`windmill/wmill.yaml` は、この repo に schedule が無くても `includeSchedules: true` のままにしてある。同期から
外すと、UI で作った schedule や前に push した schedule を `windmill:push` が消さない。古い checkout の
`windmill:push` が戻すこともあり、戻った schedule は capture-ledger の予定と別にクロールを始めるので、doctor の
`schedule` が残っていないかを見る。変数は秘密かどうかによらず同期しない
（`skipVariables: true`。`skipSecrets: true` も書いてある）。`u/admin/waggle_token` は `scripts/capture-ledger-token.ts` が API 経由で入れる。

フォルダは同期する（`skipFolders` は書いておらず、既定で同期）。`windmill/f/<名前>/folder.meta.yaml` が正で、
**手元に無いフォルダは push が消す** —— API や UI で作ったフォルダは次の push で消える（2026-11-01 に
`windmill:diff` で確かめた）。スクリプトのシークレットの置き場 `f/waggle_secrets` もその形で作ってある。中の
変数は同期しないので、push で消えも増えもしない（[リンクを辿る](/crawl/)）。新しいフォルダは、最初の push の
後にもう 1 度だけ `windmill:diff` に `~ folder` で出る —— Windmill は作るときに作成者を `owners` と `extra_perms`
に足し、手元の `owners: []` と食い違うため（`f/waggle_secrets` で実測）。次の push が手元の形を書く見込みで、
`f/waggle` は remote も `owners: []`。doctor の「push」は script の中身しか比べないので、この差で ✗ にはならない。

script の `main` の引数を変えたら、`.script.yaml`（schema）・`.script.lock`・`wmill-lock.yaml` を
`pnpm run windmill:metadata`（`wmill generate-metadata`）で作り直し、`pnpm run format` を通す（生成物は prettier の
形ではない）。生成は、内容を変えていない script も「stale」に数えて作り直すことがある —— stale の判定の hash が
yaml の整形まで含むため、format の後は常に stale になる。触っていない script の生成物まで commit に入れなくてよい。
push は stale を警告するだけで止まらない。`pnpm run windmill:cli <wmill の引数>` で、`.env` の接続先のまま
他の `wmill` のコマンド（`variable add` など）を打てる。

script や flow を消したら、`wmill-lock.yaml` のその行も手で消す（消す `wmill` の命令は無い）。消し忘れは `test/wmill-lock.test.ts` が鍵の名前を挙げて知らせる。

## スクリーンショットを撮り直す

[管理画面](/windmill-ui/) の PNG は `scripts/docs-shots.ts` の生成物。手で撮った絵は
無い。UI が変わったら（＝ `docker-compose.yml` の Windmill の pin を上げたら）撮り直す。
`check-doc-refs` が「compose の pin と `shots-manifest.json` の版が食い違っていたら落とす」
ので、忘れても CI が止める。

```sh
# 1. スタックを上げ、run 履歴を作る（下の 2 種が要る。無いと script が止まる）
./setup.sh && container-compose up -d -b   # + capture-ledger 側の API / issuer
#    - crawl_level の成功が 1 本
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
| `windmill/f/waggle_secrets/folder.meta.yaml`   | スクリプトのシークレットを置くフォルダ。中の変数は人が置き、git には入れない     |
| `test/`                                        | 単体試験。**`windmill/f/` の下には置かないこと** —— `sync push` が配備してしまう |
| `scripts/*.ts`                                 | host 側の道具（bootstrap、トークン、点検）                                       |
| `.env.local`                                   | **道具が書く**（`WINDMILL_TOKEN`）。git は無視する                               |
| `.dev/capture-ledger.env`                      | capture-ledger に渡す行。**読むのは向こうの `pnpm run connect`**                 |

環境変数を足すのは 3 点契約で、`scripts/check-env.ts` が両方向に検査する:
`.env.example`、`scripts/env.ts` の名前の一覧、そしてリテラル文字列での読み取り。

### 設定のファイルは 2 枚ある

実行系の script は（`docs:shots` を除いて）`.env` と `.env.local` を**この順で** node に渡す
（`--env-file-if-exists` を 2 つ）。**後に渡したほうが勝つ**ので、同じ名前が両方に
在れば `.env.local` の値が効く。`docs:shots` はどちらも渡さず、`WINDMILL_URL`・`WINDMILL_EMAIL`・
`WINDMILL_PASSWORD` を shell の環境から読む（無ければ開発の既定値）。

分けてあるのは持ち主が違うから。`.env` は人が書く値、`.env.local` は
**走らせてみないと決まらない値**（Windmill の token）。道具が人の書いた行を
並べ替えたり消したりすると、次に何が起きたのか追えなくなる。

**書くのは自分の repo だけ、跨ぐときは読むだけ。** `windmill:bootstrap` は
capture-scheduler で打つコマンドなので、capture-ledger には書きに行かない ——
渡したい行は `.dev/capture-ledger.env` に置き、取りに行くのは向こうの
`pnpm run connect`。打った repo の外が変わるのは、打った人の予想に反する。

古い `.env.local` を疑うときは、**両方を作り直す**のがいちばん速い:
`pnpm run windmill:bootstrap` を打ち直し、capture-ledger で `pnpm run connect`。
どちらも何度打ってもよい（token は増えるが、古いものも使えるまま残る）。

## 範囲外

1. **失敗しても誰にも知らせない。** flow の実行の失敗は実行履歴に赤で残るだけで、見に行くまで
   気づかない。定期の回の失敗は
   [capture-workbench](https://github.com/uraitakahito/capture-workbench) の全部の画面の帯にも
   出るが、どこかへ送りはしない。
2. **本番構成は決めていない。** Apple Container は開発用。

## ライセンス

Windmill 自体は AGPLv3。社内で自分たちのために動かすぶんには制約にならないが、
Windmill を製品の一部として外部に再提供するなら、AGPLv3 に従うか商用ライセンスが要る。
