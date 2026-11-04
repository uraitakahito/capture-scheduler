/**
 * この段で台帳に載ったぶんを、全文検索の索引に載せるよう capture-ledger に頼む。
 *
 * ## ここに判断は無い
 *
 * 渡すのは `crawl_id` だけ。**どの archive がまだ索引されていないかは capture-ledger が
 * 知っている** (`archives.indexed_at IS NULL`)。id の一覧をこちらで組み立てて渡す形も
 * 書けるが、そうすると「何を索引すべきか」の判断が Windmill の flow へ移る。答えの読み分けは
 * `test/index-level.test.ts` が見ているが、何を載せるかの判断はここに置かない。
 *
 * 本文の取り出し (WACZ を開いて `pages.jsonl` を読む) も capture-ledger 側。ここに置くと
 * S3 の資格情報が Windmill にも要る。
 *
 * ## 検索は台帳の必須の部品 —— 載らなければ段を落とす
 *
 * capture-ledger は `CAPTURE_LEDGER_OPENSEARCH_URL` が無ければ起動しない (CAPTURE-53)。だから
 * この口は必ず在り、**どの失敗も黙らせない**:
 *
 * - 404 —— クロールが無いか、トークンの名前にクロールの許可 (`can_submit`) が無い。capture-ledger は
 *   列挙を避けるために両者を区別せずに答える (`api/routes.ts`)。以前は「検索の無い配備」としてこれを
 *   飛ばしていたが、その配備はもう無い。飛ばすと、索引が 1 本も載らないまま flow が緑で終わる
 * - 503 —— OpenSearch が答えない
 * - 202 で `failed` が 1 以上 —— 載せられなかったアーカイブがある (`indexed_at` は立たないので、
 *   同じクロールの次の段の索引か、`pnpm run search:reindex` が拾い直す)
 *
 * 投げると flow の failure_module (`fail_crawl.ts`) が走る。最後の段では、台帳はクロールを段の報告の
 * 時点で succeeded にしているので、クロールの状態は変わらず、Windmill の run だけが赤くなる。
 */
import * as wmill from "windmill-client";

export interface IndexOutcome {
  /** この呼び出しの時点で、まだ索引に載っていなかったアーカイブの本数。 */
  pending: number;
  /** 載せたアーカイブの本数。 */
  indexed: number;
  /** 載せられなかったアーカイブの本数 (`pending - indexed`)。 */
  failed: number;
  /** 載せたアーカイブに含まれていた、索引の件数 (ページ一覧の行のうち載せた物)。 */
  pages: number;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

export async function main(crawl_id: string): Promise<IndexOutcome> {
  // 設定は変数から。`report_level.ts` と同じ理由 (schema の既定値は webhook からの
  // 実行には効かない)。
  const waggle_url = await wmill.getVariable("u/admin/waggle_api_url");
  const token = await wmill.getVariable("u/admin/waggle_token");

  // **`content-type` を送らない。** この POST に本文は無く (渡すのは URL の中の
  // crawl_id だけ)、`application/json` を名乗ると Fastify が
  // `FST_ERR_CTP_EMPTY_JSON_BODY` で 400 を返す —— 「JSON だと言ったのに空」。
  const res = await fetch(`${waggle_url}/api/crawls/${crawl_id}/index`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    const head = `POST /api/crawls/${crawl_id}/index → ${String(res.status)} ${body}`;
    if (res.status === 404) {
      throw new Error(
        `${head} —— クロールが無いか、トークンの名前にクロールの許可 (can_submit) が無い`,
      );
    }
    if (res.status === 503) {
      throw new Error(`${head} —— capture-ledger の OpenSearch が答えない`);
    }
    throw new Error(head);
  }

  const answer = (await res.json()) as Record<string, unknown>;
  const { pending, indexed, failed, pages } = answer;
  if (!isCount(pending) || !isCount(indexed) || !isCount(failed) || !isCount(pages)) {
    throw new Error(
      `POST /api/crawls/${crawl_id}/index の答えの形が違う (pending・indexed・failed・pages が要る): ` +
        JSON.stringify(answer).slice(0, 300),
    );
  }
  const outcome: IndexOutcome = { pending, indexed, failed, pages };
  console.log(
    `索引: 待っていたアーカイブ ${String(pending)} 本・載せた ${String(indexed)} 本・` +
      `載せられなかった ${String(failed)} 本・索引の件数 ${String(pages)}`,
  );
  if (failed > 0) {
    throw new Error(
      `索引に入らなかったアーカイブが ${String(failed)} 本 (待っていた ${String(pending)} 本のうち) —— ` +
        "capture-ledger の API のログの「could not index this archive」を見る",
    );
  }
  return outcome;
}
