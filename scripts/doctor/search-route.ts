/**
 * capture-ledger に全文検索の口が在るかの読み分け。
 *
 * 名乗らずに `GET /api/search?q=x` を引く。**口が在れば、名乗りを見る所で 401** になり、口が無ければ
 * route ごと無いので Fastify の 404 になる (「crawl route」と同じ見分け方)。200 を求めないのは、
 * 名乗りの無い 200 は認可が外れた印で、検索が在ることの印ではないため。
 *
 * capture-ledger は CAPTURE-53 から、`CAPTURE_LEDGER_OPENSEARCH_URL` が無ければ起動しないので、
 * 404 が返るのは古い capture-ledger だけ。古い capture-ledger では、flow の索引の段が毎回 404 で落ちる。
 */
import type { Verdict } from "./run.js";
import type { Answer } from "./windmill-contents.js";

/** host から引く検索の口。`q` は何でもよい (名乗りを見る前に答えが決まる)。 */
export const SEARCH_PROBE = "/api/search?q=x";

/** 名乗らずに `GET /api/search?q=x` を引いた答え。 */
export const readSearchRoute = (answer: Answer): Verdict => {
  if (answer.status === 401) return { ok: true };
  if (answer.status === undefined) {
    return {
      ok: false,
      need: "capture-ledger の API に届かない → cd ../capture-ledger && pnpm run api",
    };
  }
  if (answer.status === 404) {
    return {
      ok: false,
      need:
        "GET /api/search → 404 —— 台帳に検索の口が無い (CAPTURE_LEDGER_OPENSEARCH_URL)。" +
        "capture-ledger が古い → cd ../capture-ledger && git pull && pnpm run dev:up --from search",
    };
  }
  return {
    ok: false,
    need: `GET /api/search → ${String(answer.status)} (名乗らずに引いたので 401 のはず) ${answer.body.slice(0, 120)}`,
  };
};
