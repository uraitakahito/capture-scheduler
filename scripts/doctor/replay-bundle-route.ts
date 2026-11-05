/**
 * capture-ledger に合本の口 (`POST /api/crawls/:id/replay-bundle`) が在るかの読み分け (CAPTURE-57)。
 *
 * flow の合本の段 (`replay_bundle_level.ts`) は、この口が 404 なら投げる。だから口の無い古い capture-ledger の上では、
 * **どのクロールも段の報告の後に合本の段で落ち、failed で締められる** —— それを撮る前にここで言う。
 *
 * **名乗らずに叩く。** 台帳は id と本文の形を見てから名乗りを見るので、uuid の形の id と形の合う本文
 * (`{"depth":0}`) を送れば、口が在れば 401、口が無ければ Fastify の 404 (`Route POST:… not found`) になる。
 * 名乗って叩かないのは、これが書く口だから —— 名乗りで止まれば、台帳は版を払い出さず、保管庫にも何も書かない。
 * 本文を付けないと、口が在っても本文の検査で 400 になり、口の有無が分からない (crawl route の点検と同じ)。
 *
 * 台帳はクロールの口 (webhook の 2 行) を出すときだけ合本の口も出すので、この点検は crawl route の後に訊く。
 * だからここでの 404 は「capture-ledger が古い」と読める。
 */
import type { Verdict } from "./run.js";
import type { Answer } from "./windmill-contents.js";

/** 叩く口。id は uuid の形でありさえすればよい (名乗りで止まるので、クロールは引かない)。 */
export const REPLAY_BUNDLE_PROBE = "/api/crawls/00000000-0000-4000-8000-000000000000/replay-bundle";

/** 送る本文。台帳の本文の形 (`depth` だけ) に合わせる。 */
export const REPLAY_BUNDLE_PROBE_BODY = '{"depth":0}';

/** 名乗らずに `POST REPLAY_BUNDLE_PROBE` を叩いた答え。 */
export const readReplayBundleRoute = (answer: Answer): Verdict => {
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
        "POST /api/crawls/:id/replay-bundle → 404 —— 台帳に合本の口が無い (capture-ledger が古い)。" +
        "このままでは、どのクロールも合本の段で落ちる → cd ../capture-ledger && git pull && pnpm run dev:up",
    };
  }
  if (answer.status === 400) {
    return {
      ok: false,
      need:
        `POST /api/crawls/:id/replay-bundle → 400 —— 台帳が本文 ${REPLAY_BUNDLE_PROBE_BODY} の形を断った。` +
        "合本の段が送る本文と、capture-ledger の口の形が合っていない (capture-ledger と capture-scheduler の版の組) " +
        answer.body.slice(0, 120),
    };
  }
  return {
    ok: false,
    need: `POST /api/crawls/:id/replay-bundle → ${String(answer.status)} (名乗らずに叩いたので 401 のはず) ${answer.body.slice(0, 120)}`,
  };
};
