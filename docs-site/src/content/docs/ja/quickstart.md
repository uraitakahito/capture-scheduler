---
title: クイックスタート
description: Windmill を立て、1 本撮れるまで
---

## 前提 —— capture-ledger のスタックが動いていること

Windmill は capture-ledger のスタックの 2 つを使う。OpenFGA には、下の
[windmill にクロールを許可する](#windmill-にクロールを許可する)で「windmill は acme のクロールを
始めてよい」という許可を書き込む。BrowserHive は、
クロールがページを撮りに呼ぶ。始める前に、capture-ledger の
[クイックスタート](https://uraitakahito.github.io/capture-ledger/ja/quickstart/)の §1〜§5
（DNS ドメイン、submodule と `.env`、`stack:up`、データベース、OpenFGA の 2 つの ID）を済ませ、
スタックが動いていることを確かめる。向こうの `pnpm run dev:up` は §3 以降をまとめて
やるので、手で打つのは §1 と §2 だけでもよい。

**§4 のスクリプトを忘れないこと。** BrowserHive は走らせるものの顔ぶれを持たないので、
`scripts` 表が空だと、クロールはページの中で何も走らせない —— スクロールも遅延読み込みも
起きないまま、成功したアーカイブが出る（`recordRandom` を頼んだクロールの頁には BrowserHive 自身の控えるスクリプトが
入るが、乱数を控えるだけでスクロールはしない）。下の `doctor` の**スクリプト**がそれを言う。

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H 'authorization: Bearer dev-key' http://127.0.0.1:8090/stores
# 200 なら動いている。000 なら止まっている → cd ../capture-ledger && pnpm run stack:up
```

`dev-key` は開発用の OpenFGA の既定の鍵。止まったままだと、下の `idp:grant` が
「OpenFGA (http://localhost:8090) に届きません」で止まる。

以下のコードブロックは、どれも 1 行目の `cd` で「どの repo で打つか」を示す（2 つの repo は
同じ親ディレクトリに並べて clone してあり、どちらかの根で打つ前提）。capture-scheduler の
コマンドを capture-ledger で打つと、pnpm は `Missing script` としか言わない。

:::tip[まとめてなら、capture-ledger の 1 本で済みます]
capture-ledger で `pnpm run dev:up` を打つと、**このページの手順も含めて** 立ち上げの段を順に
起こします（向こうの `pnpm run dev:up --dry-run` が段の一覧を出します）。向こうが打つのは
**この repo のコマンド**で、**ファイルはこの repo の中にしか書かれません**（capture-ledger に渡す行は、
向こうの `pnpm run connect` が取りに来ます）。

```sh
cd ../capture-ledger && pnpm run dev:up
```

このページは、そのうち capture-scheduler 側を 1 つずつ手でやる道です。
:::

## 立ち上げる

```sh
cd ../capture-scheduler
sudo container system dns create capture-scheduler   # マシンごとに 1 度だけ
./setup.sh
container-compose up -d
pnpm install

pnpm run windmill:bootstrap   # workspace と token を作り、2 枚のファイルに書く（下）
pnpm run windmill:push        # script・flow を入れる
```

**貼る行はもう出ません。**bootstrap が書くのは、この repo の中の 2 枚だけです:

| ファイル                  | 中身                                         |
| ------------------------- | -------------------------------------------- |
| `.env.local`              | `WINDMILL_TOKEN`。この repo の script が読む |
| `.dev/capture-ledger.env` | capture-ledger に渡す行。**読むのは向こう**  |

capture-ledger の設定を書き換えるのは、**向こうで打つコマンドの仕事**です:

```sh
cd ../capture-ledger
pnpm run connect              # 上の行を読み、capture-ledger の .env.local に書く
```

渡るのは次の行で、**どれも要ります**（欠けると何が止まるかは下の表）:

```dotenv title="capture-scheduler/.dev/capture-ledger.env"
CAPTURE_LEDGER_CRAWL_WEBHOOK_URL=http://127.0.0.1:8000/api/w/crawler/jobs/run/f/f/waggle/crawl_level
CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=<bootstrap が作った token>
CAPTURE_LEDGER_API_HOST=0.0.0.0
CAPTURE_LEDGER_TS_COMPILE_URL=http://127.0.0.1:28080
```

| 行                                             | なぜ要るか                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `…_CRAWL_WEBHOOK_URL`・`…_CRAWL_WEBHOOK_TOKEN` | クロールを Windmill に投げる先。無いと `/api/crawls` そのものが無い（`404`）                                                                                                                                              |
| `CAPTURE_LEDGER_API_HOST=0.0.0.0`              | 段の報告はコンテナから来る。`127.0.0.1` で待つ API には届かない                                                                                                                                                           |
| `CAPTURE_LEDGER_TS_COMPILE_URL`                | host で動く capture-ledger が、落ちたクロールの型の誤りを取り直し、直し方を検査するときに呼ぶ ts-compile-service の宛先（host の `127.0.0.1:28080`）。Claude の鍵があってこれが無いと、capture-ledger の API は起動しない |

bootstrap は打つたびに新しい token を作ります（前に作ったものも、使えるまま残ります）。
**打ち直したら `connect` も打ち直すこと** —— 引き渡しファイルは新しい token で書き換わるので、
取りに行かないと capture-ledger は古い token のままです（古いほうも生きているので、
壊れるのではなく「直したはずなのに変わらない」形になります）。

flow は JWT で名乗るので、API には `CAPTURE_LEDGER_OIDC_ISSUER` と `CAPTURE_LEDGER_OIDC_CLIENT_IDS` も
要ります。どちらも上のファイルには入りません。書くのは capture-ledger の `pnpm run idp:bootstrap`（下）です。
手元の IdP（identity provider）が付けたプールの ID が issuer に入るためです。無いと API は開発用ヘッダの
設定になり、flow の段の報告は `401` になります。

`connect` を打ったら、capture-ledger 側で手元の IdP を用意し、**API を起こし直します**。

本番の IdP は Amazon Cognito です。手元では Cognito を真似る [Floci](https://github.com/floci-io/floci) が
代わりを務めます。capture-ledger のスタックの compose のサービス `idp` で、`127.0.0.1:4566` に出ています
（コンテナからは `http://idp.capture-ledger:4566`）。`idp:bootstrap` は、そこにプール・app client・
自分の利用者を作ります。app client の 1 つが `windmill` で、flow はその ID と secret でトークンを取ります。
`idp:bootstrap` は、上の issuer の行を capture-ledger の `.env.local` に書き、client の設定を引き渡しファイル
`.dev/idp.env` に書きます。読むのは下の[鍵を渡す](#鍵を渡す)です。

**capture-ledger のクイックスタート §6 で起こした API を、`Ctrl-C` で止めてから**
同じコマンドをもう一度打ちます —— 新しく 2 本目を立てるのではありません。
API が設定を読むのは**起動のときの 1 度だけ**なので、走ったままのプロセスは
上の行を知りません。並べて立てようとしても、2 本目は
`EADDRINUSE: address already in use 0.0.0.0:7070` で落ちます。**どこに残っているか
分からなくなったら**、capture-ledger の `pnpm run dev:status` が pid と起動時刻を出し、
`pnpm run dev:down` が止めます（API はコンテナではないので、
`container-compose down` では消えません）。

```sh
cd ../capture-ledger
pnpm run idp:bootstrap   # プール・app client・自分の利用者を作り、.env.local と .dev/idp.env に書く
pnpm run api             # §6 で起こしたものを止めてから、同じコマンドでもう一度
```

Floci はプールを**メモリに**持ちます。コンテナが作り直されると（`stack:up` など）プールが消え、
issuer も client の ID も secret も替わります。そのときは capture-ledger で `pnpm run dev:up --from idp` を
打ちます。IdP を用意し直し、その後の手（API の起こし直し・許可・下の鍵の受け渡し）もやり直します。

渡した行が効いたかは、API の起動ログの**最後の行**が言います:

```text
Archive API listening on 0.0.0.0:7070 — identity: JWT (http://127.0.0.1:4566/us-east-1_example); crawl level reports: ready
```

`blocked` なら、その上の warn が足りない行を名指しします（capture-ledger v0.44.0 から）。

`http://127.0.0.1:8000` で Windmill が開く。

### 鍵を渡す

Windmill の flow がトークンを取るための設定と、呼ぶ先を、Windmill の変数に入れる:

```sh
cd ../capture-scheduler
pnpm run windmill:capture-ledger-token   # flow の app client と、コンテナから見た API の宛先と、ts-compile-service の宛先を入れる
```

capture-ledger の `.dev/idp.env` を読み（既定は `../capture-ledger`。別の場所なら引数に渡すか
`CAPTURE_LEDGER_DIR` に書く）、`windmill` の app client でトークンを取れることを確かめてから、secret の
変数 `u/admin/ledger_client` に書く。入れるのは client で、トークンではない。前の版が入れていた長く
もつトークン `u/admin/waggle_token` は消す。

API の宛先（`u/admin/waggle_api_url`）は、`CAPTURE_LEDGER_API_URL` を書かなければ default
ネットワークの gateway から組みます（`container network inspect default`）。network を作り直すと
変わるので、そのときは `windmill:capture-ledger-token` をやり直します。Floci のプールが作り直されたときは、
`dev:up --from idp` がやり直します（[トークンの経路](#トークンの経路)）。

スクリプトが `catalog.json` の `params` で `kind: secret` と宣言した名前は、人が Windmill の変数
`f/waggle_secrets/<名前>` に置く（置き方は[リンクを辿る](/crawl/)の「シークレットは Windmill の変数」）。
フォルダ `f/waggle_secrets` は `windmill:push` が作る。宣言したスクリプトを使うクロールは、変数が無ければ
capture-ledger が 400 で名指して始めない。

### windmill にクロールを許可する

Windmill は capture-ledger を app client `windmill` として呼ぶ。client credentials で取ったトークンは
app client を指し、`sub` は名前ではなく、Floci が付けた client の ID になる。この機械のトークンには
組織が載らないので、capture-ledger は、その `sub` がクロールを始めてよい組織（ここでは `acme`）を引く。
capture-ledger は、クロールを始める・段を報告する・合本を書かせる・索引を渡す・締める、のたびに
「この client は acme のクロールを始めてよいか」を OpenFGA に訊き、許可が無ければ 404 を返す。
手で始めたクロールでも、段の報告は windmill の client として来る。

```
pnpm run idp:grant      （あなたが、プールごとに 1 度）
    │ .dev/idp.env から client の ID を読み、書く
    ▼
OpenFGA   user:<windmill の client の ID>  submitter  organization:acme
    ▲
    │ 訊く: user:<windmill の client の ID> は organization:acme で can_submit か
    │      （クロールを始める・段の報告・合本・索引・締めのたび）
capture-ledger API   ◄── Windmill（client credentials のトークン。sub は client の ID、群は無い）
    │
    └─ 行が在れば 202。無ければ 404 {"error":"not found"}
```

その許可を書き込む（capture-ledger 側で。Floci のプールが作り直されたら、client の ID も替わるので、
もう一度）:

```sh
cd ../capture-ledger
pnpm run idp:grant
# <client の ID> は acme のクロールを始められます (書いた: user:<client の ID> submitter organization:acme)
```

`idp:grant` は、自分の利用者（`idp:bootstrap` が作ったもの）にも許可を与える。`idp:token` で
クロールを始めたり見たりできるのはそのため。取り消すのは `fga:revoke`。書けたかどうかは、下の
`doctor` の `can_submit` の行が教える —— 足りなければ、打つべきコマンドを出す。

## 確かめる —— 1 本撮れるまで

```sh
cd ../capture-scheduler
pnpm run doctor   # 点検を順に。全部 ✓ なら、クロールが最後まで走る設定になっている
pnpm run smoke    # capture-fixtures の頁を 1 本撮り、WACZ を取り出せて検索に当たれば「撮れた」
```

smoke が既定で撮るのは、capture-ledger のスタックにいる
[capture-fixtures](https://github.com/uraitakahito/capture-fixtures) の印付きの頁
（`http://capture-fixtures.capture-ledger:8080/marked/page/smoke?tag=<印>`）。印は撮るたびに変わり、頁は
それを題と本文に書くので、capture-ledger の検索をその印で引けば、この回の archive にだけ当たる（前の回の取り込みは
混ざらない）。`example.com` のような例示の名前は、
ネットワークによって答えが変わる（ルータが `127.0.0.1` を返すことがある）ので使わない。capture-fixtures は
`dev:up` では立ち上がらないので、smoke の前に立ち上げておく:

```sh
cd ../capture-ledger
pnpm run stack:up --profile capture-fixtures capture-fixtures
```

立ち上げる前にその名前を引いていると、立ち上げてから 1 分ほど引けないことがある（「無い」という答えを
DNS が覚えるため）。

**doctor** は、このページの見出しごとに「その手が済んでいるか」を、その手が作ったものに訊く。
立っているかだけでなく、script の中身が repo と同じか、Windmill に schedule が残っていないか（時計は
capture-ledger の中に在り、古い checkout の `windmill:push` が戻すことがある）、flow の app client で取ったトークンで
クロールを始められるか、worker の中から API と BrowserHive に届くか、まで見る。✗ は、何を
直すかと、このページのどの節の手かを言う。✗ の点検に頼る点検は走らせず、「先に〇〇を」とだけ
出す —— 直すものが 1 つなら、✗ も 1 本。

```
立ち上げる
  ✓ windmill            http://127.0.0.1:8000/api/version
  …
  ✗ capture-ledger api  http://127.0.0.1:7070/healthz
  ✗ idp                 変数 u/admin/ledger_client の iss の discovery (手元は capture-ledger の Floci)
  ・crawl route         先に capture-ledger api を
  ・replay-bundle route 先に capture-ledger api を
  ・jwt                 先に capture-ledger api・idp を
  ・search route        先に capture-ledger api・idp を

直すもの (2):
  capture-ledger api —— capture-ledger の API が答えない → cd ../capture-ledger && pnpm run api
    手順: https://uraitakahito.github.io/capture-scheduler/ja/quickstart/#立ち上げる
  …
```

**smoke** は、doctor が全部 ✓ のときだけ 1 本撮る。本番と同じ道 —— capture-ledger の
`POST /api/crawls` に flow と同じ app client で取ったトークンと、1 本ごとの鍵（`Idempotency-Key`）を付けて頼み、Windmill の flow に撮らせ、段の報告を待つ ——
を通し、capture-ledger に載った archive を署名付き URL で取り出して、先頭が `PK`（WACZ は zip）であることまで
見る。capture-ledger は段の報告の時点でクロールを succeeded にし、flow の合本の段と索引の段はその後に
走るので、smoke は段の run の終わりを待つ。合本の段の答え（書けた・検められなかった WACZ が 0 本）を
照らし —— 合本の段はそれらの失敗では投げないので、run が緑でも書けたとは限らない —— capture-ledger が指す
合本の `replay.json` を replayweb-server の `/wacz/`（`127.0.0.1:8899`。capture-ledger のスタックの replayweb-server）から
読んで、この回の archive が `resources` に在るかを見る。続けて索引の段の答え（載らなかった 0 本・
載せた 1 本以上）を照らす。最後に、印で capture-ledger の検索を引き、この回の archive の当たりの時点が、
BrowserHive WACZ（[BrowserHive WACZ Profile](https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.25.0/ja/)
に適合する WACZ）のページ一覧から予想した時点（写しの行があれば写しの時点、無ければ文書の行の 1 件 `page`）と
同じかを照らす:

```
点検     doctor の … 本とも ✓
始める   POST /api/crawls → 202  crawl 545e912c-…  http://capture-fixtures.capture-ledger:8080/marked/page/smoke?tag=smokemh5k2x1fq3
待つ     running
run      http://127.0.0.1:8000/run/01a0ba19-…?workspace=crawler
終わり   succeeded (max_depth) —— 撮ったページ 1・6 秒
取り出す archive 928d640f-… の先頭が PK (WACZ = zip)
合本     r1 を書いた —— 頁 3・WACZ 1 本。replayweb-server の /wacz/org/acme/crawls/545e912c-…/r1/replay.json にこの回の archive が在る
索引     載せたアーカイブ 1 本・載らなかった 0 本・索引の件数 2
検索     「smokemh5k2x1fq3」で archive 928d640f-… の after-load・after-behaviors が当たる (ページ一覧から予想した時点と同じ)
撮れた   http://capture-fixtures.capture-ledger:8080/marked/page/smoke?tag=smokemh5k2x1fq3
```

**撮れなかったら**、smoke が落ちた段と直し方を言う（`原因` と `直す` の 2 行）。言われた手を直して
smoke をもう一度。自分が始めたクロールは、失敗しても時間切れでも Ctrl-C でも締めるので、次の 1 本が
409 で塞がれることはない。Windmill の画面で追うなら、smoke が出す `run` の URL を開く（見方は
[Windmill UI の「失敗を掘る」](/windmill-ui/#失敗を掘る--実例-1-つ)）。

```sh
cd ../capture-scheduler
pnpm run smoke http://capture-fixtures.capture-ledger:8080/links/hub   # 撮る URL を変える（当たる語が分からないので、検索は照らさない）
pnpm run smoke --timeout 300          # 待つ上限（秒。既定 180）
pnpm run smoke --no-doctor            # 点検を飛ばす（直した直後の撮り直し）
pnpm run smoke --close-running        # 409 のとき、走っている 1 本を締めてから撮る
```

smoke は capture-ledger v0.43.0 以上を前提にする（最後の段の run と、取れなかったページの理由を
capture-ledger が返すのは、その版から）。

### 症状から引く

どれも実物で起こして確かめた見え方（2026-09-19）。

| 見えたもの                                                                                                                                      | 意味                                                                                                     | 直す                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| doctor のスクリプトが ✗ ／ smoke が 400 `no scripts are registered`                                                                             | 登録済みのスクリプトが無いか、全部が既定に入らない（無効）。何も名指さないクロールは断られる             | capture-ledger で `pnpm run scripts import .upstream/capture-scripts`。全部が無効なら `pnpm run scripts enable <id>` |
| doctor の windmill が ✗ で、下の点検が「先に windmill を」                                                                                      | Windmill が落ちている                                                                                    | `container-compose up -d`（この repo で）                                                                            |
| doctor の push が ✗「repo と中身が違う」                                                                                                        | script を直したが push していない（または Windmill の UI で直した）                                      | `pnpm run windmill:push`（違いを見るだけなら `windmill:diff`）                                                       |
| doctor の worker→browserhive が ✗「名前が引けない」（止めた直後の数秒は「3 秒で答えない」）／smoke の原因が `[cap] BrowserHive に届きません: …` | BrowserHive のコンテナが止まっている（止めたコンテナは名前ごと消える）                                   | capture-ledger で `pnpm run stack:up`                                                                                |
| doctor の host→ts-compile が ✗「http://127.0.0.1:28080 に届かない」                                                                             | ts-compile が host にポートを出していない（compose の ports を足した後に作り直していない）か、落ちている | この repo で `container-compose up -d ts-compile`                                                                    |
| smoke が `failed`・撮ったページ 0 で、原因が `… net::ERR_NAME_NOT_RESOLVED …`                                                                   | 撮る URL の名前が引けない                                                                                | URL の綴り。正しければ、BrowserHive のコンテナから外の名前を引けるか                                                 |
| doctor の can_submit が ✗「… の組織が無い」か「… のクロールの許可が無い」／smoke の原因が `… /pages → 404`                                      | windmill の app client にクロールの許可が無い                                                            | capture-ledger で `pnpm run idp:grant`                                                                               |
| doctor の can_submit が ✗「トークンが通らない」／smoke の原因が `… /pages → 401`                                                                | Floci のプールが作り直され、API か Windmill の変数が古いプールのまま                                     | capture-ledger で `pnpm run dev:up --from idp`                                                                       |
| doctor の jwt が ✗「ヘッダで名乗る設定で動いている」（起動ログの最後の行は `crawl level reports: blocked`）                                     | capture-ledger の API が JWT を受けない（`CAPTURE_LEDGER_OIDC_ISSUER` が効いていない）                   | capture-ledger で `pnpm run dev:up --from idp`（`idp:bootstrap` が行を書き、API を起こし直す）                       |
| doctor の container→api が ✗「API が 127.0.0.1 で待っている」／smoke の原因が `Unable to connect`                                               | 段の報告がコンテナから API に届かない（`CAPTURE_LEDGER_API_HOST=0.0.0.0` が効いていない）                | capture-ledger で `pnpm run connect` を打ち、API を起こし直す                                                        |
| smoke が 409「走行中のクロールがある: …」                                                                                                       | 前の 1 本が running のまま                                                                               | 終わるのを待つか `pnpm run smoke --close-running`                                                                    |

## トークンの経路

```
host                                   │ コンテナ
  capture-ledger の idp:bootstrap      │
      │ .dev/idp.env に書く            │
      ▼                                │
  windmill:capture-ledger-token ───────┼──► secret 変数 u/admin/ledger_client
                                       │    （client の ID・secret・token の URL・scope）
                                       │            │
                                       │            ▼
                                       │    flow の各段 ── client credentials ──► Floci
                                       │            │ ◄── access token
                                       │            ▼
  capture-api 0.0.0.0:7070  ◄──────────┼── report_level.ts ほかの段
```

**トークンは入れない。** Cognito の access token は最長 1 日しかもたないので、変数には `windmill` の
app client を入れる。capture-ledger を呼ぶ段は、そのたびに client credentials で新しいトークンを取る。
M2M（machine-to-machine。機械どうしの認可）の取り方で、`windmill/f/waggle/report_level.ts` ほか
capture-ledger を呼ぶスクリプトの先頭の `ledgerToken` がそれをする。動かし続けた機械でも、切れるトークンが無い。

**変数が flow の資格になる。** client の ID と secret を持つ者は flow を名乗れるので、変数は secret に
してある。手元ではそこは境界ではない —— Floci の管理の API は、届くものなら誰でも（capture-ledger の
ネットワークのコンテナも）利用者を作り、トークンを取れる（capture-ledger の
[開発用の IdP（Floci）](https://uraitakahito.github.io/capture-ledger/ja/development-environment/#開発用の-idpfloci)）。

**Floci のプールが作り直されたら、capture-ledger で `pnpm run dev:up --from idp` を打つこと。**
Floci はプールをメモリに持つので、コンテナを作り直すとプールが消え、issuer も client の ID も secret も
替わる。前のトークンは通らず、変数はもう無い client を指し、許可も前の client の ID に付いたまま。
`dev:up --from idp` が、capture-ledger の `.env.local` を書き直し、API を起こし直し、新しい client に
許可を与え、`windmill:capture-ledger-token` をやり直す。`report_level.ts` の失敗メッセージがそう書いて
あるのは、踏みやすく、かつ status だけからは辿れないため。

## picker で見る（トークンを貼る）

`CAPTURE_LEDGER_OIDC_ISSUER` を立てた capture-ledger は JWT **だけ**を受け付ける。ブラウザで開く
picker（`http://127.0.0.1:7070/`）もそれに合わせて、名乗りの 2 欄の代わりにトークンの欄を出す
（capture-ledger v0.45.0 から）。API の設定は変えずに、トークンを貼って読む:

```sh
cd ../capture-ledger
pnpm run --silent idp:token | pbcopy   # idp:bootstrap が作った自分の利用者。組織は acme
open http://127.0.0.1:7070/
```

「トークン」の欄に貼って「読み込む」を押す。一覧の上に「（自分の `sub`）（acme）として見ている」と
出れば、API はそのトークンを受けている（`sub` は Floci が利用者に付けた ID で、`idp:token` が出す）。
トークンは 1 時間で切れる。Floci のプールが作り直されたときも、前のトークンは通らない ——
「401 — このトークンは通らない…」と出たら、同じコマンドで取り直して貼る。
画面の使い方は capture-ledger の[アーカイブを見る](https://uraitakahito.github.io/capture-ledger/ja/picker/)。

JWT が dev ヘッダより優先されるのは capture-ledger 側の意図された設計で、「両方設定された
環境で弱いほうへ落ちない」ため。**picker のために `CAPTURE_LEDGER_OIDC_ISSUER` を外さないこと** ——
外した API は flow の段の報告を 401 で断り、走っていたクロールは `running` のまま残って、
以後の起動を全部 409 で塞ぐ。戻し方は capture-ledger のクイックスタートの
[「409 が続くとき」](https://uraitakahito.github.io/capture-ledger/ja/quickstart/#409-が続くとき)。
