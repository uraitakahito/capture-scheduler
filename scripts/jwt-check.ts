/**
 * `check:connection` の jwt の答えを読む。
 *
 * 点検は、issuer から新しいトークンを取り、capture-ledger の `GET /api/archives` を Bearer で
 * 読む。**200 になるのは JWT を受ける API だけ**。拒まれたら、同じ API にヘッダで
 * `GET /api/me` を訊いて場面を分ける:
 *
 *   200                       API はヘッダで名乗る設定 (OIDC_ISSUER が無い)
 *   Route GET:/api/me の 404  capture-ledger が v0.42.0 より古く、見分けられない
 *   それ以外 (401)            JWT を受ける設定で、トークンそのものを拒んだ —— iss・aud・
 *                             issuer を起こし直した直後の 30 秒。理由は API のログにある
 *
 * 以前は、どの場面でも「OIDC_ISSUER を書いて」と言っていた。dev issuer の kid が固定だった
 * 頃の「issuer を起こし直した後の 401」(API が古い鍵を覚えていた) まで、それで取り違えた。
 *
 * 入出力を持たない (`can-submit.ts` と同じ理由: `check-stack.ts` は import した時点で点検を
 * 走らせるので、読み分けだけを単体で試せるようにしてある)。
 */
import type { Verdict } from "./can-submit.js";

export interface JwtProbe {
  /**
   * issuer の新しいトークンで一覧を読んだ status。トークンが取れなければ `"no-token"`、
   * API に届かなければ undefined。
   */
  token: number | undefined | "no-token";
  /** 拒まれたときだけ訊く、ヘッダでの `GET /api/me` の答え。 */
  header?: { status: number | undefined; body: string };
  /** issuer が名乗る iss (discovery の `issuer`)。need に出す値を決め打ちしない。 */
  iss: string;
}

/** Fastify が route の無いときに返す本文。 */
const ME_ROUTE_MISSING = /Route GET:\/api\/me not found/;

export const readJwt = ({ token, header, iss }: JwtProbe): Verdict => {
  if (token === 200) return { ok: true };
  if (token === "no-token") {
    return { ok: false, need: "issuer からトークンを取れない (上の oidc issuer を先に)" };
  }
  if (token === undefined) {
    return { ok: false, need: "capture-ledger の API に届かない (上の capture-ledger api を先に)" };
  }
  if (token !== 401) {
    return { ok: false, need: `issuer のトークンで GET /api/archives → ${String(token)}` };
  }
  if (header?.status === 200) {
    return {
      ok: false,
      need:
        "API はヘッダで名乗る設定で動いている → capture-ledger の .env に " +
        `CAPTURE_LEDGER_OIDC_ISSUER=${iss} を書いて API を起こし直す。` +
        "ヘッダの設定の API では、flow の段の報告 (Bearer) が 401 になる",
    };
  }
  if (header?.status === 404 && ME_ROUTE_MISSING.test(header.body)) {
    return {
      ok: false,
      need:
        "API が issuer のトークンを受けない —— capture-ledger が v0.42.0 より古く、ヘッダの設定か、" +
        `トークンを拒んだのかを見分けられない。CAPTURE_LEDGER_OIDC_ISSUER=${iss} を確かめる`,
    };
  }
  return {
    ok: false,
    need:
      "API は issuer のトークンも開発用ヘッダも受けない —— capture-ledger の .env の " +
      `CAPTURE_LEDGER_OIDC_ISSUER が ${iss} と一字一句同じか (無いなら書く)、` +
      "CAPTURE_LEDGER_OIDC_AUDIENCE が capture-ledger か。issuer を起こし直した直後なら 30 秒待つ。" +
      "理由は API のログの「JWT rejected」",
  };
};
