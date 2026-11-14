---
title: リンクを辿る
description: 1 段の流れ —— ホストで束ね、ホスト間は並列、ホスト内は逐次、間隔は完了の後
---

capture-ledger の `POST /api/crawls` が起点の URL を受け取り（定期の回は、予定に固定した撮り方から始まる）、
**1 段ずつ** flow に投げる。
flow は `f/waggle/crawl_level` で、1 回の実行が 1 段。

```
plan_level           ホストで束ね、robots.txt を 1 ホスト 1 回引く
  ↓
compile_scripts      TypeScript のスクリプトを型検査して JavaScript にする（ts-compile-service）
  ↓
for-each             ホストごとに並列（parallelism = host_parallelism）
  crawl_host           1 ホスト内は逐次。完了 → 間隔 → 次
  ↓
report_level         capture-ledger に報告し、次の段があるかを受け取る
  ↓
replay_bundle_level  クロールの合本（replayweb-server と capture-player が 1 つのアーカイブとして開く）を書き直すよう capture-ledger に頼む
  ↓
index_level          記録に載ったぶんを索引に載せるよう capture-ledger に頼む
```

`compile_scripts` は、この flow で唯一、スタックの外のサービスを呼ぶ段 ——
[ts-compile-service](https://github.com/uraitakahito/ts-compile-service) で、この repo の
compose の `ts-compile` として動く。1 本でも型が通らなければサービスは 422 を返し、段が投げる。
flow は `fail_crawl` へ落ち、クロールは診断の件数と最初の 5 件を reason に載せて `failed` で終わる。
reason は capture-ledger の上限の 2,000 字に切る。超えると capture-ledger が報告を断り、クロールは running のまま残って、
後のクロールを全部塞ぐ。型が通らないスクリプトはページに届かない。

## 段の鍵

capture-ledger は段ごとに **段の鍵**（Windmill の job の id）を決め、webhook の `?job_id=` と flow の引数 `level_key` で
渡す（CAPTURE-180）。flow は鍵をそのまま返す。

- **`report_level`** は段の報告の `Idempotency-Key` に付ける。capture-ledger は同じ段の 2 回目に最初の答えを返し、数も
  次の段も重ねない。だから report の段は **30 秒の間隔で 5 回再試行する**（計 2 分半）。応答が切れた・capture-ledger が
  起こし直していた、で段ごと落とすと、撮った段がまるごと `failed` で締まる。capture-ledger が報告を処理している間（期限 2 分）
  の 409 も投げて、ここで待つ。期限は再試行より短いので、途中で capture-ledger が落ちた報告も取り直せる。
- **`fail_crawl`**（failure_module）は落ちた段の `depth` と `levelKey` を送る。capture-ledger は一番新しい段の鍵のときだけ
  締め、ほかは `{"closed": false}`。報告の後の合本・索引の段で落ちた flow や、手で流し直した古い段の flow が、次の段を
  撮っているクロールを締めない。5xx と繋がらないときは、この段の中で 5 秒空けて 3 回まで試す（failure_module の
  `retry` が効くかは確かめていないので頼らない）。
- 同じ段の報告が 2 回届くのは、報告の再試行のほか、同じ引数で flow を手で流し直したときと、worker が止まった後に
  Windmill が job を自動でやり直したとき。Windmill の「この段からやり直す」（`jobs/restart`）は Community Edition
  では使えない（enterprise version だけ。2026-11-12 に確かめた）。

`level_key` を運ばない古い flow から報告すると、capture-ledger（段の鍵を求める版）は 400 で断る。flow と capture-ledger は
揃えて上げる。

`replay_bundle_level` も報告の後に走る。段の深さ（`depth`）を capture-ledger の `POST /api/crawls/:id/replay-bundle`
に送ると、capture-ledger がクロールの**合本**を新しい版として保管庫の `org/<組織>/crawls/<クロール>/r<版>/` に書く
—— そのクロールのそれまでの WACZ を全部並べた `replay.json` と、その頁の行の `pages.json` の組。replayweb-server と
capture-player は `replay.json` を 1 つのアーカイブとして開くので、ある WACZ の頁から別の WACZ の頁へリンクで行ける。どの WACZ を
入れるかと版の番号は capture-ledger が決め、`depth` は記録されるだけ。`index_level` より前に置くのは、合本が
OpenSearch に頼らないから —— 索引の段が落ちても合本は書かれる。

合本は撮った物から作る派生物で、作り直せる（capture-ledger の `pnpm run replay-bundle:rebuild --crawl <id>`）。
だから**この段は、capture-ledger が 200 で答えたものでは投げない** —— 保管庫に書けなかった（`error`）、検められなかった
WACZ がある（`failed` が 1 以上。次の合本が拾い直す）、入れる WACZ がまだ無い（`rev: null`）。1 行のログに書いて
返す。投げると索引の段が飛び、`fail_crawl` がクロールを `failed` で締める（次の段が既に走っていれば、capture-ledger は
一番新しい段の失敗ではないので締めない。下の「段の鍵」）。投げるのは、
capture-ledger が 200 で答えなかったとき（400 は本文の形、401 はトークン、404 はクロールが無いか、トークンの `sub` にクロールの
許可が無いか、capture-ledger が古くエンドポイントが無い、5xx）と、答えの形が違うときだけ。

`index_level` は報告の後に走るので、そのとき capture-ledger はもうクロールを締めている（または
次の段を始めている）。全文検索は capture-ledger の必須の部品なので、この段は何も飛ばさない —— capture-ledger が 404
（クロールが無いか、トークンの `sub` にクロールの許可が無い）・503（OpenSearch が答えない）・`failed` が 1 以上の
202（索引に載らなかったアーカイブがある）を返せば投げる。最後の段なら、クロールは `succeeded` のまま、
Windmill の run だけが赤くなる —— `pnpm run smoke` は run の終わりを待って、それを言う。

同じ `ts-compile` を、compose は host の `127.0.0.1:28080` にも出している。host で動く capture-ledger が、
型で落ちたクロールの誤りを行と列で取り直すときと、直し方を確かめるときに呼ぶ（host の node はコンテナの
subnet に届かないので、loopback に出す）。この宛先は、bootstrap がほかの行と一緒に capture-ledger へ渡す
（`.dev/capture-ledger.env` の `CAPTURE_LEDGER_TS_COMPILE_URL`。capture-ledger の `pnpm run connect` が写す）ので、
手で書く物はない。flow の側は今までどおり、名前（`u/admin/ts_compile_url`）で呼ぶ。

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

## BrowserHive は browser 1 台にエンドポイント 1 つ

BrowserHive は queue も pool も持たない。`POST /captures` は 1 往復で、走行中の server は
`429 Busy` で断る。だから空いている server を選ぶのは `crawl_host` の仕事 ——
`u/admin/browserhive_endpoints` の一覧を順に試し、busy なら次へ、届かないエンドポイント（BrowserHive の宛先 URL）はその
呼び出しの間は飛ばし、全部 busy なら 0.5〜1.5 秒待ってもう一周する。1 つも届かなければ
`ServerUnavailable` を投げる。

**段ごと落とすのは、ホストの 1 件目で届かないときだけ。** flow の `crawl_host` の段は、投げると
30 秒空けて 2 回まで再試行し（初回と合わせて計 3 回）、再試行はホストを 1 件目から撮り直す。撮った後に
投げると、相手に同じページの 2 回目が届き、前の成果物は保管庫に残るのに報告に入らない。だから 2 件目より
後で届かなくなったら、撮れた結果を返し、残りのページを「BrowserHive に届かない (撮り直さない)」の failed に
する。届かないままなら、次の段の 1 件目が段ごと落とす。再試行は、引数が欠けたときや、変数・
シークレット・エンドポイントの一覧を読めずに投げたときにも効く（どれも撮る前に投げる）。

**届かない、は要求が届かなかったとは限らない。** 繋がった後、答えの前に切れても届かないと数え、次の
エンドポイントで同じページを撮り直す。先のエンドポイントが撮り終えていれば、相手には 2 回目が届く
（deadline に当たったときは次へ回さない）。

帰結が 2 つ:

- **`host_parallelism` はエンドポイントの数で頭打ち。** `plan_level` が
  `parallelism = max(1, min(host_parallelism, エンドポイントの数))` を返し、for-loop はそれを使う。
  browser より多くのホストを並列にしても、busy を引いて待つホストが増えるだけ。
- **再試行はこちらに移った。** BrowserHive は server 側で再試行しなくなった —— あちらで
  再試行すると、ここで測っている間隔を素通りする。一過性の失敗（`connection` /
  `timeout` / `internal`）はもう一度だけ試す。そのホストへの他のアクセスと同じ間隔を
  空けてから。書き込み先の失敗（`artifact_sink`）は試し直さない —— 壊れているのは
  保管庫で、ページを撮り直しても同じ保管庫に書くだけ。
  方針を守れなかった失敗（`policy`。BrowserHive v18.0.0 から）も試し直さない ——
  `deny` に当たる WebSocket を開いた頁は、撮り直しても同じ WebSocket を開き、handshake は止められない。
  主の頁の renderer の crash（`renderer_crashed`。BrowserHive v28.0.0 から）も試し直さない ——
  多くはメモリ切れで、同じ頁は同じ所で落ちる。別サイトの iframe だけが落ちたときは失敗ではなく、
  取り込みは `success` で答え、アーカイブが `completeness.crashedTargets` で言う。

## 設定は変数から読む

`crawl_host` と `report_level` と `replay_bundle_level` と `index_level` は接続先を**引数では受けない**。
Windmill は schema の既定値を **UI からの実行にしか埋めない**ので、webhook で
起こすと何も届かない —— BrowserHive の宛先が undefined で
「Channel target must be a string」になった。

引数で届くのは、そのクロールについて capture-ledger が決めて**必ず送る**もの —— URL と
間隔、`capture_formats` / `signing`、**`scripts`**（ページの中で走らせる TypeScript）、そして
**`variables` / `secrets` / `secret_archive`**（クロールごとの値。[下の節](#クロールごとの値--変数とシークレット)）、
**`record_random`**（頁の JS が受け取った乱数を BrowserHive が控えるか。[クロールごとの乱数の控え](#クロールごとの乱数の控え)）。
capture-ledger が持つのは書いたままの TS で、`sha256` はそのバイト列に打たれている。`compile_scripts` が
JS にして hash を打ち直し、BrowserHive は JS の hash を照合する。2 つの hash はその 1 段で継がれる。
`report_level` はその JS の hash を、サービスが名乗った compiler の版と受け皿の型の tag と一緒に
capture-ledger へ運ぶ（段の報告の `compiled`）。capture-ledger はそれをクロールの TS の hash の隣に書き、
後の段が違う hash を報告すれば 409 で断る。スクリプトが空のクロール（`scripts: []`）も 1 段として通る。
サービスは 200 で scripts 無しを返し、ページでは何も走らず、報告には typescript と hostTypes が付く。
その場で書いた TS（`scripts` の `inline` の要素）も同じ道を通る。capture-ledger がクロールに
`inline-<name>` で固定し、flow は登録済みのスクリプトと同じく変換して差し込む。

`scripts` を必須にしてあるのは `capture_formats` と同じ理由。BrowserHive v11.0.0 は
走らせるものの顔ぶれを持たないので、送らなければページの中では何も走らず、**それでも
取り込みは成功してアーカイブも出る**。この flow が足しうるのは BrowserHive 自身のスクリプトだけで、`record_random` を
頼むと、BrowserHive は控えるスクリプトを頁の JS より先に頁へ入れる（頁が受け取る値は変えない）。渡し忘れは「一度もスクロールしなかったクロール」に
なり、した側と見分けが付かない。この flow は運ぶだけで、何を・どの順で・どちらの phase
（読み込み後の `behavior` か、遷移前の `preload` か）で走らせるかは capture-ledger が
決める。

```sh
pnpm run windmill:capture-ledger-token   # ledger_client / waggle_api_url /
                                 # browserhive_endpoints / browserhive_tls_ca /
                                 # ts_compile_url
```

`u/admin/ts_compile_url` は `compile_scripts` がスクリプトを送る宛先（既定は
`http://ts-compile.capture-scheduler:8080`、この repo の compose の `ts-compile`。
`TS_COMPILE_URL` で変えられる）。`pnpm run doctor` が worker からその `/healthz` に届くかを見る。

`u/admin/browserhive_tls_ca` は browserhive のエンドポイントが `https://` のときの CA 証明書
（PEM）で、**空文字は「平文」**。空でも変数そのものは必ず作る —— 変数を作らない形に
すると `getVariable` が落ち、script 側で「読めなかった」を「TLS は要らない」と扱った
瞬間、読み取りの失敗が黙って平文に落ちる経路になる。「システムの root で TLS」は
用意していない。browserhive の TLS は私設 CA を前提にしたもので、公開の証明書が要る
というのは server が公開インターネット上に在るという意味になるが、そうではない。
開発のスタックは平文。

BrowserHive から写しているものは他に無い。`crawl_host` は BrowserHive の HTTP API
（v12 からの `POST /captures`、本文は JSON）を `fetch` で話すので、同期し続ける契約の
ファイルが無い —— v0.22 までは BrowserHive の gRPC の `.proto` の写しを Windmill の resource に
置き、腐りを捕まえる番人を付けていた。だからエンドポイントは `http(s)://` の URL で、`crawl_host` は
古い `host:port` の形を変数の名前を挙げて断る。

## クロールごとの User-Agent

クロールごとに `User-Agent` を頼める（capture-ledger の `POST /api/crawls` の `userAgent`）。capture-ledger は
`user_agent` として必ず送り、頼まれていなければ空の字になる。**flow は運ぶだけで解かない** —— `crawl_host` は字を
BrowserHive へ渡し、`{chrome}` を browser の字から Headless を外した物にするのは BrowserHive で、空なら鍵ごと送らない。
入力が届かないと `crawl_host` は投げる。黙って browser の字のまま撮っても、クロールは成功に見えるため。`plan_level` は
robots.txt の規則を照らすのに使う: 字に `BrowserHive` があればその名前で（その組が先で、無ければ `*`）、無ければ
`*` で照らす。robots.txt を取りに行く要求は変わらない。

## クロールごとの乱数の控え

クロールごとに、頁の JS が `Math.random`・`crypto.getRandomValues`・`crypto.randomUUID` から受け取った値を BrowserHive に
控えさせられる（BrowserHive v31.1.0 の `recordRandom`）。capture-ledger は `record_random` として必ず送り、頼まれていなければ
`false` になる。**flow は運ぶだけ** —— `crawl_host` は真なら要求に `recordRandom: true` を載せ、偽なら鍵ごと送らない
（v31.1.0 より前の BrowserHive は知らない欄を 400 で断る）。入力が真偽でなければ（`null` を含む）`crawl_host` は投げる。
黙って控えずに撮っても、クロールは成功に見えるため。頼めば BrowserHive は値を BrowserHive WACZ の `random/values.jsonl` に
控え、`datapackage.json` の `browserhive:capture.random` に要約を書く（`recorded: true`）。頼まなければ `recorded` は `false`
で `skipped: "not-requested"`、`random/` は無い（[BrowserHive WACZ Profile 1.26.0](https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.26.0/ja/#random)）。
`captureFormats.wacz` の無い要求で `recordRandom` を頼むと、BrowserHive は 400 で断る（控えの行き先は WACZ だけ）。

## クロールごとの値 —— 変数とシークレット

スクリプトは、クロールごとに違う値を 2 つの経路で受け取る。変数はスクリプトが
[capture-scripts](https://github.com/uraitakahito/capture-scripts) の `defineParams`（v0.11.0 から）で宣言して読み、
シークレットは `catalog.json` の `params` で宣言して BrowserHive の受け皿 `__bh.secrets` で読む。頁に届くのは
どちらも受け皿で、`defineParams` は JS で `__bh.vars` に置き換わる。
**flow はどちらも運ぶだけで中身を見ない。**

| 経路             | capture-ledger が送る物                                                                                                  | `crawl_host` がすること                                                                    | 記録に残る物                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `variables`      | 名前 → 値。`POST /api/crawls` の `variables` で頼んだ物を capture-ledger が固定する                                      | そのまま BrowserHive の要求に載せる                                                        | 値（[BrowserHive WACZ](https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.25.0/ja/) の `browserhive:capture.settings.variables`・capture-ledger の行）                              |
| `secrets`        | 名前 → Windmill の変数の path（`f/waggle_secrets/<名前>`）。スクリプトの宣言から capture-ledger が集め、在るかを確かめる | `getVariable` で値に解き、BrowserHive の要求に**だけ**載せる。フォルダの外の path は投げる | 名前だけ（BrowserHive WACZ の `browserhive:capture.settings.secrets`。capture-ledger の行には path と、置いた時刻）                                                                              |
| `secret_archive` | 値を WARC に残すシークレットの名前 → `"keep"`（宣言の `archive: "keep"`）。無ければ `{}`                                 | 要求の `secretArchive` に載せる。**`secrets` で解いた名前だけを残す**                      | どのシークレットを残したか（`browserhive:capture.settings.secretArchive`）。ほかのシークレットの値は [BrowserHive WARC](https://uraitakahito.github.io/browserhive-warc-spec/1.4.0/ja/) で `***` |

どれも空なら鍵ごと送らない（v21 までの BrowserHive は知らない欄を 400 で断る）。古い capture-ledger は
どれも送らないので flow からは `null` で届き、`crawl_host` は「無い」と読む —— `artifact_sink` も
同じ扱いにした（以前は `undefined` しか見ておらず、省いた配備では `null` を送っていた）。`secret_archive` が
届かなければ全部のシークレットを隠すので、安全な側に倒れる。逆向きに、`secret_archive` の入力を持たない古い flow も、
この引数を断らない。Windmill は既定で引数を flow の schema に照らさず（capture-ledger が `frontier` の要素に足す `lastFinishedAt` は、
schema に無いまま `plan_level` まで届いてきた）、運ぶ段が無いので、そこでも値は隠れる。

**BrowserHive は WARC の中でもシークレットの値を隠す**（v29.0.0 から）。スクリプトが送った値もサイトが返した値も、
`secretArchive` に名前の無い物は `***` になる。`crawl_host` が `secretArchive` に残すのは、自分が組んだ `secrets` に在る
名前だけ —— BrowserHive は `secrets` に無い名前を 400 で断り、それは 1 ページではなくクロールの全部の取り込みに当たる。
capture-ledger も行に固定した名前だけを送るが、ここでも見直す。BrowserHive は 8 字未満の隠す値と、隠す値を書いた取り込みの URL も
断るので、そうしたクロールはページごとに BrowserHive の 400 で失敗する（capture-ledger は値を見ないので先に断れない）。

### シークレットは Windmill の変数

値を持つのは Windmill だけ。人が前もって置く（`--secret` は新しく作るときの既定なので、付けなくても secret
になるが、書いておく）:

```sh
pnpm run windmill:cli variable add '<値>' f/waggle_secrets/<名前> --secret --description '<何の鍵か>'
```

- 名前はスクリプトが宣言した綴り（`^[a-z][a-z0-9_]*$`）。path を組むのは capture-ledger で、`crawl_host` は
  `f/waggle_secrets/` の外の path を名前と一緒に投げる。
- フォルダ `f/waggle_secrets` は `windmill/f/waggle_secrets/folder.meta.yaml` が正で、`windmill:push` が作る。
  **API や UI で作ったフォルダは次の push で消える**（`wmill sync push` は手元に無いフォルダを消す）。中の変数は
  同期しない（`skipVariables`）ので、push で消えも増えもしない。`pnpm run doctor` の「シークレットのフォルダ」が
  在るかを見る。
- 宣言したシークレットが Windmill に無ければ、capture-ledger はクロールを始めずに 400 で名前と path を言う。
  `crawl_host` が解くときに無い（クロールの途中で消された）なら段ごと落ち、`fail_crawl` が締める。
- 値が通るのは、Windmill の worker から BrowserHive への要求の本文だけ。run の履歴に載る引数は path。
  Windmill の job のログは、secret の値の全体一致を `zzp*****c3b` の形に伏せる（1.806.0 で実測。部分文字列は
  伏せない）が、`crawl_host` は元から値を log に出さない（出すのは名前と、そのうち WARC に残す物だけ）。BrowserHive の
  側の扱い（残すと言わなければ WARC でも隠す・ログで伏せる・頁の JS からは読める）は BrowserHive の docs を見ること。

予定の `request` は `POST /api/crawls` と同じ形なので、`variables` も書ける。シークレットは書かない —— スクリプトが
宣言した名前を、capture-ledger が回ごとに Windmill の変数に結ぶので、定期の回でも手で始めたクロールでも同じ値が届く。
