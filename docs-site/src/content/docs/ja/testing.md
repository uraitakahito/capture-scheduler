---
title: 試験
description: 何も要らない単体と、スタック一式が要る e2e。なぜ両方要るのか
---

```sh
pnpm run test        # 単体。スタック不要、数秒
pnpm run test:e2e    # e2e。スタックが要る
pnpm run check       # push の前に走らせる検査の全部（中身は package.json の check）
```

`pretest:e2e` が先に doctor を `--e2e` 付きで走らせ、足りないものを名指しする ——
[クイックスタートの「確かめる」](/quickstart/#確かめる--1-本撮れるまで)の点検に、capture-fixtures と、走っている定期の回が
無いことと、試験が名乗る手元の IdP（identity provider）の利用者 `e2e` のクロールの許可（capture-ledger で `pnpm run idp:grant --user e2e`）を足した物。立っているかだけで
なく、クロールが最後まで走る設定かも見る —— どれかが外れていると、クロールは段の報告のところで
初めて落ち、`running` のまま残る。全文検索もその 1 つ —— capture-ledger は OpenSearch
（`CAPTURE_LEDGER_OPENSEARCH_URL`。capture-ledger の `dev:up` が書く）が無ければ起動しない。それでも API が動いたまま
OpenSearch が止まったり、索引ごと作り直されたりはするので、doctor の `search route` が flow の app client のトークンで
検索を引いて言う。vitest の外に置いてあるのは意図的 —— global setup が throw すると
vitest は必ず「No test files found, exiting with code 1」を先に出し、中に書いたどんなメッセージも
その後ろに隠れるため。

相手の宛先は環境変数で差し替えられる（`E2E_WAGGLE_URL`・`E2E_FIXTURES_URL`・
`E2E_FIXTURES_HOST_URL`・`E2E_SUBJECT`・`E2E_LEDGER_DIR`。既定は `test/e2e/helpers/stack.ts` と
`crawl-level.e2e.test.ts` の先頭）。試験はトークンを capture-ledger の
`pnpm run --silent idp:token --user e2e --org acme` で取り、capture-ledger の CLI を打つ試験も向こうで打つので、
capture-ledger の checkout が `../capture-ledger` に在る前提になる。git worktree から流すときは
`E2E_LEDGER_DIR=<capture-ledger の checkout>` を付ける（無いと `spawnSync pnpm ENOENT` で落ちる）。
doctor の点検は、同じ場所を `CAPTURE_LEDGER_DIR` から読む。

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

script が import するのは `windmill-client` で、`plan_level.ts` だけが `robots-parser` も import する。
どちらも devDependency なので、script はそのまま vitest に読み込める。IO は差し替える:
`vi.stubGlobal("fetch", …)` と `vi.mock("windmill-client", …)`。

`flow.yaml` そのものを読む単体が 1 本ある（`crawl-level-flow.test.ts`）。`crawl_host` の引数（`.script.yaml` の schema）は
全部 `input_transforms` が運び、`secret_archive` は flow の入力から来ること。見るのは形だけで、Windmill が値を届けるかは
いまも e2e の問い。`crawl-host-main.test.ts` は `windmill-client` と `fetch` を差し替えて `crawl_host` の `main` そのものを
呼び、flow から渡された物（`secret_archive`）が BrowserHive の要求まで届くかを見る。

`captureHost` を `crawl_host.ts` から export してあるのは、間隔のループを偽のエンドポイントで
回すため —— `captureHost` は BrowserHive のエンドポイント（`Endpoint`）を引数で受け、`Endpoint.capture` は
答え（`Answer`）を返すだけなので、偽物は名前（`target`）と関数 1 つを持つオブジェクトで足りる。`retry`（全 BrowserHive が busy のときの待ち幅）を引数にして
あるのは、**実タイマーの ms スケール**で書くため。fake timer は、この workspace の
別の場所で capture 系の sleep に対して試して一往復溶かしている。

## e2e は本物のクロールを始める

どの試験も、Windmill の実行のエンドポイント（HTTP の method と path の組）ではなく **capture-ledger の API** でクロールを始める —— 目的が
「capture-ledger が実際に送る引数」を運ぶことだから: `crawl_id` / `depth` / `frontier` /
`per_host_delay_ms` / `host_parallelism` / `capture_formats` / `signing` / `scripts` / `variables` /
`secrets` / `secret_archive` / `user_agent` と、受け取り先を出している配備では `artifact_sink` で、**`respect_robots` は入っていない**。

最初の試験が見ているのは 5 つ:

1. **capture-fixtures が `/links/hidden` を一度も受け取っていない**こと。robots.txt が禁じている
   ページで、判定は**相手のリクエストログ**から採る —— capture-ledger は「記録したこと」しか
   言わない。
2. クロールが成功し、1 ページ以上取り込んでいること
3. 最後の段の run が終わった後に、`GET /api/search?q=hub` がこのクロールのアーカイブに当たること。
   succeeded を待つだけでなく run の終わりを待つ —— capture-ledger は段の報告の時点でクロールを succeeded にし、
   flow の合本の段と索引の段はその後に走るので、succeeded の直後の検索は索引より先になりうる。当たりはこの
   クロールのアーカイブに絞るので、前の回に同じ頁を撮っていても、それで通りはしない
4. capture-ledger がこのクロールの合本を指していること（`GET /api/crawls/:id` の `replayBundle`）。`error` が無く、版が
   1 以上で、鍵が `org/acme/crawls/<クロール>/r<版>/replay.json`、頁の行がこのクロールのアーカイブの数以上。
   run が緑でもこれは言えない —— 合本の段は、capture-ledger が 200 で返す失敗では投げない（その失敗 1 つでクロールを
   止めないため）
5. capture-ledger が受け取り先（成果物を PUT する先）を出していれば（トークン無しの `PUT /api/sink/…` が 404 でなく
   401 を返す）、そのクロールのアーカイブの `objectKey` が全部 `org/acme/<YYYY-MM>/` の下に
   あること。平らな鍵は、受け取り先が配られず BrowserHive が自前の bucket へ書いた印 ——
   capture-ledger #226 から直るまで実際にそうなっていて、その形のクロールは上の 4 つを通る。

`plan_level.ts` の `?? true` を消して配備すると、**単体と e2e が両方赤くなり**、
e2e のほうは capture-fixtures が禁じられたページを受け取ったことを示す。この対は一度わざと
確かめてある: 片方しか赤くならないなら、もう片方は見ているつもりで見ていない。

### ページの中で走るもの

残りの多くは、クロールがページの中で走らせるスクリプトを見る。判定はやはり capture-fixtures の
リクエストログで、query を含む URL ごとに全部の要求を数えている。

- **登録済みのスクリプトは、頼んだときだけ走る。** 名指した autofetch が `/assets/hero-2x.svg` を
  取りに行く（1280px・DPR 1 のブラウザは自分では要求しない）。対照は同じページへの 2 本で、
  `scripts: []` を送っても、`scripts` を省いて capture-ledger の既定に任せても、誰も要求しない —— autofetch は
  既定に入らない（capture-scripts v0.5.0 から）。
- **型の通らないスクリプトは、compile の段でクロールごと落ちる。** 診断の件数と最初の 5 件が、
  クロールの `error` に残る。
  登録済みのスクリプト（capture-ledger の CLI で壊れたスクリプトを足して消す）と、その場の TS の両方で見る。
- **その場の TS は、頼んだ順に走る。** `/plain-html?inline=<token>&state=<document.readyState>` を
  取りに行き、ログに印を残す。遷移の前に走れば `loading`、読み込みの後なら `complete`。
- **同じその場の TS を `preload` で頼み直すと、遷移の前に走る。** 2 本とも同じ source なので、
  2 本目は ts-compile-service の cache に当たる。答えごと覚えていた cache は 1 本目の `behavior` を
  返し、印は `complete` になった。ts-compile-service v0.2.2 までがその形で、この試験はそれに対して赤い。
- **型の誤りがいくつあっても、クロールは failed で締まり、次を塞がない。** 型の誤りを数百件出す
  その場の TS で始める。`error` が件数を言い、capture-ledger の上限の 2,000 字に収まることと、続けて始めた
  1 本が通ることを見る。v0.24.2 までは診断を全部載せたので capture-ledger が断り、クロールは running のまま残った。
- **クロールごとの変数が頁に届く。** `POST /api/crawls` の `variables` で渡した値を、その場の TS が `defineParams` で
  読んで `/plain-html?var=<値>` を取りに行く。同じ値が capture-ledger の `GET /api/crawls/:id` の
  `variables` と、WACZ の `datapackage.json` の `settings.variables` に在る。
- **必須の変数を渡さなければ、始める前に断る。** `400 missing variables` で、`diagnostics` に `BH0001`。クロールの行は
  立たず、capture-fixtures に要求は届かない。宣言の形に合わない値（`.min(1)` に空の字）は `400 invalid variables`。
- **シークレットが頁に届き、記録には残らない。** 試験が `f/waggle_secrets/e2e_probe` に無作為の値を置き、その場の
  TS が `__bh.secrets.e2e_probe` の長さだけを `/plain-html?len=<長さ>` で送る。値そのものは WACZ の全 member・
  capture-ledger の答え・Windmill の run の引数のどこにも無く、`settings.secrets` に名前だけ在る。対照は、同じ値を変数で
  渡した取り込み —— そちらでは同じ探し方で WACZ に見つかる。
- **隠すシークレットは、通信に載せても WACZ に残らない**（BrowserHive v29.0.0）。その場の TS が値を
  `/echo/text?v=<値>` で送り、capture-fixtures は値を HTML で返す。値は無作為で、`%`・HTML・JSON で綴りが変わる字と、
  乱数の 12 字（16 進）を持つ。証人は要求ログで、値がサイトに届いたことを乱数の字で確かめる。WACZ の全 member に、値の
  綴りも乱数の字も無く（16 進の字はどの符号化でも残るので、綴りの一覧が見落とした形も見つかる）、capture-ledger の `archive` は
  `null`、`settings.secretArchive` は `{}`、WARC には `BrowserHive-Redacted` と `/echo/text?v=***` が在る。
- **keep と宣言したシークレットは、capture-ledger → flow → crawl_host → BrowserHive と運ばれ、WARC に値のまま残る**（上の対照）。
  同じ送り方で、宣言に `archive: "keep"` と書く。capture-ledger の `archive` は `"keep"`、crawl_host の段の run の引数に
  `secret_archive` が在り、`settings.secretArchive` に名前が在り、乱数の字が WARC に見つかる。flow が `secret_archive` を
  運び忘れると、この試験だけが赤くなる。
- **宣言した required のシークレットが Windmill に無ければ、capture-ledger が 400 で名指し、クロールの行は立たない。**
- **スクリプトの Zod が、厳しい CSP のページで動く**（`zod.e2e.test.ts`）。起点は capture-fixtures の `/csp/strict`
  （`script-src 'self'` で eval を禁じ、違反を `/csp/report` へ報告させる）。その場の TS が `z.object` を同期で定義し、
  `await` の後で `parse` して `/plain-html?zod=<印>` を取りに行く。印が届き、`/csp/report` は 0 回。
  対照は同じページで `await` の後に `new Function` を呼ぶ 1 本で、`/csp/report` が届く。対照も `await` の後なのは、
  `page.evaluate` の同期の間は CDP が eval を許し、CSP に当たらないから。
- **BrowserHive が Zod を読むスクリプトの終わりを待つ。** `await` で 1.5 秒待つスクリプトの後で、ページのログの
  `script … finished after N ms` の N が 1,500 以上。関数で包んだ JS は完了値が Promise でなくなり、数 ms で終わった形になる。
- **走った JS が記録に残る。** WACZ の `behaviors/custom.jsonl` の `source` に `// zod <版> (MIT)` が在り、`import` は無い。
- **形が合わないときは成功のまま、項目が残る。** `safeParse` と `__bh.log.error` のスクリプトで、クロールは succeeded、
  ページのログの error の行に項目の名前が在る。
- **受けない `import` の形は、compile の段でクロールごと落ちる。** `import { z as zod }` で failed、`error` に `BH0003`。

### 定期の回

時計は capture-ledger の中に在り（[定期実行](https://uraitakahito.github.io/capture-ledger/ja/schedules/)）、
この repo は渡された段を撮るだけ。だから `schedule.e2e.test.ts` は端から端を見る —— `POST /api/schedules` で予定を作り、
`POST /api/schedules/:id/run`（いま撮る）で 1 本頼むと、本物の flow を通って撮れ、クロールの行に予定の名前が残る。
同じファイルで、止める・再開する・消すと、読めない cron・短すぎる周期・同じ名前を capture-ledger が断ることも見る。

**試験の中で定期の回を待たない。** 止めるのは入口の doctor で、`--e2e` の**定期の回**が、走っている回があれば ✗ になる。
e2e が走り始めれば直近のクロールが新しいので、周回は静かな時間（既定 10 分）で待つ。

## 覆えていないもの

期限で始まる回は e2e を通らない —— 静かな時間を待つので試験にならず、待たない「いま撮る」を使っている。
周回の判定は capture-ledger の単体と `schedules-smoke` に任せている。

「いま撮る」は e2e の最中でも静かな時間を待たない。別の予定で押すと、試験と試験の間に回が始まり、次の試験が 409 になる。
