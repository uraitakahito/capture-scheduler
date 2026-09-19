---
title: クイックスタート
description: Windmill を立て、capture-ledger 用のトークンを渡し、UI を開くまで
---

## 前提 —— capture-ledger のスタックが動いていること

Windmill が働く相手は capture-ledger のスタック。付与は OpenFGA に書き、クロールは
BrowserHive を呼ぶ。始める前に、capture-ledger の
[クイックスタート](https://uraitakahito.github.io/capture-ledger/ja/quickstart/)の §1〜§5
（DNS ドメイン、submodule と `.env`、`stack:up`、データベース、OpenFGA の 2 つの ID）を済ませ、
スタックが動いていることを確かめる:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H 'authorization: Bearer dev-key' http://127.0.0.1:8090/stores
# 200 なら動いている。000 なら止まっている → cd ../capture-ledger && pnpm run stack:up
```

`dev-key` は開発用の OpenFGA の既定の鍵。止まったままだと、下の `fga:grant` が
「OpenFGA (http://localhost:8090) に届きません」で止まる。

## 立ち上げる

```sh
sudo container system dns create capture-scheduler   # マシンごとに 1 度だけ
./setup.sh
container-compose up -d
pnpm install

pnpm run windmill:bootstrap   # workspace と token を作る。出力は 2 か所に貼る:
                              #   WINDMILL_TOKEN=…          → この repo の .env
                              #   CAPTURE_LEDGER_CRAWL_WEBHOOK_URL / _TOKEN の 2 行
                              #                             → capture-ledger の .env
pnpm run windmill:push        # script・flow・schedule を入れる
pnpm run windmill:push-proto  # BrowserHive の proto を入れる（crawl_host が読む。push には含まれない）
```

bootstrap を以前に済ませてあるなら、webhook の URL は
`http://127.0.0.1:8000/api/w/crawler/jobs/run/f/f/waggle/crawl_level`、token はこの repo の
`.env` の `WINDMILL_TOKEN` と同じ値です。

capture-ledger 側（別のターミナル）。`.env` に 4 行を足してから起こします ——
**どれが欠けても、クロールは最後まで走りません**:

```sh
cd ../capture-ledger
# .env に:
#   CAPTURE_LEDGER_CRAWL_WEBHOOK_URL=…                bootstrap が出した 2 行
#   CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=…              （無いと /api/crawls そのものが無い）
#   CAPTURE_LEDGER_API_HOST=0.0.0.0                   段の報告はコンテナから来る
#   CAPTURE_LEDGER_OIDC_ISSUER=http://127.0.0.1:9099  flow は JWT で名乗る
pnpm run oidc:issuer                         # 動かし続ける
pnpm run api                                 # 動いていたら起こし直す（設定は起動時に読む）
pnpm run fga:grant submitter windmill acme   # これが無いと 404
```

戻ってきて、鍵を渡し、つながったかを見る:

```sh
pnpm run windmill:capture-ledger-token   # トークンと、コンテナから見た API の宛先を入れる
pnpm run check:connection                # 全部 ✓ なら、つながっている
```

API の宛先（`u/admin/waggle_api_url`）は、`CAPTURE_LEDGER_API_URL` を書かなければ default
ネットワークの gateway から組みます（`container network inspect default`）。network を作り直すと
変わるので、そのときは `windmill:capture-ledger-token` をやり直します。`check:connection` の
何が ✗ かで、足りないものが分かります（[試験](/testing/)）。

`http://127.0.0.1:8000` で Windmill が開く。

## トークンの経路

```
host                                   │ コンテナ
  dev issuer 127.0.0.1:9099            │
      │ POST /token                    │
      ▼                                │
  windmill:capture-ledger-token ───────────────┼──► secret 変数 u/admin/waggle_token
                                       │            │
  capture-api 0.0.0.0:7070  ◄───────────┼── trigger_crawl.ts
```

**dev issuer は loopback から出さないこと。** あれは頼まれれば誰の名前でもトークンを
出すので、コンテナから引ける場所に置いた瞬間、ブリッジに届く誰もが `windmill` を
名乗れる —— `submitter` の付与を回り込めることになり、JWT にした意味が消える。

鍵を作る力は host に残し、跨がせるのは**出来上がったトークン 1 本**だけ。

**issuer を再起動したら `pnpm run windmill:capture-ledger-token` をやり直すこと。**
issuer は起動のたびに鍵をメモリ上で作り直すので（意図された挙動）、古いトークンは
401 になる。`report_level.ts` と `trigger_crawl.ts` の失敗メッセージがそう書いてあるのは、
踏みやすく、かつ status だけからは辿れないため。

## picker が 401 になる

`CAPTURE_LEDGER_OIDC_ISSUER` を立てると、capture-ledger は JWT **だけ**を受け付けるようになり、
ブラウザで開く picker（`http://127.0.0.1:7070/`）が 401 になる。

JWT が dev ヘッダより優先されるのは capture-ledger 側の意図された設計で、「両方設定された
環境で弱いほうへ落ちない」ため。こちらで回避するものではない。

使い分けること。picker を触るときは capture-ledger の `.env` の `CAPTURE_LEDGER_OIDC_ISSUER` を
コメントアウトする。**両立させる仕組みは作っていない** —— それは identity の設計を
変える話で、別件。

**クロールが走っている間は切り替えないこと。** flow の段の報告は Bearer で来るので、JWT を
外した API では 401 になり、そのクロールは `running` のまま残って、以後の起動を全部 409 で塞ぐ。
戻し方は capture-ledger のクイックスタートの
[「409 が続くとき」](https://uraitakahito.github.io/capture-ledger/ja/quickstart/#409-が続くとき)。
