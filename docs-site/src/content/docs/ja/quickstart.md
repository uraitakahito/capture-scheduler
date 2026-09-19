---
title: クイックスタート
description: Windmill を立て、1 本撮れるまで
---

## 前提 —— capture-ledger のスタックが動いていること

Windmill は capture-ledger のスタックの 2 つを使う。OpenFGA には、下の
[windmill にクロールを許可する](#windmill-にクロールを許可する)で「windmill は acme のクロールを
起こしてよい」という許可を書き込む。BrowserHive は、
クロールがページを撮りに呼ぶ。始める前に、capture-ledger の
[クイックスタート](https://uraitakahito.github.io/capture-ledger/ja/quickstart/)の §1〜§5
（DNS ドメイン、submodule と `.env`、`stack:up`、データベース、OpenFGA の 2 つの ID）を済ませ、
スタックが動いていることを確かめる:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H 'authorization: Bearer dev-key' http://127.0.0.1:8090/stores
# 200 なら動いている。000 なら止まっている → cd ~/projects/crawler/capture-ledger && pnpm run stack:up
```

`dev-key` は開発用の OpenFGA の既定の鍵。止まったままだと、下の `fga:grant` が
「OpenFGA (http://localhost:8090) に届きません」で止まる。

以下のコードブロックは、どれも 1 行目の `cd` で「どの repo で打つか」を示す（2 つの repo は
`~/projects/crawler/` に並べて clone してある前提。別の場所なら読み替える）。capture-scheduler の
コマンドを capture-ledger で打つと、pnpm は `Missing script` としか言わない。

## 立ち上げる

```sh
cd ~/projects/crawler/capture-scheduler
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
cd ~/projects/crawler/capture-ledger
# .env に:
#   CAPTURE_LEDGER_CRAWL_WEBHOOK_URL=…                bootstrap が出した 2 行
#   CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=…              （無いと /api/crawls そのものが無い）
#   CAPTURE_LEDGER_API_HOST=0.0.0.0                   段の報告はコンテナから来る
#   CAPTURE_LEDGER_OIDC_ISSUER=http://127.0.0.1:9099  flow は JWT で名乗る
pnpm run oidc:issuer                         # 動かし続ける
pnpm run api                                 # 動いていたら起こし直す（設定は起動時に読む）
```

`http://127.0.0.1:8000` で Windmill が開く。

### 鍵を渡す

Windmill の flow が capture-ledger を呼ぶためのトークンと、呼ぶ先を、Windmill の変数に入れる:

```sh
cd ~/projects/crawler/capture-scheduler
pnpm run windmill:capture-ledger-token   # トークンと、コンテナから見た API の宛先を入れる
```

API の宛先（`u/admin/waggle_api_url`）は、`CAPTURE_LEDGER_API_URL` を書かなければ default
ネットワークの gateway から組みます（`container network inspect default`）。network を作り直すと
変わるので、そのときは `windmill:capture-ledger-token` をやり直します。issuer を起こし直したときも
同じ（[トークンの経路](#トークンの経路)）。

### windmill にクロールを許可する

Windmill は capture-ledger を `windmill` という名前で呼ぶ（トークンの `sub`。組織は `acme`）。
capture-ledger は、クロールを起こす・段を報告する・索引を渡す・締める、のたびに
「windmill は acme のクロールを起こしてよいか」を OpenFGA に訊き、許可が無ければ 404 を返す。
手で起こしたクロールでも、段の報告は windmill の名前で来る。

```
pnpm run fga:grant submitter windmill acme      （あなたが 1 度だけ）
    │ 書く
    ▼
OpenFGA   user:windmill  submitter  organization:acme
    ▲
    │ 訊く: user:windmill は organization:acme で can_submit か
    │      （クロールを起こす・段の報告・索引・締めのたび）
capture-ledger API   ◄── Windmill（sub=windmill, orgs=[acme] のトークン）
    │
    └─ 行が在れば 202。無ければ 404 {"error":"not found"}
```

その許可を 1 行書き込む（capture-ledger 側で 1 度だけ。取り消すのは `fga:revoke`）:

```sh
cd ~/projects/crawler/capture-ledger
pnpm run fga:grant submitter windmill acme
# windmill は acme のクロールを起こせます (書いた: user:windmill submitter organization:acme)
```

`CAPTURE_LEDGER_SUBJECT` / `_ORGANIZATIONS` を変えたなら、その名前で。書けたかどうかは、下の
`doctor` の `can_submit` の行が教える —— 足りなければ、capture-ledger が実際に見た
名前で、打つべきコマンドを出す。

## 確かめる —— 1 本撮れるまで

```sh
cd ~/projects/crawler/capture-scheduler
pnpm run doctor   # 13 本の点検。全部 ✓ なら、クロールが最後まで走る設定になっている
pnpm run smoke    # https://example.com/ を 1 本撮り、WACZ を取り出せたら「撮れた」
```

**doctor** は、このページの見出しごとに「その手が済んでいるか」を、その手が作ったものに訊く。
立っているかだけでなく、script の中身が repo と同じか、proto が古くないか、Windmill が持っている
トークンでクロールを起こせるか、worker の中から API と BrowserHive に届くか、まで見る。✗ は、何を
直すかと、このページのどの節の手かを言う。✗ の点検に頼る点検は走らせず、「先に〇〇を」とだけ
出す —— 直すものが 1 つなら、✗ も 1 本。

```
立ち上げる
  ✓ windmill            http://127.0.0.1:8000/api/version
  …
  ✗ capture-ledger api  http://127.0.0.1:7070/healthz
  ✗ oidc issuer         http://127.0.0.1:9099/.well-known/openid-configuration
  ・crawl route         先に capture-ledger api を
  ・jwt                 先に capture-ledger api・oidc issuer を

直すもの (2):
  capture-ledger api —— capture-ledger の API が答えない → cd ../capture-ledger && pnpm run api
    手順: https://uraitakahito.github.io/capture-scheduler/ja/quickstart/#立ち上げる
  …
```

**smoke** は、doctor が全部 ✓ のときだけ 1 本撮る。本番と同じ道 —— capture-ledger の
`POST /api/crawls` に flow と同じトークンで頼み、Windmill の flow に撮らせ、段の報告を待つ ——
を通し、台帳に載った archive を署名付き URL で取り出して、先頭が `PK`（WACZ は zip）であることまで
見る:

```
点検     doctor の 13 本とも ✓
起こす   POST /api/crawls → 202  crawl 545e912c-…  https://example.com/
待つ     running
run      http://127.0.0.1:8000/run/01a0ba19-…?workspace=crawler
終わり   succeeded (max_depth) —— 撮ったページ 1・6 秒
取り出す archive 928d640f-… の先頭が PK (WACZ = zip)
撮れた   https://example.com/
```

**撮れなかったら**、smoke が落ちた段と直し方を言う（`原因` と `直す` の 2 行）。言われた手を直して
smoke をもう一度。自分が起こしたクロールは、失敗しても時間切れでも Ctrl-C でも締めるので、次の 1 本が
409 で塞がれることはない。Windmill の画面で追うなら、smoke が出す `run` の URL を開く（見方は
[Windmill UI の「失敗を掘る」](/windmill-ui/#失敗を掘る--実例-2-つ)）。

```sh
cd ~/projects/crawler/capture-scheduler
pnpm run smoke https://example.org/   # 撮る URL を変える
pnpm run smoke --timeout 300          # 待つ上限（秒。既定 180）
pnpm run smoke --no-doctor            # 点検を飛ばす（直した直後の撮り直し）
pnpm run smoke --close-running        # 409 のとき、走っている 1 本を締めてから撮る
```

smoke は capture-ledger v0.43.0 以上を前提にする（最後の段の run と、取れなかったページの理由を
台帳が返すのは、その版から）。

### 症状から引く

どれも実物で起こして確かめた見え方（2026-09-19）。

| 見えたもの                                                                                                                 | 意味                                                                   | 直す                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| doctor の windmill が ✗ で、下の点検が「先に windmill を」                                                                 | Windmill が落ちている                                                  | `container-compose up -d`（この repo で）                                               |
| doctor の proto が ✗「Windmill に proto が無い」／smoke の原因が `[cap] Resource not found at u/admin/browserhive_proto …` | proto を入れていない                                                   | `pnpm run windmill:push-proto`                                                          |
| doctor の proto が ✗「repo の capture.proto と違う」                                                                       | BrowserHive の版を上げて proto を取り直したが、Windmill の写しが古い   | `pnpm run windmill:push-proto`                                                          |
| doctor の push が ✗「repo と中身が違う」                                                                                   | script を直したが push していない（または Windmill の UI で直した）    | `pnpm run windmill:push`（違いを見るだけなら `windmill:diff`）                          |
| doctor の worker→browserhive が ✗「名前が引けない」／smoke の原因が `[cap] BrowserHive に届きません: …`                    | BrowserHive のコンテナが止まっている（止めたコンテナは名前ごと消える） | capture-ledger で `pnpm run stack:up`                                                   |
| smoke が `succeeded`・撮ったページ 0 で、原因が `… net::ERR_NAME_NOT_RESOLVED …`                                           | 撮る URL の名前が引けない                                              | URL の綴り。正しければ、BrowserHive のコンテナから外の名前を引けるか                    |
| doctor の can_submit が ✗「… のクロールの許可が無い」／smoke の原因が `… /pages → 404`                                     | windmill にクロールの許可が無い                                        | capture-ledger で `pnpm run fga:grant submitter windmill acme`                          |
| doctor の can_submit が ✗「トークンが通らない」／smoke の原因が `… /pages → 401`                                           | issuer を起こし直し、Windmill のトークンが古い                         | `pnpm run windmill:capture-ledger-token`                                                |
| doctor の container→api が ✗「API が 127.0.0.1 で待っている」／smoke の原因が `Unable to connect`                          | 段の報告がコンテナから API に届かない                                  | capture-ledger の `.env` に `CAPTURE_LEDGER_API_HOST=0.0.0.0` を書いて API を起こし直す |
| smoke が 409「走行中のクロールがある: …」                                                                                  | 前の 1 本が running のまま                                             | 終わるのを待つか `pnpm run smoke --close-running`                                       |

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
名乗れる —— `fga:grant` で windmill だけに与えたクロールの許可を誰でも使えることになり、
JWT にした意味が消える。

鍵を作る力は host に残し、跨がせるのは**出来上がったトークン 1 本**だけ。

**issuer を再起動したら `pnpm run windmill:capture-ledger-token` をやり直すこと。**
issuer は起動のたびに鍵をメモリ上で作り直すので（意図された挙動）、古いトークンは
401 になる。`report_level.ts` と `trigger_crawl.ts` の失敗メッセージがそう書いてあるのは、
踏みやすく、かつ status だけからは辿れないため。

API は起こし直さなくてよい。鍵の名前（kid）も一緒に替わるので、API は新しいトークンを
1 本見た時点で鍵を取り直す（capture-ledger v0.42.1 から。それより前は kid が固定で、
API が古い鍵を最長 10 分覚えたまま、新しいトークンを 401 にしていた）。issuer を起こし直した
直後の 30 秒は、新しいトークンも通らないことがある —— `doctor` の jwt がそう言う。

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
