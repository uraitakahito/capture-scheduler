/**
 * クロールの合本を、この段で台帳に載ったぶんまで含めて書き直すよう capture-ledger に頼む (CAPTURE-57)。
 *
 * 合本は、そのクロールの WACZ を全部並べた `replay.json` と、その頁の行の `pages.json` の組。capture-ledger が
 * 保管庫の `org/<組織>/crawls/<クロール>/r<版>/` に書き、replay はそれを 1 つのアーカイブとして開く —— どの WACZ の
 * 頁へもリンクで行ける。版は書くたびに台帳が払い出し、書いた版は書き換えない。
 *
 * ## ここに判断は無い
 *
 * 渡すのは `crawl_id` と段の深さ (`depth`) だけ。**どの WACZ を入れるかは capture-ledger が知っている**
 * (`archives.crawl_id`)。深さは `replay.json` に記録されるだけで、版ではない。
 *
 * ## 台帳が 200 で返す失敗では投げない
 *
 * 合本は撮った物から作る派生物で、後から作り直せる (capture-ledger の `pnpm run replay-bundle:rebuild`)。
 * ここで投げると、後ろの索引の段 (`index_level`) が飛び、flow の failure_module (`fail_crawl.ts`) がクロールを
 * failed で締める —— 次の段が既に出ていれば、台帳の状態が食い違う。だから 200 の答えは、どれも 1 行の
 * ログに書いて返す:
 *
 * - `error` が在る —— 保管庫に書けなかった (台帳は `crawls.replay_bundle_error` にも残す)
 * - `failed` が 1 以上 —— 検められなかった WACZ がある (次の合本が拾い直す)
 * - `rev` が null —— 入れる WACZ がまだ無いので書かなかった
 *
 * ## 投げるのは、200 で答えなかったときと答えの形が違うときだけ
 *
 * 400 (本文の形)・401 (トークン)・404 (クロールが無い・トークンの名前に `can_submit` が無い・capture-ledger が
 * 古く口が無い)・5xx (台帳が DB に届かない)。どれも段を進めても直らない設定か台帳の誤りで、黙ると合本が 1 本も
 * 書かれないまま flow が緑で終わる。
 */
import * as wmill from "windmill-client";

/** capture-ledger の答えそのもの (`POST /api/crawls/:id/replay-bundle` の 200)。 */
export interface ReplayBundleOutcome {
  /** 書いた (書こうとした) 版。入れる WACZ が無く、書かなかったときは null。 */
  rev: number | null;
  /** `pages.json` の行の数。 */
  pages: number;
  /** `replay.json` の `resources` に入れた WACZ の数。 */
  members: number;
  /** 記録が 0 で外した WACZ の数。 */
  skipped: number;
  /** 検められなかった WACZ の数。次の合本が拾い直す。 */
  failed: number;
  /** 保管庫に書けなかった理由。書けたら null。 */
  error: string | null;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isRev = (value: unknown): value is number | null =>
  value === null || (isCount(value) && value >= 1);

/** 1 行のログ。書けたか・書けなかったか・書かなかったかを先に言う。 */
const describe = ({ rev, pages, members, skipped, failed, error }: ReplayBundleOutcome): string => {
  const uninspected =
    failed > 0 ? `・検められなかった WACZ ${String(failed)} 本 (次の合本が拾い直す)` : "";
  if (rev === null) {
    return `合本: 入れる WACZ がまだ無いので書かなかった (記録が 0 で外した ${String(skipped)} 本${uninspected})`;
  }
  if (error !== null) {
    return (
      `合本: r${String(rev)} を保管庫に書けなかった (クロールは止めない。台帳の replay_bundle_error に残る` +
      `${uninspected}): ${error}`
    );
  }
  return (
    `合本: r${String(rev)} を書いた —— 頁 ${String(pages)}・WACZ ${String(members)} 本` +
    `・記録が 0 で外した ${String(skipped)} 本${uninspected}`
  );
};

export async function main(crawl_id: string, depth: number): Promise<ReplayBundleOutcome> {
  // 設定は変数から。`report_level.ts` と同じ理由 (schema の既定値は webhook からの
  // 実行には効かない)。
  const waggle_url = await wmill.getVariable("u/admin/waggle_api_url");
  const token = await wmill.getVariable("u/admin/waggle_token");

  // **本文があるので `content-type` を送る。** `index_level.ts` と逆 —— あちらは本文の無い POST で、
  // `application/json` を名乗ると Fastify が 400 を返す。こちらは名乗らないと本文が読まれず、台帳は
  // depth が無いと言って 400 を返す。
  const res = await fetch(`${waggle_url}/api/crawls/${crawl_id}/replay-bundle`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ depth }),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    const head = `POST /api/crawls/${crawl_id}/replay-bundle → ${String(res.status)} ${body}`;
    if (res.status === 404 && body.includes("Route POST:")) {
      // Fastify が口ごと知らないときの 404。台帳の 404 (`{"error":"not found"}`) とは本文で分かれる
      throw new Error(`${head} —— capture-ledger に合本の口が無い (capture-ledger が古い)`);
    }
    if (res.status === 404) {
      throw new Error(
        `${head} —— クロールが無いか、トークンの名前にクロールの許可 (can_submit) が無い`,
      );
    }
    if (res.status === 400) {
      throw new Error(
        `${head} —— 台帳が本文の形を断った (flow の replay_bundle の段が depth を渡しているか)`,
      );
    }
    throw new Error(head);
  }

  const answer = (await res.json()) as Record<string, unknown>;
  const { rev, pages, members, skipped, failed, error } = answer;
  if (
    !isRev(rev) ||
    !isCount(pages) ||
    !isCount(members) ||
    !isCount(skipped) ||
    !isCount(failed) ||
    !(error === null || typeof error === "string")
  ) {
    throw new Error(
      `POST /api/crawls/${crawl_id}/replay-bundle の答えの形が違う ` +
        "(rev・pages・members・skipped・failed・error が要る): " +
        JSON.stringify(answer).slice(0, 300),
    );
  }
  const outcome: ReplayBundleOutcome = { rev, pages, members, skipped, failed, error };
  console.log(describe(outcome));
  return outcome;
}
