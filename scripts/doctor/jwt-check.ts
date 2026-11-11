/**
 * doctor の jwt の答えを読む。
 *
 * 点検は、flow と同じ資格 (client credentials) でトークンを取り、capture-ledger の `GET /api/archives` を
 * Bearer で読む。**200 になるのは JWT を受ける API だけ**。拒まれたら、同じ API にヘッダで
 * `GET /api/me` を訊いて場面を分ける:
 *
 *   200                       API はヘッダで名乗る設定 (OIDC_ISSUER が無い)
 *   Route GET:/api/me の 404  capture-ledger が v0.42.0 より古く、見分けられない
 *   それ以外 (401)            JWT を受ける設定で、トークンそのものを拒んだ —— iss・client_id・
 *                             プールの作り直し。理由は API のログにある
 *
 * 入出力を持たない。訊くのは `checks.ts`。
 */
import type { Verdict } from "./run.js";

export interface JwtProbe {
  /**
   * flow の資格で取ったトークンで一覧を読んだ status。トークンが取れなければ `"no-token"`、
   * API に届かなければ undefined。
   */
  token: number | undefined | "no-token";
  /** 拒まれたときだけ訊く、ヘッダでの `GET /api/me` の答え。 */
  header?: { status: number | undefined; body: string };
  /** flow の資格の iss (変数 `u/admin/ledger_client`)。need に出す値を決め打ちしない。 */
  iss: string;
}

/** Fastify が route の無いときに返す本文。 */
const ME_ROUTE_MISSING = /Route GET:\/api\/me not found/;

export const readJwt = ({ token, header, iss }: JwtProbe): Verdict => {
  if (token === 200) return { ok: true };
  if (token === "no-token") {
    return {
      ok: false,
      need: "flow の資格でトークンを取れない (上の idp を先に) → cd ../capture-ledger && pnpm run dev:up --from idp",
    };
  }
  if (token === undefined) {
    return { ok: false, need: "capture-ledger の API に届かない (上の capture-ledger api を先に)" };
  }
  if (token !== 401) {
    return { ok: false, need: `flow のトークンで GET /api/archives → ${String(token)}` };
  }
  if (header?.status === 200) {
    return {
      ok: false,
      need:
        `API はヘッダで名乗る設定で動いている (CAPTURE_LEDGER_OIDC_ISSUER=${iss} が効いていない) → ` +
        "capture-ledger で pnpm run dev:up --from idp (idp:bootstrap が .env.local に書き、API を起こし直す)。" +
        "ヘッダの設定の API では、flow の段の報告 (Bearer) が 401 になる",
    };
  }
  if (header?.status === 404 && ME_ROUTE_MISSING.test(header.body)) {
    return {
      ok: false,
      need:
        "API が flow のトークンを受けない —— capture-ledger が v0.42.0 より古く、ヘッダの設定か、" +
        `トークンを拒んだのかを見分けられない。CAPTURE_LEDGER_OIDC_ISSUER=${iss} を確かめる`,
    };
  }
  return {
    ok: false,
    need:
      "API は flow のトークンも開発用ヘッダも受けない —— capture-ledger の .env.local の " +
      `CAPTURE_LEDGER_OIDC_ISSUER が ${iss} と一字一句同じか、CAPTURE_LEDGER_OIDC_CLIENT_IDS に ` +
      "Windmill の app client の ID が在るか (どちらも idp:bootstrap が書く。cd ../capture-ledger && pnpm run dev:up --from idp)。" +
      "理由は API のログの「JWT rejected」",
  };
};
