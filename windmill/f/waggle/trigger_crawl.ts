/**
 * capture-ledger に取り込みを 1 回起こし、終わるまで見届ける。
 *
 * Windmill が決めるのは「いつ」だけ。「何を・どう投げるか」は capture-ledger の側にある
 * (対象の一覧は `capture_targets`、取り込む形式は `CAPTURE_LEDGER_CAPTURE_FORMATS`)。
 * ここから渡せるのは `limit` だけで、それも省ける —— 知らない鍵を送ると capture-ledger は
 * 400 を返す。
 *
 * ## なぜ「クロール」なのか
 *
 * 以前は `POST /api/runs` を叩いていた。`runs` は「`capture_targets` の有効な行を
 * 全部投げる」1 回で、深さも範囲も持たない —— これは **`max_depth = 0` のクロール**と
 * 同じものだったので、畳んだ。`fromTargets` がその表現で、既定では辿らない。
 *
 * 畳んだことで、日次の取り込みにも**礼儀 (ホストごとの間隔) が効く**ようになった。
 * 以前の run は全件を同時に投げていて、間隔の概念が無かった。
 *
 * ## 終わるまで待つ理由
 *
 * `POST /api/crawls` は 202 を返して即座に戻る。そこで終わりにすると、**この job は
 * 取り込みが失敗しても緑のまま**になる。Windmill の実行履歴に赤を残せるのは
 * ここで throw したときだけなので、終端まで見てから決める。
 *
 * ## 409 は失敗ではない
 *
 * capture-ledger は走行中の 2 本目を 409 で拒む (構造的に 1 本しか走れない)。これは
 * 「今回は見送る」であって異常ではないので、**緑で終わる**。再試行してもいけない ——
 * 走っている 1 本が終わるまで、何度投げても同じ答えが返るだけ。
 *
 * 畳んだことで、**手で起こしたクロールとも塞ぎ合う**ようになった。礼儀の観点では
 * それが正しい (同じホストを 2 経路が叩かない) が、日次が見送られる回数は増える。
 */

type Terminal = "succeeded" | "failed";

interface CrawlState {
  crawlId: string;
  state: "running" | Terminal;
  stopReason: string | null;
  startedAt: string;
  finishedAt: string | null;
  pagesDiscovered: number | null;
  pagesCaptured: number | null;
  error: string | null;
}

export interface Result {
  outcome: Terminal | "skipped";
  crawlId?: string;
  pagesDiscovered?: number;
  pagesCaptured?: number;
  stopReason?: string | null;
}

/** 取り込みは数十分に達しうる。既定は 2 時間で諦める。 */
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 15_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * route そのものが無いときの本文。Fastify が返す `Route POST:/api/crawls not found` の形。
 *
 * capture-ledger は webhook の 2 行 (CAPTURE_LEDGER_CRAWL_WEBHOOK_URL / _TOKEN) が無いと
 * `/api/crawls` を出さない —— その配備にクロールの能力は無い、が正しい答えだから。
 */
const ROUTE_MISSING = /Route [A-Z]+:\/api\/crawls\S* not found/;

/**
 * 本文を必ず読んでから投げる。status だけにすると、capture-ledger が返している理由
 * (`{"error":"..."}`) が消えて「404 でした」しか残らない。
 *
 * **404 は 2 通りある。** route が無い (上) か、route は在るが呼び出し元にクロールの許可が
 * 無いか (`{"error":"not found"}`)。status は同じで、本文で分かれる。以前はどちらでも許可を
 * 疑わせていて、webhook の 2 行が無い配備でも「fga:grant を叩け」と言っていた。
 */
const failure = async (res: Response, what: string): Promise<Error> => {
  const body = await res.text();
  const hint =
    res.status === 401
      ? " —— トークンが古いかもしれません (issuer を再起動しましたか)"
      : res.status === 404 && ROUTE_MISSING.test(body)
        ? " —— capture-ledger が /api/crawls を出していません (capture-ledger の .env に" +
          " CAPTURE_LEDGER_CRAWL_WEBHOOK_URL と _TOKEN。windmill:bootstrap が出す 2 行)"
        : res.status === 404
          ? " —— トークンの名前 (sub) に、その組織のクロールの許可がありますか" +
            " (capture-ledger: pnpm run fga:grant submitter <sub> <org>。既定は windmill acme)"
          : "";
  return new Error(`${what} → ${String(res.status)} ${body.slice(0, 300)}${hint}`);
};

export async function main(
  waggle_url: string,
  token: string,
  limit?: number,
  timeout_ms: number = DEFAULT_TIMEOUT_MS,
  /**
   * 問い合わせの間隔。**試験のためだけに引数へ出してある。**
   *
   * 既定の 15 秒のままだと、待機ループの試験が 1 本あたり 15 秒かかる ——
   * sleep が最初の問い合わせより前に入るため。`crawl_host.ts` の `captureHost` に
   * 対してやったのと同じ形で、fake timer を使わずに実タイマーの ms スケールで
   * 書けるようにする。
   */
  poll_interval_ms: number = POLL_INTERVAL_MS,
): Promise<Result> {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const started = await fetch(`${waggle_url}/api/crawls`, {
    method: "POST",
    headers,
    // `fromTargets` が「登録済みの一覧を全部」。深さは capture-ledger が 0 にする。
    body: JSON.stringify({ fromTargets: limit === undefined ? {} : { limit } }),
  });

  if (started.status === 409) {
    // 走行中。今回は見送る —— 再試行しない。
    console.log("既に走っているので見送ります (409)");
    return { outcome: "skipped" };
  }
  if (started.status !== 202) {
    throw await failure(started, "POST /api/crawls");
  }

  const { crawlId } = (await started.json()) as { crawlId: string };
  console.log(`起こしました: ${crawlId}`);

  const deadline = Date.now() + timeout_ms;
  for (;;) {
    if (Date.now() > deadline) {
      // 走ったまま残る。ここで殺す術は無い (capture-ledger に中断の口が無い)。
      throw new Error(
        `${crawlId} が ${String(Math.round(timeout_ms / 60000))} 分で終わりませんでした。` +
          " まだ走っているかもしれません —— GET /api/crawls/:id で見てください",
      );
    }
    await sleep(poll_interval_ms);

    const res = await fetch(`${waggle_url}/api/crawls/${crawlId}`, { headers });
    if (!res.ok) throw await failure(res, `GET /api/crawls/${crawlId}`);
    const crawl = (await res.json()) as CrawlState;
    if (crawl.state === "running") continue;

    const counts = {
      pagesDiscovered: crawl.pagesDiscovered ?? 0,
      pagesCaptured: crawl.pagesCaptured ?? 0,
    };
    if (crawl.state === "failed") {
      throw new Error(`${crawlId} は失敗しました: ${crawl.error ?? "(理由なし)"}`);
    }

    // **知らない値を「成功」に落とさない。**
    //
    // ここが無いと、capture-ledger 側の field 名が変わっただけで `crawl.state` が
    // `undefined` になり、上の 2 つの比較を素通りして succeeded を返す ——
    // 走行中でも失敗でも「成功」と報告することになる。日次の実行はここでしか
    // 成否を決めていないので、静かに間違えると誰も気づかない。
    //
    // 線の形を守っているものは他に無い: capture-ledger 側に response schema は無く、
    // こちらは `as CrawlState` の素のキャスト。**この 1 つが唯一の砦。**
    // (`runs.status` → `runs.state` の改名を捕まえたのがこれ。)
    if (crawl.state !== "succeeded") {
      throw new Error(
        `${crawlId}: 知らない状態「${String(crawl.state)}」が返りました。` +
          " capture-ledger の /api/crawls/:id が返す field 名が変わっていませんか",
      );
    }

    // succeeded は「最後まで走った」であって「全部取れた」ではない。
    // 打ち切りでも succeeded で終わる —— 理由は `stopReason` が語る。
    //
    // **対象一覧からの取り込みは常に `max_depth` で終わる。** 深さ 0 なので
    // 「次の段は無い」が「深さの上限に当たった」として記録される。異常ではない。
    console.log(`完了: ${JSON.stringify({ ...counts, stopReason: crawl.stopReason })}`);
    return { outcome: "succeeded", crawlId, ...counts, stopReason: crawl.stopReason };
  }
}
