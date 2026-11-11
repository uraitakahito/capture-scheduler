/**
 * capture-ledger の全文検索が働いているかの読み分け。
 *
 * **名乗って引く。** flow の資格で取ったばかりのトークンで `GET /api/search?q=x` を引く (jwt の行と同じ
 * 取り方)。名乗らずに引くと、エンドポイントが在れば名乗りを見る所で 401 になるので、OpenSearch が止まっていても
 * ✓ に見える —— 台帳の検索のエンドポイントは、名乗りを見た後で OpenSearch に訊く。名乗って引けば、200 が
 * 「エンドポイントが在り、OpenSearch が答えた」、503 が「OpenSearch が答えないか、索引が無い」、404 が「エンドポイントが無い」と
 * 分かれる。
 *
 * capture-ledger は CAPTURE-53 から、OpenSearch に届かなければ起動しないので、404 が返るのは古い
 * capture-ledger だけ。503 は起動の後にも起きる —— API が動いたまま OpenSearch が落ちたか、作り直された
 * (compose の OpenSearch は volume を持たないので、作り直すと索引ごと消える)。どちらでも flow の索引の段は
 * 落ちる。
 */
import type { Verdict } from "./run.js";
import type { Answer } from "./windmill-contents.js";

/** host から引く検索のエンドポイント。`q` は何でもよい (当たりの数は見ない)。 */
export const SEARCH_PROBE = "/api/search?q=x";

/** flow の資格のトークンで `GET /api/search?q=x` を引いた答え。 */
export const readSearchRoute = (answer: Answer): Verdict => {
  if (answer.status === 200) return { ok: true };
  if (answer.status === undefined) {
    return {
      ok: false,
      need: "capture-ledger の API に届かない → cd ../capture-ledger && pnpm run api",
    };
  }
  if (answer.status === 503) {
    return {
      ok: false,
      need:
        "GET /api/search → 503 —— capture-ledger の OpenSearch が答えないか、索引が無い → " +
        "cd ../capture-ledger && pnpm run dev:status の「検索」の行を見る (答えないなら " +
        "pnpm run dev:up --from search、索引が無いなら pnpm run search:reindex)",
    };
  }
  if (answer.status === 404) {
    return {
      ok: false,
      need:
        "GET /api/search → 404 —— 台帳に検索のエンドポイントが無い (CAPTURE_LEDGER_OPENSEARCH_URL)。" +
        "capture-ledger が古い → cd ../capture-ledger && git pull && pnpm run dev:up --from search",
    };
  }
  return {
    ok: false,
    need: `GET /api/search → ${String(answer.status)} (flow の資格のトークンで引いたので 200 のはず) ${answer.body.slice(0, 120)}`,
  };
};
