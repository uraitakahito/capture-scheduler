/**
 * この段で台帳に載ったぶんを、全文検索の索引に載せるよう capture-ledger に頼む。
 *
 * ## ここに判断は無い
 *
 * 渡すのは `crawl_id` だけ。**どの archive がまだ索引されていないかは capture-ledger が
 * 知っている** (`archives.indexed_at IS NULL`)。id の一覧をこちらで組み立てて渡す形も
 * 書けるが、そうすると「何を索引すべきか」の判断が **単体試験の無い場所**へ移る。
 * この repo の Windmill script は 1 本も試験を持っていないので、判断は置かない。
 *
 * 本文の取り出し (WACZ を開いて `pages.jsonl` を読む) も capture-ledger 側。ここに置くと
 * S3 の資格情報が Windmill にも要る。
 *
 * ## 索引が無い配備では 404 が返る
 *
 * `CAPTURE_LEDGER_OPENSEARCH_URL` を設定していない capture-ledger は、この口を **そもそも出さない**。
 * それは正しい答え (その配備に検索は無い) なので、**失敗にしない** —— 404 だけは
 * 通し、それ以外の失敗は投げる。ここで一律に投げると、検索を使わない配備で
 * クロールの flow が毎回赤くなる。
 */
import * as wmill from "windmill-client";

export interface IndexOutcome {
  /** 索引に載せたアーカイブの本数。 */
  indexed: number;
  /** そのアーカイブに含まれていたページの数。 */
  pages: number;
  /** この配備に検索が無かった (capture-ledger が口を出していない)。 */
  skipped: boolean;
}

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

  if (res.status === 404) {
    // 上の docstring のとおり。**404 は「索引が無い」とも「許可が無い」とも読める**
    // ので、log には両方の可能性を残す —— capture-ledger は列挙を避けるために両者を
    // 区別せずに答える設計 (`api/routes.ts`)。
    console.log(
      "索引の口がありません (この配備に検索が無いか、トークンの名前にクロールの許可がありません)。飛ばします",
    );
    return { indexed: 0, pages: 0, skipped: true };
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `POST /api/crawls/${crawl_id}/index → ${String(res.status)} ${body.slice(0, 300)}`,
    );
  }

  const outcome = (await res.json()) as { indexed: number; pages: number };
  console.log(
    `索引: アーカイブ ${String(outcome.indexed)} 本 / ページ ${String(outcome.pages)} 件`,
  );
  return { ...outcome, skipped: false };
}
